/*
 * Content script injected on stashdb.org.
 *
 * Shows a "Search Prowlarr" button only on scene pages. On click it resolves
 * the studio + female performers + date (via StashDB's GraphQL API, with a
 * DOM fallback), searches Prowlarr, and renders resolution-sorted results
 * with a per-release download button.
 *
 * There are 5 progressively looser search steps (studio+performers+date,
 * studio+performers, performers+date, title+date, title). They run in order,
 * automatically moving to the next step whenever one comes back empty, and
 * stop at the first step with a hit — showing a small notice each time the
 * search is auto-expanded. A "Try Harder" button in the results panel lets
 * you manually advance to the next step at any time, hit or not.
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
  if (currentSceneId()) {
    if (!existing) injectButton();
  } else if (existing) {
    existing.remove();
    closePanel();
  }
}

// Poll for SPA navigation changes and re-evaluate whether to show the button.
setInterval(syncButton, 600);
syncButton();

function injectButton() {
  const btn = document.createElement("button");
  btn.id = "sdp-button";
  btn.type = "button";
  btn.textContent = "⬇ Search Prowlarr";
  btn.addEventListener("click", onSearchClick);
  document.body.appendChild(btn);
}

/* ------------------------------------------------------------------ *
 * Scene data extraction                                               *
 * ------------------------------------------------------------------ */

async function fetchSceneViaGraphQL(sceneId) {
  const query = `query Scene($id: ID!) {
    findScene(id: $id) {
      title
      date
      studio { name }
      performers { performer { name gender } }
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
  const females = (scene.performers || [])
    .map((p) => p.performer)
    .filter((p) => p && FEMALE_GENDERS.has(p.gender))
    .map((p) => p.name);
  return { studio, females, title: scene.title, date: scene.date || "" };
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
  return { studio, females, title: document.title, date: extractDateFromDOM() };
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

function titleTerm(scene) {
  return (scene.title || "").trim();
}

function joinTerms(terms) {
  return terms.filter(Boolean).join(" ").trim();
}

// Search steps, tried in order until one returns at least one hit. Not
// every indexer names releases by studio, so later steps drop it in favor
// of the scene date and, eventually, just the scene title.
const QUERY_STEPS = [
  {
    label: "studio + performers + date",
    build: (scene) => joinTerms([studioTerm(scene), ...scene.females, formatDateYYMMDD(scene.date)])
  },
  {
    label: "studio + performers",
    build: (scene) => joinTerms([studioTerm(scene), ...scene.females])
  },
  {
    label: "performers + date",
    build: (scene) => joinTerms([...scene.females, formatDateYYMMDD(scene.date)])
  },
  {
    label: "title + date",
    build: (scene) => joinTerms([titleTerm(scene), formatDateYYMMDD(scene.date)])
  },
  {
    label: "title",
    build: (scene) => joinTerms([titleTerm(scene)])
  }
];

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

// Counts how many of the scene's search criteria (studio, each female
// performer, title, date) show up in the release's title, so releases
// matching more of what we know about the scene sort first within a
// resolution group.
function scoreRelease(release, scene) {
  const hay = normalizeForMatch(`${release.title || ""} ${release.sortTitle || ""}`);
  let score = 0;

  if (scene.studio && hay.includes(normalizeForMatch(scene.studio))) score++;
  for (const name of scene.females || []) {
    if (name && hay.includes(normalizeForMatch(name))) score++;
  }
  if (scene.title && hay.includes(normalizeForMatch(scene.title))) score++;

  const iso = String(scene.date || "").match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const [, yyyy, mm, dd] = iso;
    if (hay.includes(`${yyyy}${mm}${dd}`) || hay.includes(`${yyyy.slice(2)}${mm}${dd}`)) score++;
  }

  return score;
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
    <div class="sdp-query"></div>
    <div class="sdp-notice" hidden></div>
    <div class="sdp-body"></div>
    <div class="sdp-panel-foot">
      <button type="button" class="sdp-try-harder" hidden>🍆 Try Harder</button>
    </div>`;
  panel.querySelector(".sdp-close").addEventListener("click", closePanel);
  panel.querySelector(".sdp-try-harder").addEventListener("click", onTryHarderClick);
  document.body.appendChild(panel);
  return panel;
}

