# Next Gen Worship Beta — Worship Song App (Beta v2.0.14 — Playlists, Favorites, Chord Visibility)

An offline-first worship songbook PWA. Static HTML/CSS/JS, no build step, no
backend — built to run on GitHub Pages and install like a native app.

This is **Version 2** of the planning doc's roadmap, building on Version 1
(official songs, settings, light/dark mode, smart search, chord transpose)
by adding **Playlists** and a permanent **Favorites** playlist. User Songs
and Sheet Music are still ahead — see "Built for what's next", below.

## What's new in this version

- **Playlists** — a new "Playlists" tab in the bottom navigation, between
  Songs and Settings
- A permanent **Favorites** playlist — tap the heart icon on any song to
  add/remove it; it can't be renamed or deleted
- Create a playlist from Settings-free, one-tap **+** on the Playlists page,
  or directly from inside a song (**+** next to the heart) — creating one
  there adds the current song to it in the same step
- Add more songs to an existing playlist from inside that playlist (its own
  **+** button opens a searchable song picker)
- **Rename** or **delete** any user-created playlist via the three-dot (⋮)
  menu in the top-right of that playlist's page (not shown for Favorites)
- Playlists are saved on-device (IndexedDB, with a localStorage fallback)
  behind a small, swappable storage layer (`PlaylistStorage` in
  `js/app.js`) — see "Playlists storage", below, for what this does and
  doesn't cover
- **Export / Import playlists** (Settings → App) — downloads/loads a
  `ngworship-playlists.json` file, the supported way to carry playlists to
  a different browser on the same phone (see below for why this is a
  manual step, not automatic)

## What's in this version (carried over from v1)

- Official songs library with search (title, song number, artist, and lyric
  phrases — try searching "God awesome")
- Sort: A–Z, Z–A, number low–high, number high–low
- Song view with chords rendered above lyrics
- Chord transpose (up/down by semitone, resets to original key)
- Independent lyric and chord font size controls
- Light / dark mode (saved on-device)
- **Interface language: Mongolian (default) and English**, switchable in
  Settings (Playlists strings are also localized for Korean; the
  traditional-script Mongolian variant currently falls back to modern
  Cyrillic for the new Playlists strings only, pending a proper
  translation pass)
- Settings page with a song-database selector and an **Install App** button
- Full PWA support: manifest, service worker, offline caching
- Bottom navigation: Songs, Playlists, Settings — User Songs and Sheet
  Music are not yet in the nav; they'll be added back in when their
  versions land

## Playlists storage — what "local file, not browser-specific" means here

Playlists are saved **on the device**, not in the cloud — there's no
backend and nothing is uploaded anywhere. In practice that means IndexedDB
as the primary store, with a localStorage mirror as a fallback for
contexts where IndexedDB isn't available. Both of those are genuinely
**per-browser** storage: a real limitation of the web platform is that a
website has no way to share storage between two different browsers (say,
Chrome and Safari) on the same phone, or to write to an arbitrary file
the way a native app could, without the person's explicit, per-file
permission each time.

So: playlists **do** persist across visits, tab closes, and reopening the
installed app, and **do** survive on the same browser you created them in.
If you switch to a different browser on the same phone, use **Settings →
Export** to save a `ngworship-playlists.json` file, then **Import** it in
the other browser — that's the supported way to carry playlists across
browsers on this device today.

The storage code itself (`PlaylistStorage` in `js/app.js`) is deliberately
isolated behind two functions — `load()` and `save()` — so this can be
upgraded later (e.g. to the File System Access API, writing to a real file
the person picks once) without touching any of the playlist logic that
calls it.

## Project structure

```
index.html          App shell — every page lives here, toggled by JS
offline.html         Self-contained offline fallback page (see "Offline screen" below)
css/style.css        Design tokens + styles (light & dark themes)
js/app.js            All app logic: search, sort, transpose, language switching, install
app.js               Mirror of js/app.js — not loaded by index.html; kept in
                     sync as a convenience copy at the repo root
data/songs/           One JSON file per song + manifest.json listing them
lang/*.js         Interface text — one file per language (config.js + eng.js/mn.js/kr.js)
manifest.json         PWA manifest
service-worker.js     Offline caching (cache-first w/ background refresh)
icons/                App icons, logos, and icons/svg/ — one SVG file per UI icon
```

`index.html` only ever loads `js/app.js` — if you edit app logic, edit
`js/app.js` and copy the same change into the root `app.js` (or just remove
the root copy if it isn't needed; it's not referenced anywhere).

## Why song data moved to one JSON file per song

Each song is its own file under `data/songs/` (e.g. `s001.json`), listed in
`data/songs/manifest.json`. This makes adding, editing, or handing off a
single song trivial — no more scrolling a 2,000-line file to find one song,
and version-control diffs stay small and readable.

**Trade-off:** this loads the data with `fetch()`, which browsers block when
a page is opened directly from disk (`file://…/index.html`) — the exact
problem an earlier draft of this app avoided by using a single `.js` file
with a global variable instead. That workaround is gone now. **The app must
be served over `http://` or `https://`** — even `http://localhost` is
enough — for the song list to load at all. This same requirement already
applied to installability and offline support, so it isn't a new category of
limitation, just a stricter version of one that was already there.

