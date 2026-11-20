[← Documentation](README.md)

# Configuration

Open the add-on's preferences (`about:addons` → stasharr → Preferences) and fill in:

| Setting | Default | Required | What it's for |
|---|---|---|---|
| **Prowlarr URL** | — | yes | Base URL, no trailing slash. e.g. `http://localhost:9696` |
| **Prowlarr API key** | — | yes | Prowlarr → Settings → General → Security |
| **Search categories** | `6000` | no | Newznab/Torznab category IDs, comma-separated. `6000` = XXX. Empty = all. |
| **Result limit** | `200` | no | Max releases Prowlarr returns per query. Raise it if stage 3 seems to be missing hits for a prolific performer. |
| **Request timeout** | `25` | no | Seconds to wait for Prowlarr, Stash or StashDB before giving up. Raise it if slow indexers keep timing out. |
| **Stash URL** | — | no | Your own StashApp, e.g. `http://localhost:9999`. Enables the "already in your library" badge, the performer sidebars, the owned badge on scene cards and Stashboard's download buttons. |
| **Stash API key** | — | no | Only if your Stash requires one. |

**Test Prowlarr** and **Test Stash** save the settings and verify each connection.

**Access to your Prowlarr and Stash.** stasharr only holds access to stashdb.org. When you press
**Save settings** or a **Test** button, Firefox asks to let it reach the hosts of the URLs you
entered; allow it, otherwise every request reports "no access … yet". After changing a URL, save
again to grant the new host. The granted hosts are listed under about:addons → stasharr →
Permissions, where you can also take them back.

**Plain http.** URLs must start with `http://` or `https://`. With plain `http://` to another
machine (anything but `localhost`), the page warns that the API key travels unencrypted across
your network. It still works; prefer https (e.g. through a reverse proxy) where you can.

A couple of knobs are deliberately not in the UI, but are one-line edits if you want them:
`MIN_SCORE` in `common.js` (the 2-of-5 threshold) and `LAST_CHANCE_LIMIT` in `content.js` (the
50-result cap on stage 3).
