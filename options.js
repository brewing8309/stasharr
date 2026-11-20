const DEFAULTS = { prowlarrUrl: "", apiKey: "", categories: "6000", searchLimit: "200", requestTimeout: "25", stashUrl: "", stashApiKey: "" };

const $ = (id) => document.getElementById(id);

async function load() {
  const cfg = await browser.storage.local.get(DEFAULTS);
  $("prowlarrUrl").value = cfg.prowlarrUrl || "";
  $("apiKey").value = cfg.apiKey || "";
  $("categories").value = cfg.categories ?? "6000";
  $("searchLimit").value = cfg.searchLimit ?? "200";
  $("requestTimeout").value = cfg.requestTimeout ?? "25";
  $("stashUrl").value = cfg.stashUrl || "";
  $("stashApiKey").value = cfg.stashApiKey || "";
  showUrlWarnings();
  const missing = await missingAccess();
  if (missing.length) {
    setStatus(`No access to ${missing.join(" and ")} yet: press Save settings and allow it.`, "err");
  }
}

const URL_FIELDS = [["prowlarrUrl", "Prowlarr"], ["stashUrl", "Stash"]];

// The host patterns for the URLs as typed, for the permission request.
function accessPatterns() {
  return URL_FIELDS.map(([id]) => hostPattern($(id).value)).filter(Boolean);
}

async function missingAccess() {
  const missing = [];
  for (const [id, product] of URL_FIELDS) {
    const pattern = hostPattern($(id).value);
    if (pattern && !(await browser.permissions.contains({ origins: [pattern] }))) missing.push(product);
  }
  return missing;
}

// Firefox only shows the permission prompt when it's asked for straight from
// the click, before anything has been awaited, so handlers call this first.
function requestAccess() {
  const origins = accessPatterns();
  return origins.length ? browser.permissions.request({ origins }) : Promise.resolve(true);
}

function showUrlWarnings() {
  for (const [id, product] of URL_FIELDS) {
    const value = $(id).value.trim();
    let warning = "";
    if (value && !hostPattern(value)) {
      warning = "Must start with http:// or https://.";
    } else if (isCleartextRemote(value)) {
      warning = `Plain http: the ${product} API key travels unencrypted over the network. Prefer https.`;
    }
    $(`${id}Warn`).textContent = warning;
  }
}

function setStatus(msg, cls, id = "status") {
  const el = $(id);
  el.textContent = msg;
  el.className = `status ${cls || ""}`.trim();
}

async function save(access = Promise.resolve(true)) {
  showUrlWarnings();
  for (const [id, product] of URL_FIELDS) {
    const value = $(id).value.trim();
    if (value && !hostPattern(value)) throw new Error(`${product} URL must start with http:// or https://.`);
  }
  const granted = await access;
  const limit = parseInt($("searchLimit").value, 10);
  const timeout = parseInt($("requestTimeout").value, 10);
  await browser.storage.local.set({
    prowlarrUrl: $("prowlarrUrl").value.trim().replace(/\/+$/, ""),
    apiKey: $("apiKey").value.trim(),
    categories: $("categories").value.trim(),
    searchLimit: String(Number.isFinite(limit) && limit > 0 ? limit : 200),
    requestTimeout: String(Number.isFinite(timeout) && timeout > 0 ? timeout : 25),
    stashUrl: $("stashUrl").value.trim().replace(/\/+$/, ""),
    stashApiKey: $("stashApiKey").value.trim()
  });
  if (!granted) throw new Error("Saved, but access was not allowed: stasharr can't reach Prowlarr or Stash until you do.");
  setStatus("Saved.", "ok");
}

// A rejected sendMessage (background not ready, extension just reloaded)
// would otherwise leave "Testing…" on screen with the error only in the console.
// The result shows next to the section's own Test button.
async function testConnection(type, product, statusId, access) {
  try {
    await save(access);
    setStatus("Testing…", "", statusId);
    const resp = await browser.runtime.sendMessage({ type });
    if (resp && resp.ok) {
      setStatus(`Connected${resp.info && resp.info.version ? ` (${product} ${resp.info.version})` : ""}.`, "ok", statusId);
    } else {
      setStatus((resp && resp.error) || "Connection failed.", "err", statusId);
    }
  } catch (e) {
    setStatus(e.message || "Connection failed.", "err", statusId);
  }
}

$("save").addEventListener("click", () => save(requestAccess()).catch((e) => setStatus(e.message, "err")));
$("test").addEventListener("click", () => testConnection("test", "Prowlarr", "statusProwlarr", requestAccess()));
$("testStash").addEventListener("click", () => testConnection("testStash", "Stash", "statusStash", requestAccess()));
for (const [id] of URL_FIELDS) $(id).addEventListener("input", showUrlWarnings);
$("version").textContent = `v${browser.runtime.getManifest().version} · settings`;
load().catch((e) => setStatus(`Could not load settings: ${e.message}`, "err"));
