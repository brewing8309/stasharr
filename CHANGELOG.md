# Changelog

## 1.1.0 — 2026-09-19

The search got rebuilt from the ground up. 1.0.0 fired **one** query at Prowlarr — studio name
plus performer names, glued together — and showed you whatever came back. If that missed, you
were on your own.

This release turns that into a three-stage hunt that widens on demand, scores everything it
finds, and shows you exactly what it searched for. It also learns to work backwards: select any
text anywhere in the browser and it'll find the StashDB scene it belongs to.

### Added

**Three-stage search.** The button now escalates instead of giving up:

- **Stage 1** fires 5 queries in parallel — `performers + studio + date`, `performers + date`,
  `performers + studio`, `studio + date`, and `title`.
- **🍆 Try Harder** adds 3 more using the parent studio and performer aliases, skipping
  anything already tried or with nothing to fill in.
- **🍑 Last Chance...** sweeps on performers alone, drops the quality filter entirely, and
  sorts by how close each release's publish date sits to the scene date.

Results **accumulate** across stages and are de-duplicated by release GUID — moving up a stage
never throws away an earlier hit.

**Result scoring.** Every release is checked against 5 known facts about the scene — studio,
parent studio, performer (any cast member *or* one of her aliases), title, date — and stages 1
and 2 only show releases matching at least 2 of them. Each row shows its own score inline
(`3/5 hits (Studio, Performer, Date)`), so you can see why something is in the list. Higher
scores rank above lower ones within a resolution group.

**Right-click → Search StashDB.** Select any text on any page — a torrent filename, a
`[Studio] Performer - Title` line from a forum, or a half-remembered title — and right-click to
find the StashDB scene it belongs to. Matches appear in a floating panel with thumbnails,
studio, date and cast; clicking one opens the scene on StashDB. The selection is normalised
first (file extensions, `1080p`/`x264`/`WEB-DL` tags and separators all stripped) without
assuming which format it is.

**"Already in Stash" badge.** Point the new **Stash URL** setting at your own StashApp and every
scene page tells you upfront whether it's already in your library, with its resolution and a
direct link — matched on the stash-box ID StashApp records when it scraped from StashDB.

**Details pane.** A collapsible section above the results shows the scene data behind the
search, plus one expandable block per query with a live status (searching… / failed / N results)
and that query's own raw, unfiltered results. Blocks you expand stay expanded as other queries
finish. Nothing is hidden.

**Publish-date proximity on every row** (`4d from scene date`). Informational only — it never
affects scoring or sorting, except in Last Chance, where it *is* the sort.

**Result limit setting**, default 200. Raise it if Last Chance seems to be missing hits for a
prolific performer; Prowlarr's per-query cap is what's cutting them off.

**A license.** [PolyForm Noncommercial 1.0.0](LICENSE): use it, fork it, modify it, redistribute
it freely — you just can't sell it, and you have to keep the attribution and the vibecoded
notice visible. Previously the repo had no license at all, which technically meant all rights
reserved.

### Changed

- **Queries are smarter.** Scene titles get parenthetical asides and punctuation stripped before
  use; dates are formatted `YY.MM.DD` to match release naming; performer aliases and parent
  studios feed the later stages. Queries that would duplicate one already sent are skipped.
- **Download status sticks.** A release you've sent shows **✓ Sent** for the rest of the panel's
  lifetime — including across stage changes — so you can't grab the same thing twice by accident.
- **Partial failures are visible.** If some queries in a batch fail but others succeed, a warning
  banner appears above the results instead of that only being discoverable in the Details pane.
- **Requests time out after 20s** instead of hanging forever on a dead indexer or an unreachable
  instance.
- **Buttons disable themselves mid-search**, so a double-click can't kick off a second
  overlapping run.
- **A stage label** above the list always says which stage's results you're looking at.
- **The README was rewritten** — what it does, how the stages and scoring actually work, an
  architecture diagram, both install paths, a configuration table and a troubleshooting matrix.
- **Fixed add-on ID** (`stasharr@brewing8309`) so re-signing updates the installed copy instead
  of creating a duplicate.

### Upgrading from 1.0.0

- **Firefox will ask for a new permission** on update: the right-click search needs
  `contextMenus`. Everything else uses permissions the extension already had.
- **Your existing settings carry over** untouched. The new **Result limit** defaults to 200 and
  the two **Stash** fields are optional — leave them empty and the "already in Stash" badge
  simply stays off.
- **No action needed for the search itself.** The button works the same way; it just doesn't stop
  after one try any more.
