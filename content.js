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
 * Stage 2 ("Try harder", click 1): SECOND_PASS_QUERIES — the same idea
 * using parent studio and performer aliases instead.
 *
 * Stage 3 ("Last chance", click 2): a single "performers only" query,
 * with no MIN_SCORE filter and no resolution grouping — instead sorted by
 * how close each release's Prowlarr publish date is to the scene's release
 * date (closer = higher) and capped at LAST_CHANCE_LIMIT, since a popular
 * performer's whole catalog could otherwise flood the panel. After this
 * stage the button is replaced by a sign-off message; there's nothing left
 * to fall back to.
 *
 * If a StashApp instance is configured, it also checks (via the background
 * script) whether the scene is already in that library and shows a badge
 * with its resolution and a link, above the search button in the dock. And for the
 * scene's first two female performers, a sidebar on the right (first) and
 * left (second) edge shows up to SIDEBAR_SCENES of their other scenes in
 * Stash, with thumbnails and a link to the performer there if there are more.
 * On every StashDB page, scene cards in lists (performer, studio, tag and
 * search pages, the scene list) get a badge with the resolution when that scene
 * is already in Stash.
 */

const SCENE_RE = /^\/scenes\/([0-9a-f-]{36})/i;

/* ------------------------------------------------------------------ *
 * Scene detection + button lifecycle (StashDB is a client-side SPA)   *
 * ------------------------------------------------------------------ */

function currentSceneId() {
  const m = location.pathname.match(SCENE_RE);
  return m ? m[1] : null;
}

let lastSceneId = null;

// Declared up here, not with the rest of the sidebar code: the first
// syncButton() below already runs before the end of this file is reached.
// The first performer's sidebar goes on the right edge, the second's on the left.
const SIDEBAR_SIDES = ["right", "left"];
// StashDB's content spans the full width, so the two 380px sidebars always
// cover some of it; below this viewport width they'd cover too much and
// start collapsed to their header.
const SIDEBAR_COLLAPSE_BELOW_PX = 1800;
// Inline icons (static markup, never mixed with page or API data), turned
// into elements by icon(). Up here for the same reason: the dock is built by
// that first syncButton().
const ICONS = {
  logo: `<svg width="26" height="26" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="15" fill="#ff6b2c"/><g fill="#141517"><rect x="19.5" y="12" width="15" height="6" rx="2.5"/><rect x="12" y="19.5" width="6" height="8" rx="2.5"/><rect x="19.5" y="29" width="15" height="6" rx="2.5"/><rect x="36" y="36.5" width="6" height="8" rx="2.5"/><rect x="19.5" y="46" width="15" height="6" rx="2.5"/></g><circle cx="49" cy="49" r="3.5" fill="#fff"/></svg>`,
  search: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M20 20l-4.6-4.6"/></svg>`,
  download: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v12M6.5 10.5L12 16l5.5-5.5M5 20h14"/></svg>`,
  check: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`,
  refresh: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>`,
  close: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>`,
  chevron: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 15l6-6 6 6"/></svg>`,
  open: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17L17 7M9 7h8v8"/></svg>`,
  arrow: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>`,
  radar: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="2"/><path d="M7.8 16.2a6 6 0 0 1 0-8.4M16.2 7.8a6 6 0 0 1 0 8.4M4.9 19.1a10 10 0 0 1 0-14.2M19.1 4.9a10 10 0 0 1 0 14.2"/></svg>`
};
// Bumped on every scene change, so a lookup still in flight for the previous
// scene (or an earlier visit to this one) can't add its sidebars late.
let sidebarGeneration = 0;

// Button, badge and panel all belong to one scene, so any scene change,
// including straight from one scene to another, clears them and starts
// over for the new one. Sub-pages of the same scene change nothing.
function syncButton() {
  const sceneId = currentSceneId();
  if (sceneId === lastSceneId) return;
  lastSceneId = sceneId;

  const dock = document.getElementById("sdp-dock");
  if (dock) dock.remove();
  hidePerformerSidebars();
  closePanel();
  if (sceneId) {
    injectButton(sceneId);
    showPerformerSidebars(sceneId);
    // Stashboard's download buttons link here with AUTO_SEARCH_HASH: open
    // the panel and search right away. Searching is all it does; grabbing
    // a release still takes a click, even with Auto-Download on.
    // A tick later: on page load this runs before the rest of this file
    // (and the constants the search uses) has been evaluated.
    if (location.hash === AUTO_SEARCH_HASH) {
      dropAutoSearchHash();
      setTimeout(() => onSearchClick({ auto: false }), 0);
    }
  }
}

// So a reload doesn't search again. In Firefox through the page's own
// history object, so the router's state object stays the page's.
function dropAutoSearchHash() {
  const pageHistory = window.wrappedJSObject ? window.wrappedJSObject.history : history;
  try {
    pageHistory.replaceState(pageHistory.state, "", location.pathname + location.search);
  } catch (e) { /* the hash just stays */ }
}

