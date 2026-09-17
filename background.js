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
// content script, a spinner) stuck forever.
const REQUEST_TIMEOUT_MS = 20000;

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    if (e.name === "AbortError") {
      throw new Error(`Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s: ${url}`);
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
  const params = new URLSearchParams({
    query,
    type: "search",
    limit: "200",
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
  return prowlarrFetch(`/api/v1/search`, { method: "POST", body });
}

async function testConnection() {
  const status = await prowlarrFetch(`/api/v1/system/status`);
  return { version: status && status.version };
}

/* ------------------------------------------------------------------ *
 * StashApp: check whether a StashDB scene is already downloaded       *
 * ------------------------------------------------------------------ */

async function stashFetch(query, variables) {
  const cfg = await getConfig();
  const base = normalizeBase(cfg.stashUrl);
  if (!base) throw new Error("Stash URL is not configured. Open the extension options.");

  const res = await fetchWithTimeout(base + "/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      ...(cfg.stashApiKey ? { "ApiKey": cfg.stashApiKey } : {})
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

async function testStashConnection() {
  const data = await stashFetch(`query { version { version } }`, {});
  return { version: data && data.version && data.version.version };
}

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
    case "testStash":
      return testStashConnection().then(
        (info) => ({ ok: true, info }),
        (err) => ({ ok: false, error: err.message })
      );
    default:
      return Promise.resolve({ ok: false, error: "Unknown message type" });
  }
});