function updateTryHarderButton(panel) {
  const btn = panel.querySelector(".sdp-try-harder");
  const state = panel._sdpState;
  btn.hidden = !state || state.stepIndex >= QUERY_STEPS.length - 1;
}

function showNotice(panel, text) {
  const notice = panel.querySelector(".sdp-notice");
  notice.textContent = text;
  notice.hidden = false;
}

function hideNotice(panel) {
  panel.querySelector(".sdp-notice").hidden = true;
}

function fmtSize(bytes) {
  if (!bytes || bytes < 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

function renderResults(panel, query, results, scene) {
  panel.querySelector(".sdp-query").textContent = `Query: ${query}`;
  const body = panel.querySelector(".sdp-body");
  body.innerHTML = "";

  if (!results.length) {
    body.innerHTML = `<div class="sdp-empty">No releases found.</div>`;
    return;
  }

  const sorted = sortResults(results, scene);
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

    const row = document.createElement("div");
    row.className = "sdp-row";

    const meta = [];
    if (r.indexer) meta.push(r.indexer);
    if (typeof r.seeders === "number") meta.push(`${r.seeders} seeders`);
    else if (typeof r.grabs === "number") meta.push(`${r.grabs} grabs`);
    if (r.size) meta.push(fmtSize(r.size));
    if (r.protocol) meta.push(r.protocol);

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
    body.appendChild(row);
  }
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

// Sends `query` to Prowlarr and renders the loading/error state into `panel`.
// Returns the results array, or null if nothing more should be rendered
// (an error or empty-query message was already shown).
async function doSearch(panel, query, emptyMessage) {
  const body = panel.querySelector(".sdp-body");
  panel.querySelector(".sdp-query").textContent = `Query: ${query || "(empty)"}`;
  if (!query) {
    body.innerHTML = `<div class="sdp-empty">${emptyMessage}</div>`;
    return null;
  }

  body.innerHTML = `<div class="sdp-loading">Searching Prowlarr…</div>`;
  try {
    const resp = await browser.runtime.sendMessage({ type: "search", query });
    if (!resp || !resp.ok) {
      body.innerHTML = `<div class="sdp-empty">Search failed: ${(resp && resp.error) || "unknown error"}</div>`;
      return null;
    }
    return resp.results;
  } catch (e) {
    body.innerHTML = `<div class="sdp-empty">Search failed: ${e.message}</div>`;
    return null;
  }
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

// Runs QUERY_STEPS starting after the panel's current step. In auto mode
// (the initial search) it keeps advancing past empty results until a step
// gets a hit or the steps run out; in manual mode (the "Try Harder" button)
// it runs exactly one step and renders whatever comes back, even if empty.
async function advanceSearch(panel, { auto }) {
  const state = panel._sdpState;
  if (!state) return;

  let stepIndex = state.stepIndex + 1;
  let executedCount = 0;
  while (stepIndex < QUERY_STEPS.length) {
    const step = QUERY_STEPS[stepIndex];
    const query = step.build(state.scene);
    if (!query) {
      // Nothing to search for at this step (e.g. no title) — skip it.
      stepIndex++;
      continue;
    }

    if (auto && executedCount > 0) {
      showNotice(panel, `No hits yet — search expanded to ${step.label}.`);
    } else {
      hideNotice(panel);
    }

    const results = await doSearch(panel, query, `No usable "${step.label}" search terms for this scene.`);
    state.stepIndex = stepIndex;
    executedCount++;
    updateTryHarderButton(panel);
    if (results === null) return;

    if (!auto || results.length > 0) {
      renderResults(panel, query, results, state.scene);
      return;
    }
    stepIndex++;
  }

  state.stepIndex = QUERY_STEPS.length;
  updateTryHarderButton(panel);
  if (auto) {
    panel.querySelector(".sdp-body").innerHTML = `<div class="sdp-empty">No releases found with any search.</div>`;
  }
}

async function onSearchClick() {
  const panel = ensurePanel();
  const scene = await resolveSceneForPanel(panel);
  if (!scene) return;

  panel._sdpState = { scene, stepIndex: -1 };
  await advanceSearch(panel, { auto: true });
}

async function onTryHarderClick() {
  const panel = document.getElementById("sdp-panel");
  if (!panel || !panel._sdpState) return;
  await advanceSearch(panel, { auto: false });
}