// StashDB is a client-side SPA, and a content script can't hook its
// history.pushState. Every route change re-renders the page, though, so
// re-check on DOM changes (at most once per frame) and on back/forward.
// Link changes count too: React can reuse a scene card for another scene by
// just updating its href.
// syncButton returns right away when the scene hasn't changed, and
// syncCardBadges only looks at scene cards it hasn't checked yet.
let syncQueued = false;
function queueSync() {
  if (syncQueued) return;
  syncQueued = true;
  requestAnimationFrame(() => {
    syncQueued = false;
    syncButton();
    syncCardBadges();
  });
}
new MutationObserver(queueSync).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["href"] });
window.addEventListener("popstate", queueSync);
syncButton();

function icon(name) {
  const svg = ICONS[name].replace("<svg ", '<svg xmlns="http://www.w3.org/2000/svg" ');
  return document.importNode(new DOMParser().parseFromString(svg, "image/svg+xml").documentElement, true);
}

// A <span> with text, for button labels next to an icon.
function textSpan(text, className) {
  const span = document.createElement("span");
  if (className) span.className = className;
  span.textContent = text;
  return span;
}

// The dock in the bottom right corner: the Stash badge (once known) on top,
// the search button and the Auto-Download switch below it.
function injectButton(sceneId) {
  const dock = document.createElement("div");
  dock.id = "sdp-dock";
  const row = document.createElement("div");
  row.className = "sdp-dock-row";
  const btn = document.createElement("button");
  btn.id = "sdp-button";
  btn.type = "button";
  btn.addEventListener("click", () => onSearchClick());
  row.append(btn, autoToggle());
  dock.appendChild(row);
  document.body.appendChild(dock);
  resetSearchButton();

  checkStashApp(sceneId).then((scene) => {
    // The user may have navigated away while the lookup was in flight.
    if (scene && currentSceneId() === sceneId) showStashBadge(scene);
  });
}

// The Auto-Download switch next to the search button. Stored in
// storage.local, so it stays as set across scenes, tabs and restarts, and
// follows changes made in other tabs.
function autoToggle() {
  const wrap = document.createElement("label");
  wrap.id = "sdp-auto";
  wrap.title = "After a search, download the top release with every hit automatically";
  wrap.innerHTML = `<input type="checkbox" aria-label="Auto-Download"><span class="sdp-switch"></span><span class="sdp-auto-label">Auto-DL</span>`;
  const input = wrap.querySelector("input");
  browser.storage.local.get({ autoDownload: false }).then(({ autoDownload }) => { input.checked = autoDownload; });
  input.addEventListener("change", () => browser.storage.local.set({ autoDownload: input.checked }));
  // Other open StashDB tabs follow when the switch is flipped in one of them.
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.autoDownload) input.checked = !!changes.autoDownload.newValue;
  });
  return wrap;
}

function resetSearchButton() {
  const btn = document.getElementById("sdp-button");
  if (btn) btn.replaceChildren(icon("search"), textSpan("Search Prowlarr"));
}

// While a search runs, the button shows how many of its queries are back.
function showSearchProgress(done, total) {
  const btn = document.getElementById("sdp-button");
  if (!btn) return;
  btn.innerHTML = `<span>Searching</span><span class="sdp-progress"></span><span class="sdp-progress-n"></span>`;
  const bar = btn.querySelector(".sdp-progress");
  for (let i = 0; i < total; i++) {
    const seg = document.createElement("span");
    if (i < done) seg.className = "sdp-on";
    bar.appendChild(seg);
  }
  btn.querySelector(".sdp-progress-n").textContent = `${done}/${total}`;
}

/* ------------------------------------------------------------------ *
 * Scene data extraction                                               *
 * ------------------------------------------------------------------ */

// Runs a findScene query against StashDB's own API with the user's session.
async function stashdbFindScene(query, sceneId) {
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
  return scene;
}

