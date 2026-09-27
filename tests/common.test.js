const test = require("node:test");
const assert = require("node:assert/strict");
const c = require("../common.js");

const release = (title, extra = {}) => ({ title, guid: title, ...extra });

const scene = {
  studio: "Acme Studio",
  parentStudio: "Acme Group",
  females: ["Jane Doe", "Mary Major"],
  femaleAliasNames: ["Janie D", "Mary Major"],
  title: "Weekend Getaway",
  date: "2026-09-10"
};

test("normalizeForMatch lowercases and drops everything but letters and digits", () => {
  assert.equal(c.normalizeForMatch("Jane Doe's 26.09.10 [1080p]"), "janedoes260910" + "1080p");
  assert.equal(c.normalizeForMatch(null), "");
});

test("formatDateYYMMDD matches release naming", () => {
  assert.equal(c.formatDateYYMMDD("2026-09-10"), "26.09.10");
  assert.equal(c.formatDateYYMMDD("2026-09-10T00:00:00Z"), "26.09.10");
  assert.equal(c.formatDateYYMMDD(""), "");
});

test("cleanTitle drops asides and punctuation", () => {
  assert.equal(c.cleanTitle("Weekend Getaway (Part 2): The Return!"), "Weekend Getaway The Return");
});

test("cleanSelectionText normalizes filenames, forum lines and plain text alike", () => {
  const cases = {
    "Studio.Performer.Name.26.09.10.XXX.1080p.mp4": "Studio Performer Name 26 09 10",
    "[Studio] Performer - Scene Title": "Studio Performer Scene Title",
    "Performer - Scene Title": "Performer Scene Title",
    "Studio.Name.Performer.One.and.Performer.Two.WEB-DL.x264-GROUP.mkv": "Studio Name Performer One and Performer Two GROUP",
    "just a half-remembered title": "just a half remembered title",
    "   ": ""
  };
  for (const [input, expected] of Object.entries(cases)) {
    assert.equal(c.cleanSelectionText(input), expected, input);
  }
});

test("mergeResults dedupes by guid, falling back to indexer + title", () => {
  const merged = c.mergeResults([
    [{ guid: "a" }, { guid: "b" }],
    [{ guid: "b" }, { indexer: "x", title: "t" }, { indexer: "x", title: "t" }]
  ]);
  assert.equal(merged.length, 3);
});

test("resolutionOf buckets releases", () => {
  assert.equal(c.resolutionOf(release("Scene.2160p")), "2160p");
  assert.equal(c.resolutionOf(release("Scene.4K")), "2160p");
  assert.equal(c.resolutionOf(release("Scene.1080p")), "1080p");
  assert.equal(c.resolutionOf(release("Scene.720p")), "720p");
  assert.equal(c.resolutionOf(release("Scene.480p")), "480p");
  assert.equal(c.resolutionOf(release("Scene")), "other");
});

test("matchedCriteria reports each matching criterion", () => {
  const r = release("AcmeStudio.26.09.10.Jane.Doe.Weekend.Getaway.XXX.1080p");
  assert.deepEqual(c.matchedCriteria(r, scene), ["Studio", "Performer", "Title", "Date"]);
  assert.deepEqual(c.matchedCriteria(release("Unrelated.Release.1080p"), scene), []);
});

test("parent studio only counts when it differs from the studio", () => {
  const same = { ...scene, parentStudio: scene.studio };
  assert.ok(!c.matchedCriteria(release("AcmeStudio.Something"), same).includes("Parent studio"));
  assert.ok(c.matchedCriteria(release("AcmeGroup.Something"), scene).includes("Parent studio"));
});

test("sortResults ranks by resolution, then score, then seeders", () => {
  const sorted = c.sortResults([
    release("Jane.Doe.720p", { seeders: 100 }),
    release("Jane.Doe.26.09.10.1080p", { seeders: 1 }),
    release("Jane.Doe.1080p", { seeders: 50 }),
    release("Jane.Doe.1080p.again", { seeders: 5 })
  ], scene).map((r) => r.title);
  assert.deepEqual(sorted, ["Jane.Doe.26.09.10.1080p", "Jane.Doe.1080p", "Jane.Doe.1080p.again", "Jane.Doe.720p"]);
});

test("sortByAgeProximity puts the closest publish date first and unknown dates last", () => {
  const sorted = c.sortByAgeProximity([
    release("none"),
    release("far", { publishDate: "2027-01-01" }),
    release("near", { publishDate: "2026-09-12" })
  ], scene).map((r) => r.title);
  assert.deepEqual(sorted, ["near", "far", "none"]);
  assert.equal(c.ageLabel(release("near", { publishDate: "2026-09-12" }), scene), "2d from scene date");
  assert.equal(c.ageLabel(release("none"), scene), "publish date unknown");
});
