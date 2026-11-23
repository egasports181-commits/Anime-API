import { getMedia } from '../core/anilist.js';
import { extractMegaPlayDetails } from "../extractors/megaplay.js";
import { buildTitleSearchQueries, buildTitles, decodeEntities, titleIdentityScore } from "../core/new-provider-utils.js";
import { wreqFetch } from "../core/wreq.js";

// Anikoto mirrors / rotates its domain. Put one or more bases (comma separated) in the ANIKOTO_BASES
// env var to switch without touching code. The first is tried first, the rest are failovers.
function readEnv(name) {
  try { return typeof process !== "undefined" ? process.env?.[name] : undefined; } catch { return undefined; }
}
const ANIKOTO_BASES = String(readEnv("ANIKOTO_BASES") || "https://anikoto.cz")
  .split(",").map((base) => base.trim().replace(/\/+$/, "")).filter(Boolean);
let ANIKOTO = ANIKOTO_BASES[0];
const MAPPER = "https://mapper.nekostream.site/api/mal";
const ANIZIP = "https://api.ani.zip/mappings";
const SPOOF_REF = "https://hianimes.re/";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const LANG_MAP = {
  en: "en", english: "en", ja: "ja", japanese: "ja",
  fr: "fr", french: "fr", de: "de", german: "de",
  es: "es", spanish: "es", pt: "pt", portuguese: "pt"
};