## Replacing an icon

Every icon the app uses lives as its own file under `icons/svg/` (search,
back arrow, contact envelope, social icons, etc — names are descriptive, e.g.
`nav-songs-bookmark.svg`). To swap one out, just replace that file's content
with a different SVG — the app fetches and injects each icon at runtime, so
no code changes are needed, and a replacement with a different `viewBox`
still renders correctly. The splash-screen and about-page logos
(`icons/splash-logo.png`, `icons/about-logo.png`) are separate PNGs and can
be swapped the same simple way — the splash logo in particular is shown at
its own aspect ratio, never stretched, whatever size image you give it.

## Editing the song list

To add a song: create `data/songs/sNNN.json` (copy an existing one as a
template) and add its filename to `data/songs/manifest.json`. To edit a
song: open its file directly. Nothing in `js/app.js` needs to change either
way — the manifest is the only "index" the app needs.

Chords are written inline in the lyric line using square brackets right
before the syllable they land on:

```js
"lyrics": [
  "[Am]Oh Holy [G]Amazing God we pray"
]
```

renders as "Am" above "Oh" and "G" above "Amazing". A `""` empty string in
the `lyrics` array creates a blank line (verse/chorus break).

Fields match the planning doc's data structure: `id`, `number`, `title`,
`alternateTitles`, `artist`, `key`, `lyrics`, `labels`, `metadata`, `audio`,
`sheetMusic`. `audio` and `sheetMusic` are wired into the data model now so
later versions can light them up without a schema change.

## Interface language (Mongolian / English)

`lang/` holds one file per interface language (config.js sets the default and order). The app defaults to
**Mongolian** — set by `window.SONGBOOK_DEFAULT_LANG = "mn"` at the bottom of
that file. Change that line to `"en"` if you want English as the default;
either way, people can switch languages themselves from **Settings → App
language**, and their choice is remembered on their device.

This is the *interface* language (menus, buttons, labels) — separate from
the song database selector, which controls which songbook's content you're
viewing, matching the plan's note that these are independent settings.

To add a new language: copy `lang/eng.js`, translate every value, set its key, add a <script> line in index.html
each value, add it under a new key (e.g. `ko`), and add an `<option>` for it
in the `#ui-lang-select` dropdown in `index.html`.

## Running locally

Any static file server works, e.g.:

```bash
python3 -m http.server 8080
# then open http://localhost:8080
```

Opening `index.html` directly via `file://` now works for browsing and
searching songs too (see above), but **the service worker and the Install
button require HTTPS or `localhost`** — that's a browser security rule, not
something this app can opt out of. Use a local server (or GitHub Pages) to
test those two specifically. When the page isn't on a secure origin, the
Install row in Settings explains this instead of showing a dead button.

## Deploying to GitHub Pages

1. Create a new GitHub repository and push this folder's contents to it
   (this folder should be the repo root, or the root of the branch/folder
   you configure Pages to serve).
2. In the repo: **Settings → Pages → Build and deployment → Source** = "Deploy
   from a branch", pick `main` and `/ (root)`.
3. Wait for the Pages build to finish, then visit the URL GitHub gives you
   (`https://<username>.github.io/<repo-name>/`).
4. All paths in this project are relative (`./`, `css/…`, `data/…`), so it
   works whether it's served from a root domain or a `/repo-name/`
   subpath — no path edits needed.
5. GitHub Pages serves everything over HTTPS automatically, which is exactly
   what the service worker and Install button need to work.

### Updating the app later

Bump `SONGBOOK_VERSION_NUMBER` at the top of `version.js` whenever you ship
changed files. That's the **only** place a version number needs to be
edited — everything else derives from it automatically. Update
`SONGBOOK_VERSION_PRERELEASE` in the same file too (e.g. `'beta.1'`, or
`''` for a stable release) if that needs to change.

#### Why the version number matters — and why it's a single source of truth

This app is offline-first: the service worker caches the app shell
aggressively so it keeps working with no connection. That means an
installed device will happily keep serving old, stale files **forever**
unless something tells it a new version exists.

Two things depend on the version number, for different reasons:

- **`CACHE_VERSION`** (used in `service-worker.js`) is the cache-busting
  signal — changing its string is literally what causes
  `caches.open(CACHE_VERSION)` to open a *new* cache bucket, which makes
  the old one eligible for deletion and forces the browser to re-fetch
  every file. Ship changed files without bumping this and users can be
  stuck on the old version indefinitely, even after a hard refresh.
- **`APP_VERSION`** (used in `js/app.js`) is what's shown to the user on
  the About/Settings page (across every language file, via
  `versionSub(v)`), and it also drives the hard-update backstop — the code
  that detects a version mismatch on load and force-wipes the service
  worker + cache as a last resort, in case the normal `CACHE_VERSION`
  update path doesn't fire for some reason.

