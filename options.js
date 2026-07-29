const DEFAULTS = { prowlarrUrl: "", apiKey: "", categories: "6000" };

const $ = (id) => document.getElementById(id);

async function load() {
  const cfg = await browser.storage.local.get(DEFAULTS);
  $("prowlarrUrl").value = cfg.prowlarrUrl || "";
  $("apiKey").value = cfg.apiKey || "";
  $("categories").value = cfg.categories ?? "6000";
}

function setStatus(msg, cls) {
  const el = $("status");
  el.textContent = msg;
  el.className = cls || "";
}

async function save() {
  await browser.storage.local.set({
    prowlarrUrl: $("prowlarrUrl").value.trim().replace(/\/+$/, ""),
    apiKey: $("apiKey").value.trim(),
    categories: $("categories").value.trim()
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

$("save").addEventListener("click", save);
$("test").addEventListener("click", test);
load();
