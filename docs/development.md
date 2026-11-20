[← Documentation](README.md)

# Development & releasing

No build step, no bundler, no runtime dependencies. Clone it and it runs. `package.json` only pins
`web-ext` (via `package-lock.json`) for the release workflow; the extension never loads it.

```
manifest.json    MV2, storage + contextMenus + activeTab + stashdb.org;
                 Prowlarr/Stash hosts as optional permissions, granted on Save
common.js        pure text/matching/scoring helpers, loaded ahead of both scripts below
background.js    every cross-origin request (Prowlarr, StashApp, StashDB search),
                 configurable timeouts, context-menu registration
content.js       injected on stashdb.org — scene resolution, query building,
                 the 3-stage state machine, results panel, performer sidebars,
                 owned badges on scene cards
picker.js        injected on demand into any page for the reverse lookup panel
content.css      the look of everything injected: dock, panels, sidebars, badges
fonts/           Archivo + IBM Plex Mono (SIL OFL 1.1), bundled — no font CDN requests
options.html/js  preferences
tests/           node:test suite — run with `node --test` (Node 20+, nothing to install)
```

Content scripts can't reach cross-origin hosts, so everything network-facing lives in
`background.js` and is reached by message passing. Credentials never leave `browser.storage.local`
and are only ever sent to the hosts you configured yourself.

### Releasing

1. Bump `version` in `manifest.json`, add a `CHANGELOG.md` entry, and add an entry to
   `updates.json` pointing at `releases/download/v<version>/stasharr-<version>.xpi`.
   `node --test` fails until all three agree.
2. Push a tag `v<version>` on that commit. The [Release](../.github/workflows/release.yml)
   workflow runs the tests, has Mozilla sign the build as an unlisted add-on and publishes a
   GitHub release with `stasharr-<version>.xpi` attached and the CHANGELOG entry as notes.
   It needs the secrets `AMO_JWT_ISSUER` and `AMO_JWT_SECRET` from
   [AMO → API Keys](https://addons.mozilla.org/developers/addon/api/key/) in the `release`
   environment (Settings → Environments), which only admits `v*` tags.
3. Merge to `main` once the release is up. Installs read `updates.json` from `main`, so
   publishing the release *first* means they never go looking for a file that isn't there yet.

Mozilla signs each version number only once, so re-running a release that already got signed
fails. If a run breaks after signing, take the signed `.xpi` from the run's artifacts and attach
it to the release by hand. A release you pull after publishing needs a new version.

### Repository hardening

- Rulesets: `main` can't be deleted or force-pushed; `v*` tags can't be moved or deleted
  (repository admins may bypass, the workflow token can't).
- Actions: only GitHub-owned actions, pinned to a full commit SHA (enforced by the repo
  setting). Bump a pin by replacing the SHA and the version comment together.
- The job that signs holds the AMO keys but can only read the repo and persists no git
  credentials; web-ext comes from `package-lock.json` with install scripts disabled. Only the
  publish job, which runs no third-party code, may create the release.
