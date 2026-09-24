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

async function test() {
  await save();
  setStatus("Testing…", "");
  const resp = await browser.runtime.sendMessage({ type: "test" });
  if (resp && resp.ok) {
    setStatus(`Connected${resp.info && resp.info.version ? " (Prowlarr " + resp.info.version + ")" : ""}.`, "ok");
  } else {
    setStatus((resp && resp.error) || "Connection failed.", "err");
  }
}

async function testStash() {
  await save();
  setStatus("Testing…", "");
  const resp = await browser.runtime.sendMessage({ type: "testStash" });
  if (resp && resp.ok) {
    setStatus(`Connected${resp.info && resp.info.version ? " (Stash " + resp.info.version + ")" : ""}.`, "ok");
  } else {
    setStatus((resp && resp.error) || "Connection failed.", "err");
  }
}

$("save").addEventListener("click", save);
$("test").addEventListener("click", test);
$("testStash").addEventListener("click", testStash);
load();
