/*
 * Content script injected on stashdb.org.
 *
 * Shows a "Search Prowlarr" button only on scene pages. On click it resolves
 * the studio + female performers + date (via StashDB's GraphQL API, with a
 * DOM fallback), searches Prowlarr, and renders resolution-sorted results
 * with a per-release download button.
 *
 * The initial search runs 5 broad queries in parallel (performers+studio+
 * date, performers+date, performers+studio, studio+date, title — see
 * BROAD_QUERIES), merges and de-duplicates the results by guid, and keeps
 * only releases matching at least MIN_SCORE of the scene's known criteria
 * (studio, parent studio, each performer/alias, title, date — see
 * scoreRelease). This avoids guessing which single AND-heavy query an
 * indexer will match, at the cost of more Prowlarr requests up front.
 *
 * Narrower alias/parent-studio combinations (see QUERY_STEPS) aren't run
 * automatically — a "Try Harder" button in the results panel steps through
 * them one at a time, for scenes the broad pass didn't find.
 *
 * If a StashApp instance is configured, it also checks (via the background
 * script) whether the scene is already in that library and shows a badge
 * with its resolution and a link, above the search button.
 */

const SCENE_RE = /^\/scenes\/([0-9a-f-]{36})/i;
const FEMALE_GENDERS = new Set(["FEMALE", "TRANSGENDER_FEMALE"]);

/* ------------------------------------------------------------------ *
 * Scene detection + button lifecycle (StashDB is a client-side SPA)   *
 * ------------------------------------------------------------------ */

function currentSceneId() {
  const m = location.pathname.match(SCENE_RE);
  return m ? m[1] : null;
}

let lastPath = null;

function syncButton() {
  if (location.pathname === lastPath) return;
  lastPath = location.pathname;

  const existing = document.getElementById("sdp-button");
  const sceneId = currentSceneId();
  if (sceneId) {
    if (!existing) injectButton(sceneId);
  } else if (existing) {
    existing.remove();
    hideStashBadge();
    closePanel();
  }
}

// Poll for SPA navigation changes and re-evaluate whether to show the button.
setInterval(syncButton, 600);
syncButton();

function injectButton(sceneId) {
  const btn = document.createElement("button");
  btn.id = "sdp-button";
  btn.type = "button";
  btn.textContent = "⬇ Search Prowlarr";
  btn.addEventListener("click", onSearchClick);
  document.body.appendChild(btn);

  checkStashApp(sceneId).then((scene) => {
    // The user may have navigated away while the lookup was in flight.
    if (scene && currentSceneId() === sceneId) showStashBadge(scene);
  });
}

/* ------------------------------------------------------------------ *
 * Scene data extraction                                               *
 * ------------------------------------------------------------------ */

async function fetchSceneViaGraphQL(sceneId) {
  const query = `query Scene($id: ID!) {
    findScene(id: $id) {
      title
      date
      studio { name parent { name } }
      performers { performer { name gender aliases } }
    }
  }`;
  const url = new URL("/graphql", location.origin).href;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ query, variables: { id: sceneId } })
  });
  if (!res.ok) throw new Error("GraphQL HTTP " + res.status);
  const json = await res.json();
  if (json.errors && json.errors.length) throw new Error(json.errors[0].message);
  const scene = json.data && json.data.findScene;
  if (!scene) throw new Error("Scene not found");

  const studio = scene.studio ? scene.studio.name : "";
  const parentStudio = scene.studio && scene.studio.parent ? scene.studio.parent.name : "";
  const femalePerformers = (scene.performers || [])
    .map((p) => p.performer)
    .filter((p) => p && FEMALE_GENDERS.has(p.gender));
  const females = femalePerformers.map((p) => p.name);
  // One alias per performer (their first listed one) is enough to give the
  // search cascade an alternate name to try — not every alias.
  const femaleAliasNames = femalePerformers.map((p) => (p.aliases && p.aliases[0]) || p.name);
  return { studio, parentStudio, females, femaleAliasNames, title: scene.title, date: scene.date || "" };
}