function normalize(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

const BLOCK_STATUS = new Set([403, 429, 503]);
const CHALLENGE_RE = /<title>\s*(?:just a moment|attention required)|cf-browser-verification|checking your browser before accessing/i;

function looksBlocked(status, body = "") {
  return BLOCK_STATUS.has(status) || CHALLENGE_RE.test(String(body ?? "").slice(0, 6000));
}

// Plain fetch first (same behaviour as before). If it throws or the site answers 403/429/503, retry once
// with the browser-impersonating client that senshi / anipm / mkissa already use. Only for the site itself.
async function request(url, headers = {}) {
  const init = { headers: { "User-Agent": UA, ...headers } };
  let res = null;
  let netError = null;
  try {
    res = await fetch(url, init);
  } catch (error) {
    netError = error;
  }
  const onSite = ANIKOTO_BASES.some((base) => url.startsWith(base));
  if (onSite && (!res || BLOCK_STATUS.has(res.status))) {
    try {
      const alt = await wreqFetch(url, { session: "anikoto", headers: init.headers });
      if (alt && (alt.ok || !res)) { res = alt; netError = null; }
    } catch (error) {
      netError = netError || error;
    }
  }
  if (!res) {
    const code = netError?.cause?.code || netError?.code || netError?.message || "network error";
    const err = new Error(`Anikoto unreachable (${code}) fetching ${url}`);
    err.reason = "unreachable";
    throw err;
  }
  return res;
}

async function httpGet(url, headers = {}) {
  const res = await request(url, { Accept: "text/html,*/*", ...headers });
  const body = await res.text().catch(() => null);
  if (!res.ok) {
    const _e = new Error(`HTTP ${res.status} fetching ${url}`);
    _e.status = res.status;
    _e.rawBody = body;
    _e.reason = looksBlocked(res.status, body) ? "blocked" : "http_error";
    throw _e;
  }
  return body ?? "";
}

async function getJSON(url, headers = {}) {
  const res = await request(url, { Accept: "application/json,*/*", ...headers });
  if (!res.ok) {
    const _raw = await res.text().catch(() => null);
    const _e = new Error(`HTTP ${res.status} fetching ${url}`);
    _e.status = res.status;
    _e.rawBody = _raw;
    _e.reason = looksBlocked(res.status, _raw) ? "blocked" : "http_error";
    throw _e;
  }
  return res.json();
}

const MODIFIERS = [
  "ova", "movie", "special", "specials", "tales", "journal", "part", "season", "kanwa", "spin-off", "theatre"
];

function scoreCandidate(cand, primaryEn, primaryRom, synonyms) {
  let score = 0;
  const candNameNorm = normalize(cand.name);
  const candJpNorm   = normalize(cand.jp);
  const candSlugNorm = normalize(cand.slug);

  const normEn  = normalize(primaryEn);
  const normRom = normalize(primaryRom);

  if (normEn && candNameNorm === normEn) score += 1000;
  if (normRom && candNameNorm === normRom) score += 900;
  if (normRom && candJpNorm === normRom) score += 800;

  const targetText = `${primaryEn || ""} ${primaryRom || ""} ${(synonyms || []).join(" ")}`.toLowerCase();
  
  for (const mod of MODIFIERS) {
    const candHasMod = candNameNorm.includes(mod) || candSlugNorm.includes(mod);
    const targetHasMod = targetText.includes(mod);
    if (candHasMod && !targetHasMod) {
      score -= 300;
    }
  }

  for (const t of [primaryEn, primaryRom, ...(synonyms || [])]) {
    const normT = normalize(t);
    if (!normT || normT.length < 3) continue;

    if (candNameNorm === normT) score += 200;
    else if (candNameNorm.startsWith(normT) || normT.startsWith(candNameNorm)) score += 80;
    else if (candNameNorm.includes(normT) || normT.includes(candNameNorm)) score += 40;

    if (candJpNorm && candJpNorm === normT) score += 100;
  }

  const lengthDiff = Math.abs(candNameNorm.length - (normEn || normRom || "").length);
  score -= lengthDiff * 2;

  return score;
}

async function searchAnikoto(query, diag) {
  if (diag) diag.attempts++;
  const searchHtml = await httpGet(`${ANIKOTO}/filter?keyword=${encodeURIComponent(query)}`, { Referer: `${ANIKOTO}/` });
  const candidates = [];

  // Host-agnostic on purpose: the site may answer with absolute links on another host, or relative ones.
  const re = /<a\s+class="name d-title"\s+href="(?:https?:\/\/[^"\/]+)?\/watch\/([^"/]+)(?:\/ep-\d+)?"[^>]*data-jp="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(searchHtml)) !== null) {
    const slug = m[1];
    const jp = decodeEntities(m[2].trim());
    const name = decodeEntities(m[3].replace(/<[^>]*>/g, "").trim());
    candidates.push({ slug, name, jp });
  }

  if (!candidates.length) {
    const reFallback = /<a\s+[^>]*?href="(?:https?:\/\/[^"\/]+)?\/watch\/([^"/]+)(?:\/ep-\d+)?"[^>]*>([\s\S]*?)<\/a>/g;
    while ((m = reFallback.exec(searchHtml)) !== null) {
      candidates.push({ slug: m[1], name: m[1], jp: "" });
    }
  }

  if (diag) {
    diag.ok++;
    if (!candidates.length) {
      diag.empty++;
      if (looksBlocked(200, searchHtml)) diag.blocked++;
      if (diag.sampleTitle === null) {
        diag.sampleTitle = (searchHtml.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
        diag.sampleBytes = searchHtml.length;
      }
    }
  }

  const seen = new Set();
  return candidates.filter(c => {
    if (seen.has(c.slug)) return false;
    seen.add(c.slug);
    return true;
  });
}

function parseEpisodeRows(html) {
  const rows = [];
  const re = /<a\s+[^>]*data-id="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  for (const match of html.matchAll(re)) {
    const tag = match[0];
    const getAttr = (name) => tag.match(new RegExp(`data-${name}="([^"]*)"`))?.[1] ?? "";
    const number = Number.parseInt(getAttr("num"), 10);
    if (!Number.isInteger(number)) continue;
    const title = decodeEntities(match[2].match(/<span\s+class="d-title"[^>]*>([\s\S]*?)<\/span>/i)?.[1]?.replace(/<[^>]*>/g, "").trim() ?? "");
    rows.push({
      number,
      ids: getAttr("ids"),
      hasSub: getAttr("sub") === "1",
      hasDub: getAttr("dub") === "1",
      malId: Number.parseInt(getAttr("mal"), 10) || null,
      slug: getAttr("slug"),
      timestamp: getAttr("timestamp"),
      title: title || `Episode ${number}`,
    });
  }
  return rows;
}

