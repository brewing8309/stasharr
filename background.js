/*
 * Background script.
 *
 * Content scripts on stashdb.org cannot talk to a Prowlarr or Stash instance
 * directly (cross-origin), so all requests are proxied through here. The
 * <all_urls> host permission lets us reach whatever URLs the user configured
 * on the options page.
 */

const DEFAULTS = {
  prowlarrUrl: "",
  apiKey: "",
  // Newznab/Torznab XXX category. Prowlarr accepts a comma separated list.
  categories: "6000",
  // Max releases per Prowlarr search request. A broad "performers only"
  // search (Stage 3) can exceed this for a prolific performer, in which
  // case the extra results simply aren't returned by Prowlarr at all —
  // raising this gives Stage 3's age-based sort more to work with.
  searchLimit: "200",
  // Seconds before a request to any backend is aborted.
  requestTimeout: "25",
  // The user's own StashApp instance, used to check whether a StashDB scene
  // has already been downloaded.
  stashUrl: "",
  stashApiKey: ""
};

// The stash-box endpoint URL StashApp records on scenes it scraped from
// StashDB — matches the "Stash-boxes" entry a Stash user would configure to
// scrape StashDB.
const STASHDB_ENDPOINT = "https://stashdb.org/graphql";

async function getConfig() {
  const cfg = await browser.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...cfg };
}

function normalizeBase(url) {
  return (url || "").trim().replace(/\/+$/, "");
}

// Prowlarr/Stash requests can otherwise hang indefinitely on a dead
// indexer or an unreachable instance, leaving the caller (and, in the
// content script, a spinner) stuck forever. Read per request rather than
// passed in by callers, so all three backends (Prowlarr, Stash, StashDB)
// honour the setting without threading it through.
async function requestTimeoutMs() {
  const cfg = await getConfig();
  const seconds = parseInt(cfg.requestTimeout, 10);
  return (Number.isFinite(seconds) && seconds > 0 ? seconds : 25) * 1000;
}

async function fetchWithTimeout(url, options) {
  const timeoutMs = await requestTimeoutMs();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    if (e.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs / 1000}s: ${url}`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function prowlarrFetch(path, { method = "GET", body = null } = {}) {
  const cfg = await getConfig();
  const base = normalizeBase(cfg.prowlarrUrl);
  if (!base) throw new Error("Prowlarr URL is not configured. Open the extension options.");
  if (!cfg.apiKey) throw new Error("Prowlarr API key is not configured. Open the extension options.");

  const res = await fetchWithTimeout(base + path, {
    method,
    headers: {
      "X-Api-Key": cfg.apiKey,
      "Accept": "application/json",
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Prowlarr ${method} ${path} failed: ${res.status} ${res.statusText}${text ? " – " + text.slice(0, 300) : ""}`);
  }
  return text ? JSON.parse(text) : null;
}

async function search(query) {
  const cfg = await getConfig();
  const limit = parseInt(cfg.searchLimit, 10);
  const params = new URLSearchParams({
    query,
    type: "search",
    limit: String(Number.isFinite(limit) && limit > 0 ? limit : 200),
    offset: "0"
  });
  const cats = (cfg.categories || "").trim();
  if (cats) {
    for (const c of cats.split(",").map((s) => s.trim()).filter(Boolean)) {
      params.append("categories", c);
    }
  }
  const results = await prowlarrFetch(`/api/v1/search?${params.toString()}`);
  return Array.isArray(results) ? results : [];
}

async function grab(release) {
  // Prowlarr grabs a release via POST /api/v1/search with the guid + indexerId.
  const body = { guid: release.guid, indexerId: release.indexerId };
  await prowlarrFetch(`/api/v1/search`, { method: "POST", body });
  if (release.guid) {
    // Best-effort: failing to persist mustn't turn a successful grab into "Failed".
    rememberGrabbed(release.guid).catch((e) => console.warn("[StashDB→Prowlarr] Could not remember grab:", e.message));
  }
}

// GUIDs of releases already sent to Prowlarr ({ guid: sentAt }), read by
// content.js so a new search, another tab or a reload can't offer them
// again. Written only here, one write at a time: two grabs in quick
// succession would otherwise both read the old map and the second write
// would drop the first.
let grabbedWrites = Promise.resolve();

