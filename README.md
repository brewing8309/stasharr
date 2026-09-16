# stasharr (Firefox extension)

Adds a **Search Prowlarr** button to StashDB scene pages. It searches your Prowlarr instance, and
lets you start a download for the release you pick. *100% Vibecoded with Claude*

## Features

- Button appears **only on scene pages** (`https://stashdb.org/scenes/<id>`).
- Reads studio + performers + date via StashDB's GraphQL API (using your
  logged-in session)
- "Female" = performers with gender `FEMALE` or `TRANSGENDER_FEMALE`.
- Searches Prowlarr using up to 5 progressively looser queries, stopping at
  the first one that gets a hit:
  1. `StudioNameNoSpaces performer1 performer2 … YY.MM.DD`
  2. `StudioNameNoSpaces performer1 performer2 …`
  3. `performer1 performer2 … YY.MM.DD`
  4. `Scene Title YY.MM.DD`
  5. `Scene Title`
  Each step that runs after the first shows a small notice in the panel that
  the search was expanded.
- The results panel has a **🍆 Try Harder** button to manually run the next
  step in that list at any time, whether or not the current step had hits.
- Prowlarr search restricted to XXX category `6000` by default (configurable).
- Results are grouped by resolution (**2160p → 1080p → 720p → other**), and
  within each group sorted by how many of the scene's search criteria
  (studio, each performer, title, date) show up in the release name, then by
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