async function inspectAnikotoCandidate(candidate) {
  const watchHtml = await httpGet(`${ANIKOTO}/watch/${candidate.slug}`, { Referer: `${ANIKOTO}/` });
  const showId = watchHtml.match(/data-id="(\d+)"/)?.[1];
  if (!showId) throw Object.assign(new Error(`watch page ${candidate.slug} has no numeric data-id (page markup changed?)`), { reason: "inspect_failed" });
  const listJson = await getJSON(`${ANIKOTO}/ajax/episode/list/${showId}`, {
    "X-Requested-With": "XMLHttpRequest",
    Referer: `${ANIKOTO}/watch/${candidate.slug}`,
  });
  const episodes = parseEpisodeRows(listJson.result || "");
  if (!episodes.length) throw Object.assign(new Error(`episode list for ${candidate.slug} (show ${showId}) had no parsable rows (endpoint or attributes changed?)`), { reason: "inspect_failed" });
  return { ...candidate, showId, episodes };
}

async function searchAllKeywords(keywords) {
  const diag = { base: ANIKOTO, attempts: 0, ok: 0, failed: 0, empty: 0, blocked: 0, firstError: null, sampleTitle: null, sampleBytes: 0 };
  const found = new Map();
  for (let index = 0; index < keywords.length; index += 4) {
    const results = await Promise.all(keywords.slice(index, index + 4).map((keyword) =>
      searchAnikoto(keyword, diag).catch((error) => {
        diag.failed++;
        if (error.reason === "blocked") diag.blocked++;
        diag.firstError = diag.firstError || error;
        return [];
      })));
    for (const list of results) for (const candidate of list) found.set(candidate.slug, candidate);
  }
  return { found, diag };
}

// Turns "nothing found" into something you can act on (the old code swallowed every search error).
function explainNoCandidates(attempts, scored) {
  let reason = "title_mismatch";
  const parts = attempts.map((d) => {
    const partial = d.failed && d.failed < d.attempts ? ` (${d.failed}/${d.attempts} searches failed)` : "";
    if (d.attempts && d.failed === d.attempts) {
      reason = d.blocked ? "blocked" : (d.firstError?.reason || "unreachable");
      return `${d.base}: all ${d.attempts} searches failed - ${d.blocked ? "BLOCKED (Cloudflare / bot protection)" : "site unreachable or erroring"}: ${d.firstError?.message}`;
    }
    if (!scored.length) {
      reason = d.blocked ? "blocked" : "no_results";
      return `${d.base}: site answered but no title links were found in any result page (page title "${d.sampleTitle ?? ""}", ${d.sampleBytes} bytes) - challenge page, empty results, or the site's markup/domain changed${partial}`;
    }
    const top = [...scored].sort((a, b) => b.titleScore - a.titleScore).slice(0, 3)
      .map((c) => `"${c.name}" (${c.titleScore.toFixed(2)})`).join(", ");
    return `${d.base}: ${scored.length} result(s) found but none similar enough to the AniList titles; closest: ${top}${partial}`;
  });
  return { reason, text: parts.join(" | ") };
}