function rememberGrabbed(guid) {
  const write = grabbedWrites.then(async () => {
    const { grabbed } = await browser.storage.local.get({ grabbed: {} });
    const next = pruneGrabbed(grabbed, Date.now(), GRABBED_MAX_AGE_MS);
    next[guid] = Date.now();
    await browser.storage.local.set({ grabbed: next });
  });
  grabbedWrites = write.catch(() => {});
  return write;
}

async function testConnection() {
  const status = await prowlarrFetch(`/api/v1/system/status`);
  return { version: status && status.version };
}

/* ------------------------------------------------------------------ *
 * StashApp: check whether a StashDB scene is already downloaded       *
 * ------------------------------------------------------------------ */

function stashAuthHeaders(cfg) {
  return cfg.stashApiKey ? { "ApiKey": cfg.stashApiKey } : {};
}

async function stashFetch(query, variables) {
  const cfg = await getConfig();
  const base = normalizeBase(cfg.stashUrl);
  if (!base) throw new Error("Stash URL is not configured. Open the extension options.");

  const res = await fetchWithTimeout(base + "/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      ...stashAuthHeaders(cfg)
    },
    body: JSON.stringify({ query, variables })
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Stash request failed: ${res.status} ${res.statusText}${text ? " – " + text.slice(0, 300) : ""}`);
  }
  const json = text ? JSON.parse(text) : null;
  if (json && json.errors && json.errors.length) {
    throw new Error(json.errors[0].message);
  }
  return json && json.data;
}

// StashApp has used `stash_id_endpoint` (endpoint + stash_id) to filter
// scenes by stash-box ID for a while; older instances only understand the
// plain `stash_id` filter. Try the modern shape first and fall back.
async function findSceneByStashId(stashId) {
  const modernQuery = `query FindByStashId($endpoint: String!, $stashId: String!) {
    findScenes(scene_filter: { stash_id_endpoint: { endpoint: $endpoint, stash_id: $stashId, modifier: EQUALS } }, filter: { per_page: 1 }) {
      scenes { id title files { height width } }
    }
  }`;
  const legacyQuery = `query FindByStashId($stashId: String!) {
    findScenes(scene_filter: { stash_id: { value: $stashId, modifier: EQUALS } }, filter: { per_page: 1 }) {
      scenes { id title files { height width } }
    }
  }`;

  let data;
  try {
    data = await stashFetch(modernQuery, { endpoint: STASHDB_ENDPOINT, stashId });
  } catch (e) {
    data = await stashFetch(legacyQuery, { stashId });
  }
  return data && data.findScenes && data.findScenes.scenes && data.findScenes.scenes[0];
}

function sceneHeight(scene) {
  const heights = (scene.files || [])
    .map((f) => f.height)
    .filter((h) => typeof h === "number" && h > 0);
  return heights.length ? Math.max(...heights) : null;
}

function heightLabel(height) {
  if (!height) return "unknown resolution";
  if (height >= 2000) return "2160p";
  if (height >= 1000) return "1080p";
  if (height >= 700) return "720p";
  return `${height}p`;
}

async function checkStashScene(stashId) {
  const cfg = await getConfig();
  const base = normalizeBase(cfg.stashUrl);
  if (!base) return null; // Stash not configured — nothing to check.

  const scene = await findSceneByStashId(stashId);
  if (!scene) return null;

  return {
    id: scene.id,
    title: scene.title,
    resolution: heightLabel(sceneHeight(scene)),
    url: `${base}/scenes/${scene.id}`
  };
}

/* ------------------------------------------------------------------ *
 * StashApp: the performers' other scenes, for the sidebars shown on   *
 * StashDB scene pages                                                 *
 * ------------------------------------------------------------------ */

// Matched by the StashDB ID Stash records when a performer is tagged from
// StashDB, never by name: a same-named performer may be someone else.
// stash_id_endpoint is deprecated in recent Stash in favour of
// stash_ids_endpoint, but still served, and older instances only know it.
async function findPerformerByStashId(stashId) {
  const data = await stashFetch(`query FindPerformerByStashId($endpoint: String!, $stashId: String!) {
    findPerformers(performer_filter: { stash_id_endpoint: { endpoint: $endpoint, stash_id: $stashId, modifier: EQUALS } }, filter: { per_page: 1 }) {
      performers { id name }
    }
  }`, { endpoint: STASHDB_ENDPOINT, stashId });
  return data && data.findPerformers && data.findPerformers.performers[0];
}

// Newest first. The scene being viewed is left out (it already has its own
// badge), from the count as well as the list.
async function findPerformerScenes(performerId, excludeSceneId) {
  const sceneFilter = { performers: { value: [performerId], modifier: "INCLUDES" } };
  if (excludeSceneId) sceneFilter.id = { value: Number(excludeSceneId), modifier: "NOT_EQUALS" };
  const data = await stashFetch(`query PerformerScenes($sceneFilter: SceneFilterType!, $perPage: Int!) {
    findScenes(scene_filter: $sceneFilter, filter: { per_page: $perPage, sort: "date", direction: DESC }) {
      count
      scenes { id title date files { basename } }
    }
  }`, { sceneFilter, perPage: SIDEBAR_SCENES });
  return (data && data.findScenes) || { count: 0, scenes: [] };
}

// `performers` are { id, name } with StashDB IDs (see sidebarPerformers).
// Returns one entry per performer, in the same order, or null where there's
// nothing to show: not in Stash, no other scenes there, or the lookup failed.
async function stashPerformerScenes(sceneStashId, performers) {
  const cfg = await getConfig();
  const base = normalizeBase(cfg.stashUrl);
  if (!base) return [];

  const current = await findSceneByStashId(sceneStashId).catch(() => null);
  return Promise.all((performers || []).slice(0, SIDEBAR_PERFORMERS).map(async (p) => {
    try {
      const performer = await findPerformerByStashId(p.id);
      if (!performer) return null;
      const found = await findPerformerScenes(performer.id, current && current.id);
      if (!found.count || !found.scenes.length) return null;
      return {
        name: performer.name || p.name,
        url: `${base}/performers/${performer.id}`,
        count: found.count,
        scenes: found.scenes.map((s) => ({
          id: s.id,
          title: stashSceneLabel(s),
          date: s.date || "",
          url: `${base}/scenes/${s.id}`
        }))
      };
    } catch (e) {
      console.warn(`[StashDB→Prowlarr] Stash lookup for ${p.name || p.id} failed:`, e.message);
      return null;
    }
  }));
}

// Screenshots are fetched here rather than linked from the page: stashdb.org
// is HTTPS and a local Stash usually isn't (Firefox won't load that as mixed
// content), and the API key would have to go into the URL, readable by any
// script on stashdb.org. Scaled down, since a full-size screenshot is a few
// hundred KB to pass to the page for a 180px wide thumbnail.
const THUMB_WIDTH = 360;

async function stashSceneThumb(sceneId) {
  const cfg = await getConfig();
  const base = normalizeBase(cfg.stashUrl);
  if (!base) throw new Error("Stash URL is not configured. Open the extension options.");
  if (!/^\d+$/.test(String(sceneId))) throw new Error(`Invalid Stash scene ID: ${sceneId}`);

  const res = await fetchWithTimeout(`${base}/scene/${sceneId}/screenshot`, { headers: stashAuthHeaders(cfg) });
  if (!res.ok) throw new Error(`Stash screenshot request failed: ${res.status} ${res.statusText}`);
  const blob = await res.blob();
  try {
    return await shrinkImage(blob, THUMB_WIDTH);
  } catch (e) {
    return blobToDataUrl(blob);
  }
}

async function shrinkImage(blob, width) {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, width / bitmap.width);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL("image/jpeg", 0.85);
}

async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return `data:${blob.type || "image/jpeg"};base64,${btoa(binary)}`;
}

async function testStashConnection() {
  const data = await stashFetch(`query { version { version } }`, {});
  return { version: data && data.version && data.version.version };
}

/* ------------------------------------------------------------------ *
 * "Search StashDB for selection": right-click a text selection on any   *
 * page to find the matching StashDB scene, shown in a small picker      *
 * panel injected into that page (see picker.js). Unlike the Prowlarr/   *
 * Stash proxying above, this always talks to the fixed stash-box        *
 * endpoint, not a user-configured URL.                                  *
 * ------------------------------------------------------------------ */

async function stashdbFetch(query, variables) {
  const res = await fetchWithTimeout(STASHDB_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    credentials: "include",
    body: JSON.stringify({ query, variables })
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`StashDB request failed: ${res.status} ${res.statusText}${text ? " – " + text.slice(0, 300) : ""}`);
  }
  const json = text ? JSON.parse(text) : null;
  if (json && json.errors && json.errors.length) {
    throw new Error(json.errors[0].message);
  }
  return json && json.data;
}

// searchScenes returns a QueryScenesResultType wrapper ({ count, scenes }),
// not a bare scene list — only the deprecated searchScene does that.
const SEARCH_SCENES_QUERY = `query SearchScenes($term: String!) {
  searchScenes(term: $term, limit: 8) {
    scenes {
      id
      title
      release_date
      studio { name }
      performers { performer { name } }
      images { url }
    }
  }
}`;

async function searchStashDBScenes(term) {
  const data = await stashdbFetch(SEARCH_SCENES_QUERY, { term });
  const scenes = (data && data.searchScenes && data.searchScenes.scenes) || [];
  return scenes.map((s) => ({
    id: s.id,
    title: s.title || "",
    date: s.release_date || "",
    studio: s.studio ? s.studio.name : "",
    performers: (s.performers || []).map((p) => p.performer && p.performer.name).filter(Boolean),
    image: s.images && s.images[0] ? s.images[0].url : null
  }));
}

async function handleSelectionSearch(rawText, tabId) {
  const term = cleanSelectionText(rawText);
  let payload;
  if (!term) {
    payload = { raw: rawText, term, error: "Nothing searchable in the selected text." };
  } else {
    try {
      payload = { raw: rawText, term, matches: await searchStashDBScenes(term) };
    } catch (e) {
      payload = { raw: rawText, term, error: e.message };
    }
  }

  try {
    await browser.tabs.insertCSS(tabId, { file: "content.css" });
    await browser.tabs.executeScript(tabId, { file: "picker.js" });
    await browser.tabs.sendMessage(tabId, { type: "sdpShowCandidates", ...payload });
  } catch (e) {
    // Restricted pages (about:, addons.mozilla.org, ...) can't be injected
    // into — nothing sensible to show the user there anyway.
    console.warn("[StashDB→Prowlarr] Could not show picker panel:", e.message);
  }
}

browser.contextMenus.create({
  id: "sdp-search-selection",
  title: 'Search StashDB for "%s"',
  contexts: ["selection"]
});

browser.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "sdp-search-selection" && tab && tab.id != null) {
    handleSelectionSearch(info.selectionText, tab.id);
  }
});

browser.runtime.onMessage.addListener((msg) => {
  switch (msg && msg.type) {
    case "search":
      return search(msg.query).then(
        (results) => ({ ok: true, results }),
        (err) => ({ ok: false, error: err.message })
      );
    case "grab":
      return grab(msg.release).then(
        () => ({ ok: true }),
        (err) => ({ ok: false, error: err.message })
      );
    case "test":
      return testConnection().then(
        (info) => ({ ok: true, info }),
        (err) => ({ ok: false, error: err.message })
      );
    case "checkStash":
      return checkStashScene(msg.stashId).then(
        (scene) => ({ ok: true, scene }),
        (err) => ({ ok: false, error: err.message })
      );
    case "stashPerformerScenes":
      return stashPerformerScenes(msg.sceneStashId, msg.performers).then(
        (performers) => ({ ok: true, performers }),
        (err) => ({ ok: false, error: err.message })
      );
    case "stashSceneThumb":
      return stashSceneThumb(msg.sceneId).then(
        (dataUrl) => ({ ok: true, dataUrl }),
        (err) => ({ ok: false, error: err.message })
      );
    case "testStash":
      return testStashConnection().then(
        (info) => ({ ok: true, info }),
        (err) => ({ ok: false, error: err.message })
      );
    default:
      return Promise.resolve({ ok: false, error: "Unknown message type" });
  }
});