async function fetchSceneViaGraphQL(sceneId) {
  const scene = await stashdbFindScene(`query Scene($id: ID!) {
    findScene(id: $id) {
      title
      date
      studio { name parent { name } }
      performers { performer { name gender aliases } as }
    }
  }`, sceneId);

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

// Goes on top of the dock, which then grows upwards: the panel moves along.
function showStashBadge(scene) {
  const dock = document.getElementById("sdp-dock");
  if (!dock) return;
  const old = document.getElementById("sdp-stash-badge");
  if (old) old.remove();
  const badge = document.createElement("div");
  badge.id = "sdp-stash-badge";
  const link = document.createElement("a");
  link.href = scene.url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.title = `Already in Stash — ${scene.resolution}. Opens it in Stash.`;
  link.append(textSpan("", "sdp-dot"), textSpan("Already in your Stash", "sdp-badge-text"),
    textSpan(scene.resolution, "sdp-badge-res"), icon("open"));
  badge.appendChild(link);
  dock.prepend(badge);
  placePanel();
}

/* ------------------------------------------------------------------ *
 * StashApp: sidebars with the performers' other scenes                *
 * ------------------------------------------------------------------ */

function hidePerformerSidebars() {
  sidebarGeneration++;
  document.querySelectorAll(".sdp-sidebar").forEach((el) => el.remove());
}

async function fetchSceneAppearances(sceneId) {
  const scene = await stashdbFindScene(`query ScenePerformers($id: ID!) {
    findScene(id: $id) {
      performers { performer { id name gender } }
    }
  }`, sceneId);
  return scene.performers || [];
}

// Like the badge, a nice-to-have: any failure just means no sidebars, with
// the reason in the console.
async function showPerformerSidebars(sceneId) {
  const generation = sidebarGeneration;
  try {
    const { stashUrl } = await browser.storage.local.get({ stashUrl: "" });
    if (!String(stashUrl).trim()) return;

    const performers = sidebarPerformers(await fetchSceneAppearances(sceneId));
    if (!performers.length || generation !== sidebarGeneration) return;

    const resp = await browser.runtime.sendMessage({ type: "stashPerformerScenes", sceneStashId: sceneId, performers });
    if (!resp || !resp.ok) {
      console.warn("[StashDB→Prowlarr] Stash performer lookup failed:", (resp && resp.error) || "unknown error");
      return;
    }
    if (generation !== sidebarGeneration) return;
    resp.performers.forEach((p, i) => {
      if (p && SIDEBAR_SIDES[i]) renderSidebar(p, SIDEBAR_SIDES[i]);
    });
  } catch (e) {
    console.warn("[StashDB→Prowlarr] Stash performer lookup failed:", e.message);
  }
}

function newTabLink(className, href) {
  const a = document.createElement("a");
  a.className = className;
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  return a;
}

// Everything in here comes from Stash, so it's set as text/attributes only.
function renderSidebar(performer, side) {
  const bar = document.createElement("aside");
  bar.className = `sdp-sidebar sdp-sidebar-${side}`;

  const head = document.createElement("div");
  head.className = "sdp-sidebar-head";
  const avatar = document.createElement("span");
  avatar.className = "sdp-sidebar-avatar";
  avatar.setAttribute("aria-hidden", "true");
  avatar.textContent = initials(performer.name);
  const who = document.createElement("div");
  who.className = "sdp-sidebar-who";
  const name = newTabLink("sdp-sidebar-name", performer.url);
  name.textContent = performer.name;
  name.title = `${performer.name} in Stash`;
  const count = document.createElement("span");
  count.className = "sdp-sidebar-count";
  count.textContent = performer.count
    ? `${performer.count} other scene${performer.count === 1 ? "" : "s"} in Stash`
    : "No other scenes in Stash";
  who.append(name, count);
  head.append(avatar, who);
  const radar = radarButton(performer);
  if (radar) head.append(radar);
  bar.appendChild(head);

  // Nothing to fold away without scenes: just the header, for the radar.
  if (!performer.scenes.length) {
    document.body.appendChild(bar);
    return;
  }

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "sdp-sidebar-toggle";
  toggle.appendChild(icon("chevron"));
  toggle.addEventListener("click", () => {
    delete bar.dataset.sdpPanelCollapsed;
    setSidebarCollapsed(bar, !bar.classList.contains("sdp-collapsed"));
  });
  head.append(toggle);
  setSidebarCollapsed(bar, window.innerWidth < SIDEBAR_COLLAPSE_BELOW_PX);

  const body = document.createElement("div");
  body.className = "sdp-sidebar-body";
  const label = document.createElement("div");
  label.className = "sdp-sidebar-label";
  label.textContent = "Newest in your Stash";
  body.appendChild(label);

  for (const [i, scene] of performer.scenes.entries()) {
    const card = newTabLink(`sdp-sidebar-scene${i === 0 ? " sdp-lead" : ""}`, scene.url);
    card.title = scene.title;
    const img = document.createElement("img");
    img.className = "sdp-sidebar-thumb";
    img.alt = "";
    const title = document.createElement("span");
    title.className = "sdp-sidebar-scene-title";
    title.textContent = scene.title;
    card.append(img, title);
    if (scene.date) {
      const date = document.createElement("span");
      date.className = "sdp-sidebar-scene-date";
      date.textContent = scene.date;
      card.appendChild(date);
    }
    body.appendChild(card);
    loadSidebarThumb(img, scene.id);
  }

  const rest = performer.count - performer.scenes.length;
  if (rest > 0) {
    const more = newTabLink("sdp-sidebar-more", performer.url);
    more.append(textSpan(`${rest} more in Stash`), icon("arrow"));
    body.appendChild(more);
  }

  bar.appendChild(body);
  document.body.appendChild(bar);
}

function setSidebarCollapsed(bar, collapsed) {
  bar.classList.toggle("sdp-collapsed", collapsed);
  const toggle = bar.querySelector(".sdp-sidebar-toggle");
  if (!toggle) return;
  toggle.title = collapsed ? "Show scenes" : "Hide scenes";
  toggle.setAttribute("aria-label", toggle.title);
  toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
}

// "Mara Quinn" → "MQ", for the round placeholder in a sidebar's header.
function initials(name) {
  const words = String(name || "").trim().split(/\s+/).filter(Boolean);
  return words.slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "?";
}

// Radar pill in a sidebar's header: puts the performer on Stashboard's radar (or
// takes them off), so its front page shows more of them. Not offered for
// favourites, unless one is on the radar anyway.
function radarButton(performer) {
  if (!performer.id || (performer.favorite && !performer.radar)) return null;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "sdp-sidebar-radar";
  button.append(icon("radar"), textSpan(""));
  let since = performer.radar;
  const show = (error) => {
    button.lastChild.textContent = error ? "Failed" : since ? "On radar" : "Radar";
    button.classList.toggle("sdp-on", !!since);
    button.classList.toggle("sdp-error", !!error);
    button.setAttribute("aria-pressed", since ? "true" : "false");
    if (error) button.title = `Couldn't change the radar: ${error}`;
    else if (since) button.title = `On your Stashboard radar since ${since}. Click to take ${performer.name} off.`;
    else button.title = `Put ${performer.name} on your Stashboard radar: not a favourite, but more of them on your Stash front page`;
  };
  show(null);
  button.addEventListener("click", async () => {
    button.disabled = true;
    let error = null;
    try {
      const resp = await browser.runtime.sendMessage({ type: "stashRadar", performerId: performer.id, on: !since });
      if (resp && resp.ok) since = resp.radar;
      else error = (resp && resp.error) || "unknown error";
    } catch (e) {
      error = e.message;
    }
    button.disabled = false;
    show(error);
  });
  return button;
}

// Thumbnails come through the background script (see stashSceneThumb); a
// failed one just keeps the empty placeholder.
async function loadSidebarThumb(img, stashSceneId) {
  try {
    const resp = await browser.runtime.sendMessage({ type: "stashSceneThumb", sceneId: stashSceneId });
    if (resp && resp.ok) img.src = resp.dataUrl;
    else console.warn("[StashDB→Prowlarr] Stash thumbnail failed:", (resp && resp.error) || "unknown error");
  } catch (e) {
    console.warn("[StashDB→Prowlarr] Stash thumbnail failed:", e.message);
  }
}

/* ------------------------------------------------------------------ *
 * StashApp: owned badge on StashDB's scene cards                      *
 * ------------------------------------------------------------------ */

// StashDB's scene cards, per stash-box: the grid card of the scene,
// performer, studio and tag lists (components/sceneCard/SceneCard.tsx, a
// `.SceneCard` whose image links to the scene) and the row on the search
// page (pages/search/SceneCard.tsx, an `a.SearchPage-scene` around a `.card`).
const SCENE_CARD_LINKS = ".SceneCard a.SceneCard-image[href^='/scenes/'], a.SearchPage-scene[href^='/scenes/']";

// Answers are kept across StashDB's page changes, so paging back and forth
// doesn't ask Stash again, but not for good: a scene downloaded meanwhile
// should show up on a later visit. A failed lookup (Stash unreachable, or
// older than 0.31) is retried sooner, but not on every re-render.
const CARD_ANSWER_TTL_MS = 10 * 60 * 1000;
const CARD_RETRY_MS = 60 * 1000;
const CARD_ANSWERS_MAX = 2000;
// Cards often render over a few frames; wait briefly to ask for all at once.
const CARD_LOOKUP_DELAY_MS = 150;

// StashDB scene ID → { scene: { url, resolution } | null, failed?, at }.
const cardAnswers = new Map();
const cardPending = new Set();
const cardInFlight = new Set();
let cardLookupTimer = null;
let cardBadgesOn = false;
// Bumped when the Stash settings change, so an answer from the old instance
// that's still in flight is dropped instead of cached.
let cardGeneration = 0;

function cardAnswer(id) {
  const entry = cardAnswers.get(id);
  if (entry && Date.now() - entry.at < (entry.failed ? CARD_RETRY_MS : CARD_ANSWER_TTL_MS)) return entry;
  cardAnswers.delete(id);
  return null;
}

function rememberCardAnswer(id, entry) {
  cardAnswers.delete(id);
  cardAnswers.set(id, entry);
  while (cardAnswers.size > CARD_ANSWERS_MAX) cardAnswers.delete(cardAnswers.keys().next().value);
}

// The badge sits over a grid card's image, next to its link rather than in
// it, and at the start of a search row.
function cardBadgeHost(link) {
  if (link.classList.contains("SearchPage-scene")) return link.querySelector(".card");
  return link.closest(".SceneCard-body");
}

function sceneCards() {
  const cards = [];
  for (const link of document.querySelectorAll(SCENE_CARD_LINKS)) {
    const m = link.getAttribute("href").match(SCENE_RE);
    const host = m && cardBadgeHost(link);
    if (host) cards.push({ id: m[1], host });
  }
  return cards;
}

// Runs after every batch of DOM changes (see queueSync), so only from
// callbacks, never while this file is still being evaluated. A card's host
// remembers the scene it was checked for: React reusing a card for another
// scene gets it checked again, while a card already done (including the
// mutation from adding its own badge) costs nothing.
function syncCardBadges() {
  if (!cardBadgesOn) return;
  const missing = [];
  for (const { id, host } of sceneCards()) {
    if (host.dataset.sdpStashFor === id) continue;
    if (host.dataset.sdpStashFor) clearCard(host);
    const answer = cardAnswer(id);
    if (answer) markCard(host, id, answer.scene);
    else if (!cardInFlight.has(id)) missing.push(id);
  }
  if (missing.length) queueCardLookups(missing);
}

function queueCardLookups(ids) {
  ids.forEach((id) => cardPending.add(id));
  if (!cardLookupTimer) cardLookupTimer = setTimeout(runCardLookups, CARD_LOOKUP_DELAY_MS);
}

async function runCardLookups() {
  cardLookupTimer = null;
  const generation = cardGeneration;
  const ids = [...cardPending];
  cardPending.clear();
  ids.forEach((id) => cardInFlight.add(id));

  let scenes = null;
  try {
    const resp = await browser.runtime.sendMessage({ type: "stashScenesByStashIds", stashIds: ids });
    if (resp && resp.ok) scenes = resp.scenes || {};
    else console.warn("[StashDB→Prowlarr] Stash list lookup failed:", (resp && resp.error) || "unknown error");
  } catch (e) {
    console.warn("[StashDB→Prowlarr] Stash list lookup failed:", e.message);
  }

  ids.forEach((id) => cardInFlight.delete(id));
  if (generation === cardGeneration) {
    const at = Date.now();
    for (const id of ids) {
      rememberCardAnswer(id, scenes ? { scene: scenes[id] || null, at } : { scene: null, failed: true, at });
    }
  }
  // Also after a dropped answer: its cards were skipped as in flight meanwhile.
  syncCardBadges();
}

function clearCard(host) {
  delete host.dataset.sdpStashFor;
  host.classList.remove("sdp-card-host");
  host.querySelectorAll(":scope > .sdp-card-badge").forEach((el) => el.remove());
}

// Like the sidebars: text and attributes only, it all comes from Stash.
function markCard(host, id, scene) {
  host.dataset.sdpStashFor = id;
  if (!scene) return;
  const badge = newTabLink("sdp-card-badge", scene.url);
  badge.textContent = scene.resolution || "In Stash";
  badge.title = `Already in Stash${scene.resolution ? ` — ${scene.resolution}` : ""}`;
  // A search row is itself a link to the StashDB scene, whose clicks React
  // Router handles at the page root: this one should only open Stash.
  badge.addEventListener("click", (e) => e.stopPropagation());
  host.classList.add("sdp-card-host");
  host.appendChild(badge);
}

// On only while a Stash URL is set; changing the Stash settings starts over.
async function updateCardBadges() {
  const generation = ++cardGeneration;
  try {
    const { stashUrl } = await browser.storage.local.get({ stashUrl: "" });
    cardBadgesOn = !!String(stashUrl).trim();
  } catch (e) {
    console.warn("[StashDB→Prowlarr] Could not read settings:", e.message);
    cardBadgesOn = false;
  }
  if (generation !== cardGeneration) return;
  cardAnswers.clear();
  document.querySelectorAll("[data-sdp-stash-for]").forEach(clearCard);
  syncCardBadges();
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.stashUrl || changes.stashApiKey)) updateCardBadges();
});
updateCardBadges();

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

