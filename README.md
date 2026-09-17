# stasharr (Firefox extension)

Adds a **Search Prowlarr** button to StashDB scene pages. It searches your Prowlarr instance, and
lets you start a download for the release you pick. *100% Vibecoded with Claude*

## Features

- Button appears **only on scene pages** (`https://stashdb.org/scenes/<id>`).
- Reads studio + performers + date via StashDB's GraphQL API (using your
  logged-in session)
- "Female" = performers with gender `FEMALE` or `TRANSGENDER_FEMALE`.
- The initial search fires 5 broad queries at Prowlarr **in parallel**,
  merges the results (de-duplicated by release guid), and checks every
  release against 5 fixed criteria — Studio, Parent studio, Performer (any
  cast member or her alias), Title, Date. Only releases matching **at least
  2 of the 5** are shown, to filter out noise from broad queries (e.g. a
  prolific performer's whole catalog):
  1. Performers + studio + date
  2. Performers + date
  3. Performers + studio
  4. Studio + date
  5. Scene title

  Dates are formatted `YY.MM.DD`; scene titles have parenthetical asides and
  punctuation stripped before being used as a search term. A collapsible
  **Details** section above the results shows the scene data behind the
  search and one block per query, listed one below another — each showing a
  spinner while that query is still running, then that query's own
  (unfiltered) results live as soon as it comes back, in the same style as
  the main list below. Once everything has settled, a summary line shows how
  many results came back in total and how many passed the criteria filter.
- The results panel has a **🍆 Try Harder** button to manually search 5
  narrower fallback combinations one at a time (performer aliases and
  parent studio in place of the studio/performer names above, plus their
  +date variants) — for scenes the broad pass didn't find enough for. A step
  is skipped automatically if there's nothing to search, or it would repeat
  an already-tried query (e.g. no alias, or the studio has no parent brand).
- Prowlarr search restricted to XXX category `6000` by default (configurable).
- Results are grouped by resolution (**2160p → 1080p → 720p → other**), and
  within each group sorted by how many of the 5 criteria match (shown on
  each result, e.g. "3/5 hits (Studio, Performer, Date)"), then by
  seeders/grabs.
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