async function findAnikotoShow(media, anizip) {
  const mappings = anizip ?? await getJSON(`${ANIZIP}?anilist_id=${media.id}`).catch(() => null);
  const titles = [...new Set(buildTitles(media, mappings).filter(Boolean))];
  const keywords = buildTitleSearchQueries(titles, 18);

  // Try the current base first, then any failover bases from ANIKOTO_BASES. The one that works sticks.
  const bases = [ANIKOTO, ...ANIKOTO_BASES.filter((base) => base !== ANIKOTO)];
  const attempts = [];
  let allCandidatesMap = new Map();
  for (const base of bases) {
    ANIKOTO = base;
    const { found, diag } = await searchAllKeywords(keywords);
    attempts.push(diag);
    allCandidatesMap = found;
    if (found.size) break;
  }
  if (!allCandidatesMap.size) ANIKOTO = bases[0];

  const scored = [...allCandidatesMap.values()].map((candidate) => {
    const titleScore = titleIdentityScore(titles, [candidate.name, candidate.jp, candidate.slug.replace(/-/g, " ")]);
    return { ...candidate, titleScore, legacyScore: scoreCandidate(candidate, media.title?.english, media.title?.romaji, media.synonyms || []) };
  });
  const candidates = scored.filter((candidate) => candidate.titleScore >= 0.28)
    .sort((left, right) => right.titleScore - left.titleScore || right.legacyScore - left.legacyScore)
    .slice(0, 12);

  if (!candidates.length) {
    const why = explainNoCandidates(attempts, scored);
    const err = new Error(`No confident Anikoto title candidates for AniList ${media.id} [${why.reason}] ${why.text}`);
    err.reason = why.reason;
    throw err;
  }
  const inspected = [];
  const inspectErrors = [];
  for (let index = 0; index < candidates.length; index += 4) {
    const batch = await Promise.allSettled(candidates.slice(index, index + 4).map(inspectAnikotoCandidate));
    for (const result of batch) {
      if (result.status === "fulfilled" && result.value) inspected.push(result.value);
      else if (result.status === "rejected") inspectErrors.push(result.reason);
    }
  }
  if (!inspected.length) {
    const first = inspectErrors[0];
    const err = new Error(`No confident Anikoto identity match for AniList ${media.id} [${first?.reason === "blocked" ? "blocked" : "inspect_failed"}] ${inspectErrors.length}/${candidates.length} candidate pages could not be read - first error: ${first?.message ?? "unknown"} (base ${ANIKOTO})`);
    err.reason = first?.reason === "blocked" ? "blocked" : "inspect_failed";
    throw err;
  }

  const expectedMal = Number(media.idMal) || null;
  if (expectedMal) {
    const exact = inspected.filter((candidate) => candidate.episodes.some((episode) => episode.malId === expectedMal));
    if (exact.length) {
      const expectedEpisodes = Number(media.episodes) > 0 ? Number(media.episodes) : null;
      const getMatchMetrics = (candidate) => {
        const rows = candidate.episodes.filter((episode) => episode.malId === expectedMal);
        const numbers = new Set(rows.map((episode) => episode.number));
        const expectedRange = expectedEpisodes
          ? new Set(rows.map((episode) => episode.number).filter((number) => number >= 1 && number <= expectedEpisodes)).size
          : 0;
        return {
          completeRange: expectedEpisodes !== null && expectedRange === expectedEpisodes,
          exactCount: expectedEpisodes !== null && numbers.size === expectedEpisodes,
          expectedRange,
          excess: expectedEpisodes === null ? 0 : Math.max(0, numbers.size - expectedEpisodes),
        };
      };
      exact.sort((left, right) => {
        const leftMetrics = getMatchMetrics(left);
        const rightMetrics = getMatchMetrics(right);
        return Number(rightMetrics.completeRange) - Number(leftMetrics.completeRange)
          || Number(rightMetrics.exactCount) - Number(leftMetrics.exactCount)
          || rightMetrics.expectedRange - leftMetrics.expectedRange
          || leftMetrics.excess - rightMetrics.excess
          || right.titleScore - left.titleScore;
      });
      const chosen = exact[0];
      const episodes = chosen.episodes.filter((episode) => episode.malId === expectedMal);
      const numbers = new Set(episodes.map((episode) => episode.number));
      for (const candidate of exact.slice(1)) {
        const rows = candidate.episodes.filter((episode) => episode.malId === expectedMal);
        if (!rows.length || rows.some((episode) => numbers.has(episode.number))) continue;
        for (const episode of rows) {
          numbers.add(episode.number);
          episodes.push(episode);
        }
      }
      episodes.sort((left, right) => left.number - right.number);
      if (expectedEpisodes && episodes.length > expectedEpisodes) {
        const expectedRange = new Map();
        for (const episode of episodes) {
          if (episode.number >= 1 && episode.number <= expectedEpisodes && !expectedRange.has(episode.number)) {
            expectedRange.set(episode.number, episode);
          }
        }
        if (expectedRange.size === expectedEpisodes) {
          episodes.splice(0, episodes.length, ...[...expectedRange.values()].sort((left, right) => left.number - right.number));
        }
      }
      return { ...chosen, title: chosen.name, episodes, malId: expectedMal };
    }
  }

  const viable = inspected.filter((candidate) => {
    const hasProviderMal = candidate.episodes.some((episode) => episode.malId);
    return candidate.titleScore >= 0.72 && (!expectedMal || !hasProviderMal);
  }).sort((left, right) => right.titleScore - left.titleScore || right.legacyScore - left.legacyScore);
  const chosen = viable[0];
  const runnerUp = viable[1];
  if (!chosen || runnerUp && chosen.titleScore - runnerUp.titleScore < 0.08) {
    const why = !chosen
      ? `${inspected.length} page(s) read but none usable: ` + inspected.slice(0, 3).map((c) =>
          `"${c.name}" (title ${c.titleScore.toFixed(2)}, ${c.episodes.some((e) => e.malId) ? `has MAL ids but none equal ${expectedMal}` : "no MAL ids"})`).join(", ")
      : `two near-identical matches: "${chosen.name}" (${chosen.titleScore.toFixed(2)}) vs "${runnerUp.name}" (${runnerUp.titleScore.toFixed(2)})`;
    const reason = !chosen ? "no_viable_match" : "ambiguous";
    const err = new Error(`No confident Anikoto identity match for AniList ${media.id} [${reason}] ${why}`);
    err.reason = reason;
    throw err;
  }
  return { ...chosen, title: chosen.name, malId: expectedMal };
}

