// Runs background.js against stubbed browser.* and fetch, the way Firefox
// loads it: common.js and background.js sharing one global.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function loadBackground({ fetch }) {
  const store = { prowlarrUrl: "http://prowlarr", apiKey: "key" };
  let onMessage;
  const browser = {
    storage: {
      local: {
        // Async with a real delay, so concurrent callers interleave like they do in Firefox.
        async get(defaults) {
          await tick();
          return JSON.parse(JSON.stringify({ ...defaults, ...store }));
        },
        async set(values) {
          await tick();
          Object.assign(store, JSON.parse(JSON.stringify(values)));
        }
      }
    },
    contextMenus: { create() {}, onClicked: { addListener() {} } },
    runtime: { onMessage: { addListener: (fn) => { onMessage = fn; } } },
    tabs: {}
  };
  const context = vm.createContext({
    browser, fetch, console, setTimeout, clearTimeout, AbortController, URLSearchParams
  });
  for (const file of ["common.js", "background.js"]) {
    vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context, { filename: file });
  }
  return { store, send: (msg) => onMessage(msg) };
}

const ok = (body = "") => ({ ok: true, status: 200, statusText: "OK", text: async () => body });

test("two grabs in quick succession are both remembered", async () => {
  const { store, send } = loadBackground({ fetch: async () => ok() });
  const results = await Promise.all([
    send({ type: "grab", release: { guid: "a", indexerId: 1 } }),
    send({ type: "grab", release: { guid: "b", indexerId: 1 } })
  ]);
  assert.deepEqual(results.map((r) => r.ok), [true, true]);
  for (let i = 0; i < 20; i++) await tick();
  assert.deepEqual(Object.keys(store.grabbed).sort(), ["a", "b"]);
});

test("a failed grab is not remembered", async () => {
  const { store, send } = loadBackground({
    fetch: async () => ({ ok: false, status: 500, statusText: "Error", text: async () => "" })
  });
  const result = await send({ type: "grab", release: { guid: "a", indexerId: 1 } });
  assert.equal(result.ok, false);
  for (let i = 0; i < 20; i++) await tick();
  assert.equal(store.grabbed, undefined);
});
