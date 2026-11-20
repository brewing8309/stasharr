# Security Audit Review

| | |
|---|---|
| **Project** | stasharr (Firefox extension, Manifest V2) |
| **Version reviewed** | 1.8.1, with the hardening changes released as 1.9.0 (see the [changelog](CHANGELOG.md)) |
| **Date** | 2026-11-20 |
| **Type** | White-box review: source code, manifest, release pipeline and repository settings, with automated tests against stubbed browser APIs |
| **Performed by** | AI-assisted review (Claude Code) on behalf of the maintainer |

## 1. Summary
stasharr adds a search and download panel to stashdb.org. It sends scene searches to the operator's Prowlarr and asks the operator's Stash which scenes are already in the library. It holds two valuable secrets, the Prowlarr API key and the optional Stash API key. It runs inside a third-party website it does not control, and it is updated automatically through a self-hosted update manifest.

The extension has no runtime dependencies and keeps all network access in its background script. The review found no injection flaw: every value from Prowlarr, Stash or StashDB is put into the page as text, never as HTML. The findings concerned the extension's privileges, its trust in the host page, and the integrity of the release pipeline. All of them were fixed and covered by regression tests before this report was finalized. The test suite (58 tests) passes on the reviewed version.

**Overall assessment: good**, for its intended use by a single operator with Prowlarr and Stash on a home network. The remaining risks are listed in section 6. Most of them come from where the extension runs (inside stashdb.org) and from Manifest V2, not from defects in the code.

## 2. Scope
**In scope**
- `manifest.json`: permissions, content scripts, web-accessible resources, update URL.
- `background.js`: message handling, all requests to Prowlarr, Stash and StashDB, the context menu, script injection, the Stash page marker registration.
- `content.js`, `content.css`: everything injected into stashdb.org (panel, dock, sidebars, badges, Auto-Download).
- `picker.js` (injected into any page for the reverse lookup) and `stash-marker.js` (injected into Stash pages).
- `options.html`, `options.js`: settings and secret storage.
- `common.js`: shared parsing and matching helpers.
- The release workflow, the update manifest (`updates.json`) and the GitHub repository settings.

**Out of scope**
- The security of stashdb.org, Prowlarr, Stash, the indexers and the download client.
- Firefox itself and the add-on signing service (AMO).
- The operator's network and host.