// DOM fallback: parse the rendered scene page. StashDB renders each performer
// as `<a href="/performers/<id>"><svg><title>Female</title></svg><span>Name</span></a>`.
// The gender word lives ONLY in the icon's <svg><title> (not visible layout
// text), and the name lives in the sibling <span>. Read each anchor's own icon
// title and name rather than substring-matching the shared performers
// container, whose textContent glues every gender word onto the next name.
const FEMALE_LABELS = new Set(["female", "transfemale"]);

// No single reliable selector for the scene date across StashDB's markup, so
// try progressively looser sources: structured data, a <time> element, then
// a bare ISO date anywhere in the page text.
function extractDateFromDOM() {
  for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const data = JSON.parse(el.textContent);
      for (const item of Array.isArray(data) ? data : [data]) {
        if (item && item.datePublished) return item.datePublished;
      }
    } catch (e) { /* malformed/unrelated JSON-LD block, skip it */ }
  }
  const time = document.querySelector("time[datetime]");
  if (time) return time.getAttribute("datetime");
  const m = document.body.textContent.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  return m ? m[0] : "";
}

function fetchSceneViaDOM() {
  const studioLink = document.querySelector('a[href^="/studios/"]');
  const studio = studioLink ? studioLink.textContent.trim() : "";

  const females = [];
  document.querySelectorAll('a[href^="/performers/"]').forEach((a) => {
    const gender = (a.querySelector("svg title")?.textContent || "").trim().toLowerCase();
    if (!FEMALE_LABELS.has(gender)) return;
    // Name is the visible text; the anchor's textContent would also include
    // the (non-rendered) gender word from the icon <title>, so read the span.
    const nameEl = a.querySelector("span");
    const name = (nameEl ? nameEl.textContent : a.textContent).trim();
    if (name && !females.includes(name)) females.push(name);
  });
  // No aliases or parent studio available from the rendered page — the
  // alias/parent search steps will just no-op (identical to the primary
  // studio/name steps) rather than add anything here.
  return { studio, parentStudio: "", females, femaleAliasNames: females.slice(), title: document.title, date: extractDateFromDOM() };
}

async function resolveScene(sceneId) {
  try {
    const data = await fetchSceneViaGraphQL(sceneId);
    if (data.studio || data.females.length) return data;
  } catch (e) {
    console.warn("[StashDB→Prowlarr] GraphQL failed, falling back to DOM:", e.message);
  }
  return fetchSceneViaDOM();
}

/* ------------------------------------------------------------------ *
 * StashApp: "already downloaded" badge                                *
 * ------------------------------------------------------------------ */

// Asks the background script whether this StashDB scene already exists in
// the user's own StashApp library. Returns null if it doesn't, Stash isn't
// configured, or the lookup fails for any reason — this is a nice-to-have
// indicator, not worth surfacing an error for.
async function checkStashApp(sceneId) {
  try {
    const resp = await browser.runtime.sendMessage({ type: "checkStash", stashId: sceneId });
    if (!resp || !resp.ok) {
      if (resp && resp.error) console.warn("[StashDB→Prowlarr] Stash lookup failed:", resp.error);
      return null;
    }
    return resp.scene || null;
  } catch (e) {
    console.warn("[StashDB→Prowlarr] Stash lookup failed:", e.message);
    return null;
  }
}

function hideStashBadge() {
  const el = document.getElementById("sdp-stash-badge");
  if (el) el.remove();
}

function showStashBadge(scene) {
  hideStashBadge();
  const badge = document.createElement("div");
  badge.id = "sdp-stash-badge";
  const link = document.createElement("a");
  link.href = scene.url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = `✓ Already in Stash — ${scene.resolution}`;
  badge.appendChild(link);
  document.body.appendChild(badge);
}