// Resolving a show costs up to ~40 upstream requests (18 searches + 2 per candidate). Doing that for every
// episode click is what gets an IP rate-limited, so remember the result for a while.
const SHOW_CACHE = new Map();
const SHOW_INFLIGHT = new Map();
const SHOW_TTL_AIRING = 5 * 60_000;
const SHOW_TTL_DONE = 60 * 60_000;

async function resolveShow(media, anizip, { fresh = false } = {}) {
  const key = Number(media.id);
  if (fresh) {
    SHOW_CACHE.delete(key);
  } else {
    const hit = SHOW_CACHE.get(key);
    if (hit && Date.now() - hit.at < hit.ttl) return { show: hit.show, fromCache: true, ageMs: Date.now() - hit.at };
    if (SHOW_INFLIGHT.has(key)) return { show: await SHOW_INFLIGHT.get(key), fromCache: false, ageMs: 0 };
  }
  const promise = findAnikotoShow(media, anizip).then((show) => {
    if (SHOW_CACHE.size >= 200) SHOW_CACHE.delete(SHOW_CACHE.keys().next().value);
    SHOW_CACHE.set(key, { show, at: Date.now(), ttl: media.status === "FINISHED" ? SHOW_TTL_DONE : SHOW_TTL_AIRING });
    return show;
  }).finally(() => { if (SHOW_INFLIGHT.get(key) === promise) SHOW_INFLIGHT.delete(key); });
  SHOW_INFLIGHT.set(key, promise);
  return { show: await promise, fromCache: false, ageMs: 0 };
}

function mapTrack(t, source) {
  const label = t.label ?? "";
  const langKey = label.toLowerCase().split(" ")[0];
  return {
    url: t.file,
    label: label || "English",
    srclang: LANG_MAP[langKey] ?? "en",
    default: t.default ?? false,
    source
  };
}