// Stage 2 ("Try harder"): a second automatic parallel batch using the
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

// Stage 3 ("Last chance"): the loosest possible query — performers
// alone, no date/studio at all.
function lastChanceQuery(scene) {
  return joinTerms([...scene.females]);
}

/* ------------------------------------------------------------------ *
 * UI: results panel                                                   *
 * ------------------------------------------------------------------ */

// The right-hand sidebar folds up to its header while the panel is open,
// so the two don't overlap, and opens again when the panel closes, unless
// the user has used its toggle meanwhile.
function closePanel() {
  const p = document.getElementById("sdp-panel");
  if (p) p.remove();
  const right = document.querySelector(".sdp-sidebar-right[data-sdp-panel-collapsed]");
  if (right) {
    delete right.dataset.sdpPanelCollapsed;
    setSidebarCollapsed(right, false);
  }
}

const STEP_LABELS = ["Automatic", "Try harder", "Last chance"];

function ensurePanel() {
  closePanel();
  const panel = document.createElement("div");
  panel.id = "sdp-panel";
  panel.innerHTML = `
    <div class="sdp-panel-head">
      <div class="sdp-head-text">
        <span class="sdp-title">Releases</span>
        <span class="sdp-subtitle"></span>
      </div>
      <span class="sdp-head-actions">
        <button type="button" class="sdp-refresh" title="Search again" aria-label="Search again"></button>
        <button type="button" class="sdp-close" title="Close" aria-label="Close"></button>
      </span>
    </div>
    <div class="sdp-steps"></div>
    <details class="sdp-details">
      <summary><span class="sdp-details-sum">Reading scene…</span><span class="sdp-details-tag">Details</span></summary>
      <div class="sdp-details-body"></div>
    </details>
    <div class="sdp-body"></div>
    <div class="sdp-panel-foot">
      <button type="button" class="sdp-try-harder" hidden></button>
    </div>`;
  panel.querySelector(".sdp-panel-head").prepend(icon("logo"));
  panel.querySelector(".sdp-refresh").appendChild(icon("refresh"));
  panel.querySelector(".sdp-close").appendChild(icon("close"));
  const steps = panel.querySelector(".sdp-steps");
  STEP_LABELS.forEach((label, i) => {
    const step = document.createElement("div");
    step.className = `sdp-step${i === 0 ? " sdp-current" : ""}`;
    step.append(textSpan("", "sdp-step-bar"), textSpan(`Pass ${i + 1}`, "sdp-step-num"), textSpan(label, "sdp-step-label"));
    steps.appendChild(step);
  });
  panel.querySelector(".sdp-close").addEventListener("click", closePanel);
  panel.querySelector(".sdp-refresh").addEventListener("click", () => onSearchClick({ fresh: true }));
  panel.querySelector(".sdp-try-harder").addEventListener("click", onTryHarderClick);
  document.body.appendChild(panel);

  const right = document.querySelector(".sdp-sidebar-right");
  if (right && right.querySelector(".sdp-sidebar-toggle") && !right.classList.contains("sdp-collapsed")) {
    right.dataset.sdpPanelCollapsed = "1";
    setSidebarCollapsed(right, true);
  }
  placePanel();
  return panel;
}

