# stasharr (Firefox extension)

Adds a **Search Prowlarr** button to StashDB scene pages. It searches your Prowlarr instance, and
lets you start a download for the release you pick. *100% Vibecoded with Claude*

## Features

- Button appears **only on scene pages** (`https://stashdb.org/scenes/<id>`).
- Reads studio + performers + date via StashDB's GraphQL API (using your
  logged-in session)
- "Female" = performers with gender `FEMALE` or `TRANSGENDER_FEMALE`.
- The initial search fires 4 broad, single-concept queries at Prowlarr **in
  parallel**, merges the results (de-duplicated by release guid), and scores
  every release against everything known about the scene — studio, parent
  studio, each performer (and their alias), title, and date. Only releases
  matching **at least 2** of those criteria are shown, to filter out noise
  from broad queries (e.g. a prolific performer's whole catalog):
  1. Performers + date
  2. Performers
  3. Scene title + date
  4. Scene title

  Dates are formatted `YY.MM.DD`; scene titles have parenthetical asides and
  punctuation stripped before being used as a search term.
- The results panel has a **🍆 Try Harder** button to manually search 7
  narrower, studio-based fallback combinations one at a time (studio +
  performers, parent studio + performers, performer aliases, and their
  +date variants) — for scenes the broad pass didn't find enough for. A step
  is skipped automatically if there's nothing to search, or it would repeat
  an already-tried query (e.g. no alias, or the studio has no parent brand).
- Prowlarr search restricted to XXX category `6000` by default (configurable).
- Results are grouped by resolution (**2160p → 1080p → 720p → other**), and
  within each group sorted by how many of the scene's search criteria show
  up in the release name (the same score used for the minimum-2 filter),
  then by seeders/grabs.
- Clicking **Download** tells Prowlarr to grab the release (sends it to the
  download client configured in Prowlarr).
- If a StashApp URL is configured, each scene page checks (via the
  background script) whether that scene is already in your own Stash
  library — matched by the StashDB stash-box ID StashApp records when a
  scene was scraped from StashDB. If found, a small badge appears above the
  **⬇ Search Prowlarr** button showing its resolution, linking straight to
  the scene in your Stash instance.

## Setup

1. Install the Firefox extension
3. Open the extension's **Preferences/Options** (toolbar icon or
   `about:addons` → this add-on → Preferences) and enter:
   - **Prowlarr URL** — e.g. `http://localhost:9696`
   - **Prowlarr API key** — Prowlarr → Settings → General → Security
   - **Categories** — defaults to `6000` (XXX); comma-separated, or empty for all.
   - **Stash URL** (optional) — e.g. `http://localhost:9999`, to enable the
     "already downloaded" badge.
   - **Stash API key** (optional) — only needed if your Stash instance
     requires one.
4. Click **Test Prowlarr** / **Test Stash** to verify, then **Save**.

## Usage

1. Go to a scene on `stashdb.org`.
2. If it's already in your Stash library, a badge above the button shows its
   resolution and links to it.
3. Click the green **⬇ Search Prowlarr** button (bottom-right).
4. Pick a release from the sorted list and click **Download**.

## Notes

- If GraphQL extraction fails (e.g. not logged in), it falls back to reading the
  rendered page; make sure you're logged into StashDB for best results.
