/*
 * Content script injected on stashdb.org.
 *
 * Shows a "Search Prowlarr" button only on scene pages. On click it resolves
 * the studio + female performers + date (via StashDB's GraphQL API, with a
 * DOM fallback), searches Prowlarr, and renders resolution-sorted results
 * with a per-release download button.
 *
 * The search runs in up to 3 stages, each a fully automatic parallel batch:
 *
 * Stage 1 (automatic): 5 broad queries (performers+studio+date,
 * performers+date, performers+studio, studio+date, title — see
 * BROAD_QUERIES), merged/de-duplicated by guid, kept if they match at least
 * MIN_SCORE of the scene's known criteria (studio, parent studio, each
 * performer/alias, title, date — see scoreRelease/CRITERIA).
 *
 * Stage 2 ("🍆 Try Harder", click 1): SECOND_PASS_QUERIES — the same idea
 * using parent studio and performer aliases instead.
 *
 * Stage 3 ("🍑 Last Chance...", click 2): a single "performers only" query,
 * with no MIN_SCORE filter and no resolution grouping — instead sorted by
 * how close each release's Prowlarr publish date is to the scene's release
 * date (closer = higher) and capped at LAST_CHANCE_LIMIT, since a popular
 * performer's whole catalog could otherwise flood the panel. After this
 * stage the button is replaced by a sign-off message; there's nothing left
 * to fall back to.
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

let lastSceneId = null;

// Button, badge and panel all belong to one scene, so any scene change,
// including straight from one scene to another, clears them and starts
// over for the new one. Sub-pages of the same scene change nothing.
function syncButton() {
  const sceneId = currentSceneId();
  if (sceneId === lastSceneId) return;
  lastSceneId = sceneId;

  const existing = document.getElementById("sdp-button");
  if (existing) existing.remove();
  hideStashBadge();
  closePanel();
  if (sceneId) injectButton(sceneId);
}

// StashDB is a client-side SPA, and a content script can't hook its
// history.pushState. Every route change re-renders the page, though, so
// re-check on DOM changes (at most once per frame) and on back/forward.
// syncButton returns right away when the scene hasn't changed.
let syncQueued = false;
function queueSync() {
  if (syncQueued) return;
  syncQueued = true;
  requestAnimationFrame(() => {
    syncQueued = false;
    syncButton();
  });
}
new MutationObserver(queueSync).observe(document.body, { childList: true, subtree: true });
window.addEventListener("popstate", queueSync);
syncButton();

function injectButton(sceneId) {
  const btn = document.createElement("button");
  btn.id = "sdp-button";
  btn.type = "button";
  btn.textContent = "⬇ Search Prowlarr";
  btn.addEventListener("click", () => onSearchClick());
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
      performers { performer { name gender aliases } as }
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
  const appearances = (scene.performers || [])
    .filter((a) => a.performer && FEMALE_GENDERS.has(a.performer.gender));
  const females = appearances.map((a) => a.performer.name);
  // One alias per performer (their first listed one) is enough to give the
  // search cascade an alternate name to try — not every alias.
  const femaleAliasNames = appearances.map((a) => (a.performer.aliases && a.performer.aliases[0]) || a.performer.name);
  // Scoring, unlike querying, costs nothing per extra name, so it uses all of them.
  const femaleNameSets = appearances.map((a) => performerNameSet(a.performer.name, a.as, a.performer.aliases));
  return { studio, parentStudio, females, femaleAliasNames, femaleNameSets, title: scene.title, date: scene.date || "" };
}

// DOM fallback: parse the rendered scene page. StashDB renders each performer
// as `<a href="/performers/<id>"><svg><title>Female</title></svg><span>Name</span></a>`.
// The gender word lives ONLY in the icon's <svg><title> (not visible layout
// text), and the name lives in the sibling <span>. Read each anchor's own icon
// title and name rather than substring-matching the shared performers
// container, whose textContent glues every gender word onto the next name.
const FEMALE_LABELS = new Set(["female", "transfemale"]);

// StashDB's scene header is `<h3><span>Title</span></h3>` followed by
// `<h6><a>Studio</a> • YYYY-MM-DD</h6>` (stash-box Scene.tsx).
const SCENE_HEADER = ".card-header";

// The page title is "<scene title> | StashDB", and only a fallback for when
// the header isn't rendered.
function extractTitleFromDOM() {
  const h3 = document.querySelector(`${SCENE_HEADER} h3`);
  if (h3 && h3.textContent.trim()) return h3.textContent.trim();
  const t = document.title;
  const cut = t.lastIndexOf(" | ");
  return (cut > 0 ? t.slice(0, cut) : t).trim();
}

// The header's date first, then structured data or a <time> element. No
// guessing from the rest of the page: an unrelated date there (a comment,
// an edit) would search for the wrong day, which is worse than no date.
function extractDateFromDOM() {
  const h6 = document.querySelector(`${SCENE_HEADER} h6`);
  const inHeader = h6 && h6.textContent.match(/\b\d{4}-\d{2}-\d{2}\b/);
  if (inHeader) return inHeader[0];
  for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const data = JSON.parse(el.textContent);
      for (const item of Array.isArray(data) ? data : [data]) {
        if (item && item.datePublished) return item.datePublished;
      }
    } catch (e) { /* malformed/unrelated JSON-LD block, skip it */ }
  }
  const time = document.querySelector("time[datetime]");
  return time ? time.getAttribute("datetime") : "";
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
  return {
    studio, parentStudio: "", females, femaleAliasNames: females.slice(),
    femaleNameSets: females.map((n) => performerNameSet(n, "", [])),
    title: extractTitleFromDOM(), date: extractDateFromDOM()
  };
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