function streamRank(stream) {
  if (stream.type === "hls" && stream.variant === "modern") return 0;
  if (stream.type === "hls") return 1;
  return 2;
}

function subtitleTypeFromServerType(typeName) {
  if (typeName === "hsub") return "hardsub";
  if (typeName === "sub") return "softsub";
  return null;
}

async function extractEmbedSource(embedUrl) {
  try {
    return await extractMegaPlayDetails(embedUrl, { userAgent: UA, referer: SPOOF_REF });
  } catch (e) {
    return null;
  }
}

export async function getEpisodes(anilistId, ctx = {}) {
  const media = ctx.media || await getMedia(anilistId);
  if (!media) throw new Error(`Could not resolve media for AniList ID: ${anilistId}`);

  const anizipRes = ctx.anizip ?? await getJSON(`${ANIZIP}?anilist_id=${anilistId}`).catch(() => null);
  const { show } = await resolveShow(media, anizipRes);
  const sub = [];
  const dub = [];
  for (const row of show.episodes) {
    const num = row.number;
    const azEp = anizipRes?.episodes?.[String(num)] ?? {};
    const img = azEp.image || null;
    const desc = azEp.overview || azEp.summary || null;
    const airDate = azEp.airDate || azEp.airdate || null;

    const base = {
      number: num,
      title: row.title,
      duration: null,
      filler: false,
      uncensored: false,
      description: desc,
      image: img,
      airDate: airDate
    };

    if (row.hasSub) {
      sub.push({
        id: `watch/anikoto/${anilistId}/sub/anikoto-${num}`,
        ...base,
        audio: "sub"
      });
    }
    if (row.hasDub) {
      dub.push({
        id: `watch/anikoto/${anilistId}/dub/anikoto-${num}`,
        ...base,
        audio: "dub"
      });
    }
  }

  sub.sort((a, b) => a.number - b.number);
  dub.sort((a, b) => a.number - b.number);

  return {
    meta: {
      title: show.title,
      slug: show.slug,
      malId: show.malId,
      source: "anikoto"
    },
    episodes: { sub, dub }
  };
}

