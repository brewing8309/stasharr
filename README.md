<div align="center">

# stasharr

**Find the release for a StashDB scene without ever leaving the page.**

A Firefox extension that turns any [StashDB](https://stashdb.org) scene page into a one-click
Prowlarr search — resolving the scene's studio, cast and date, hunting your indexers in three
escalating passes, scoring what comes back, and sending your pick straight to your download client.

![Firefox](https://img.shields.io/badge/Firefox-WebExtension-FF7139?logo=firefoxbrowser&logoColor=white)
![Manifest](https://img.shields.io/badge/Manifest-v2-blue)
![Dependencies](https://img.shields.io/badge/dependencies-none-success)
![Vibecoded](https://img.shields.io/badge/100%25-vibecoded-ff69b4)

</div>

---

> ### Heads up: this is 100% vibecoded
>
> Every line of this extension was written by Claude, prompt by prompt, with no human writing
> code by hand. It works, it's commented, and it's been thought through — but it has never seen a
> code review by a human being, has no test suite, and makes no promises. Read it before you run
> it. That's the deal.

---

## What it does

You're on a StashDB scene page. You want the file. Normally that means copy-pasting the studio,
the performers and the date into Prowlarr, guessing at naming conventions, and trying again with
different terms when nothing hits.

This does that for you, and then some:

| | |
|---|---|
| **One-click search** | A floating **⬇ Search Prowlarr** button on every `stashdb.org/scenes/<id>` page. |
| **Three escalating passes** | Starts narrow and precise, widens on demand — 5 parallel queries, then 3 more, then a last-ditch performer-only sweep. |
| **Scored results** | Every release is checked against 5 known facts about the scene and ranked, so a prolific performer's entire back catalogue doesn't drown the one file you want. |
| **Grouped by quality** | 2160p → 1080p → 720p → everything else, with seeders/size/indexer on every row. |
| **One-click grab** | **Download** hands the release to Prowlarr, which passes it to your download client. |
| **"Already have it"** | If you run StashApp, scenes already in your library get a badge with their resolution and a link — before you search anything. |
| **Reverse lookup** | Select *any* text anywhere in the browser → right-click → **Search StashDB** to find the scene that text belongs to. |
| **Full transparency** | A **Details** pane shows every query fired, live, with each one's own raw unfiltered results. No black box. |

## How it works

Everything runs locally in your browser. There is no server, no telemetry, no third party — just
your Firefox talking to your Prowlarr, your Stash, and StashDB.

```
              ┌──────────────────────── Firefox ────────────────────────┐
              │                                                          │
 stashdb.org  │  content.js ──── GraphQL (your session) ──► StashDB      │
 scene page   │      │           studio · cast · aliases · parent · date │
              │      │                                                   │
              │      ▼                                                   │
              │  3-stage search ──► background.js ──────────► Prowlarr   │
              │      ▲                (all cross-origin        (search   │
              │      │                 requests proxied         + grab)  │
              │  results panel          through here)                    │
              │  scored · grouped · deduped ◄─────────────────► StashApp │
              │                                                (library  │
 any page ────┤  right-click selection ──► background.js ──► StashDB      │
 (reverse)    │              picker.js ◄── matching scenes     search)   │
              │                                                          │
              └──────────────────────────────────────────────────────────┘
```

### The three stages

Each stage fires its queries **in parallel**, merges the responses, de-duplicates them by release
GUID, and merges them into everything found so far. Results never get thrown away when you move
up a stage — the list only ever grows.

<table>
<tr><th>Stage</th><th>Trigger</th><th>Queries</th><th>Filtering</th></tr>
<tr>
<td><b>1 — Automatic</b></td>
<td>Clicking the button</td>
<td>

`performers + studio + date`<br>
`performers + date`<br>
`performers + studio`<br>
`studio + date`<br>
`title`

</td>
<td>Must match ≥ 2 of 5 criteria</td>
</tr>
<tr>
<td><b>2 — 🍆 Try Harder</b></td>
<td>Click 1</td>
<td>

`performers + parent studio + date`<br>
`performers + parent studio`<br>
`performer aliases + date`

</td>
<td>Same ≥ 2 of 5 filter</td>
</tr>
<tr>
<td><b>3 — 🍑 Last Chance...</b></td>
<td>Click 2</td>
<td>

`performers` (nothing else)

</td>
<td>No filter. Sorted by publish-date proximity, capped at 50.</td>
</tr>
</table>

Queries that would repeat something already tried — or that have nothing to fill in, like a studio
with no parent brand — are skipped rather than re-sent. After stage 3 there is nothing left to
fall back to, so the button retires itself and leaves a parting word in its place.

### Scoring

Every release title is normalised (lowercased, punctuation stripped) and checked against five
fixed facts about the scene:

**Studio** · **Parent studio** · **Performer** (any cast member *or* one of her aliases) · **Title** · **Date**

Stages 1 and 2 only show releases matching **at least 2 of 5** — that's what keeps the broad
queries usable. Every row shows its own score inline (`3/5 hits (Studio, Performer, Date)`), so
you can see exactly why something is in the list. Within a resolution group, higher scores rank
first, then seeders/grabs.

Every row also shows how far its Prowlarr publish date sits from the scene's release date
(`4d from scene date`). That's **informational only** — it never feeds the score or the sort,
except in stage 3, where it *is* the sort.

### Reverse lookup

Found a filename in a forum post, a release tracker, or a chat log and want to know which scene it
actually is? Select it, right-click, **Search StashDB for "…"**.

The selection gets normalised into a plain search phrase — file extensions, quality and codec tags
(`1080p`, `x264`, `WEB-DL`, …) and separators (dots, underscores, brackets, hyphens) all stripped —
without assuming which format it is. All of these work:

```
Studio.Performer.Name.26.09.10.XXX.1080p.mp4   →   Studio Performer Name 26 09 10
[Studio] Performer - Scene Title               →   Studio Performer Scene Title
Performer - Scene Title                        →   Performer Scene Title
just a half-remembered title                   →   just a half remembered title
```

A floating panel then shows the matching StashDB scenes with their thumbnails, studio, date and
cast. Click one to open it on StashDB — where the normal search button takes over. This step only
finds and confirms the scene; it never touches Prowlarr on its own.

## Install

Firefox refuses to permanently install unsigned extensions on Release and Beta, so pick one:

<details>
<summary><b>Temporary — for trying it out</b> (gone on restart)</summary>

1. Clone or download this repo.
2. Open `about:debugging#/runtime/this-firefox`.
3. **Load Temporary Add-on…** → pick `manifest.json`.

</details>

<details>
<summary><b>Signed — for keeping it</b> (needs a free AMO account)</summary>

Sign it to yourself as an unlisted add-on — it never goes on the public store, and never gets
reviewed by Mozilla:

```bash
npm install --global web-ext
web-ext sign --channel=unlisted \
  --api-key="$AMO_JWT_ISSUER" \
  --api-secret="$AMO_JWT_SECRET"
```

Get the credentials at [addons.mozilla.org → Developer Hub → API Keys](https://addons.mozilla.org/developers/addon/api/key/).
The signed `.xpi` lands in `web-ext-artifacts/`; drag it into Firefox to install permanently.

The extension ships a fixed add-on ID (`stasharr@brewing8309`), so re-signing a new version
updates the installed one instead of creating a duplicate.

</details>

> Firefox Developer Edition, Nightly and ESR can skip signing entirely by setting
> `xpinstall.signatures.required` to `false` in `about:config`.

## Configuration

Open the add-on's preferences (`about:addons` → stasharr → Preferences) and fill in:

| Setting | Default | Required | What it's for |
|---|---|---|---|
| **Prowlarr URL** | — | yes | Base URL, no trailing slash. e.g. `http://localhost:9696` |
| **Prowlarr API key** | — | yes | Prowlarr → Settings → General → Security |
| **Search categories** | `6000` | no | Newznab/Torznab category IDs, comma-separated. `6000` = XXX. Empty = all. |
| **Result limit** | `200` | no | Max releases Prowlarr returns per query. Raise it if stage 3 seems to be missing hits for a prolific performer. |
| **Stash URL** | — | no | Your own StashApp, e.g. `http://localhost:9999`. Enables the "already in your library" badge. |
| **Stash API key** | — | no | Only if your Stash requires one. |

**Test Prowlarr** and **Test Stash** verify each connection before you save.

A couple of knobs are deliberately not in the UI, but are one-line edits in `content.js` if you
want them: `MIN_SCORE` (the 2-of-5 threshold) and `LAST_CHANCE_LIMIT` (the 50-result cap on
stage 3).

## Usage

1. Open a scene on `stashdb.org`. If it's already in your Stash library, the badge tells you now.
2. Hit **⬇ Search Prowlarr** (bottom right).
3. Pick a release, hit **Download**. It turns into **✓ Sent** and stays that way — even across
   stages — so you can't accidentally grab the same thing twice.
4. Nothing good? **🍆 Try Harder**, then **🍑 Last Chance...**.
5. Curious what it actually searched for? Expand **Details** — every query, every raw result.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Panel says "Could not read scene" | Not logged into StashDB. It falls back to scraping the rendered page, which has no aliases or parent studio — log in for the good data. |
| Every query fails instantly | Prowlarr URL or API key wrong. Hit **Test Prowlarr** in preferences. |
| Search hangs, then errors | Requests time out after 20s. Usually a dead indexer in Prowlarr, or an unreachable instance. |
| Some queries fail, others don't | You'll get a warning banner above the results; expand **Details** to see which indexer choked. Partial results still show. |
| Stage 3 feels like it's missing things | Raise **Result limit**. Prowlarr caps at 200 by default, and a prolific performer blows through that easily. |
| No "already in Stash" badge | Stash URL not set, or the scene was never scraped from StashDB (matching is done on the stash-box ID StashApp records). |
| Right-click search does nothing | Restricted page (`about:`, `addons.mozilla.org`) — Firefox forbids injection there. Also needs a StashDB login. |

## Under the hood

No build step, no bundler, no dependencies. Clone it and it runs.

```
manifest.json    MV2, <all_urls> + storage + contextMenus
background.js    every cross-origin request (Prowlarr, StashApp, StashDB search),
                 20s timeouts, context-menu registration
content.js       injected on stashdb.org — scene resolution, query building,
                 scoring, the 3-stage state machine, results panel
picker.js        injected on demand into any page for the reverse lookup panel
content.css      shared styling for both panels
options.html/js  preferences
```

Content scripts can't reach cross-origin hosts, so everything network-facing lives in
`background.js` and is reached by message passing. Credentials never leave `browser.storage.local`
and are only ever sent to the hosts you configured yourself.

## Disclaimer

This tool searches **your own** Prowlarr instance across **your own** indexers, and talks to
**your own** Stash. It hosts nothing, indexes nothing, distributes nothing, and ships with no
indexers, trackers or sources of any kind. What you point it at, and whether you're entitled to
what you find, is entirely on you.

Not affiliated with StashDB, Stash, or Prowlarr.