function studioTerm(scene) {
  return (scene.studio || "").replace(/\s+/g, "");
}

function parentStudioTerm(scene) {
  return (scene.parentStudio || "").replace(/\s+/g, "");
}

function femaleAliasTerms(scene) {
  return scene.femaleAliasNames || scene.females;
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
// — see runQueryBatch.
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

// Stage 2 ("🍆 Try Harder"): a second automatic parallel batch using the
// parent studio and performer aliases instead of the studio/primary names
// BROAD_QUERIES already tried. A query is guarded to "" (not left to
// joinTerms) when there's no parent studio, so it's skipped for the right
// reason instead of silently collapsing into a plain "performers + date"
// query mislabeled as this one. Term order matches BROAD_QUERIES so a query
// that turns out identical to one already tried (e.g. no alias set) is
// caught by the dedup in onTryHarderClick instead of being re-sent with its
// words shuffled.
const SECOND_PASS_QUERIES = [
  {
    label: "performers + parent studio + date",
    build: (scene) => parentStudioTerm(scene)
      ? joinTerms([...scene.females, parentStudioTerm(scene), formatDateYYMMDD(scene.date)])
      : ""
  },
  {
    label: "performers + parent studio",
    build: (scene) => parentStudioTerm(scene) ? joinTerms([...scene.females, parentStudioTerm(scene)]) : ""
  },
  {
    label: "performer aliases + date",
    build: (scene) => joinTerms([...femaleAliasTerms(scene), formatDateYYMMDD(scene.date)])
  }
];

// Stage 3 ("🍑 Last Chance..."): the loosest possible query — performers
// alone, no date/studio at all.
function lastChanceQuery(scene) {
  return joinTerms([...scene.females]);
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
      <span class="sdp-head-actions">
        <button type="button" class="sdp-refresh" title="Search again">↻</button>
        <button type="button" class="sdp-close" title="Close">✕</button>
      </span>
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
  panel.querySelector(".sdp-refresh").addEventListener("click", () => onSearchClick({ fresh: true }));
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
// false, collapsed) is read back from the previous state by callers so a
// query block the user manually expanded stays expanded across those
// re-renders. Once everything is known, `counts` adds the aggregate
// "found / passed filter" line for the merged, MIN_SCORE-filtered list
// shown at the bottom. Takes `state` (not just `scene`) since its per-query
// preview rows go through buildResultRow, which needs state.grabbed too.
function renderDetails(panel, state, queryStates, counts) {
  const scene = state.scene;
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
    block.open = qs.open === true;
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
        content.appendChild(buildResultRow(r, state));
      }
    }

    block.appendChild(content);
    body.appendChild(block);
  }

  if (counts) {
    addRow("Results", `${counts.total} found across all queries, ${counts.filtered} passed the ≥ ${MIN_SCORE}/${CRITERIA.length} filter`);
  }
}