// Just above the dock, whose height depends on whether the Stash badge is in it.
function placePanel() {
  const panel = document.getElementById("sdp-panel");
  const dock = document.getElementById("sdp-dock");
  if (!panel || !dock) return;
  const bottom = Math.max(0, window.innerHeight - dock.getBoundingClientRect().top) + 12;
  panel.style.bottom = `${bottom}px`;
  panel.style.maxHeight = `calc(100vh - ${bottom + 160}px)`;
}

// Studio · date · performers, under the panel's title.
function setPanelSubtitle(panel, scene) {
  const bits = [];
  if (scene.studio) bits.push(scene.studio);
  if (scene.date) bits.push(scene.date);
  if (scene.females && scene.females.length) bits.push(scene.females.join(", "));
  const el = panel.querySelector(".sdp-subtitle");
  el.textContent = bits.join(" · ");
  el.title = el.textContent;
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

  const failed = queryStates.filter((qs) => qs.status === "error").length;
  const pending = queryStates.filter((qs) => qs.status === "pending").length;
  const sum = [`${queryStates.length} quer${queryStates.length === 1 ? "y" : "ies"}`];
  if (pending) sum.push(`${pending} running`);
  if (failed) sum.push(`${failed} failed`);
  if (counts) sum.push(`${counts.filtered} kept`);
  panel.querySelector(".sdp-details-sum").textContent = sum.join(" · ");

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
    block.className = `sdp-details-query sdp-q-${qs.status}`;
    block.open = qs.open === true;
    block.addEventListener("toggle", () => { qs.open = block.open; });

    const summary = document.createElement("summary");
    summary.className = "sdp-details-query-label";
    let status;
    if (qs.status === "pending") status = "searching…";
    else if (qs.status === "error") status = "failed";
    else status = `${qs.results.length} result${qs.results.length === 1 ? "" : "s"}`;
    const text = document.createElement("span");
    text.className = "sdp-details-query-text";
    text.textContent = qs.query;
    summary.append(text, status);
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
    addRow("Results", `${counts.total} found across all queries, ${counts.filtered} passed the ≥ ${MIN_SCORE}/${applicableCriteria(state.scene).length} filter`);
  }
}

