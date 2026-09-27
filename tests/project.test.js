// Consistency checks across files that nothing else would catch.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
const manifest = JSON.parse(read("manifest.json"));

test("common.js loads before the scripts that depend on it", () => {
  assert.deepEqual(manifest.content_scripts[0].js, ["common.js", "content.js"]);
  assert.deepEqual(manifest.background.scripts, ["common.js", "background.js"]);
});

test("background.js and options.js agree on the settings and their defaults", () => {
  const defaults = (src) => {
    const body = src.match(/const DEFAULTS = \{([\s\S]*?)\};/)[1];
    return Object.fromEntries([...body.matchAll(/(\w+):\s*"([^"]*)"/g)].map((m) => [m[1], m[2]]));
  };
  assert.deepEqual(defaults(read("background.js")), defaults(read("options.js")));
});
