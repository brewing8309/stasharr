/*
 * Pure text, matching and scoring helpers: no DOM, no browser.* APIs.
 * Loaded ahead of content.js and background.js (see manifest.json) and
 * required directly by the tests in tests/.
 */

// Shared values use `var`/`function` so they land on the global that the
// scripts loaded after this one read from.

// Some releases are named by date instead of studio, e.g. "26.09.10" for
// 2026-09-10. StashDB dates come as "YYYY-MM-DD"; take the last two digits
// of the year to match that convention.
function formatDateYYMMDD(dateStr) {
  const m = String(dateStr || "").match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1].slice(2)}.${m[2]}.${m[3]}` : "";
}

// Strips parenthetical asides ("(Part 2)") and punctuation from a scene
// title before it's used as a search term — most Torznab searches treat the
// query as required tokens, so stray punctuation/asides just narrow the
// search for no benefit. Scoring isn't affected: it already normalizes.
function cleanTitle(title) {
  return String(title || "")
    .replace(/[([{][^)\]}]*[)\]}]/g, " ")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Folds accents ("Zoë" → "zoe", release names rarely keep them) and drops
// everything but letters and digits. Non-Latin scripts stay, so a Japanese
// studio name doesn't normalize to "".
function normalizeForMatch(s) {
  return foldText(s).replace(/[^\p{L}\p{N}]+/gu, "");
}

function foldText(s) {
  return String(s || "").normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase().replace(/ß/g, "ss");
}

// An empty needle is in every string, so a name that normalizes to nothing
// must never count as a match.
function hayHas(hay, name) {
  const needle = normalizeForMatch(name);
  return needle !== "" && hay.includes(needle);
}

function releaseHay(release) {
  return normalizeForMatch(`${release.title || ""} ${release.sortTitle || ""}`);
}

// Merges Prowlarr result arrays from multiple parallel queries into one
// list, de-duplicated by release guid (falling back to indexer+title for
// any release missing one, which shouldn't normally happen).
function mergeResults(resultArrays) {
  const seen = new Set();
  const merged = [];
  for (const results of resultArrays) {
    for (const r of results) {
      const key = r.guid || `${r.indexer}|${r.title}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(r);
    }
  }
  return merged;
}

/* ------------------------------------------------------------------ *
 * Scoring and sorting                                                 *
 * ------------------------------------------------------------------ */

// Rank: 2160p first, then 1080p, then 720p, then everything else.
var RES_ORDER = ["2160p", "1080p", "720p"];

function resolutionOf(release) {
  const hay = `${release.title || ""} ${release.sortTitle || ""}`;
  if (/\b(2160p|4k|uhd)\b/i.test(hay)) return "2160p";
  if (/\b1080p\b/i.test(hay)) return "1080p";
  if (/\b720p\b/i.test(hay)) return "720p";
  const m = hay.match(/\b(\d{3,4})p\b/i);
  return m ? m[1].toLowerCase() + "p" : "other";
}

// Normalized names that identify one performer in a release title. Her
// primary name and the name she's credited as in this scene always count;
// other aliases only if multi-word or 6+ characters, since a short alias
// like "Mia" would substring-match unrelated releases.
function performerNameSet(name, credited, aliases) {
  const keys = [];
  const add = (n) => {
    const k = normalizeForMatch(n);
    if (k && !keys.includes(k)) keys.push(k);
  };
  add(name);
  add(credited);
  for (const a of aliases || []) {
    if (a && (/\s/.test(a.trim()) || normalizeForMatch(a).length >= 6)) add(a);
  }
  return keys;
}

// How many of the scene's female performers a release names.
function countPerformers(hay, scene) {
  return scene.femaleNameSets.filter((keys) => keys.some((k) => hay.includes(k))).length;
}

function matchesDate(hay, scene) {
  const iso = String(scene.date || "").match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!iso) return false;
  const [, yyyy, mm, dd] = iso;
  return hay.includes(`${yyyy}${mm}${dd}`) || hay.includes(`${yyyy.slice(2)}${mm}${dd}`);
}

var TITLE_STOPWORDS = new Set([
  "with", "from", "that", "this", "your", "into", "have", "when", "what", "they", "them", "then",
  "there", "their", "about", "just", "will", "more", "some", "over", "were", "been", "here"
]);
var TITLE_MIN_OVERLAP = 0.6;

function titleWords(title) {
  const words = foldText(title).split(/[^\p{L}\p{N}]+/u);
  return [...new Set(words.filter((w) => w.length >= 4 && !TITLE_STOPWORDS.has(w)))];
}

// Release names often truncate or reword long titles, so besides the whole
// title, enough of its significant words also counts as a match.
function matchesTitle(hay, scene) {
  const whole = normalizeForMatch(scene.title);
  if (!whole) return false;
  if (hay.includes(whole)) return true;
  const words = titleWords(scene.title);
  return words.length > 0 && words.filter((w) => hay.includes(w)).length / words.length >= TITLE_MIN_OVERLAP;
}

// The 5 fixed criteria a release is judged against. "Performer" matches if
// ANY female performer (or one of her names) shows up, so the denominator
// stays a constant 5 regardless of cast size; how many of the cast a
// release names only breaks ties (see sortResults).
var CRITERIA = [
  { label: "Studio", test: (hay, scene) => hayHas(hay, scene.studio) },
  { label: "Parent studio", test: (hay, scene) => scene.parentStudio !== scene.studio && hayHas(hay, scene.parentStudio) },
  { label: "Performer", test: (hay, scene) => countPerformers(hay, scene) > 0 },
  { label: "Title", test: matchesTitle },
  { label: "Date", test: matchesDate }
];