async function handleWatch(anilistId, audio, epNum, ctx = {}) {
  if (audio !== "sub" && audio !== "dub") {
    return jsonResponse({ error: "audio must be sub or dub" }, 400);
  }

  const media = ctx.media || await getMedia(anilistId);
  if (!media) {
    return jsonResponse({ error: `Could not resolve media for AniList ID: ${anilistId}` }, 400);
  }

  const findEp = (list) => list.episodes.find((episode) => episode.number === Number(epNum) && episode[audio === "sub" ? "hasSub" : "hasDub"]);
  let { show, fromCache, ageMs } = await resolveShow(media, ctx.anizip);
  let targetEp = findEp(show);
  if (!targetEp?.ids && fromCache && ageMs > 30_000) {
    // the cached episode list may predate a new release - re-resolve once before giving up
    // (the 30s floor stops a request for a non-existent episode from forcing a refresh every time)
    ({ show } = await resolveShow(media, ctx.anizip, { fresh: true }));
    targetEp = findEp(show);
  }

  if (!targetEp?.ids) {
    return jsonResponse({ error: `Episode ${epNum} not found for show: ${show.title}` }, 404);
  }

  const malIdNum = targetEp.malId || media.idMal || null;

  const [serverDataRes, mapperRes] = await Promise.allSettled([
    getJSON(`${ANIKOTO}/ajax/server/list?servers=${encodeURIComponent(targetEp.ids)}`, {
      "X-Requested-With": "XMLHttpRequest",
      Referer: `${ANIKOTO}/`
    }),
    (targetEp.malId && targetEp.slug && targetEp.timestamp)
      ? getJSON(`${MAPPER}/${targetEp.malId}/${targetEp.slug}/${targetEp.timestamp}`, { Referer: `${ANIKOTO}/` })
      : Promise.resolve(null)
  ]);

  const serverData = serverDataRes.status === "fulfilled" ? serverDataRes.value : null;
  const mapperData = mapperRes.status === "fulfilled" ? mapperRes.value : null;

  const serverHtml = serverData?.result || "";
  const serverItems = [];
  const downloadItems = [];

  const typeRe = /<div class="type" data-type="([^"]+)">([\s\S]*?)<\/ul>\s*<\/div>/g;
  let typeM;
  while ((typeM = typeRe.exec(serverHtml)) !== null) {
    const typeName = typeM[1];
    for (const li of typeM[2].matchAll(/<li\s+([^>]*data-link-id[^>]*)>([\s\S]*?)<\/li>/g)) {
      const linkId = li[1].match(/data-link-id="([^"]+)"/)?.[1];
      const name = li[2].replace(/<[^>]+>/g, "").trim();
      if (!linkId) continue;

      if (typeName === "dl" || name.toLowerCase().includes("download") || name.toLowerCase().includes("kiwi")) {
        downloadItems.push({ linkId, name });
      } else if (typeName === audio || (audio === "sub" && typeName === "hsub")) {
        serverItems.push({ linkId, name, serverType: typeName, subtitleType: subtitleTypeFromServerType(typeName) });
      }
    }
  }

  if (mapperData) {
    for (const [sKey, sObj] of Object.entries(mapperData)) {
      if (sKey === "status") continue;
      const cleanName = sKey.replace(/[-_]+$/, "").trim();
      if (sObj?.[audio]?.url) {
        serverItems.push({
          linkId: sObj[audio].url,
          name: cleanName,
          serverType: audio,
          subtitleType: subtitleTypeFromServerType(audio)
        });
      }
      if (sObj?.[audio]?.download) {
        for (const [dLabel, dUrl] of Object.entries(sObj[audio].download)) {
          if (dUrl && typeof dUrl === "string") {
            downloadItems.push({ url: dUrl, name: cleanName });
          }
        }
      }
    }
  }

  const streams = [];
  const subtitles = [];
  const downloads = [];

  const serverSeen = new Set();
  const subSeen = new Set();
  const dlSeen = new Set();

  for (const item of serverItems) {
    const serverKey = `${item.name}:${item.subtitleType || item.serverType || audio}`;
    if (serverSeen.has(serverKey)) continue;
    serverSeen.add(serverKey);

    const resolved = item.linkId.startsWith("http")
      ? { result: { url: item.linkId } }
      : await getJSON(`${ANIKOTO}/ajax/server?get=${encodeURIComponent(item.linkId)}`, {
          "X-Requested-With": "XMLHttpRequest",
          Referer: `${ANIKOTO}/`
        }).catch(() => null);

    const embedUrl = resolved?.result?.url;
    if (!embedUrl) continue;

    let serverIntro = { start: 0, end: 0 };
    let serverOutro = { start: 0, end: 0 };

    if (resolved?.result?.skip_data?.intro?.length === 2) {
      const [s, e] = resolved.result.skip_data.intro;
      if (s || e) serverIntro = { start: Number(s) || 0, end: Number(e) || 0 };
    }
    if (resolved?.result?.skip_data?.outro?.length === 2) {
      const [s, e] = resolved.result.skip_data.outro;
      if (s || e) serverOutro = { start: Number(s) || 0, end: Number(e) || 0 };
    }

    const hlsSources = [];

    if (embedUrl.includes("#aHR0c")) {
      const b64 = embedUrl.split("#")[1];
      try {
        const decodedUrl = atob(b64);
        if (decodedUrl.includes(".m3u8")) {
          hlsSources.push({ url: decodedUrl, variant: null });
        }
      } catch (e) {}
    }

    const extracted = await extractEmbedSource(embedUrl);
    const itemSubs = [];

    if (extracted?.sources?.length) {
      for (const source of extracted.sources) {
        if (!hlsSources.some((item) => item.url === source.url)) hlsSources.push(source);
      }

      for (const t of extracted.tracks ?? []) {
        const mapped = mapTrack(t, item.name);
        itemSubs.push(mapped);
        if (!subSeen.has(mapped.url)) {
          subSeen.add(mapped.url);
          subtitles.push(mapped);
        }
      }

      if (extracted.intro?.start || extracted.intro?.end) {
        serverIntro = { start: Number(extracted.intro.start) || 0, end: Number(extracted.intro.end) || 0 };
      }
      if (extracted.outro?.start || extracted.outro?.end) {
        serverOutro = { start: Number(extracted.outro.start) || 0, end: Number(extracted.outro.end) || 0 };
      }
    }

    if (hlsSources.length) {
      for (const source of hlsSources) {
        const streamObj = {
          url: source.url,
          type: "hls",
          server: item.name,
          embedUrl,
          referer: extracted?.origin ? `${extracted.origin}/` : `${new URL(embedUrl).origin}/`,
          subtitles: itemSubs,
          priority: streams.length ? 4 : 5,
          isActive: streams.length === 0
        };
        if (item.subtitleType) streamObj.subtitleType = item.subtitleType;
        if (source.variant) streamObj.variant = source.variant;
        if (serverIntro.start || serverIntro.end) streamObj.intro = serverIntro;
        if (serverOutro.start || serverOutro.end) streamObj.outro = serverOutro;
        streams.push(streamObj);
      }
      streams.push({
        url: embedUrl,
        type: "embed",
        server: item.name,
        referer: `${new URL(embedUrl).origin}/`,
        priority: 4,
        isActive: false
      });
      if (item.subtitleType) streams[streams.length - 1].subtitleType = item.subtitleType;
    } else {
      const streamObj = {
        url: embedUrl,
        type: "embed",
        server: item.name,
        referer: `${new URL(embedUrl).origin}/`,
        priority: 4,
        isActive: streams.length === 0
      };
      if (item.subtitleType) streamObj.subtitleType = item.subtitleType;
      if (serverIntro.start || serverIntro.end) streamObj.intro = serverIntro;
      if (serverOutro.start || serverOutro.end) streamObj.outro = serverOutro;
      streams.push(streamObj);
    }
  }

  for (const dl of downloadItems) {
    let dlUrl = dl.url;
    if (!dlUrl && dl.linkId) {
      const resolved = await getJSON(`${ANIKOTO}/ajax/server?get=${encodeURIComponent(dl.linkId)}`, {
        "X-Requested-With": "XMLHttpRequest",
        Referer: `${ANIKOTO}/`
      }).catch(() => null);
      dlUrl = resolved?.result?.url;
    }

    if (dlUrl && !dlSeen.has(dlUrl)) {
      dlSeen.add(dlUrl);
      downloads.push({
        url: dlUrl,
        label: dl.name
      });
    }
  }

  streams.sort((left, right) => streamRank(left) - streamRank(right));
  streams.forEach((stream, index) => {
    stream.priority = index === 0 ? 5 : 4;
    stream.isActive = index === 0;
  });

  return jsonResponse({
    anilistId: parseInt(anilistId),
    malId: malIdNum,
    episode: epNum,
    audio,
    streams,
    subtitles,
    downloads,
    headers: {
      "User-Agent": UA,
      "Referer": streams[0]?.referer || `${ANIKOTO}/`
    }
  });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,OPTIONS",
          "Access-Control-Allow-Headers": "*"
        }
      });
    }
    try {
      let m = path.match(/^\/watch\/anikoto\/(\d+)\/(sub|dub)\/anikoto-(\d+)\/?$/);
      if (m) return await handleWatch(m[1], m[2], parseInt(m[3]));

      m = path.match(/^\/episodes\/anikoto\/(\d+)\/?$/);
      if (m) {
        const data = await getEpisodes(parseInt(m[1]));
        return jsonResponse(data);
      }
      return jsonResponse({ error: "Not found" }, 404);
    } catch (err) {
      return jsonResponse({ error: err.message, reason: err.reason ?? null, stack: err.stack }, 500);
    }
  }
};
