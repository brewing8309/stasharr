[← Documentation](README.md)

# Features

The pieces beyond the search itself. All of them need a Stash URL in the preferences unless noted.

## Already in your Stash

On a scene page, a badge shows its resolution and a link when the scene is in your library. On scene cards in performer, studio, tag and search lists, a lime badge (e.g. **1080p**) marks owned scenes; one request per page, a click opens the scene in Stash. Needs Stash 0.31 or newer. Matching uses the StashDB ID Stash stores, never names.

## Performer sidebars

The scene's first two performers each get a sidebar (right edge, then left) with up to 4 of their other scenes in your library, thumbnails included, and a link to the performer in Stash when there are more. On narrower windows they start folded; **+** opens one. Male performers don't get one.

## Auto-Download

The switch next to the search button sends the top release with every hit to Prowlarr after a search. It never applies to searches started from Stashboard.

## Download from Stashboard

[Stashboard](https://github.com/brewing8309/stashboard), a front page dashboard for Stash, shows
StashDB rows — trending, new from your favourites — next to your library. With stasharr installed
and your Stash URL set, every StashDB tile you don't have yet gets **⬇ Download**: it opens the
scene on StashDB with the panel already open and Stage 1 running. You still pick the release.

How they find each other: stasharr marks your Stash page (only the exact Stash URL from the
options) so Stashboard knows to show the button, and any link to a StashDB scene ending in
`#stasharr-search` opens with the search started. That link only ever starts a search; sending
a release to Prowlarr always takes your click.

## Stashboard's radar

The performer sidebars have a **Radar** button in their header: it puts the performer on
[Stashboard](https://github.com/brewing8309/stashboard)'s radar — not a favourite, but a
**More from …** row for them on your Stash front page, with their unwatched scenes and the StashDB
ones you're missing. Click again to take them off. It writes one thing, the performer's `radar`
custom field in Stash (the day you set it), the same field Stashboard's own 📡 uses. A performer
gets a sidebar for this even with no other scenes in your Stash yet; favourites don't get the button.

## Reverse lookup

Needs no Stash.

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