// A release must match at least this many of the 5 CRITERIA to be shown —
// the broad queries in runQueryBatch can pull in a lot of noise (e.g.
// every scene of a prolific performer), and this is what filters it back
// out.
var MIN_SCORE = 2;

// Returns which of CRITERIA a release matches, e.g. ["Studio", "Performer",
// "Date"] — used both for the "3/5 hits" line under each result and for the
// MIN_SCORE filter (score = matched.length).
function matchedCriteria(release, scene) {
  const hay = releaseHay(release);
  return CRITERIA.filter((c) => c.test(hay, scene)).map((c) => c.label);
}

function scoreRelease(release, scene) {
  return matchedCriteria(release, scene).length;
}

// Stage 3 ("Last Chance") only — deliberately NOT part of CRITERIA/
// scoreRelease, so it never affects the MIN_SCORE filter or ranking
// anywhere else. Compares a release's Prowlarr publish date against the
// scene's release date; the closer, the more likely it's the right scene.
// Returns days apart, or null if either date is missing/unparseable (some
// torrent indexers don't report a publish date at all) — callers treat
// null as "worst"/unknown rather than crashing or scoring it as a match.
function ageDistanceDays(release, scene) {
  const sceneTime = Date.parse(scene.date || "");
  const releaseTime = Date.parse(release.publishDate || "");
  if (Number.isNaN(sceneTime) || Number.isNaN(releaseTime)) return null;
  return Math.abs(releaseTime - sceneTime) / 86400000;
}

function ageLabel(release, scene) {
  const days = ageDistanceDays(release, scene);
  return days === null ? "publish date unknown" : `${Math.round(days)}d from scene date`;
}

// Closest publish date first; releases with no usable date sort last.
function sortByAgeProximity(results, scene) {
  return results.slice().sort((a, b) => {
    const da = ageDistanceDays(a, scene);
    const db = ageDistanceDays(b, scene);
    if (da === null && db === null) return 0;
    if (da === null) return 1;
    if (db === null) return -1;
    return da - db;
  });
}

// Resolution first; within a resolution, more matched criteria, then more
// of the cast named, then more seeders/grabs.
function sortResults(results, scene) {
  const rankOf = (r) => {
    const idx = RES_ORDER.indexOf(resolutionOf(r));
    return idx === -1 ? RES_ORDER.length : idx;
  };
  return results
    .map((r) => {
      const hay = releaseHay(r);
      return {
        r,
        rank: rankOf(r),
        score: CRITERIA.filter((c) => c.test(hay, scene)).length,
        cast: countPerformers(hay, scene),
        seeds: r.seeders ?? r.grabs ?? 0
      };
    })
    .sort((a, b) => a.rank - b.rank || b.score - a.score || b.cast - a.cast || b.seeds - a.seeds)
    .map((x) => x.r);
}

// How long a release sent to Prowlarr keeps showing "✓ Sent".
var GRABBED_MAX_AGE_MS = 90 * 86400000;

// Returns a copy of a { guid: sentAt } map without entries older than maxAgeMs.
function pruneGrabbed(grabbed, now, maxAgeMs) {
  return Object.fromEntries(Object.entries(grabbed || {}).filter(([, at]) => now - at < maxAgeMs));
}

/* ------------------------------------------------------------------ *
 * Right-click selection search                                        *
 * ------------------------------------------------------------------ */

// Selected text on an arbitrary page can be a torrent-style filename
// ("Studio.Performer.Name.26.09.10.XXX.1080p.mp4"), a loosely structured
// line ("[Studio] Performer - Scene Title"), or just plain free text with
// no structure at all. Rather than trying to parse any of these into
// separate studio/performer/title fields (fragile across formats), this
// just normalizes everything into a flat, punctuation-free search phrase
// and lets StashDB's own fuzzy search rank it.
var SELECTION_NOISE_RE = /\b(1080p|720p|2160p|4k|uhd|hd|sd|x264|x265|h264|h265|hevc|avc|xvid|web ?dl|webrip|hdtv|dvdrip|bluray|brrip|xxx|nfo|proof|repack|internal|multisub|complete)\b/gi;

function cleanSelectionText(text) {
  return String(text || "")
    .slice(0, 200)
    // File extension, if this is actually a filename.
    .replace(/\.(mp4|mkv|avi|wmv|mov|m4v|ts|m2ts|flv)$/i, "")
    // Dots/underscores/hyphens/brackets/pipes are all used as separators
    // across these formats — normalize them all to spaces instead of
    // guessing which punctuation style is "real". This has to run before
    // the noise-token strip below so a hyphen-glued release-group tag
    // (e.g. "x264-GROUP") splits into separate words first, rather than
    // leaving a dangling "-GROUP" once "x264" alone is stripped out.
    .replace(/[-._|[\](){}]+/g, " ")
    .replace(SELECTION_NOISE_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    formatDateYYMMDD, cleanTitle, normalizeForMatch, foldText, hayHas, releaseHay, mergeResults,
    RES_ORDER, resolutionOf, performerNameSet, countPerformers, matchesDate,
    titleWords, matchesTitle, CRITERIA, MIN_SCORE,
    matchedCriteria, scoreRelease, ageDistanceDays, ageLabel, sortByAgeProximity,
    sortResults, GRABBED_MAX_AGE_MS, pruneGrabbed, cleanSelectionText
  };
}
