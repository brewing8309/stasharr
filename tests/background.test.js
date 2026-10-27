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
  const storageListeners = [];
  // Content scripts registered through browser.contentScripts, live ones only.
  const registered = [];
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
          const changes = Object.fromEntries(Object.keys(values).map((k) => [k, { oldValue: store[k], newValue: values[k] }]));
          Object.assign(store, JSON.parse(JSON.stringify(values)));
          storageListeners.forEach((fn) => fn(changes, "local"));
        }
      },
      onChanged: { addListener: (fn) => storageListeners.push(fn) }
    },
    contentScripts: {
      async register(options) {
        await tick();
        const entry = { options: JSON.parse(JSON.stringify(options)) };
        registered.push(entry);
        return { unregister: async () => { registered.splice(registered.indexOf(entry), 1); } };
      }
    },
    contextMenus: { create() {}, onClicked: { addListener() {} } },
    runtime: { onMessage: { addListener: (fn) => { onMessage = fn; } } },
    tabs: {}
  };
  const context = vm.createContext({
    browser, fetch, console, setTimeout, clearTimeout, AbortController, URL, URLSearchParams, btoa
  });
  for (const file of ["common.js", "background.js"]) {
    vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context, { filename: file });
  }
  // Message replies reach the caller as a copy (structured clone), not as
  // objects from the background script's own realm.
  return {
    store, registered, browser,
    send: async (msg) => JSON.parse(JSON.stringify(await onMessage(msg))),
    settle: async () => { for (let i = 0; i < 30; i++) await tick(); }
  };
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
function stashStub({ currentScene, performers = {}, scenes = {}, byStashId = [] }) {
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
    } else if (body.query.includes("ScenesByStashIds")) {
      const wanted = body.variables.stashIds;
      data = { findScenes: { scenes: byStashId.filter((sc) => sc.stash_ids.some((sid) => wanted.includes(sid.stash_id))) } };
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
    performers: { "sdb-jane": { id: "5", name: "Jane Doe", favorite: false, custom_fields: { radar: "2026-10-20", other: "x" } } },
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
      id: "5",
      favorite: false,
      radar: "2026-10-20",
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

test("a performer with no other scenes in Stash still gets a sidebar, for the 📡", async () => {
  const stub = stashStub({
    performers: { "sdb-jane": { id: "5", name: "Jane Doe", favorite: true, custom_fields: {} } },
    scenes: { 5: { count: 0, scenes: [] } }
  });
  const { send } = loadBackground({ fetch: stub.fetch, settings: stashSettings });
  const resp = await send({ type: "stashPerformerScenes", sceneStashId: "s", performers: [{ id: "sdb-jane", name: "Jane Doe" }] });
  assert.deepEqual(resp, { ok: true, performers: [
    { id: "5", favorite: true, radar: null, name: "Jane Doe", url: "http://stash:9999/performers/5", count: 0, scenes: [] }
  ] });
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

const STASHDB = "https://stashdb.org/graphql";

test("scene cards: one query finds which StashDB scenes are in Stash", async () => {
  const stub = stashStub({
    byStashId: [
      { id: "1", files: [{ width: 1920, height: 1080 }], stash_ids: [{ endpoint: STASHDB, stash_id: "a" }] },
      // Matched via another stash-box's ID only: not a StashDB match.
      { id: "2", files: [], stash_ids: [{ endpoint: "https://theporndb.net/graphql", stash_id: "b" }] },
      // Carries a requested and an unrequested StashDB ID; only the requested one counts.
      { id: "3", files: [], stash_ids: [{ endpoint: STASHDB, stash_id: "c" }, { endpoint: STASHDB, stash_id: "zzz" }] }
    ]
  });
  const { send } = loadBackground({ fetch: stub.fetch, settings: stashSettings });
  const resp = await send({ type: "stashScenesByStashIds", stashIds: ["a", "b", "c", "d", "a", "", null] });

  assert.deepEqual(resp, {
    ok: true,
    scenes: {
      a: { url: "http://stash:9999/scenes/1", resolution: "1080p" },
      c: { url: "http://stash:9999/scenes/3", resolution: "" }
    }
  });
  assert.equal(stub.requests.length, 1);
  const { query, variables } = stub.requests[0].body;
  // stash_ids_endpoint only accepts EQUALS (any of the IDs), not INCLUDES.
  assert.match(query, /stash_ids_endpoint: \{ endpoint: \$endpoint, stash_ids: \$stashIds, modifier: EQUALS \}/);
  assert.match(query, /per_page: -1/);
  assert.deepEqual(variables, { endpoint: STASHDB, stashIds: ["a", "b", "c", "d"] });
  assert.equal(stub.requests[0].headers.ApiKey, "secret");
});

test("scene cards: long lists are asked for in batches of 100", async () => {
  const stub = stashStub({});
  const { send } = loadBackground({ fetch: stub.fetch, settings: stashSettings });
  const ids = Array.from({ length: 250 }, (_, i) => `id-${i}`);
  const resp = await send({ type: "stashScenesByStashIds", stashIds: ids });
  assert.deepEqual(resp, { ok: true, scenes: {} });
  assert.deepEqual(stub.requests.map((r) => r.body.variables.stashIds.length), [100, 100, 50]);
});

test("scene cards: without a Stash URL nothing is asked", async () => {
  const stub = stashStub({});
  const { send } = loadBackground({ fetch: stub.fetch });
  assert.deepEqual(await send({ type: "stashScenesByStashIds", stashIds: ["a"] }), { ok: true, scenes: {} });
  assert.equal(stub.requests.length, 0);
});

test("scene cards: a Stash too old for stash_ids_endpoint reports its error", async () => {
  const fetch = async () => ok(JSON.stringify({ errors: [{ message: 'Field "stash_ids_endpoint" is not defined by type "SceneFilterType".' }] }));
  const { send } = loadBackground({ fetch, settings: stashSettings });
  const resp = await send({ type: "stashScenesByStashIds", stashIds: ["a"] });
  assert.equal(resp.ok, false);
  assert.match(resp.error, /stash_ids_endpoint/);
});

test("the Stash page marker is registered for the Stash host, and follows the Stash URL", async () => {
  const bg = loadBackground({ fetch: async () => ok(), settings: { stashUrl: "http://192.168.1.10:9999/" } });
  await bg.settle();
  assert.deepEqual(bg.registered.map((r) => r.options), [
    { matches: ["http://192.168.1.10/*"], js: [{ file: "stash-marker.js" }], runAt: "document_idle" }
  ]);
  await bg.browser.storage.local.set({ stashUrl: "https://stash.example.org" });
  await bg.browser.storage.local.set({ stashUrl: "https://stash2.example.org" });
  await bg.settle();
  assert.deepEqual(bg.registered.map((r) => r.options.matches), [["https://stash2.example.org/*"]], "only the latest, the old ones are gone");
  await bg.browser.storage.local.set({ stashUrl: "" });
  await bg.settle();
  assert.equal(bg.registered.length, 0);
});

test("without a Stash URL no marker is registered", async () => {
  const bg = loadBackground({ fetch: async () => ok() });
  await bg.settle();
  assert.equal(bg.registered.length, 0);
});

function runMarker({ stashUrl, origin }) {
  const attributes = {};
  const events = [];
  const context = vm.createContext({
    browser: {
      storage: { local: { get: async (d) => ({ ...d, stashUrl }) } },
      runtime: { getManifest: () => ({ version: "9.9.9" }) }
    },
    location: { origin },
    document: { documentElement: { setAttribute: (k, v) => { attributes[k] = v; } } },
    window: { dispatchEvent: (e) => events.push(e.type) },
    CustomEvent: class { constructor(type) { this.type = type; } },
    URL
  });
  vm.runInContext(fs.readFileSync(path.join(root, "stash-marker.js"), "utf8"), context);
  return new Promise((resolve) => setTimeout(() => resolve({ attributes, events }), 10));
}

test("stash-marker.js marks only the exact Stash origin, port included", async () => {
  assert.deepEqual(await runMarker({ stashUrl: "http://192.168.1.10:9999", origin: "http://192.168.1.10:9999" }),
    { attributes: { "data-stasharr": "9.9.9" }, events: ["stasharr:ready"] });
  assert.deepEqual(await runMarker({ stashUrl: "http://192.168.1.10:9999", origin: "http://192.168.1.10:8080" }), { attributes: {}, events: [] });
  assert.deepEqual(await runMarker({ stashUrl: "", origin: "http://192.168.1.10:9999" }), { attributes: {}, events: [] });
});

test("📡 sets the radar field to today, or removes just that field", async () => {
  const requests = [];
  const fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    const fields = body.variables.input.custom_fields.partial || {};
    return ok(JSON.stringify({ data: { performerUpdate: { id: body.variables.input.id, custom_fields: { other: "kept", ...fields } } } }));
  };
  const { send } = loadBackground({ fetch, settings: stashSettings });
  const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();

  assert.deepEqual(await send({ type: "stashRadar", performerId: "5", on: true }), { ok: true, radar: today });
  assert.match(requests[0].query, /performerUpdate\(input: \$input\)/);
  assert.deepEqual(requests[0].variables.input, { id: "5", custom_fields: { partial: { radar: today } } });

  assert.deepEqual(await send({ type: "stashRadar", performerId: "5", on: false }), { ok: true, radar: null });
  assert.deepEqual(requests[1].variables.input, { id: "5", custom_fields: { remove: ["radar"] } });
});

test("📡 only takes numeric Stash performer IDs", async () => {
  let calls = 0;
  const { send } = loadBackground({ fetch: async () => { calls++; return ok("{}"); }, settings: stashSettings });
  const resp = await send({ type: "stashRadar", performerId: "1) { id } x: performerDestroy(", on: true });
  assert.equal(resp.ok, false);
  assert.equal(calls, 0);
});
