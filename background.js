/*
 * Background script.
 *
 * Content scripts on stashdb.org cannot talk to a Prowlarr instance directly
 * (cross-origin), so all Prowlarr requests are proxied through here. The
 * <all_urls> host permission lets us reach whatever Prowlarr URL the user
 * configured on the options page.
 */

const DEFAULTS = {
  prowlarrUrl: "",
  apiKey: "",
  // Newznab/Torznab XXX category. Prowlarr accepts a comma separated list.
  categories: "6000"
};

async function getConfig() {
  const cfg = await browser.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...cfg };
}

function normalizeBase(url) {
  return (url || "").trim().replace(/\/+$/, "");
}

async function prowlarrFetch(path, { method = "GET", body = null } = {}) {
  const cfg = await getConfig();
  const base = normalizeBase(cfg.prowlarrUrl);
  if (!base) throw new Error("Prowlarr URL is not configured. Open the extension options.");
  if (!cfg.apiKey) throw new Error("Prowlarr API key is not configured. Open the extension options.");

  const res = await fetch(base + path, {
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
    default:
      return Promise.resolve({ ok: false, error: "Unknown message type" });
  }
});
