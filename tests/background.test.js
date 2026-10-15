// Runs background.js against stubbed browser.* and fetch, the way Firefox
// loads it: common.js and background.js sharing one global.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function loadBackground({ fetch, settings = {} }) {
  const store = { prowlarrUrl: "http://prowlarr", apiKey: "key", ...settings };
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
    browser, fetch, console, setTimeout, clearTimeout, AbortController, URLSearchParams, btoa
  });
  for (const file of ["common.js", "background.js"]) {
    vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context, { filename: file });
  }
  // Message replies reach the caller as a copy (structured clone), not as
  // objects from the background script's own realm.
  return { store, send: async (msg) => JSON.parse(JSON.stringify(await onMessage(msg))) };
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

// A Stash GraphQL server stub: answers by which query was sent and records
// every request, so tests can check the filters the background script used.
function stashStub({ currentScene, performers = {}, scenes = {} }) {
  const requests = [];
  const fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ url, headers: options.headers || {}, body });
    if (url.endsWith("/screenshot")) {
      return { ok: true, status: 200, statusText: "OK", blob: async () => new Blob(["jpg"], { type: "image/jpeg" }) };
    }
    let data;
    if (body.query.includes("findPerformers")) {
      const p = performers[body.variables.stashId];
      data = { findPerformers: { performers: p ? [p] : [] } };
    } else if (body.query.includes("PerformerScenes")) {
      const id = body.variables.sceneFilter.performers.value[0];
      data = { findScenes: scenes[id] || { count: 0, scenes: [] } };
    } else {
      data = { findScenes: { scenes: currentScene ? [currentScene] : [] } };
    }
    return ok(JSON.stringify({ data }));
  };
  return { fetch, requests };
}

const stashSettings = { stashUrl: "http://stash:9999/", stashApiKey: "secret" };

test("performer sidebars come from Stash by StashDB ID, without the scene being viewed", async () => {
  const stub = stashStub({
    currentScene: { id: "42", title: "This one", files: [] },
    performers: { "sdb-jane": { id: "5", name: "Jane Doe" } },
    scenes: {
      5: {
        count: 9,
        scenes: [
          { id: "11", title: "Newest", date: "2026-09-01", files: [] },
          { id: "10", title: "", date: null, files: [{ basename: "old.mp4" }] }
        ]
      }
    }
  });
  const { send } = loadBackground({ fetch: stub.fetch, settings: stashSettings });
  const resp = await send({
    type: "stashPerformerScenes",
    sceneStashId: "scene-uuid",
    performers: [{ id: "sdb-jane", name: "Jane Doe" }, { id: "sdb-unknown", name: "Not In Stash" }]
  });

  assert.equal(resp.ok, true);
  assert.deepEqual(resp.performers, [
    {
      name: "Jane Doe",
      url: "http://stash:9999/performers/5",
      count: 9,
      scenes: [
        { id: "11", title: "Newest", date: "2026-09-01", url: "http://stash:9999/scenes/11" },
        { id: "10", title: "old.mp4", date: "", url: "http://stash:9999/scenes/10" }
      ]
    },
    null
  ]);

  const performerLookup = stub.requests.find((r) => r.body && r.body.query.includes("findPerformers"));
  assert.match(performerLookup.body.query, /stash_id_endpoint: \{ endpoint: \$endpoint, stash_id: \$stashId, modifier: EQUALS \}/);
  assert.deepEqual(performerLookup.body.variables, { endpoint: "https://stashdb.org/graphql", stashId: "sdb-jane" });
  assert.equal(performerLookup.headers.ApiKey, "secret");

  const sceneLookup = stub.requests.find((r) => r.body && r.body.query.includes("PerformerScenes"));
  assert.deepEqual(sceneLookup.body.variables, {
    sceneFilter: {
      performers: { value: ["5"], modifier: "INCLUDES" },
      id: { value: 42, modifier: "NOT_EQUALS" }
    },
    perPage: 4
  });
});

test("a performer with no other scenes in Stash gets no sidebar", async () => {
  const stub = stashStub({
    performers: { "sdb-jane": { id: "5", name: "Jane Doe" } },
    scenes: { 5: { count: 0, scenes: [] } }
  });
  const { send } = loadBackground({ fetch: stub.fetch, settings: stashSettings });
  const resp = await send({ type: "stashPerformerScenes", sceneStashId: "s", performers: [{ id: "sdb-jane", name: "Jane Doe" }] });
  assert.deepEqual(resp, { ok: true, performers: [null] });
  // The scene isn't in Stash, so there's nothing to leave out.
  const sceneLookup = stub.requests.find((r) => r.body && r.body.query.includes("PerformerScenes"));
  assert.equal(sceneLookup.body.variables.sceneFilter.id, undefined);
});

test("without a Stash URL there are no sidebars and no requests", async () => {
  const stub = stashStub({});
  const { send } = loadBackground({ fetch: stub.fetch });
  const resp = await send({ type: "stashPerformerScenes", sceneStashId: "s", performers: [{ id: "a", name: "A" }] });
  assert.deepEqual(resp, { ok: true, performers: [] });
  assert.equal(stub.requests.length, 0);
});

test("thumbnails are fetched from Stash with the API key and handed over as a data URL", async () => {
  const stub = stashStub({});
  const { send } = loadBackground({ fetch: stub.fetch, settings: stashSettings });
  const resp = await send({ type: "stashSceneThumb", sceneId: "11" });
  assert.deepEqual(resp, { ok: true, dataUrl: "data:image/jpeg;base64," + Buffer.from("jpg").toString("base64") });
  assert.equal(stub.requests[0].url, "http://stash:9999/scene/11/screenshot");
  assert.equal(stub.requests[0].headers.ApiKey, "secret");
});

test("thumbnails only accept numeric Stash scene IDs", async () => {
  const stub = stashStub({});
  const { send } = loadBackground({ fetch: stub.fetch, settings: stashSettings });
  const resp = await send({ type: "stashSceneThumb", sceneId: "../../graphql" });
  assert.equal(resp.ok, false);
  assert.equal(stub.requests.length, 0);
});
