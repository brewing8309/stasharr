[← Documentation](README.md)

# Troubleshooting

| Symptom | Cause |
|---|---|
| Panel says "Could not read scene" | Not logged into StashDB. It falls back to scraping the rendered page, which has no aliases or parent studio — log in for the good data. |
| Every query fails instantly | Prowlarr URL or API key wrong. Hit **Test Prowlarr** in preferences. |
| Search hangs, then errors | Requests time out after 25s by default. Usually a dead indexer in Prowlarr, or an unreachable instance — raise **Request timeout** if your indexers are just slow. |
| Results look stale | Reopening a scene within 30 minutes restores the last search instead of re-querying. Hit **↻** in the panel header. |
| Some queries fail, others don't | You'll get a warning banner above the results; expand **Details** to see which indexer choked. Partial results still show. |
| Stage 3 feels like it's missing things | Raise **Result limit**. Prowlarr caps at 200 by default, and a prolific performer blows through that easily. |
| No "already in Stash" badge | Stash URL not set, or the scene was never scraped from StashDB (matching is done on the stash-box ID StashApp records). |
| No owned badge on scene cards | Stash URL not set, Stash older than 0.31 (it lacks the `stash_ids_endpoint` filter — the console says so), or the scenes were never matched to StashDB in Stash. |
| No performer sidebars | Stash URL not set, the performer isn't linked to StashDB in Stash (matching is done on her StashDB ID, never by name), or you have no other scene of hers. Male performers don't get one. |
| Right-click search does nothing | Restricted page (`about:`, `addons.mozilla.org`) — Firefox forbids injection there. Also needs a StashDB login. |

## FAQ

**Is it safe to give it my Prowlarr key?** The key stays in `browser.storage.local` on your machine
and is only sent to the Prowlarr URL you typed. There is no stasharr server and no telemetry; the
manifest declares `data_collection_permissions: none`.

**Which sites can it reach?** Only stashdb.org by default. When you press **Save settings**, Firefox
asks for access to the hosts of the Prowlarr and Stash URLs you entered, and nothing else. After
changing a URL, Save again to grant the new host. Firefox lists the granted hosts under
about:addons → stasharr → Permissions.

**"stasharr has no access to Prowlarr yet"** — the host permission is missing (e.g. after the update
from 1.8, which dropped the blanket `<all_urls>`). Open the preferences and press **Save settings**.

**Does it work on Chrome, Edge or Android?** No. It's a Firefox Manifest v2 extension; desktop
Firefox only.

**Does it download anything itself?** No. It asks Prowlarr to grab a release. Prowlarr hands it to
whatever download client you set up there.

**A release I own shows no badge.** Matching uses the StashDB ID that Stash stores when a scene
was identified. Scenes never matched to StashDB in Stash can't be recognised. See
[Troubleshooting](#troubleshooting).

**How do updates work?** The signed add-on checks [`updates.json`](../updates.json) in this repo
(about:addons → gear → *Check for Updates*). Nothing is installed without Firefox's normal
update flow.