## 3. Methodology
1. **Architecture and threat modelling.** Identified the assets, trust boundaries and realistic attackers (section 4).
2. **Manual code review** of every message handler, every outbound request, every DOM insertion, and every place that runs in a page the extension does not own. The review followed untrusted input (release titles, Stash metadata, StashDB data, page DOM, URL hash) to sensitive sinks (`innerHTML`, `href`, requests that carry an API key, actions that change state).
3. **Sink inventory.** Every `innerHTML` and `insertAdjacentHTML` was checked. All of them take fixed templates; data is inserted with `textContent` only.
4. **Automated tests** against stubbed `browser.*` and `fetch` APIs. They cover the sender check, the missing-permission path, timeout messages, ID validation and the click guards (`tests/background.test.js`, `tests/common.test.js`, `tests/project.test.js`).
5. **Static analysis** with `web-ext lint`: no errors. Three warnings about `innerHTML` remain; each assigns a fixed template without data.
6. **Dependency audit** with `npm audit` on the release tooling: one critical advisory (`shell-quote`, reached only through web-ext's Firefox launcher) was fixed with an override. No known vulnerabilities remain. The extension itself ships no third-party code.
7. **Repository and CI review** of branch and tag protection, Actions permissions and secret handling, through the GitHub API.
8. **Not performed:** testing in a live Firefox. The permission prompt and the new click guards were verified by tests and code review only.

## 4. Threat model
| Asset | Why it matters |
|---|---|
| Prowlarr API key | Full control over Prowlarr: indexers, their credentials, and sending releases to the download client |
| Stash API key | Read and write access to the media library and its metadata |
| Contents of the Stash library | Private: which scenes and performers the operator owns |
| Prowlarr and Stash addresses | Reveal the operator's internal network layout |
| The update channel | Every installation runs whatever the next signed version contains, with the extension's privileges |

| Attacker | Capability assumed |
|---|---|
| Script on stashdb.org (XSS, compromise, or the site itself) | Can read and change the DOM the extension injects, fire events at it and change the URL hash. Cannot call extension APIs directly. |
| Malicious indexer or release uploader | Controls release titles, indexer names and other fields in Prowlarr's search results |
| Malicious web page opened by the operator | Can link to stashdb.org with any URL and hash. Its DOM receives the reverse lookup panel when the operator uses it there. |
| Plugin or page on the Stash origin | Can read what the Stash page marker exposes |
| Compromised build dependency or CI token | Runs code in the release workflow |
| Observer on the local network | Can read plain-HTTP traffic to Prowlarr and Stash |

## 5. Control assessment

| Area | Assessment | Observations |
|---|---|---|
| **Permissions** | Good | Required: `storage`, `contextMenus`, `activeTab` and stashdb.org. The Prowlarr and Stash hosts are optional permissions, requested on the options page for exactly the configured hosts. Requests to a host without permission are not sent; the error tells the operator to save the settings. *Fixed in 1.9.0:* previously the extension held `<all_urls>`. |
| **Output encoding / XSS** | Strong | No data reaches HTML parsing. Release titles, indexer names, Stash titles and file names, StashDB metadata and error messages are inserted with `textContent`. Links to Stash are built from the configured base and numeric IDs, and open with `noopener noreferrer`. |
| **Trust in the host page** | Good | Buttons that search, download, change Auto-Download, start a second search pass or change Stash ignore events that page scripts fire (`isTrusted`). Extension state attached to DOM nodes lives on the content script's side of Firefox's Xray wrappers and is invisible to the page. *Fixed in 1.9.0:* previously stashdb.org scripts could trigger downloads and Stash changes with synthetic clicks. See 6.1 for what the page can still read. |
| **Message passing** | Strong | The background script answers only the extension's own pages and its content script on `https://stashdb.org`. Scripts injected elsewhere (reverse lookup panel, Stash marker) are refused, although they send no messages today. Stash scene and performer IDs are checked as numeric before use. *Fixed in 1.9.0:* previously the sender was not checked. |
| **Request integrity** | Strong | GraphQL queries use variables, never string concatenation. Prowlarr search parameters are built with `URLSearchParams`. Every request has a configurable timeout. |
| **Secret handling** | Good | API keys are stored in `browser.storage.local` and sent only in headers (`X-Api-Key`, `ApiKey`), never in URLs, and only to the configured hosts. Stash screenshots are fetched by the background script, so the key never appears in the page. The options page shows the keys in password fields. See 6.2. |
| **Transport security** | Adequate | HTTP or HTTPS is the operator's choice. *Added in 1.9.0:* the options page rejects any scheme other than http(s) and warns when an API key would travel over plain HTTP to another machine. Requests to stashdb.org always use HTTPS. |
| **Information exposure** | Good | *Changed in 1.9.0:* error messages shown on stashdb.org carry at most 150 characters of a backend's answer, and timeouts name the request path instead of the internal address. No telemetry; the manifest declares `data_collection_permissions: none`. Fonts are bundled, so no font CDN is contacted. |
| **Auto-Download** | Good | Off by default, stored per browser profile. The `#stasharr-search` link (used by Stashboard) only starts a search, never a download. Each release is sent once; sent releases are remembered. |
| **Update channel** | Good | Installations read `updates.json` from `main` over HTTPS. Firefox installs only builds signed by Mozilla for this add-on ID, so a changed `updates.json` alone cannot deliver foreign code. |
| **Release pipeline** | Strong | *Hardened in 1.9.0:* Actions are pinned by commit SHA (enforced by the repository setting), and only GitHub-owned actions are allowed. web-ext is installed from `package-lock.json` with install scripts disabled. The signing job can only read the repository, keeps no git credentials on disk and gets the AMO keys from the `release` environment, which admits only `v*` tags. A separate publish job, running no third-party code, creates the GitHub release. The AMO credentials were rotated during the review. |
| **Repository protection** | Good | *Added during the review:* `main` cannot be deleted or force-pushed. `v*` tags cannot be moved or deleted (repository admins may bypass; the workflow token cannot). Secret scanning with push protection and Dependabot security updates are enabled. |

## 6. Residual risks and recommendations
These are inherent to the deployment model or are optional further hardening. None of them is an open defect.

1. **stashdb.org can read what the extension shows.** The panel, sidebars and badges are part of stashdb.org's DOM. A script on that site can read which scenes are in the operator's Stash, the Stash URL, the performers' other scenes, their thumbnails and the search results. This is how a content-script UI works; it cannot be isolated from the page it lives in. *Recommendation:* if this matters, leave the Stash URL empty, which turns off every Stash-backed feature on stashdb.org.
2. **Content scripts can read the stored API keys.** In Manifest V2, `browser.storage.local` is open to every script of the extension, including the content script on stashdb.org. The content script never reads the keys, and a page cannot call extension APIs. Only a code-execution flaw in the content script itself would expose them. *Recommendation:* keep data out of `innerHTML` (enforced by review and the existing lint), and move the keys to background-only storage when the extension moves to Manifest V3.
3. **Plain HTTP on the LAN.** The usual setup reaches Prowlarr and Stash over HTTP, so the API keys are readable by anyone who can sniff that network segment. *Recommendation:* use HTTPS (for example through a reverse proxy), at least for Prowlarr.
4. **Searches can be triggered from outside.** Any web page can link to a StashDB scene with `#stasharr-search` and so start a Prowlarr search across all indexers. It cannot start a download. *Recommendation:* none required. Restrict it to links from the Stash origin if indexer query volume becomes a concern.
5. **The reverse lookup panel lives in the page it was opened on.** That page can read the StashDB matches and tell that stasharr is installed. Thumbnails are loaded from StashDB's image host. *Recommendation:* use the reverse lookup on pages you trust.
6. **The Stash marker reveals the extension version.** Pages and plugins on the configured Stash origin can read `data-stasharr`. This is intended (Stashboard depends on it) and limited to that origin.
7. **`main` takes direct pushes.** Pull requests are not required, so a stolen maintainer credential could change code without review. The signature requirement and the tag rules limit what that achieves. *Recommendation:* require pull requests on `main` if more people get write access.
8. **No live browser test.** Firefox's permission prompt, the update migration (the options page opening once after the update) and the click guards were checked by tests and review, not in a running Firefox. *Recommendation:* run one manual pass after each release that touches permissions.

## 7. Conclusion
stasharr keeps its secrets in the background script and never turns external data into markup. Since 1.9.0 it holds only the host permissions it needs and no longer trusts the host page with actions. Its release pipeline is protected against tampering by dependencies and tokens. The main remaining exposure is the one every content-script UI has: stashdb.org can see what stasharr shows on its pages. Operators who configure Stash should accept that, or leave Stash unconfigured. A new review is recommended after changes to permissions, message handling, the release workflow, or a move to Manifest V3.