// The action button walks through 3 stages: 1 = show "Try harder" (runs
// SECOND_PASS_QUERIES), 2 = show "Last chance" (runs the Last Chance
// search), 3 = nothing left — hide the button and show a sign-off message
// in its place instead. The pass steps at the top follow along.
const NO_LUCK_HTML = `<div class="sdp-no-luck">Kein Glück. Zeit für Plan B: die eigene Hand.</div>`;

// Stage 2's queries: the same idea as Stage 1 with parent studio and
// aliases, minus anything Stage 1 already tried.
function secondPassQueries(state) {
  return [...new Set(SECOND_PASS_QUERIES.map((q) => q.build(state.scene)).filter(Boolean))]
    .filter((q) => !state.triedQueries.has(q));
}

// `running`: the current stage's search is still going. Once the last one
// is done, all three steps show as done.
function updateSteps(panel, running) {
  const state = panel._sdpState;
  const stage = state ? state.stage : 1;
  const finished = !!state && stage >= 3 && !running;
  panel.querySelectorAll(".sdp-step").forEach((step, i) => {
    step.classList.toggle("sdp-done", i + 1 < stage || finished);
    step.classList.toggle("sdp-current", i + 1 === stage && !finished);
  });
}

function updateActionButton(panel) {
  const foot = panel.querySelector(".sdp-panel-foot");
  const btn = foot.querySelector(".sdp-try-harder");
  const state = panel._sdpState;

  updateSteps(panel, false);

  if (!state || state.stage >= 3) {
    btn.hidden = true;
    if (state && state.stage >= 3 && !foot.querySelector(".sdp-no-luck")) {
      foot.insertAdjacentHTML("beforeend", NO_LUCK_HTML);
    }
    return;
  }

  btn.hidden = false;
  let hint = "performers only";
  if (state.stage === 1) {
    const n = secondPassQueries(state).length;
    hint = n ? `+${n} quer${n === 1 ? "y" : "ies"}` : "nothing new to try";
  }
  btn.innerHTML = `<span></span><span class="sdp-try-hint"></span>`;
  btn.firstChild.textContent = state.stage === 1 ? "Try harder" : "Last chance";
  btn.lastChild.textContent = hint;
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
// `state` (not just `scene`) so it can show "Sent" for a release already
// grabbed, here or in any earlier search (see loadGrabbed).
function buildResultRow(r, state) {
  const scene = state.scene;
  const row = document.createElement("div");
  row.className = "sdp-row";
  // So Auto-Download can find the row of the release it picked.
  row._sdpRelease = r;

  // With more than one performer, show how much of the cast the release names ("Performer 2/3").
  const cast = scene.females.length > 1 ? ` ${countPerformers(releaseHay(r), scene)}/${scene.females.length}` : "";
  const matched = matchedCriteria(r, scene).map((label) => (label === "Performer" ? label + cast : label));
  const total = applicableCriteria(scene).length;
  const meta = [];
  if (typeof r.seeders === "number") meta.push(`${r.seeders} seeders`);
  else if (typeof r.grabs === "number") meta.push(`${r.grabs} grabs`);
  if (r.size) meta.push(fmtSize(r.size));
  if (r.indexer) meta.push(r.indexer);
  if (r.protocol) meta.push(r.protocol);
  // Shown everywhere (not just Stage 3) so it can be eyeballed over time
  // without yet affecting scoring anywhere — see ageDistanceDays.
  meta.push(ageLabel(r, scene));

  const info = document.createElement("div");
  info.className = "sdp-info";
  info.innerHTML = `<div class="sdp-rel-title"></div><div class="sdp-rel-meta"></div>`;
  info.querySelector(".sdp-rel-title").textContent = r.title || "(untitled release)";
  const metaEl = info.querySelector(".sdp-rel-meta");

  // One segment per scene fact, lit for each the release matches.
  const hits = document.createElement("span");
  hits.className = `sdp-hits${matched.length === total ? " sdp-full" : ""}`;
  hits.title = `${matched.length} of ${total} scene facts match${matched.length ? `: ${matched.join(", ")}` : ""}`;
  const pips = document.createElement("span");
  pips.className = "sdp-pips";
  for (let i = 0; i < total; i++) {
    const pip = document.createElement("span");
    pip.className = `sdp-pip${i < matched.length ? " sdp-on" : ""}`;
    pips.appendChild(pip);
  }
  const n = document.createElement("span");
  n.textContent = `${matched.length}/${total}`;
  hits.append(pips, n);
  metaEl.appendChild(hits);
  if (matched.length) {
    const which = document.createElement("span");
    which.className = "sdp-hits-which";
    which.textContent = matched.join(", ");
    metaEl.appendChild(which);
  }
  for (const bit of meta) {
    const span = document.createElement("span");
    span.textContent = bit;
    metaEl.appendChild(span);
  }

  const dl = document.createElement("button");
  dl.type = "button";
  dl.className = "sdp-dl";
  if (r.guid && state.grabbed.has(r.guid)) {
    setDownloadButton(dl, "sent");
    dl.disabled = true;
  } else {
    setDownloadButton(dl, "idle");
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
  if (state.stage === 1) return "Pass 1 · ranked by scene facts";
  if (state.stage === 2) return "Pass 1 + 2 · ranked by scene facts";
  return "Last chance · sorted by distance to the scene date";
}

// The download button's look per state; its text is static markup.
function setDownloadButton(btn, state) {
  btn.classList.toggle("sdp-done", state === "sent");
  btn.classList.toggle("sdp-error", state === "failed");
  if (state === "sent") btn.replaceChildren(icon("check"), textSpan("Sent"));
  else if (state === "sending") btn.replaceChildren(textSpan("Sending…"));
  else if (state === "failed") btn.replaceChildren(textSpan("Failed"));
  else btn.replaceChildren(icon("download"), textSpan("Download"));
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
    const criteriaList = applicableCriteria(scene).map((c) => c.label).join(", ");
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
      const name = document.createElement("span");
      name.className = "sdp-group-name";
      name.textContent = res === "other" ? "Other" : res;
      const n = sorted.filter((x) => resolutionOf(x) === res).length;
      const count = document.createElement("span");
      count.className = "sdp-group-count";
      count.textContent = `${n} release${n === 1 ? "" : "s"}`;
      h.append(name, count);
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

// Returns { ok, error } so Auto-Download can report the outcome.
async function grabRelease(btn, release, state) {
  btn.disabled = true;
  setDownloadButton(btn, "sending");
  try {
    const resp = await browser.runtime.sendMessage({ type: "grab", release });
    if (resp && resp.ok) {
      setDownloadButton(btn, "sent");
      // background.js persists it; this covers the panel that's already open.
      if (release.guid) state.grabbed.add(release.guid);
      return { ok: true };
    }
    setDownloadButton(btn, "failed");
    btn.title = (resp && resp.error) || "Grab failed";
    btn.disabled = false;
    return { ok: false, error: btn.title };
  } catch (e) {
    setDownloadButton(btn, "failed");
    btn.title = e.message;
    btn.disabled = false;
    return { ok: false, error: e.message };
  }
}

// Auto-Download: after a search, grabs the release autoPickRelease picks
// (every applicable hit, highest resolution, top of the list) through its
// own row's button, and says above the list what it did or why it didn't.
// Never twice for a scene: if any full-hit release was already sent, it
// leaves it at that.
async function maybeAutoDownload(panel, state) {
  const { autoDownload } = await browser.storage.local.get({ autoDownload: false });
  // The panel may have been closed or replaced (another scene) meanwhile.
  if (!autoDownload || !state.allResults.length || !panel.isConnected) return;

  const body = panel.querySelector(".sdp-body");
  const status = messageDiv("sdp-auto-status", "");
  body.prepend(status);
  const say = (text, cls) => {
    status.textContent = `Auto-Download: ${text}`;
    if (cls) status.classList.add(cls);
  };

  const scene = state.scene;
  const full = applicableCriteria(scene).length;
  const sent = state.allResults.find((r) => r.guid && state.grabbed.has(r.guid) && scoreRelease(r, scene) === full);
  if (sent) return say(`already sent "${sent.title}" — nothing new downloaded.`);

  const pick = autoPickRelease(state.allResults, scene);
  if (!pick) return say(`no release with all ${full}/${full} hits — pick one yourself.`);

  const row = [...body.querySelectorAll(".sdp-row")].find((el) => el._sdpRelease === pick);
  if (!row) return say(`couldn't find the row for "${pick.title}".`, "sdp-error");
  row.classList.add("sdp-auto-pick");
  row.scrollIntoView({ block: "nearest" });

  const label = `"${pick.title}" (${resolutionOf(pick)}, ${full}/${full} hits)`;
  say(`sending ${label}…`);
  const outcome = await grabRelease(row.querySelector(".sdp-dl"), pick, state);
  if (outcome.ok) say(`sent ${label} to Prowlarr.`, "sdp-done");
  else say(`sending ${label} failed: ${outcome.error}`, "sdp-error");
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
  let back = 0;
  showSearchProgress(back, queries.length);

  await Promise.all(queries.map((query, i) =>
    prowlarrSearch(query).then((outcome) => {
      showSearchProgress(++back, queries.length);
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
  showSearchProgress(0, 1);

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
  setPanelSubtitle(panel, state.scene);
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
// `auto: false` (Stashboard's auto-search link) skips Auto-Download.
async function onSearchClick({ fresh = false, auto = true } = {}) {
  const btn = document.getElementById("sdp-button");
  if (btn.disabled) return;
  btn.disabled = true;
  btn.innerHTML = `<span>Reading scene…</span>`;
  try {
    const sceneId = currentSceneId();
    if (!sceneId) return;
    const panel = ensurePanel();
    const grabbed = await loadGrabbed();
    const cached = fresh ? null : cachedScene(sceneId);
    if (cached) {
      restorePanel(panel, cached, grabbed);
      if (auto) await maybeAutoDownload(panel, cached.state);
      return;
    }

    // sceneId, not a fresh URL read: the user may have moved on during the awaits.
    const scene = await resolveSceneForPanel(panel, sceneId);
    if (!scene) return;
    setPanelSubtitle(panel, scene);

    const broadQueries = [...new Set(BROAD_QUERIES.map((q) => q.build(scene)).filter(Boolean))];
    const state = { scene, stage: 1, triedQueries: new Set(broadQueries), allResults: [], allQueryStates: [], grabbed };
    panel._sdpState = state;
    cacheScene(sceneId, state);

    await runQueryBatch(panel, state, broadQueries, "No performers or title found for this scene.");
    updateActionButton(panel);
    if (auto) await maybeAutoDownload(panel, state);
  } finally {
    btn.disabled = false;
    resetSearchButton();
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
  // The dock's button too: it shows this stage's progress, and a second
  // search shouldn't start on top of this one.
  const searchBtn = document.getElementById("sdp-button");
  btn.disabled = true;
  if (searchBtn) searchBtn.disabled = true;
  try {
    if (state.stage === 1) {
      const queries = secondPassQueries(state);
      queries.forEach((q) => state.triedQueries.add(q));
      state.stage = 2;
      updateSteps(panel, true);
      await runQueryBatch(panel, state, queries, "Nothing new to try — no parent studio or aliases available.");
    } else if (state.stage === 2) {
      state.stage = 3;
      updateSteps(panel, true);
      await runLastChanceSearch(panel, state);
    }
    updateActionButton(panel);
  } finally {
    btn.disabled = false;
    if (searchBtn) searchBtn.disabled = false;
    resetSearchButton();
  }
}