// The action button walks through 3 stages: 1 = show "🍆 Try Harder" (runs
// SECOND_PASS_QUERIES), 2 = show "🍑 Last Chance..." (runs the Last Chance
// search), 3 = nothing left — hide the button and show a sign-off message
// in its place instead.
const NO_LUCK_HTML = `<div class="sdp-no-luck">🥱 Kein Glück. Zeit für Plan B: die eigene Hand.</div>`;

function updateActionButton(panel) {
  const foot = panel.querySelector(".sdp-panel-foot");
  const btn = foot.querySelector(".sdp-try-harder");
  const state = panel._sdpState;

  if (!state || state.stage >= 3) {
    btn.hidden = true;
    if (state && state.stage >= 3 && !foot.querySelector(".sdp-no-luck")) {
      foot.insertAdjacentHTML("beforeend", NO_LUCK_HTML);
    }
    return;
  }

  btn.hidden = false;
  btn.textContent = state.stage === 1 ? "🍆 Try Harder" : "🍑 Last Chance...";
}

// Status lines carry text from Prowlarr, Stash and StashDB, so they're built
// with textContent and never interpolated into HTML.
function messageDiv(className, text) {
  const div = document.createElement("div");
  div.className = className;
  div.textContent = text;
  return div;
}

function fmtSize(bytes) {
  if (!bytes || bytes < 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

// Builds one result row (title, meta line with the match-criteria hit count
// and publish-date proximity, download button) — shared by the main
// results list and the per-query previews in the Details section. Takes
// `state` (not just `scene`) so it can show "✓ Sent" for a release already
// grabbed, here or in any earlier search (see loadGrabbed).
function buildResultRow(r, state) {
  const scene = state.scene;
  const row = document.createElement("div");
  row.className = "sdp-row";

  // With more than one performer, show how much of the cast the release names ("Performer 2/3").
  const cast = scene.females.length > 1 ? ` ${countPerformers(releaseHay(r), scene)}/${scene.females.length}` : "";
  const matched = matchedCriteria(r, scene).map((label) => (label === "Performer" ? label + cast : label));
  const meta = [];
  if (r.indexer) meta.push(r.indexer);
  if (typeof r.seeders === "number") meta.push(`${r.seeders} seeders`);
  else if (typeof r.grabs === "number") meta.push(`${r.grabs} grabs`);
  if (r.size) meta.push(fmtSize(r.size));
  if (r.protocol) meta.push(r.protocol);
  meta.push(`${matched.length}/${CRITERIA.length} hits (${matched.join(", ")})`);
  // Shown everywhere (not just Stage 3) so it can be eyeballed over time
  // without yet affecting scoring anywhere — see ageDistanceDays.
  meta.push(ageLabel(r, scene));

  const info = document.createElement("div");
  info.className = "sdp-info";
  info.innerHTML = `<div class="sdp-rel-title"></div><div class="sdp-rel-meta"></div>`;
  info.querySelector(".sdp-rel-title").textContent = r.title || "(untitled release)";
  info.querySelector(".sdp-rel-meta").textContent = meta.join(" · ");

  const dl = document.createElement("button");
  dl.type = "button";
  dl.className = "sdp-dl";
  if (r.guid && state.grabbed.has(r.guid)) {
    dl.textContent = "✓ Sent";
    dl.classList.add("sdp-done");
    dl.disabled = true;
  } else {
    dl.textContent = "Download";
    dl.addEventListener("click", () => grabRelease(dl, r, state));
  }

  row.appendChild(info);
  row.appendChild(dl);
  return row;
}

// Small label shown above the list so it's always clear how far the search
// has progressed — results accumulate across stages (see state.allResults),
// so without this there'd be no way to tell whether what's on screen is
// just Stage 1 or everything found so far.
function stageLabel(state) {
  if (state.stage === 1) return "Stage 1: automatic search";
  if (state.stage === 2) return "Stage 1 + 2 (Try Harder)";
  return "Last Chance — sorted by publish-date proximity";
}

// Renders the result list into `panel` and returns { total, filtered }
// counts (for the Details section). `results` is expected to already be
// the accumulated set across every stage run so far (state.allResults),
// not just the latest batch — see runQueryBatch. `opts.partialFailure`
// shows a visible warning above the list when some (but not all) queries
// in the batch that produced these results failed, since that's otherwise
// only visible by expanding Details.
function renderResults(panel, results, state, opts = {}) {
  const scene = state.scene;
  const body = panel.querySelector(".sdp-body");
  body.innerHTML = "";

  const stageDiv = document.createElement("div");
  stageDiv.className = "sdp-stage-label";
  stageDiv.textContent = stageLabel(state);
  body.appendChild(stageDiv);

  if (opts.partialFailure) {
    const warn = document.createElement("div");
    warn.className = "sdp-warning";
    warn.textContent = "Some queries in this batch failed — see Details for which.";
    body.appendChild(warn);
  }

  if (!results.length) {
    body.insertAdjacentHTML("beforeend", `<div class="sdp-empty">No releases found.</div>`);
    return { total: 0, filtered: 0 };
  }

  const filtered = results.filter((r) => scoreRelease(r, scene) >= MIN_SCORE);
  if (!filtered.length) {
    const criteriaList = CRITERIA.map((c) => c.label).join(", ");
    body.appendChild(messageDiv("sdp-empty", `Found ${results.length} release(s), but none matched at least ${MIN_SCORE} of the scene's known details (${criteriaList}).`));
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
    body.appendChild(buildResultRow(r, state));
  }

  return { total: results.length, filtered: filtered.length };
}

// Stage 3 only: no MIN_SCORE filter (the whole point is to surface releases
// that don't pass it on title/date/studio text alone), no resolution
// grouping (a close date match in 720p should outrank a distant one in
// 2160p, per the "closer = higher" requirement), and a hard cap at
// LAST_CHANCE_LIMIT so a prolific performer's entire catalog doesn't flood
// the panel. `results` is the accumulated set across all 3 stages, same as
// renderResults, so switching to Last Chance doesn't discard what Stage 1/2
// already found — it's included in the age-sorted view too.
const LAST_CHANCE_LIMIT = 50;

function renderLastChanceResults(panel, results, state) {
  const scene = state.scene;
  const body = panel.querySelector(".sdp-body");
  body.innerHTML = "";

  const stageDiv = document.createElement("div");
  stageDiv.className = "sdp-stage-label";
  stageDiv.textContent = stageLabel(state);
  body.appendChild(stageDiv);

  if (!results.length) {
    body.insertAdjacentHTML("beforeend", `<div class="sdp-empty">No releases found.</div>`);
    return;
  }

  const shown = sortByAgeProximity(results, scene).slice(0, LAST_CHANCE_LIMIT);
  if (shown.length < results.length) {
    const note = document.createElement("div");
    note.className = "sdp-note";
    note.textContent = `Showing the ${shown.length} closest to the scene date, out of ${results.length} found.`;
    body.appendChild(note);
  }
  for (const r of shown) {
    body.appendChild(buildResultRow(r, state));
  }
}

async function grabRelease(btn, release, state) {
  btn.disabled = true;
  btn.textContent = "Sending…";
  try {
    const resp = await browser.runtime.sendMessage({ type: "grab", release });
    if (resp && resp.ok) {
      btn.textContent = "✓ Sent";
      btn.classList.add("sdp-done");
      // background.js persists it; this covers the panel that's already open.
      if (release.guid) state.grabbed.add(release.guid);
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

async function resolveSceneForPanel(panel, sceneId) {
  const body = panel.querySelector(".sdp-body");
  body.innerHTML = `<div class="sdp-loading">Reading scene…</div>`;
  try {
    return await resolveScene(sceneId);
  } catch (e) {
    body.replaceChildren(messageDiv("sdp-empty", `Could not read scene: ${e.message}`));
    return null;
  }
}

// Runs a batch of queries in parallel (used for both Stage 1 and Stage 2)
// and updates the Details section as each one resolves (see renderDetails),
// so its per-query spinners turn into that query's own results live rather
// than everything appearing at once. Once all queries have settled, merges
// this batch's results into state.allResults (so nothing found in an
// earlier stage is lost) and renders the accumulated set — renderResults
// applies the MIN_SCORE filter, so this is also where the noise from
// overly-broad queries (e.g. a prolific performer's whole catalog) gets cut
// back down. Shows a visible warning if some (but not all) queries failed.
async function runQueryBatch(panel, state, queries, emptyMessage) {
  const body = panel.querySelector(".sdp-body");

  if (!queries.length) {
    // Nothing new for this stage to search (e.g. fully deduped away) —
    // keep showing everything accumulated so far instead of blanking the
    // list, just note why this stage didn't add anything.
    const counts = renderResults(panel, state.allResults, state);
    body.prepend(messageDiv("sdp-note", emptyMessage));
    renderDetails(panel, state, state.allQueryStates, counts);
    return;
  }

  // Appended to (not replacing) state.allQueryStates, so Details keeps
  // showing every query tried across every stage, not just this batch's.
  const startIdx = state.allQueryStates.length;
  state.allQueryStates.push(...queries.map((query) => ({ query, status: "pending" })));
  renderDetails(panel, state, state.allQueryStates);
  body.innerHTML = LOADING_HTML;

  await Promise.all(queries.map((query, i) =>
    prowlarrSearch(query).then((outcome) => {
      // Carry over whatever the user set `open` to, so a query block they
      // expanded manually doesn't collapse again just because another query
      // elsewhere finished and triggered a re-render.
      const open = state.allQueryStates[startIdx + i].open;
      state.allQueryStates[startIdx + i] = outcome.ok
        ? { query, status: "done", results: outcome.results, open }
        : { query, status: "error", error: outcome.error, open };
      renderDetails(panel, state, state.allQueryStates);
    })
  ));

  const batchStates = state.allQueryStates.slice(startIdx);
  const succeeded = batchStates.filter((s) => s.status === "done");
  const failed = batchStates.filter((s) => s.status === "error");
  if (!succeeded.length) {
    body.replaceChildren(messageDiv("sdp-empty", `Search failed: ${failed[0] ? failed[0].error : "unknown error"}`));
    return;
  }

  state.allResults = mergeResults([state.allResults, ...succeeded.map((s) => s.results)]);
  const counts = renderResults(panel, state.allResults, state, { partialFailure: failed.length > 0 });
  renderDetails(panel, state, state.allQueryStates, counts);
}

// Stage 3 ("Last Chance"): a single query, rendered through
// renderLastChanceResults instead of the standard renderResults (no
// MIN_SCORE filter, no resolution grouping, capped at LAST_CHANCE_LIMIT,
// sorted by publish-date proximity to the scene's date). Merges into
// state.allResults first, same as runQueryBatch, so Stage 1/2's results
// are included in the age-sorted view rather than discarded.
async function runLastChanceSearch(panel, state) {
  const scene = state.scene;
  const query = lastChanceQuery(scene);
  const body = panel.querySelector(".sdp-body");

  if (!query) {
    renderDetails(panel, state, state.allQueryStates);
    body.innerHTML = `<div class="sdp-empty">No performers found for this scene.</div>`;
    return;
  }

  // Appended to (not replacing) state.allQueryStates, same pattern as
  // runQueryBatch, so Details keeps showing every query tried across every
  // stage rather than just this one.
  const idx = state.allQueryStates.length;
  state.allQueryStates.push({ query, status: "pending" });
  renderDetails(panel, state, state.allQueryStates);
  body.innerHTML = LOADING_HTML;

  const outcome = await prowlarrSearch(query);
  if (!outcome.ok) {
    const open = state.allQueryStates[idx].open;
    state.allQueryStates[idx] = { query, status: "error", error: outcome.error, open };
    renderDetails(panel, state, state.allQueryStates);
    body.replaceChildren(messageDiv("sdp-empty", `Search failed: ${outcome.error}`));
    return;
  }

  const open = state.allQueryStates[idx].open;
  state.allQueryStates[idx] = { query, status: "done", results: outcome.results, open };
  state.allResults = mergeResults([state.allResults, outcome.results]);
  renderLastChanceResults(panel, state.allResults, state);
  renderDetails(panel, state, state.allQueryStates);
}

// GUIDs of releases already sent to Prowlarr ({ guid: sentAt }). background.js
// records them after each grab; reading them here means a new search, another
// tab or a reload can't offer them again.
async function loadGrabbed() {
  const { grabbed } = await browser.storage.local.get({ grabbed: {} });
  return new Set(Object.keys(pruneGrabbed(grabbed, Date.now(), GRABBED_MAX_AGE_MS)));
}

// Searches per scene, so reopening one (e.g. after navigating back in
// StashDB's SPA) restores it instead of re-querying every indexer. The
// entry holds the live state object, so later stages are included too.
// In memory only: a page reload starts fresh.
const SCENE_CACHE_TTL_MS = 30 * 60 * 1000;
const SCENE_CACHE_MAX = 20;
const sceneCache = new Map();

function cacheScene(sceneId, state) {
  const now = Date.now();
  for (const [id, entry] of sceneCache) {
    if (now - entry.at >= SCENE_CACHE_TTL_MS) sceneCache.delete(id);
  }
  sceneCache.delete(sceneId);
  sceneCache.set(sceneId, { state, at: now });
  while (sceneCache.size > SCENE_CACHE_MAX) sceneCache.delete(sceneCache.keys().next().value);
}

// Only a finished search where every query succeeded is worth restoring;
// one still running or partly failed is re-run instead.
function cachedScene(sceneId) {
  const entry = sceneCache.get(sceneId);
  if (!entry || Date.now() - entry.at >= SCENE_CACHE_TTL_MS) return null;
  const queries = entry.state.allQueryStates;
  return queries.length && queries.every((q) => q.status === "done") ? entry : null;
}

function restorePanel(panel, entry, grabbed) {
  const state = entry.state;
  state.grabbed = new Set([...state.grabbed, ...grabbed]);
  panel._sdpState = state;
  if (state.stage >= 3) {
    renderLastChanceResults(panel, state.allResults, state);
    renderDetails(panel, state, state.allQueryStates);
  } else {
    renderDetails(panel, state, state.allQueryStates, renderResults(panel, state.allResults, state));
  }
  const mins = Math.round((Date.now() - entry.at) / 60000);
  panel.querySelector(".sdp-body").prepend(messageDiv("sdp-note",
    `Restored your search from ${mins < 1 ? "just now" : `${mins} min ago`} — ↻ to search again.`));
  updateActionButton(panel);
}

// Guards against a double-click starting a second, overlapping search: a
// disabled button doesn't dispatch click events, and the explicit check
// covers the panel's ↻ button, which reuses this handler. Re-enables in
// `finally` even if something above throws, so a failure never leaves the
// button stuck.
async function onSearchClick({ fresh = false } = {}) {
  const btn = document.getElementById("sdp-button");
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    const sceneId = currentSceneId();
    if (!sceneId) return;
    const panel = ensurePanel();
    const grabbed = await loadGrabbed();
    const cached = fresh ? null : cachedScene(sceneId);
    if (cached) {
      restorePanel(panel, cached, grabbed);
      return;
    }

    // sceneId, not a fresh URL read: the user may have moved on during the awaits.
    const scene = await resolveSceneForPanel(panel, sceneId);
    if (!scene) return;

    const broadQueries = [...new Set(BROAD_QUERIES.map((q) => q.build(scene)).filter(Boolean))];
    const state = { scene, stage: 1, triedQueries: new Set(broadQueries), allResults: [], allQueryStates: [], grabbed };
    panel._sdpState = state;
    cacheScene(sceneId, state);

    await runQueryBatch(panel, state, broadQueries, "No performers or title found for this scene.");
    updateActionButton(panel);
  } finally {
    btn.disabled = false;
  }
}

// Runs whichever stage the panel is currently on: Stage 1 → 2 runs
// SECOND_PASS_QUERIES (parallel, deduped against everything already tried),
// Stage 2 → 3 runs the single Last Chance query. The stage advances before
// it runs, so the stage label rendered during the run is already the new
// one, and regardless of whether it finds anything (there's nothing further
// to fall back to either way) — updateActionButton then reflects it,
// including hiding the button and showing the sign-off after Stage 3.
async function onTryHarderClick() {
  const panel = document.getElementById("sdp-panel");
  if (!panel || !panel._sdpState) return;
  const state = panel._sdpState;
  const btn = panel.querySelector(".sdp-try-harder");
  btn.disabled = true;
  try {
    if (state.stage === 1) {
      const queries = [...new Set(SECOND_PASS_QUERIES.map((q) => q.build(state.scene)).filter(Boolean))]
        .filter((q) => !state.triedQueries.has(q));
      queries.forEach((q) => state.triedQueries.add(q));
      state.stage = 2;
      await runQueryBatch(panel, state, queries, "Nothing new to try — no parent studio or aliases available.");
    } else if (state.stage === 2) {
      state.stage = 3;
      await runLastChanceSearch(panel, state);
    }
    updateActionButton(panel);
  } finally {
    btn.disabled = false;
  }
}