Historically these lived as separate hardcoded literals in `README.md`,
`js/app.js`, and `service-worker.js`, which meant they could quietly drift
out of sync with each other — the number shown on a user's screen wasn't
necessarily the version of code/cache they were actually running, which
makes bug reports hard to trust.

That's what `version.js` fixes: it's the one file with an actual number in
it (`SONGBOOK_VERSION_NUMBER`), and everything else is derived from that:

- `js/app.js` reads `window.SONGBOOK_APP_VERSION` (`APP_VERSION` is just
  set to that on load) instead of hardcoding its own string.
- `service-worker.js` can't use `<script>` tags — it's a worker, not a
  page — so it pulls in the same file with
  `importScripts('./version.js')`, and reads
  `self.SONGBOOK_CACHE_VERSION` from it.
- The title heading at the top of this README is the one thing that isn't
  wired up automatically (a static Markdown file can't run JS), so update
  it by hand to match `version.js` when you bump the version — it's just
  documentation, not something any code reads.

Because `version.js` is itself listed in `CORE_SHELL` in
`service-worker.js`, it's cached and available offline like the rest of
the app shell.

## Installing the app (PWA)

- **Android / Desktop Chrome, Edge:** open the site (over HTTPS), go to
  **Settings → Install app**, or use the browser's own install icon in the
  address bar. The button only appears once the browser decides the site is
  installable — that can take a moment after the page first loads.
- **iOS Safari:** Safari doesn't support the automatic install prompt, so the
  Install button opens a hint instead — tap the **Share** icon, then
  **Add to Home Screen**.
- Once installed, the Settings page shows an "Installed" badge instead of
  the button.
- **If Install still doesn't appear on a real HTTPS deployment:** check the
  browser console for a service worker registration error, and confirm
  `manifest.json` and both icon files are reachable at their exact paths —
  those are the two most common installability blockers.

## Offline screen

`offline.html` is a small, self-contained fallback page (no dependency on
`css/style.css`, fonts, or `js/app.js` — deliberately, since it exists for
the case where something else failed to load) that the service worker shows
instead of the browser's own generic "no internet" page whenever a page
navigation fails with nothing cached to fall back to — the thing that used
to make an installed, offline PWA suddenly look like a broken website. It
reads the same `sb-theme` / `sb-accent` / `sb-ui-lang` values from
`localStorage` that the main app saves, so it matches light/dark mode,
accent color, and language without needing its own settings. It's part of
`CORE_SHELL` in `service-worker.js`, so it's always cached alongside the
rest of the required app shell.

Settings → **Reload app** also checks `navigator.onLine` before doing
anything: while offline, it skips clearing the cache/service worker (there's
nothing to safely replace them with without a connection) and just reloads
normally instead, so the still-cached app keeps working rather than
reloading into a blank/broken page.

## Built for what's next

Version 1 only ever shows one song list (Songs) and two pages (Songs,
Settings), but the underlying code doesn't assume that's all there'll ever
be. Four things were generalized ahead of time specifically so Version 2+
(User Songs, Playlists, Sheet Music) can be added without reworking existing
code:

- **Song data (`state.sources`)** — songs live under `state.sources.official`,
  not a single flat list. Adding a `state.sources.user` entry for User Songs
  is additive; `renderSongList()`, `matchesQuery()`, `sortSongs()`, and
  `openSong()` already take a source key as a parameter instead of assuming
  `official` is the only source.
- **Pages (`PAGES` registry in `js/app.js`)** — `showPage()` and `bindNav()`
  read every page's element id, which nav button lights up for it, and
  whether it hides the bottom bar from one `PAGES` object, instead of
  hardcoded if/else branches. Adding a page (e.g. `user-songs`) means adding
  one `PAGES` entry, one `<main id="…">`, and one `<button data-nav="…">` —
  not touching the routing logic itself.
- **Offline backup (`SONGDB_STORES` in `js/app.js`)** — the IndexedDB backup
  already has a reserved `user-songs` object store (unused, empty, until v2
  starts writing to it), so turning on User Songs won't need another
  IndexedDB version bump/migration down the line.
- **Bottom nav (`.bottom-nav-inner` in `css/style.css`)** — the nav buttons
  are laid out with `flex: 1 1 0` + `space-evenly` inside a width-capped
  inner wrapper, so it distributes cleanly whether there are 2 buttons (now)
  or 5 (once User Songs, Playlists, and Sheet Music are added) — no gap/width
  retuning needed.

A few things this does *not* pre-build, on purpose (per the plan's "avoid
unnecessary complexity early"): there's still only one on-screen song list
and one song-view page in the DOM — a second page for User Songs still needs
its own `<main>`, its own nav button, and its own loader (User Songs are
locally-imported, not `fetch()`-loaded from a manifest like official songs,
so `fetchSongData()` itself is intentionally left specific to the official
source rather than generalized to a fetch pattern that wouldn't fit User
Songs anyway). The song data model also already includes `labels`, `audio`,
and `sheetMusic` fields so Version 3+ features don't require restructuring
existing song data.
