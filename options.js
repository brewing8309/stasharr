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
}

function setStatus(msg, cls) {
  const el = $("status");
  el.textContent = msg;
  el.className = cls || "";
}

async function save() {
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
  setStatus("Saved.", "ok");
}

// A rejected sendMessage (background not ready, extension just reloaded)
// would otherwise leave "Testing…" on screen with the error only in the console.
async function testConnection(type, product) {
  try {
    await save();
    setStatus("Testing…", "");
    const resp = await browser.runtime.sendMessage({ type });
    if (resp && resp.ok) {
      setStatus(`Connected${resp.info && resp.info.version ? ` (${product} ${resp.info.version})` : ""}.`, "ok");
    } else {
      setStatus((resp && resp.error) || "Connection failed.", "err");
    }
  } catch (e) {
    setStatus(e.message || "Connection failed.", "err");
  }
}

$("save").addEventListener("click", () => save().catch((e) => setStatus(e.message, "err")));
$("test").addEventListener("click", () => testConnection("test", "Prowlarr"));
$("testStash").addEventListener("click", () => testConnection("testStash", "Stash"));
load().catch((e) => setStatus(`Could not load settings: ${e.message}`, "err"));
