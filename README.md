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
  search and one collapsible block per query (collapsed by default), listed
  one below another and kept across every stage — Try Harder/Last Chance add
  their queries to the same list instead of replacing it. Each block's
  summary line always shows the query and its live status (searching… /
  failed / N results); expanding it shows a spinner while that query is
  still running, then that query's own (unfiltered) results in the same
  style as the main list below. Expanding a query block manually keeps it
  expanded even as other queries finish and refresh the section. Once
  everything has settled, a summary line shows how many results came back in
  total and how many passed the criteria filter. If some (but not all)
  queries in a batch failed, a warning banner appears above the results list
  too, instead of that only being visible by expanding Details.
- Results **accumulate across stages**: running Try Harder or Last Chance
  merges its findings into everything found so far (de-duplicated by guid)
  rather than replacing the list, so a good hit from an earlier stage is
  never lost. A small label above the list always shows which stage's
  results are currently displayed.
- If the first pass isn't enough, a **🍆 Try Harder** button runs a second
  automatic parallel batch: performers + parent studio + date, performers +
  parent studio, and performer aliases + date. A query is skipped if there's
  nothing to search, or it would repeat one already tried (e.g. no alias,
  or the studio has no parent brand). Same MIN_SCORE filter, same merge
  logic as the first pass.
- Still nothing good enough? The button becomes **🍑 Last Chance...** — a
  single, much broader "performers only" search (no date, no studio). This
  one skips the criteria filter and resolution grouping entirely (the point
  is to catch releases that don't match on text at all) and instead sorts
  by how close each release's Prowlarr publish date is to the scene's
  release date — closer is shown higher — capped at the 50 closest so a
  prolific performer's whole catalog doesn't flood the panel. After this
  runs, the button disappears for good and a sign-off message takes its
  place — there's nothing further to fall back to.
- Every result row shows how many days its Prowlarr publish date is from the
  scene's release date (or "publish date unknown"), not just during Last
  Chance — purely informational, it never affects scoring or sorting outside
  of Last Chance itself.
- Prowlarr search restricted to XXX category `6000` by default, and capped
  at 200 results per request by default — both configurable. Raise the
  result limit if Last Chance seems to be missing results for a prolific
  performer.
- Results are grouped by resolution (**2160p → 1080p → 720p → other**), and
  within each group sorted by how many of the 5 criteria match (shown on
  each result, e.g. "3/5 hits (Studio, Performer, Date)"), then by
  seeders/grabs.
- Clicking **Download** tells Prowlarr to grab the release (sends it to the
  download client configured in Prowlarr). Once sent, that release shows
  "✓ Sent" instead of "Download" for the rest of the panel's lifetime — even
  after switching stages — so it can't accidentally be grabbed twice.
- If a StashApp URL is configured, each scene page checks (via the
  background script) whether that scene is already in your own Stash
  library — matched by the StashDB stash-box ID StashApp records when a
  scene was scraped from StashDB. If found, a small badge appears above the
  **⬇ Search Prowlarr** button showing its resolution, linking straight to
  the scene in your Stash instance.
- **Search StashDB for a text selection**, anywhere in the browser: select
  some text on any page (a torrent filename, a forum post like `[Studio]
  Performer - Scene Title`, or just a plain title) and right-click →
  **Search StashDB for "…"**. This normalizes the selection into a plain
  search phrase (stripping file extensions, quality/codec tags like
  `1080p`/`x264`, and separators like dots/underscores/brackets — no
  assumption about which of these formats it actually is) and queries
  StashDB's own scene search. A small floating panel then lists the
  matching scenes, each with its StashDB thumbnail, title, studio, date and
  performers; clicking one opens that scene on stashdb.org in a new tab,
  where the normal **⬇ Search Prowlarr** button takes over. This is a pure
  finder/confirmation step — it doesn't touch Prowlarr itself.

## Setup

1. Install the Firefox extension
3. Open the extension's **Preferences/Options** (toolbar icon or
   `about:addons` → this add-on → Preferences) and enter:
   - **Prowlarr URL** — e.g. `http://localhost:9696`
   - **Prowlarr API key** — Prowlarr → Settings → General → Security
   - **Categories** — defaults to `6000` (XXX); comma-separated, or empty for all.
   - **Result limit** — defaults to `200`; max releases Prowlarr returns per
     search request.
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
- Prowlarr/Stash requests time out after 20s instead of hanging indefinitely
  on a dead indexer or an unreachable instance.
- The **⬇ Search Prowlarr** and **🍆 Try Harder** buttons disable themselves
  while a search is running, so clicking again mid-search can't start a
  second, overlapping one.
- The right-click "Search StashDB for selection" feature also needs you to
  be logged into stashdb.org (it uses that GraphQL API directly, not
  Prowlarr/Stash), and won't work on pages the extension can't inject into
  (e.g. `about:` pages or addons.mozilla.org).
