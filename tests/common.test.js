const test = require("node:test");
const assert = require("node:assert/strict");
const c = require("../common.js");

const release = (title, extra = {}) => ({ title, guid: title, ...extra });

const scene = {
  studio: "Acme Studio",
  parentStudio: "Acme Group",
  females: ["Jane Doe", "Mary Major"],
  femaleAliasNames: ["Janie D", "Mary Major"],
  femaleNameSets: [
    c.performerNameSet("Jane Doe", "Janie D", ["JD", "Jane Q Doe", "Janeybird"]),
    c.performerNameSet("Mary Major", null, [])
  ],
  title: "Weekend Getaway",
  date: "2026-09-10"
};

test("normalizeForMatch lowercases and drops everything but letters and digits", () => {
  assert.equal(c.normalizeForMatch("Jane Doe's 26.09.10 [1080p]"), "janedoes260910" + "1080p");
  assert.equal(c.normalizeForMatch(null), "");
});

test("normalizeForMatch folds accents and keeps non-Latin scripts", () => {
  assert.equal(c.normalizeForMatch("Zoë Doll"), c.normalizeForMatch("Zoe.Doll"));
  assert.equal(c.normalizeForMatch("Straße"), "strasse");
  assert.notEqual(c.normalizeForMatch("ピーチ"), "");
});

test("accented performer names match their unaccented spelling in releases", () => {
  const s = { ...scene, femaleNameSets: [c.performerNameSet("Zoë Doll", null, [])] };
  assert.ok(c.matchedCriteria(release("Zoe.Doll.XXX.1080p"), s).includes("Performer"));
});

test("a studio name that normalizes to nothing never matches", () => {
  const s = { ...scene, studio: "★", parentStudio: "" };
  assert.ok(!c.matchedCriteria(release("Anything.Else.26.09.10"), s).includes("Studio"));
  assert.ok(!c.hayHas("anything", ""));
});

test("a non-Latin studio only matches releases that carry it", () => {
  const s = { ...scene, studio: "ピーチ", parentStudio: "" };
  assert.ok(!c.matchedCriteria(release("Other.Studio.26.09.10"), s).includes("Studio"));
  assert.ok(c.matchedCriteria(release("ピーチ 26.09.10"), s).includes("Studio"));
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

test("performerNameSet keeps primary and credited names, and only distinctive aliases", () => {
  assert.deepEqual(
    c.performerNameSet("Jane Doe", "Janie D", ["JD", "Mia", "Jane Q Doe", "Janeybird", "jane doe"]),
    ["janedoe", "janied", "janeqdoe", "janeybird"]
  );
  assert.deepEqual(c.performerNameSet("Mia", null, []), ["mia"]);
});

test("countPerformers counts each cast member once, via any of her names", () => {
  assert.equal(c.countPerformers(c.releaseHay(release("Unrelated")), scene), 0);
  assert.equal(c.countPerformers(c.releaseHay(release("Jane.Doe.and.Someone")), scene), 1);
  assert.equal(c.countPerformers(c.releaseHay(release("Janie.D.and.Jane.Doe")), scene), 1);
  assert.equal(c.countPerformers(c.releaseHay(release("Janeybird.and.Mary.Major")), scene), 2);
  assert.equal(c.countPerformers(c.releaseHay(release("JD.and.Nobody")), scene), 0);
});

test("the Performer criterion matches on any alias, not just the first", () => {
  assert.ok(c.matchedCriteria(release("Acme.Jane.Q.Doe.1080p"), scene).includes("Performer"));
});

test("matchesTitle accepts the whole title or enough of its significant words", () => {
  const long = { ...scene, title: "Jane's Big Weekend Getaway Adventure" };
  const hay = (t) => c.releaseHay(release(t));
  assert.deepEqual(c.titleWords(long.title), ["jane", "weekend", "getaway", "adventure"]);
  assert.ok(c.matchesTitle(hay("Acme.Janes.Big.Weekend.Getaway.Adventure.1080p"), long), "whole title");
  assert.ok(c.matchesTitle(hay("Acme.26.09.10.Jane.Weekend.Getaway.1080p"), long), "truncated: 3 of 4 words");
  assert.ok(!c.matchesTitle(hay("Acme.Jane.Doe.Adventure.1080p"), long), "2 of 4 words is below 60%");
  assert.ok(!c.matchesTitle(hay("Acme.Weekend.1080p"), { ...scene, title: "" }), "no title never matches");
});

test("matchesTitle falls back to the whole title when it has no significant words", () => {
  const stop = { ...scene, title: "Just With Them" };
  assert.deepEqual(c.titleWords(stop.title), []);
  assert.ok(c.matchesTitle(c.releaseHay(release("Just.With.Them.1080p")), stop));
  assert.ok(!c.matchesTitle(c.releaseHay(release("With.Them.1080p")), stop));
});

test("sortResults breaks score ties by how much of the cast a release names", () => {
  const sorted = c.sortResults([
    release("Acme.Jane.Doe.1080p", { seeders: 99 }),
    release("Acme.Jane.Doe.Mary.Major.1080p", { seeders: 1 })
  ], scene).map((r) => r.title);
  assert.deepEqual(sorted, ["Acme.Jane.Doe.Mary.Major.1080p", "Acme.Jane.Doe.1080p"]);
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

test("pruneGrabbed drops expired entries without mutating its input", () => {
  const day = 86400000;
  const grabbed = { old: 0, recent: 89 * day, fresh: 90 * day };
  assert.deepEqual(c.pruneGrabbed(grabbed, 90 * day, 90 * day), { recent: 89 * day, fresh: 90 * day });
  assert.equal(Object.keys(grabbed).length, 3);
  assert.deepEqual(c.pruneGrabbed(undefined, 0, day), {});
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
