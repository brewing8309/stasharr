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

test("installs poll updates.json on main of this repo", () => {
  assert.equal(
    manifest.browser_specific_settings.gecko.update_url,
    "https://raw.githubusercontent.com/brewing8309/stasharr/main/updates.json"
  );
});

test("updates.json advertises the manifest version with a matching release download", () => {
  const { id } = manifest.browser_specific_settings.gecko;
  const updates = JSON.parse(read("updates.json")).addons[id].updates;
  const entry = updates.find((u) => u.version === manifest.version);
  assert.ok(entry, `updates.json has no entry for ${manifest.version}`);
  assert.equal(
    entry.update_link,
    `https://github.com/brewing8309/stasharr/releases/download/v${manifest.version}/stasharr-${manifest.version}.xpi`
  );
});

test("the newest CHANGELOG entry is the manifest version", () => {
  assert.equal(read("CHANGELOG.md").match(/^## (\S+)/m)[1], manifest.version);
});

test("background.js and options.js agree on the settings and their defaults", () => {
  const defaults = (src) => {
    const body = src.match(/const DEFAULTS = \{([\s\S]*?)\};/)[1];
    return Object.fromEntries([...body.matchAll(/(\w+):\s*"([^"]*)"/g)].map((m) => [m[1], m[2]]));
  };
  assert.deepEqual(defaults(read("background.js")), defaults(read("options.js")));
});

test("the vibecoded Required Notice reads the same in LICENSE, README and the options page", () => {
  const notice = read("LICENSE").match(/^Required Notice: (This software is vibecoded\..*)$/m)[1];
  const flat = (s) => s.replace(/<[^>]+>/g, "").replace(/^> ?/gm, "").replace(/\s+/g, " ");
  assert.ok(flat(read("README.md")).includes(notice), "README.md");
  assert.ok(flat(read("options.html")).includes(notice), "options.html");
});
