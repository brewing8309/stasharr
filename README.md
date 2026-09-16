# stasharr (Firefox extension)

Adds a **Search Prowlarr** button to StashDB scene pages. It searches your Prowlarr instance, and
lets you start a download for the release you pick. *100% Vibecoded with Claude*

## Features

- Button appears **only on scene pages** (`https://stashdb.org/scenes/<id>`).
- Reads studio + performers + date via StashDB's GraphQL API (using your
  logged-in session)
- "Female" = performers with gender `FEMALE` or `TRANSGENDER_FEMALE`.
- Search query = `StudioNameNoSpaces performer1 performer2 …`.
- If that search returns no hits, it automatically retries with
  `performer1 performer2 … YY.MM.DD` (scene date, no studio) — some releases
  are named by date instead of studio — and shows a small notice in the panel
  that the search was expanded.
- The results panel has its own **⬇ Search by performers + date** button to
  run that alternate search directly at any time.
- Prowlarr search restricted to XXX category `6000` by default (configurable).
- Results are grouped/sorted: **2160p → 1080p → 720p → other**, and within each
  group by seeders/grabs.
- Clicking **Download** tells Prowlarr to grab the release (sends it to the
  download client configured in Prowlarr).

## Setup

1. Install the Firefox extension
3. Open the extension's **Preferences/Options** (toolbar icon or
   `about:addons` → this add-on → Preferences) and enter:
   - **Prowlarr URL** — e.g. `http://localhost:9696`
   - **Prowlarr API key** — Prowlarr → Settings → General → Security
   - **Categories** — defaults to `6000` (XXX); comma-separated, or empty for all.
4. Click **Test connection** to verify, then **Save**.

## Usage

1. Go to a scene on `stashdb.org`.
2. Click the green **⬇ Search Prowlarr** button (bottom-right).
3. Pick a release from the sorted list and click **Download**.

## Notes

- If GraphQL extraction fails (e.g. not logged in), it falls back to reading the
  rendered page; make sure you're logged into StashDB for best results.