// Some releases are named by date instead of studio, e.g. "26.09.10" for
// 2026-09-10. StashDB dates come as "YYYY-MM-DD"; take the last two digits
// of the year to match that convention.
function formatDateYYMMDD(dateStr) {
  const m = String(dateStr || "").match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1].slice(2)}.${m[2]}.${m[3]}` : "";
}

function studioTerm(scene) {
  return (scene.studio || "").replace(/\s+/g, "");
}

function parentStudioTerm(scene) {
  return (scene.parentStudio || "").replace(/\s+/g, "");
}

function femaleAliasTerms(scene) {
  return scene.femaleAliasNames || scene.females;
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

function titleTerm(scene) {
  return cleanTitle(scene.title);
}

function joinTerms(terms) {
  return terms.filter(Boolean).join(" ").trim();
}

// Broad queries run automatically in parallel. Studio is included here now
// (unlike aliases/parent studio, most releases do carry the plain studio
// name), but "performers + date" without it stays in the mix as a safety
// net for releases that don't. Their results are merged, deduped and scored
// — see runBroadSearch.
const BROAD_QUERIES = [
  {
    label: "performers + studio + date",
    build: (scene) => joinTerms([...scene.females, studioTerm(scene), formatDateYYMMDD(scene.date)])
  },
  {
    label: "performers + date",
    build: (scene) => joinTerms([...scene.females, formatDateYYMMDD(scene.date)])
  },
  {
    label: "performers + studio",
    build: (scene) => joinTerms([...scene.females, studioTerm(scene)])
  },
  {
    label: "studio + date",
    build: (scene) => joinTerms([studioTerm(scene), formatDateYYMMDD(scene.date)])
  },
  {
    label: "title",
    build: (scene) => joinTerms([titleTerm(scene)])
  }
];

// Narrower alias/parent-studio combinations, only tried one at a time via
// the "Try Harder" button when the broad pass above didn't find enough.
// They're only useful when a performer has an alias or the studio has a
// parent brand — when they don't, advanceSearch's dedup skips the step
// automatically since it'd build an identical query to one already tried
// (by an earlier step here, or one of the broad queries above).
// Term order here matches BROAD_QUERIES (performers, then studio, then
// date) so that a step which turns out identical to a broad query — e.g. a
// performer with no alias makes "performer aliases" the same as her primary
// name — produces the exact same query string and gets deduped correctly,
// instead of just reordered and re-sent to Prowlarr for nothing.
const QUERY_STEPS = [
  {
    label: "studio + performer aliases + date",
    build: (scene) => joinTerms([...femaleAliasTerms(scene), studioTerm(scene), formatDateYYMMDD(scene.date)])
  },
  {
    label: "parent studio + performers + date",
    // Guarded explicitly (not just left to joinTerms) so a missing parent
    // studio skips this step for the right reason, instead of silently
    // becoming a plain "performers + date" query mislabeled as this step.
    build: (scene) => parentStudioTerm(scene)
      ? joinTerms([...scene.females, parentStudioTerm(scene), formatDateYYMMDD(scene.date)])
      : ""
  },
  {
    label: "studio + performer aliases",
    build: (scene) => joinTerms([...femaleAliasTerms(scene), studioTerm(scene)])
  },
  {
    label: "parent studio + performers",
    build: (scene) => parentStudioTerm(scene) ? joinTerms([...scene.females, parentStudioTerm(scene)]) : ""
  },
  {
    label: "performer aliases + date",
    build: (scene) => joinTerms([...femaleAliasTerms(scene), formatDateYYMMDD(scene.date)])
  }
];

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
 * Results sorting                                                     *
 * ------------------------------------------------------------------ */

// Rank: 2160p first, then 1080p, then 720p, then everything else.
const RES_ORDER = ["2160p", "1080p", "720p"];

function resolutionOf(release) {
  const hay = `${release.title || ""} ${release.sortTitle || ""}`;
  if (/\b(2160p|4k|uhd)\b/i.test(hay)) return "2160p";
  if (/\b1080p\b/i.test(hay)) return "1080p";
  if (/\b720p\b/i.test(hay)) return "720p";
  const m = hay.match(/\b(\d{3,4})p\b/i);
  return m ? m[1].toLowerCase() + "p" : "other";
}

function normalizeForMatch(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function matchesAnyPerformer(hay, scene) {
  const aliasNames = scene.femaleAliasNames || [];
  return (scene.females || []).some((name, i) => {
    const alias = aliasNames[i];
    return (name && hay.includes(normalizeForMatch(name))) ||
      (alias && alias !== name && hay.includes(normalizeForMatch(alias)));
  });
}

function matchesDate(hay, scene) {
  const iso = String(scene.date || "").match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!iso) return false;
  const [, yyyy, mm, dd] = iso;
  return hay.includes(`${yyyy}${mm}${dd}`) || hay.includes(`${yyyy.slice(2)}${mm}${dd}`);
}

// The 5 fixed criteria a release is judged against. "Performer" matches if
// ANY female performer (or her alias) shows up — not counted per performer
// — so the denominator stays a constant 5 regardless of cast size.
const CRITERIA = [
  { label: "Studio", test: (hay, scene) => !!(scene.studio && hay.includes(normalizeForMatch(scene.studio))) },
  { label: "Parent studio", test: (hay, scene) => !!(scene.parentStudio && scene.parentStudio !== scene.studio && hay.includes(normalizeForMatch(scene.parentStudio))) },
  { label: "Performer", test: matchesAnyPerformer },
  { label: "Title", test: (hay, scene) => !!(scene.title && hay.includes(normalizeForMatch(scene.title))) },
  { label: "Date", test: matchesDate }
];

// A release must match at least this many of the 5 CRITERIA to be shown —
// the broad queries in runBroadSearch can pull in a lot of noise (e.g.
// every scene of a prolific performer), and this is what filters it back
// out.
const MIN_SCORE = 2;

// Returns which of CRITERIA a release matches, e.g. ["Studio", "Performer",
// "Date"] — used both for the "3/5 hits" line under each result and for the
// MIN_SCORE filter (score = matched.length).
function matchedCriteria(release, scene) {
  const hay = normalizeForMatch(`${release.title || ""} ${release.sortTitle || ""}`);
  return CRITERIA.filter((c) => c.test(hay, scene)).map((c) => c.label);
}

function scoreRelease(release, scene) {
  return matchedCriteria(release, scene).length;
}

function sortResults(results, scene) {
  const rank = (r) => {
    const idx = RES_ORDER.indexOf(resolutionOf(r));
    return idx === -1 ? RES_ORDER.length : idx;
  };
  return results.slice().sort((a, b) => {
    const ra = rank(a), rb = rank(b);
    if (ra !== rb) return ra - rb;
    // Within the same resolution bucket, prefer releases matching more of
    // the scene's search criteria, then more seeders/grabs.
    const sa = scoreRelease(a, scene), sb = scoreRelease(b, scene);
    if (sa !== sb) return sb - sa;
    return (b.seeders ?? b.grabs ?? 0) - (a.seeders ?? a.grabs ?? 0);
  });
}

/* ------------------------------------------------------------------ *
 * UI: results panel                                                   *
 * ------------------------------------------------------------------ */

function closePanel() {
  const p = document.getElementById("sdp-panel");
  if (p) p.remove();
}

function ensurePanel() {
  closePanel();
  const panel = document.createElement("div");
  panel.id = "sdp-panel";
  panel.innerHTML = `
    <div class="sdp-panel-head">
      <span class="sdp-title">StashDB → Prowlarr</span>
      <button type="button" class="sdp-close" title="Close">✕</button>
    </div>
    <details class="sdp-details">
      <summary>Details</summary>
      <div class="sdp-details-body"></div>
    </details>
    <div class="sdp-body"></div>
    <div class="sdp-panel-foot">
      <button type="button" class="sdp-try-harder" hidden>🍆 Try Harder</button>
    </div>`;
  panel.querySelector(".sdp-close").addEventListener("click", closePanel);
  panel.querySelector(".sdp-try-harder").addEventListener("click", onTryHarderClick);
  document.body.appendChild(panel);
  return panel;
}

// Fills the collapsible "Details" section: the scene data behind the
// search, then one collapsible block per query — its summary line always
// shows the query text plus a live status (searching…/failed/N results),
// and expanding it reveals a spinner while running, an error message if it
// failed, or its own (unfiltered) results in the same row style as the main
// list once it's done. `queryStates` is an array of { query, status:
// "pending" | "done" | "error", results?, error?, open? }, so callers can
// re-render this as each query resolves for a live view — `open` (default
// true) is read back from the previous state by callers so a query block
// the user manually collapsed stays collapsed across those re-renders. Once
// everything is known, `counts` adds the aggregate "found / passed filter"
// line for the merged, MIN_SCORE-filtered list shown at the bottom.
function renderDetails(panel, scene, queryStates, counts) {
  const body = panel.querySelector(".sdp-details-body");
  body.innerHTML = "";

  const addRow = (label, value) => {
    const row = document.createElement("div");
    row.className = "sdp-details-row";
    const strong = document.createElement("strong");
    strong.textContent = `${label}: `;
    row.appendChild(strong);
    row.appendChild(document.createTextNode(value));
    body.appendChild(row);
  };

  const sceneBits = [];
  if (scene.studio) sceneBits.push(`Studio: ${scene.studio}`);
  if (scene.parentStudio) sceneBits.push(`Parent studio: ${scene.parentStudio}`);
  if (scene.females && scene.females.length) sceneBits.push(`Performers: ${scene.females.join(", ")}`);
  if (scene.title) sceneBits.push(`Title: ${scene.title}`);
  if (scene.date) sceneBits.push(`Date: ${formatDateYYMMDD(scene.date)}`);
  addRow("Scene", sceneBits.join(" · ") || "(no data)");

  if (!queryStates.length) {
    addRow("Queries", "(none)");
    return;
  }

  for (const qs of queryStates) {
    const block = document.createElement("details");
    block.className = "sdp-details-query";
    block.open = qs.open !== false;
    block.addEventListener("toggle", () => { qs.open = block.open; });

    const summary = document.createElement("summary");
    summary.className = "sdp-details-query-label";
    let status;
    if (qs.status === "pending") status = "searching…";
    else if (qs.status === "error") status = "failed";
    else status = `${qs.results.length} result${qs.results.length === 1 ? "" : "s"}`;
    summary.textContent = `${qs.query} — ${status}`;
    block.appendChild(summary);

    const content = document.createElement("div");
    content.className = "sdp-details-query-body";

    if (qs.status === "pending") {
      content.innerHTML = `<div class="sdp-loading sdp-loading-inline"><span class="sdp-spinner" role="status" aria-label="Searching…"></span></div>`;
    } else if (qs.status === "error") {
      const err = document.createElement("div");
      err.className = "sdp-empty";
      err.textContent = `Failed: ${qs.error}`;
      content.appendChild(err);
    } else if (!qs.results.length) {
      const empty = document.createElement("div");
      empty.className = "sdp-empty";
      empty.textContent = "No releases found.";
      content.appendChild(empty);
    } else {
      for (const r of sortResults(qs.results, scene)) {
        content.appendChild(buildResultRow(r, scene));
      }
    }

    block.appendChild(content);
    body.appendChild(block);
  }

  if (counts) {
    addRow("Results", `${counts.total} found across all queries, ${counts.filtered} passed the ≥ ${MIN_SCORE}/${CRITERIA.length} filter`);
  }
}

function updateTryHarderButton(panel) {
  const btn = panel.querySelector(".sdp-try-harder");
  const state = panel._sdpState;
  btn.hidden = !state || state.stepIndex >= QUERY_STEPS.length - 1;
}

function fmtSize(bytes) {
  if (!bytes || bytes < 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

// Builds one result row (title, meta line with the match-criteria hit
// count, download button) — shared by the main results list and the
// per-query previews in the Details section.
function buildResultRow(r, scene) {
  const row = document.createElement("div");
  row.className = "sdp-row";

  const matched = matchedCriteria(r, scene);
  const meta = [];
  if (r.indexer) meta.push(r.indexer);
  if (typeof r.seeders === "number") meta.push(`${r.seeders} seeders`);
  else if (typeof r.grabs === "number") meta.push(`${r.grabs} grabs`);
  if (r.size) meta.push(fmtSize(r.size));
  if (r.protocol) meta.push(r.protocol);
  meta.push(`${matched.length}/${CRITERIA.length} hits (${matched.join(", ")})`);

  const info = document.createElement("div");
  info.className = "sdp-info";
  info.innerHTML = `<div class="sdp-rel-title"></div><div class="sdp-rel-meta"></div>`;
  info.querySelector(".sdp-rel-title").textContent = r.title || "(untitled release)";
  info.querySelector(".sdp-rel-meta").textContent = meta.join(" · ");

  const dl = document.createElement("button");
  dl.type = "button";
  dl.className = "sdp-dl";
  dl.textContent = "Download";
  dl.addEventListener("click", () => grabRelease(dl, r));

  row.appendChild(info);
  row.appendChild(dl);
  return row;
}

// Renders the result list into `panel` and returns { total, filtered }
// counts (for the Details section).
function renderResults(panel, results, scene) {
  const body = panel.querySelector(".sdp-body");
  body.innerHTML = "";

  if (!results.length) {
    body.innerHTML = `<div class="sdp-empty">No releases found.</div>`;
    return { total: 0, filtered: 0 };
  }

  const filtered = results.filter((r) => scoreRelease(r, scene) >= MIN_SCORE);
  if (!filtered.length) {
    const criteriaList = CRITERIA.map((c) => c.label).join(", ");
    body.innerHTML = `<div class="sdp-empty">Found ${results.length} release(s), but none matched at least ${MIN_SCORE} of the scene's known details (${criteriaList}).</div>`;
    return { total: results.length, filtered: 0 };
  }

  const sorted = sortResults(filtered, scene);
  let lastRes = null;
  for (const r of sorted) {
    const res = resolutionOf(r);
    if (res !== lastRes) {
      lastRes = res;
      const h = document.createElement("div");
      h.className = "sdp-group";
      h.textContent = res === "other" ? "Other" : res;
      body.appendChild(h);
    }
    body.appendChild(buildResultRow(r, scene));
  }

  return { total: results.length, filtered: filtered.length };
}

async function grabRelease(btn, release) {
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = "Sending…";
  try {
    const resp = await browser.runtime.sendMessage({ type: "grab", release });
    if (resp && resp.ok) {
      btn.textContent = "✓ Sent";
      btn.classList.add("sdp-done");
    } else {
      btn.textContent = "Failed";
      btn.classList.add("sdp-error");
      btn.title = (resp && resp.error) || "Grab failed";
      btn.disabled = false;
    }
  } catch (e) {
    btn.textContent = "Failed";
    btn.classList.add("sdp-error");
    btn.title = e.message;
    btn.disabled = false;
  }
}

/* ------------------------------------------------------------------ *
 * Main click handler                                                  *
 * ------------------------------------------------------------------ */

// Sends one query to Prowlarr via the background script. Never throws —
// callers get an { ok, results | error } outcome either way, so a failure
// in one of several parallel searches doesn't reject the whole batch.
async function prowlarrSearch(query) {
  try {
    const resp = await browser.runtime.sendMessage({ type: "search", query });
    if (!resp || !resp.ok) return { ok: false, error: (resp && resp.error) || "unknown error" };
    return { ok: true, results: resp.results };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

const LOADING_HTML = `<div class="sdp-loading"><span class="sdp-spinner" role="status" aria-label="Searching…"></span></div>`;

// Sends `query` to Prowlarr and renders the loading/error state into
// `panel`. Returns { ok: true, results } or { ok: false, message } — never
// throws, and never returns without one or the other, so callers can always
// reflect the outcome in both the body and the Details section.
async function doSearch(panel, query, emptyMessage) {
  const body = panel.querySelector(".sdp-body");
  if (!query) {
    body.innerHTML = `<div class="sdp-empty">${emptyMessage}</div>`;
    return { ok: false, message: emptyMessage };
  }

  body.innerHTML = LOADING_HTML;
  const outcome = await prowlarrSearch(query);
  if (!outcome.ok) {
    body.innerHTML = `<div class="sdp-empty">Search failed: ${outcome.error}</div>`;
    return { ok: false, message: outcome.error };
  }
  return { ok: true, results: outcome.results };
}

async function resolveSceneForPanel(panel) {
  const sceneId = currentSceneId();
  if (!sceneId) return null;
  const body = panel.querySelector(".sdp-body");
  body.innerHTML = `<div class="sdp-loading">Reading scene…</div>`;
  try {
    return await resolveScene(sceneId);
  } catch (e) {
    body.innerHTML = `<div class="sdp-empty">Could not read scene: ${e.message}</div>`;
    return null;
  }
}

// The initial, automatic search: fires all (deduped, non-empty) broad
// queries in parallel and updates the Details section as each one resolves
// (see renderDetails), so its per-query spinners turn into that query's own
// results live rather than everything appearing at once. Once all queries
// have settled, merges the results and renders them — renderResults applies
// the MIN_SCORE filter, so this is also where the noise from overly-broad
// queries (e.g. a prolific performer's whole catalog) gets cut back down.
async function runBroadSearch(panel, scene, queries) {
  const body = panel.querySelector(".sdp-body");

  if (!queries.length) {
    renderDetails(panel, scene, []);
    body.innerHTML = `<div class="sdp-empty">No performers or title found for this scene.</div>`;
    return;
  }

  const queryStates = queries.map((query) => ({ query, status: "pending", open: true }));
  renderDetails(panel, scene, queryStates);
  body.innerHTML = LOADING_HTML;

  await Promise.all(queries.map((query, i) =>
    prowlarrSearch(query).then((outcome) => {
      // Carry over whatever the user set `open` to, so a query block they
      // collapsed manually doesn't pop back open just because another query
      // elsewhere finished and triggered a re-render.
      const open = queryStates[i].open;
      queryStates[i] = outcome.ok
        ? { query, status: "done", results: outcome.results, open }
        : { query, status: "error", error: outcome.error, open };
      renderDetails(panel, scene, queryStates);
    })
  ));

  const succeeded = queryStates.filter((s) => s.status === "done");
  if (!succeeded.length) {
    const firstError = queryStates.find((s) => s.status === "error");
    body.innerHTML = `<div class="sdp-empty">Search failed: ${firstError ? firstError.error : "unknown error"}</div>`;
    return;
  }

  const merged = mergeResults(succeeded.map((s) => s.results));
  const counts = renderResults(panel, merged, scene);
  renderDetails(panel, scene, queryStates, counts);
}

// Runs the next not-yet-tried step from QUERY_STEPS (the narrower
// studio/parent-studio/alias combinations) and renders whatever comes back,
// even if empty. Always exactly one step per call — used only by the "Try
// Harder" button, since the broad, automatic pass is runBroadSearch above.
async function advanceSearch(panel) {
  const state = panel._sdpState;
  if (!state) return;

  let stepIndex = state.stepIndex + 1;
  while (stepIndex < QUERY_STEPS.length) {
    const step = QUERY_STEPS[stepIndex];
    const query = step.build(state.scene);
    if (!query || state.triedQueries.has(query)) {
      // Nothing to search for at this step (e.g. no parent studio), or it's
      // identical to a query already tried — skip it.
      stepIndex++;
      continue;
    }
    state.triedQueries.add(query);

    renderDetails(panel, state.scene, [{ query, status: "pending" }]);
    const outcome = await doSearch(panel, query, `No usable "${step.label}" search terms for this scene.`);
    state.stepIndex = stepIndex;
    updateTryHarderButton(panel);
    if (!outcome.ok) {
      renderDetails(panel, state.scene, [{ query, status: "error", error: outcome.message }]);
      return;
    }

    const counts = renderResults(panel, outcome.results, state.scene);
    renderDetails(panel, state.scene, [{ query, status: "done", results: outcome.results }], counts);
    return;
  }

  state.stepIndex = QUERY_STEPS.length;
  updateTryHarderButton(panel);
}

// Guards against a double-click starting a second, overlapping search: a
// disabled button doesn't dispatch click events, so this alone is enough —
// no separate busy flag needed. Re-enables in `finally` even if something
// above throws, so a failure never leaves the button stuck.
async function onSearchClick() {
  const btn = document.getElementById("sdp-button");
  btn.disabled = true;
  try {
    const panel = ensurePanel();
    const scene = await resolveSceneForPanel(panel);
    if (!scene) return;

    const broadQueries = [...new Set(BROAD_QUERIES.map((q) => q.build(scene)).filter(Boolean))];
    panel._sdpState = { scene, stepIndex: -1, triedQueries: new Set(broadQueries) };

    await runBroadSearch(panel, scene, broadQueries);
    updateTryHarderButton(panel);
  } finally {
    btn.disabled = false;
  }
}

async function onTryHarderClick() {
  const panel = document.getElementById("sdp-panel");
  if (!panel || !panel._sdpState) return;
  const btn = panel.querySelector(".sdp-try-harder");
  btn.disabled = true;
  try {
    await advanceSearch(panel);
  } finally {
    btn.disabled = false;
  }
}
