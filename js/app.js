// =========================================================
// Songbook — app.js
// Copyright (c) 2026 Next Gen Union. All rights reserved.
// Proprietary and confidential. No unauthorized copying, modification,
// or redistribution, in whole or in part, without prior written
// permission from Next Gen Union. See LICENSE for full terms.
//
// Data-driven: song content lives as one JSON file per song, one folder
// per song database under /data/ (see DB_SOURCES further down for the
// registry of which folder belongs to which source), loaded at runtime
// by loadAllSongData(). Adding a song = add a JSON file + one line in
// that source's manifest.json — nothing here needs to change. Adding a
// whole new database = a new folder + manifest + one DB_SOURCES entry +
// one <option> in index.html's #db-select.
// =========================================================

// Sourced from version.js (loaded before this file in index.html) so this
// never has to be edited here — bump the version in version.js instead.
const APP_VERSION = window.SONGBOOK_APP_VERSION;
const SEEN_VERSION_KEY = 'ngw_seen_version';

// Marks the version we're about to reload into as "already seen", so that
// when app.js re-executes after the reload, hardUpdateBackstop() below
// sees no mismatch and stays quiet. Called by every code path that already
// handles an update and is about to reload for it on its own (the normal
// controllerchange path, and the manual "Reload app" button) — so the
// backstop only ever fires for what it's actually meant for: a device that
// somehow never went through one of those normal paths at all. Without
// this, the backstop can't tell "a normal update just handled this" apart
// from "nothing has ever updated this device", and reloads a second time
// after every single normal update, on top of the reload that already
// handled it.
function markVersionSeen() {
  try {
    localStorage.setItem(SEEN_VERSION_KEY, APP_VERSION);
  } catch (e) {
    // localStorage unavailable — the reload still happens either way;
    // worst case here is the backstop redundantly double-checking on the
    // next load, not a stuck/stale app.
  }
}

// --- Hard update backstop -------------------------------------------------
// Everything above (scrollRestoration, controllerchange auto-reload,
// updateViaCache) fixes the *normal* service-worker update path. This is a
// second, independent line of defense that doesn't rely on any of that
// machinery noticing anything: it runs the instant this script itself
// executes, compares APP_VERSION against what's remembered from last time,
// and if they don't match, wipes every service worker + cache directly and
// forces one reload. So even if a device somehow never sees a normal SW
// update (host-level caching quirks, timing races, whatever), the first
// time it happens to load a genuinely fresh copy of this file, it will
// self-heal rather than staying stuck on stale code indefinitely.
//
// The normal update paths (registerServiceWorker()'s controllerchange
// listener, and the manual reloadApp() button) call markVersionSeen()
// themselves just before they reload, specifically so this backstop sees
// nothing to do on the load that follows. Without that, this ran a SECOND,
// redundant reload after every single normal update — the mismatch here
// used to only ever get cleared by this same block, so it could never tell
// "a normal path just updated this" apart from "nothing ever has".
//
// This wipes EVERY cache bucket, including the separate offline-fallback
// one (see OFFLINE_CACHE in service-worker.js) — deliberately: this path
// only runs when something is stale/wrong enough to need a full reset, so
// it shouldn't leave anything behind, offline.html included. The
// reload this triggers re-registers the service worker, whose install
// step repopulates OFFLINE_CACHE immediately after — the only real gap is
// the reload itself failing while genuinely offline, which no caching
// strategy can paper over.
(function hardUpdateBackstop() {
  try {
    const seen = localStorage.getItem(SEEN_VERSION_KEY);
    if (seen && seen !== APP_VERSION) {
      localStorage.setItem(SEEN_VERSION_KEY, APP_VERSION);
      const wipe = [];
      if ('serviceWorker' in navigator) {
        wipe.push(navigator.serviceWorker.getRegistrations().then(regs => Promise.all(regs.map(r => r.unregister()))));
      }
      if ('caches' in window) {
        wipe.push(caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k)))));
      }
      Promise.all(wipe).catch(() => {}).finally(() => window.location.reload());
      return;
    }
    localStorage.setItem(SEEN_VERSION_KEY, APP_VERSION);
  } catch (e) {
    // localStorage unavailable (e.g. private browsing edge cases) — the
    // normal service-worker update path above still applies, just skip
    // this extra backstop rather than letting it break anything.
  }
})();

// Song sources: each is an independent collection of songs — its own list,
// its own load-state, and (see SONGDB_STORES further down) its own offline
// backup store. Version 1 only ever populates and shows 'official'. The
// list/search/sort/song-view code below all takes a source key as a
// parameter rather than assuming 'official' is the only one, so a future
// 'user' source (v2's User Songs) can reuse it — add its loader, its own
// page, and a call site — without rewriting any of this.
const state = {
  sources: {
    official: { songs: [], loadFailed: false },
    english: { songs: [], loadFailed: false },
    // User Songs (v3): not fetched from a manifest like official/english —
    // loaded from IndexedDB via UserSongStorage (see loadUserSongs()) —
    // but shaped identically otherwise, so every list/search/sort/song-view
    // function below works against it with no source-specific branches.
    user: { songs: [], loadFailed: false },
  },
  // Which entry in `sources` (and which folder under data/) the Songs
  // page, search, sort, and the playlist song-picker all currently browse.
  // Driven by Settings → Song database (see the db-select dropdown/
  // 'sb-db' in bindSettings and DB_SOURCES below) — not the same thing as
  // activeSourceKey below, which instead remembers where an *already
  // open* song came from, since a person can switch databases while a
  // song from the other one is still open in the song view.
  activeDbSource: 'official',
  sortBy: 'num',       // 'alpha' | 'num'
  sortOrder: 'asc',     // 'asc' | 'desc'
  query: '',
  userSongQuery: '', // User Songs page's own search box — kept separate
                      // from `query` (the Songs page's) so switching tabs
                      // doesn't clobber whichever search the person was
                      // mid-typing on the other page.
  activeSong: null,
  activeSourceKey: 'official', // which source the open song view came from
  editorSongId: null, // set while the editor is open for an EXISTING user
                       // song (its id); null means "New song" — see
                       // openSongEditor(). Read by saveSongFromEditor() to
                       // decide insert vs update.
  transpose: 0,
  lyricsSize: 1.05,   // rem
  chordSize: 0.82,    // rem
  chordStyle: 'chip', // 'chip' | 'text' — see applyChordStyle()
  hideChords: false,  // see applyHideChords()
  lyricsWeight: 'normal',  // 'normal' | 'semibold' | 'bold' — see applyLyricsWeight()
  lyricsSpacing: 'tight', // 'tight' | 'normal' | 'loose' — see applyLyricsSpacing()
  lang: 'mn',
  currentPage: 'songs', // mirrors whichever page is currently visible (see showPage)
  playlists: { order: [], byId: {} }, // see "Playlists" section below
  activePlaylistId: null,

  // ---- Developer options (see initDevOptions()) ----
  // The page itself is only reachable after tapping the About page's app
  // icon 3 times in a row (see bindDevOptionsUnlock()) — devUnlocked isn't
  // persisted, so the nav row to it is hidden again on every fresh load
  // and has to be re-unlocked, the same as the existing accent-color
  // easter egg.
  devUnlocked: false,
  // devSabbathForced/devChristmasForced/devPartyForced: one switch per
  // easter egg, each OFF by default. Turning one ON force-shows that
  // single easter egg (Sabbath mascot / Christmas snow / accent disco
  // "party mode" respectively) regardless of today's date or manual-tap
  // state — the other two are untouched. Turning it back OFF does NOT
  // disable that egg — it just stops forcing it on, so it falls back to
  // its own original secret trigger exactly as before this feature
  // existed: Sabbath/Christmas by date, party mode by 3 taps on "Accent
  // color". See each easter egg's isXActive()-style check further down
  // for how its own override is read.
  devSabbathForced: false,
  devChristmasForced: false,
  devPartyForced: false,
  devTradMongolian: false, // see refreshLangPicker()
  devCredits: false,       // see renderCredits()
  devHideDescriptions: false, // see applyDevOptions() — toggles .settings-desc-hideable
};

// Registry of every page the router (showPage/bindNav) knows about. Adding
// a new page later — e.g. v2's "user-songs", or Playlists/Sheet Music —
// means adding one entry here plus its <main id="…"> and its
// <button data-nav="…"> in index.html; showPage() and bindNav() below
// don't need to change either way.
//   elId            — the <main> element's id.
//   navKey           — which bottom-nav button (its data-nav value) should
//                       light up while this page is open. song-view has no
//                       button of its own, so it borrows 'songs' (the list
//                       it was opened from). Omit for a page that hides the
//                       nav bar entirely (see hideNav).
//   hideNav          — true if the bottom nav should be hidden on this page.
//   rememberScroll    — true if this page's scroll position should be saved
//                       and restored across navigation. song-view is false:
//                       it shows different content each time it's opened,
//                       so it always starts at the top instead.
//   onEnter          — optional callback run each time this page is shown.
const PAGES = {
  'songs':          { elId: 'page-songs',          navKey: 'songs',     rememberScroll: true },
  'song-view':      { elId: 'page-song-view',      navKey: 'songs',     rememberScroll: false, hideNav: true },
  'user-songs':     { elId: 'page-user-songs',      navKey: 'user-songs', rememberScroll: true, onEnter: () => renderUserSongList() },
  'song-editor':    { elId: 'page-song-editor',    navKey: 'user-songs', rememberScroll: false, hideNav: true },
  'playlists':      { elId: 'page-playlists',      navKey: 'playlists', rememberScroll: true,  onEnter: () => renderPlaylistsList() },
  'playlist-view':  { elId: 'page-playlist-view',  navKey: 'playlists', rememberScroll: false, hideNav: true },
  'settings':       { elId: 'page-settings',       navKey: 'settings',  rememberScroll: true,  onEnter: () => { resetContactUI(); updateAllSegToggleThumbs({ instant: true }); } },
  'about':          { elId: 'page-about',          navKey: 'settings',  rememberScroll: false, hideNav: true },
  // Only reachable once unlocked (see unlockDevOptions()) — not through
  // history/deep-linking before that, since showPage() itself doesn't
  // gate on state.devUnlocked; the About page's row to get here is what's
  // hidden pre-unlock instead (see index.html).
  'dev-options':    { elId: 'page-dev-options',    navKey: 'settings',  rememberScroll: false, hideNav: true },
};

// Pages that open "on top of" another page (a song out of the songbook or
// a playlist, pushed over whatever list it was opened from) rather than
// being a sibling tab you switch between. These get the slide push/pop
// transition in showPage(); tab switches (Songs/Playlists/Settings) stay
// an instant cut, same as before.
const SLIDE_PAGES = new Set(['song-view', 'playlist-view', 'about', 'dev-options', 'song-editor']);

// The four bottom-nav tabs — sibling pages switched via .nav-btn taps
// rather than "opened on top of" one another, so they get the crossfade
// in runTabFadeTransition() below instead of SLIDE_PAGES' push/pop slide.
// See showPage()'s transitionType selection.
const TAB_PAGES = new Set(['songs', 'user-songs', 'playlists', 'settings']);

// Remembers each rememberScroll page's scroll position (each .page
// element's own scrollTop — see the CSS notes on .page for why it's no
// longer window/document scroll) across navigation, so leaving a page (open
// a song, switch tabs) and coming back lands where you left off, instead of
// jumping to the top every time. Derived from PAGES so a new page opts in
// just by setting rememberScroll: true there — nothing to add here. See
// showPage().
const scrollMemory = {};
Object.entries(PAGES).forEach(([name, page]) => {
  if (page.rememberScroll) scrollMemory[name] = 0;
});

// Chord transpose is limited to a full octave in either direction —
// beyond that you're just back to an enharmonic equivalent of an in-range key.
const TRANSPOSE_LIMIT = 12;

const CHROMATIC_SHARP = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const CHROMATIC_FLAT  = ['C','Db','D','Eb','E','F','Gb','G','Ab','A','Bb','B'];
const FLAT_KEYS = new Set(['F','Bb','Eb','Ab','Db','Gb','Dm','Gm','Cm','Fm','Bbm']);

// ---------------------------------------------------------
// Icons: every icon the app uses lives as its own file under
// icons/svg/ — this loader fetches each one and injects its markup into
// the matching <svg data-icon="…"> placeholder. To use a different icon,
// replace (or edit) the file in icons/svg/ — nothing here needs to change.
// A replacement file's own viewBox/attributes are honored, so a
// differently-proportioned icon still renders correctly.
// ---------------------------------------------------------
const ICON_FILES = {
  'brand-mark': 'icons/svg/brand-music-note.svg',
  'search': 'icons/svg/search.svg',
  'back-arrow': 'icons/svg/back-arrow.svg',
  'contact-mail': 'icons/svg/mail-contact.svg',
  'copy': 'icons/svg/copy.svg',
  'nav-songs': 'icons/svg/nav-songs-bookmark.svg',
  'nav-user-songs': 'icons/svg/nav-user-songs.svg',
  'nav-settings': 'icons/svg/nav-settings-gear.svg',
  'nav-playlist': 'icons/svg/nav-playlist.svg',
  'heart-outline': 'icons/svg/heart-outline.svg',
  'heart-filled': 'icons/svg/heart-filled.svg',
  'menu-kebab': 'icons/svg/menu-kebab.svg',
  'plus': 'icons/svg/plus.svg',
  'trash': 'icons/svg/trash.svg',
  'pencil': 'icons/svg/pencil.svg',
  'close': 'icons/svg/close.svg',
  'check': 'icons/svg/check.svg',
  'download': 'icons/svg/download.svg',
  'upload': 'icons/svg/upload.svg',
  'social-facebook': 'icons/svg/social-facebook.svg',
  'social-youtube': 'icons/svg/social-youtube.svg',
  'social-instagram': 'icons/svg/social-instagram.svg',
  'social-website': 'icons/svg/social-website.svg',
  // Full-color one-off (not part of the monochrome fill="currentColor" set
  // above) — the Saturday/Sabbath easter-egg mascot. See initSabbathMascot().
  'mascot-sabbath': 'icons/svg/mascot-sabbath.svg',
};

const iconFileCache = new Map();
function loadIconFile(path) {
  if (!iconFileCache.has(path)) {
    iconFileCache.set(path, fetch(path).then((res) => {
      if (!res.ok) throw new Error(`${path} responded ${res.status}`);
      return res.text();
    }));
  }
  return iconFileCache.get(path);
}

async function injectIcon(el) {
  const name = el.dataset.icon;
  const path = ICON_FILES[name];
  if (!path) return;
  try {
    const svgText = await loadIconFile(path);
    const src = new DOMParser().parseFromString(svgText, 'image/svg+xml').querySelector('svg');
    if (!src) throw new Error('no <svg> root found');
    // Adopt the file's own viewBox/attributes (so a replacement icon with
    // different proportions still renders correctly), but never touch
    // class/id — those belong to the placeholder markup, not the icon file.
    Array.from(src.attributes).forEach((attr) => {
      if (attr.name === 'class' || attr.name === 'id') return;
      el.setAttribute(attr.name, attr.value);
    });
    el.innerHTML = src.innerHTML;
  } catch (err) {
    console.warn(`Songbook: could not load icon "${name}" from ${path} —`, err);
  }
}

function initIcons(root = document) {
  return Promise.all(Array.from(root.querySelectorAll('[data-icon]')).map(injectIcon));
}

// Social links shown in Settings → About. Leave `url` empty in config.js to
// hide that icon entirely — nothing else needs to change when these are
// filled in. Each icon's artwork lives in icons/svg/ (see ICON_FILES above);
// this table just maps a platform to its label and icon file key.
const SOCIAL_ICONS = {
  facebook: { label: 'Facebook', icon: 'social-facebook' },
  youtube: { label: 'YouTube', icon: 'social-youtube' },
  instagram: { label: 'Instagram', icon: 'social-instagram' },
  website: { label: 'Website', icon: 'social-website' },
};

function renderSocialLinks() {
  const el = document.getElementById('about-social');
  if (!el) return;
  const social = (window.SONGBOOK_APP_CONFIG && window.SONGBOOK_APP_CONFIG.social) || {};
  el.innerHTML = Object.keys(SOCIAL_ICONS)
    .filter(key => social[key])
    .map(key => `<a href="${escapeHtml(social[key])}" target="_blank" rel="noopener noreferrer" aria-label="${escapeHtml(SOCIAL_ICONS[key].label)}"><svg data-icon="${SOCIAL_ICONS[key].icon}" viewBox="0 0 24 24"></svg></a>`)
    .join('');
  initIcons(el);
}

// Credits list on the About page — who's behind the app. Config-driven
// (see config.js's `creditsEnabled`/`credits`) so showing/hiding it, or
// adding/removing people, never needs a code change. creditsEnabled is a
// separate on/off switch from the list itself — flipping it off hides the
// section without losing the entries in `credits`, so turning it back on
// later doesn't mean re-typing everyone in. Developer options' own
// Credits toggle (state.devCredits) is a second, runtime way to turn it
// back on for preview purposes without editing config.js — either one
// being on is enough to show the section.
function renderCredits() {
  const section = document.getElementById('about-credits');
  const list = document.getElementById('about-credits-list');
  if (!section || !list) return;
  const config = window.SONGBOOK_APP_CONFIG || {};
  const credits = config.credits || [];
  if (!(config.creditsEnabled || state.devCredits) || !credits.length) {
    section.hidden = true;
    list.innerHTML = '';
    return;
  }
  section.hidden = false;
  list.innerHTML = credits.map(c => `
    <li class="about-credits-item">
      <span class="about-credits-role">${escapeHtml(c.role || '')}</span>
      <span class="about-credits-name">${escapeHtml(c.name || '')}</span>
    </li>`).join('');
}

function t(key, ...args) {
  const dict = (window.SONGBOOK_LANG && window.SONGBOOK_LANG[state.lang]) || {};
  const entry = dict[key];
  if (typeof entry === 'function') return entry(...args);
  return entry !== undefined ? entry : key;
}

// ---------------------------------------------------------
// Boot
// ---------------------------------------------------------
document.addEventListener('DOMContentLoaded', init);

// Each startup step runs independently — if one throws (a missing element,
// a bad selector, anything), the rest still run. Without this, one broken
// step could silently prevent applyLanguage() from ever running, leaving
// the static English placeholders in index.html on screen permanently
// instead of the real (translated) content.
function safe(label, fn) {
  try {
    fn();
  } catch (err) {
    console.error(`Songbook: "${label}" failed during startup —`, err);
  }
}

async function init() {
  safe('initIcons', initIcons);
  safe('initSplash', initSplash);
  safe('loadPrefs', loadPrefs);
  safe('bindNav', bindNav);
  safe('bindSongsPage', bindSongsPage);
  safe('bindSongView', bindSongView);
  safe('bindUserSongsPage', bindUserSongsPage);
  safe('bindSongEditor', bindSongEditor);
  safe('bindPlaylistsPage', bindPlaylistsPage);
  safe('bindPlaylistView', bindPlaylistView);
  safe('bindModalShell', bindModalShell);
  safe('bindSettings', bindSettings);
  safe('bindAboutPage', bindAboutPage);
  safe('applyLanguage', applyLanguage);
  safe('registerServiceWorker', registerServiceWorker);
  safe('setupInstallPrompt', setupInstallPrompt);
  safe('initHistoryNav', initHistoryNav);
  safe('initSabbathMascot', initSabbathMascot);
  safe('initChristmasSnow', initChristmasSnow);
  safe('bindAccentDiscoEasterEgg', bindAccentDiscoEasterEgg);
  safe('initDevOptions', initDevOptions);
  requestPersistentStorage(); // fire-and-forget; never block startup on this

  await Promise.all([loadAllSongData(), loadPlaylists(), loadUserSongs()]);
  safe('applyLanguage (post-load)', applyLanguage); // re-run so the results count reflects the loaded songs
}

// Ask the browser not to automatically evict our Cache Storage / IndexedDB
// under storage pressure. This is a real, standard API — but it's worth
// being clear about what it does and doesn't cover: it protects against
// the browser's own automatic eviction, not against a user (or an OEM
// "phone manager" cleanup tool) explicitly clearing the app's storage —
// that's a stronger, OS-level action no web page can prevent.
async function requestPersistentStorage() {
  if (!(navigator.storage && navigator.storage.persist)) return;
  try {
    const already = await navigator.storage.persisted();
    if (already) return;
    const granted = await navigator.storage.persist();
    console.log('Songbook: persistent storage', granted ? 'granted' : 'not granted (browser declined)');
  } catch (err) {
    console.warn('Songbook: persistent storage request failed —', err);
  }
}

// ---------------------------------------------------------
// Song databases — each is its own folder under data/, with its own
// manifest.json listing that folder's song files. Registered here in one
// place (DB_SOURCES) so adding a future third database (or a next-gen
// version of this app adding more) is: pick a new key, add a folder +
// manifest under data/, add one entry below, add one <option> to
// #db-select in index.html — nothing else in this file needs to change,
// since every function below reads a source's folder/hasNumbers from this
// registry rather than assuming 'data/songs/' or that every song has a
// number.
//
//   folder     — the data/ subfolder this source's songs and
//                manifest.json live in.
//   hasNumbers — false means this source's songs have no `number` field
//                (see the English database) — see applySongNumberUI() for
//                what that changes in the Songs page (hides "Sort by
//                number" and the number badges) once this source is the
//                active one.
// ---------------------------------------------------------
const DB_SOURCES = {
  official: { folder: 'mongolian', hasNumbers: true },
  english:  { folder: 'english',   hasNumbers: false },
};

// One JSON file per song, listed in <folder>/manifest.json. Adding a song
// = add its JSON file + one line in that source's manifest; nothing else
// in the app needs to change.
//
// Uses Promise.allSettled rather than Promise.all deliberately: the
// manifest and the actual files on disk can drift out of sync (a song
// removed without updating the manifest, a typo in a filename, a song
// still mid-upload). With Promise.all, ONE missing/broken file rejects
// the whole batch and the entire library — every other song, including
// ones that are perfectly fine — silently fails to load. That's the bug
// that made the app look like it had no songs (and so no working audio
// player) at all. allSettled loads everything that *does* work and just
// warns about what doesn't, so one bad entry can't take down the rest.
// ---------------------------------------------------------
async function fetchSongData(sourceKey, { forceRefresh = false } = {}) {
  const dbSource = DB_SOURCES[sourceKey];
  if (!dbSource) throw new Error(`unknown song source "${sourceKey}"`);
  const base = `data/${dbSource.folder}`;

  const headers = forceRefresh ? { 'X-Force-Refresh': '1' } : {};
  const manifestRes = await fetch(`${base}/manifest.json`, { headers });
  if (!manifestRes.ok) throw new Error(`manifest.json responded ${manifestRes.status}`);
  const files = await manifestRes.json();

  const results = await Promise.allSettled(files.map(async (file) => {
    const res = await fetch(`${base}/${file}`, { headers });
    if (!res.ok) throw new Error(`${file} responded ${res.status}`);
    return res.json();
  }));

  const failed = results.filter(r => r.status === 'rejected');
  if (failed.length) {
    console.warn(
      `Songbook: ${failed.length} of ${files.length} song file(s) failed to load and were skipped —`,
      failed.map(r => r.reason && r.reason.message ? r.reason.message : r.reason)
    );
  }

  const songs = results.filter(r => r.status === 'fulfilled').map(r => r.value);
  if (songs.length === 0 && files.length > 0) {
    // Every single file failed (e.g. fully offline with no cache yet) —
    // that's the one case that should still surface as a real failure so
    // loadSongDataFor()'s IndexedDB-backup fallback below kicks in.
    throw new Error('all song files failed to load');
  }
  // hadFailures (some, but not all, files failed) lets loadSongDataFor()
  // tell "a complete library" apart from "an incomplete one that still
  // technically succeeded" — e.g. reconnecting partway through a slow
  // download. See its use there for why that distinction matters.
  return { songs, hadFailures: failed.length > 0 };
}

// ---------------------------------------------------------
// IndexedDB backup: a second, independent offline copy of the song data.
// Cache Storage (used by the service worker) is the primary mechanism and
// is enough on its own in normal use — this exists purely as a fallback
// for the edge case where Cache Storage has been evicted by the OS under
// storage pressure (a real, documented mobile behavior, and a different
// eviction policy than IndexedDB's) while the network is also unavailable.
// ---------------------------------------------------------
const SONGDB_NAME = 'songbook-db';
// Bumped 1 → 2 to add 'user-songs', then 2 → 3 to add 'english-songs'
// below (an IndexedDB store can only be created inside onupgradeneeded,
// which only fires on a version increase). onupgradeneeded is written to
// only create stores that don't already exist, so each of these upgrades
// is additive for already-installed devices — their existing official-
// songs backup is untouched.
//
// 'user-songs' specifically is used differently from 'songs'/'english-
// songs': those two are a fetch() backup (one blob under the 'all-songs'
// key — see saveSongsToIndexedDb/loadSongsFromIndexedDb below). User Songs
// have no network source to fall back FROM — this store IS their only
// copy — so UserSongStorage (see "User Songs" section further down) reads
// and writes it directly, one song per key (its own id), instead of one
// combined blob. Same store, same reserved slot from v1, different access
// pattern for a different job.
const SONGDB_VERSION = 3;
// One object store per song source (see state.sources/DB_SOURCES above),
// so each source's offline backup lives independently and nothing
// collides. 'user' is reserved, unused, so v2's User Songs source can
// start saving to IndexedDB immediately — no further DB version bump
// needed when that day comes.
const SONGDB_STORES = {
  official: 'songs', // kept as 'songs', not renamed to 'official-songs', so
                      // existing installs' offline backup carries over as-is
  english: 'english-songs',
  user: 'user-songs',
};

function openSongDb() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) { reject(new Error('IndexedDB unavailable')); return; }
    const req = indexedDB.open(SONGDB_NAME, SONGDB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      Object.values(SONGDB_STORES).forEach((storeName) => {
        if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName);
      });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveSongsToIndexedDb(sourceKey, songs) {
  const storeName = SONGDB_STORES[sourceKey];
  if (!storeName) return;
  try {
    const db = await openSongDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put(songs, 'all-songs');
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (err) {
    // Non-fatal — this is a backup layer, not the primary path.
    console.warn(`Songbook: could not save "${sourceKey}" songs to IndexedDB —`, err);
  }
}

async function loadSongsFromIndexedDb(sourceKey) {
  const storeName = SONGDB_STORES[sourceKey];
  if (!storeName) return null;
  const db = await openSongDb();
  const songs = await new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get('all-songs');
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return songs;
}

// Loads one source (any key in DB_SOURCES) — network first, falling back
// to the IndexedDB backup on failure, exactly the same recovery path
// regardless of which source this is. Called once per registered source
// at startup (see loadAllSongData() below) rather than assuming there's
// only ever one.
async function loadSongDataFor(sourceKey) {
  const source = state.sources[sourceKey];
  try {
    const { songs, hadFailures } = await fetchSongData(sourceKey);
    if (hadFailures) {
      // Some (not all) song files failed — most often a slow or spotty
      // connection dropping partway through the batch (e.g. reconnecting
      // mid-download after being offline/throttled). fetchSongData()
      // still "succeeds" in that case since at least some songs came
      // through, but the result may be a shrunken subset of the real
      // library rather than an intentionally smaller one. If a previous
      // successful load already backed up a fuller copy to IndexedDB,
      // prefer that over silently showing an incomplete songbook.
      try {
        const backup = await loadSongsFromIndexedDb(sourceKey);
        if (backup && backup.length > songs.length) {
          console.warn(`Songbook: "${sourceKey}" network load was incomplete (${songs.length} song(s)) — using the fuller IndexedDB backup (${backup.length} song(s)) instead.`);
          source.songs = backup;
          source.loadFailed = false;
          return;
        }
      } catch (dbErr) {
        // No usable backup to compare against — fall through and use
        // the partial network result below; it's still better than
        // nothing for a first-ever load.
      }
    }
    source.songs = songs;
    saveSongsToIndexedDb(sourceKey, source.songs); // fire-and-forget; don't block on this
    source.loadFailed = false;
  } catch (err) {
    console.error(`Songbook: failed to load "${sourceKey}" song data over the network —`, err);
    try {
      const backup = await loadSongsFromIndexedDb(sourceKey);
      if (backup && backup.length) {
        console.warn(`Songbook: network/cache load failed for "${sourceKey}" — recovered songs from IndexedDB backup.`);
        source.songs = backup;
        source.loadFailed = false;
        return;
      }
    } catch (dbErr) {
      console.error(`Songbook: IndexedDB backup also unavailable for "${sourceKey}" —`, dbErr);
    }
    // Most likely cause if there's no backup either: the app was opened
    // directly from disk (file://), where browsers block fetch() of local
    // files. Serving it over http(s) — even just localhost — resolves this.
    // (Dev-facing note only — songLoadError below is the plain, actionless
    // message an actual end user sees; it deliberately doesn't mention any
    // of this, since there's nothing a real user could do about it.)
    source.songs = [];
    source.loadFailed = true;
  }
}

// Loads every registered source (see DB_SOURCES) in parallel at startup.
// Each source's load is independent — the English database being empty,
// broken, or slow never blocks or fails the Mongolian one, or vice versa.
async function loadAllSongData() {
  await Promise.all(Object.keys(DB_SOURCES).map(loadSongDataFor));
}

// ---------------------------------------------------------
// User Songs (v3): locally-authored/imported songs, stored on-device only
// — there's no server, so this store IS the song, not a cache of one.
// Reuses the same songbook-db database and its reserved 'user-songs'
// object store (see the comment above SONGDB_VERSION), but unlike the
// fetch-backup stores, each song is its own key (its `id`) rather than one
// combined 'all-songs' blob — so adding/editing/deleting one song is a
// single small write, not a read-modify-write of the entire list.
//
// state.sources.user.songs is the in-memory mirror renderSongList() etc.
// read from; every mutator below updates both IndexedDB and that array
// together so the UI never needs a separate reload to see its own change.
// ---------------------------------------------------------
const UserSongStorage = {
  async _store(mode) {
    const db = await openSongDb();
    return db.transaction(SONGDB_STORES.user, mode).objectStore(SONGDB_STORES.user);
  },
  async loadAll() {
    const db = await openSongDb();
    const songs = await new Promise((resolve, reject) => {
      const tx = db.transaction(SONGDB_STORES.user, 'readonly');
      const store = tx.objectStore(SONGDB_STORES.user);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return songs;
  },
  async put(song) {
    const db = await openSongDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(SONGDB_STORES.user, 'readwrite');
      tx.objectStore(SONGDB_STORES.user).put(song, song.id);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  },
  async remove(id) {
    const db = await openSongDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(SONGDB_STORES.user, 'readwrite');
      tx.objectStore(SONGDB_STORES.user).delete(id);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  },
};

function genUserSongId() {
  return 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Loaded once at startup (see init()) alongside loadAllSongData()/
// loadPlaylists() — a failure here just leaves User Songs empty (with
// state.sources.user.loadFailed set so renderSongList() shows the same
// "couldn't load" row it already knows how to show for official/English),
// never blocks the rest of the app from starting.
async function loadUserSongs() {
  try {
    state.sources.user.songs = await UserSongStorage.loadAll();
    state.sources.user.loadFailed = false;
  } catch (err) {
    console.error('Songbook: failed to load user songs from IndexedDB —', err);
    state.sources.user.songs = [];
    state.sources.user.loadFailed = true;
  }
}

// Inserts or updates one song (id decides which — an id already present in
// state.sources.user.songs is an update, otherwise it's an insert) in both
// IndexedDB and the in-memory list, keeping them in lockstep.
async function saveUserSong(song) {
  const list = state.sources.user.songs;
  const idx = list.findIndex(s => s.id === song.id);
  if (idx === -1) list.push(song);
  else list[idx] = song;
  await UserSongStorage.put(song);
}

async function deleteUserSong(id) {
  state.sources.user.songs = state.sources.user.songs.filter(s => s.id !== id);
  await UserSongStorage.remove(id);
  // A song can be referenced from playlists/Favorites by {sourceKey:
  // 'user', songId} — same reasoning as official songs (playlists never
  // duplicate song data, only ids), so deleting the song here doesn't
  // touch playlists directly. findSongByRef() simply stops resolving it,
  // and renderPlaylistView()/renderPlaylistsList() already tolerate a ref
  // that no longer resolves to a song (see their own null-checks) — same
  // as if an official song were ever removed from a manifest.
}

// Manual "Refresh song database" button: asks the service worker to try the
// network first (see the X-Force-Refresh handling in service-worker.js),
// falling back to the existing cached copy if that fails — so a refresh
// attempted while offline just silently keeps the offline copy intact
// instead of ever deleting it. The cache is only ever replaced by data
// that's confirmed to have loaded successfully. Unlike the initial load, a
// failure here also leaves the source's songs alone — no point wiping out songs
// that were already showing just because this refresh attempt failed.
// Only refreshes whichever source is currently active in Settings → Song
// database — not every registered source — since that's the one whose
// staleness the person is actually looking at and asking to fix.
async function reloadSongLibrary() {
  const btn = document.getElementById('reload-songs-btn');
  btn.disabled = true;
  btn.textContent = t('reloadBtnBusy');

  const sourceKey = state.activeDbSource;
  try {
    const { songs } = await fetchSongData(sourceKey, { forceRefresh: true });
    const source = state.sources[sourceKey];
    source.songs = songs;
    source.loadFailed = false;
    saveSongsToIndexedDb(sourceKey, source.songs);
    renderSongList();
    showToast(navigator.onLine ? t('toastLibraryReloaded') : t('toastLibraryOffline'));
  } catch (err) {
    console.error('Songbook: manual song database refresh failed —', err);
    showToast(t('toastLibraryReloadFailed'));
  } finally {
    btn.disabled = false;
    btn.textContent = t('reloadBtn');
  }
}

// Manual "Reload app" button: a different, heavier reload than the song
// database refresh above — this clears the offline app-shell cache and the
// service worker entirely, then reloads the page, so it picks up a fresh
// copy of everything (HTML/CSS/JS included), not just the song data. This
// exists as an explicit, deliberate action the person has to tap, since the
// browser's native swipe-down-to-reload gesture is disabled in this app
// (accidental pull-to-refresh mid-scroll was closing songs/losing state).
async function reloadApp() {
  const btn = document.getElementById('reload-app-btn');
  btn.disabled = true;
  btn.textContent = t('reloadAppBtnBusy');

  // Offline: unregistering the service worker and clearing every cache
  // leaves nothing behind to serve the reload with — nothing can be
  // re-downloaded without a connection. That combination used to be
  // exactly what stranded people on a broken/blank reload while offline.
  // Skip the destructive cleanup entirely here and just reload normally —
  // the still-intact service worker and cache keep serving the app as-is,
  // and the offline fallback page (see service-worker.js) covers it even
  // if something's still missing.
  if (!navigator.onLine) {
    showToast(t('toastReloadAppOffline'));
    btn.disabled = false;
    btn.textContent = t('reloadAppBtn');
    window.location.reload();
    return;
  }

  // This function's own reload (below) is the deliberate, complete fix —
  // the fresh load it triggers will register a new service worker, which
  // will then claim this page and fire 'controllerchange' again. Without
  // these, two other independent update-detection paths would each see
  // that fresh load as a separate, unrelated update and reload it AGAIN,
  // right on top of this one: registerServiceWorker()'s controllerchange
  // listener (suppressed for this one cycle via the sessionStorage flag),
  // and hardUpdateBackstop() at the top of this file (suppressed by
  // marking the version as seen before we go). See the comments on those
  // two for the full picture.
  try {
    sessionStorage.setItem('ngw_skip_next_auto_reload', '1');
  } catch (e) {
    // sessionStorage unavailable — worst case is one extra (harmless,
    // if annoying) reload; not worth failing the whole action over.
  }
  markVersionSeen();

  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    if (window.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch (err) {
    console.error('Songbook: app reload cleanup failed —', err);
  } finally {
    window.location.reload();
  }
}

// ---------------------------------------------------------
// In-app back navigation: the hardware/gesture/browser back button should
// move within the app (song → list, settings → list) instead of leaving
// it, and only exit after a second back press at the root within a short
// window — the same "press back again to exit" pattern many apps use.
// ---------------------------------------------------------
let lastBackPressAt = 0;
const EXIT_CONFIRM_WINDOW_MS = 2000;

// Every history entry we push carries a monotonically increasing `seq`
// alongside its page data. popstate alone doesn't say whether the browser
// moved back or forward — only that the state changed — so comparing the
// incoming seq to the last one we saw is what lets showPage() tell a real
// "back to the list" from a "forward into a song" and pick the right slide
// direction (see pendingNavDirection / SLIDE_PAGES in showPage()).
let navSeq = 0;
let currentNavSeq = 0;
function pushNavState(data) {
  navSeq += 1;
  currentNavSeq = navSeq;
  history.pushState({ ...data, seq: navSeq }, '', location.href);
}

// Set by the popstate handler right before it calls showPage/openSong/
// openPlaylist so showPage() knows whether this particular navigation is
// a back or a forward move — see the slide-transition logic in showPage().
// Direct in-app calls (tapping a song, tapping a playlist, a nav tab) never
// touch this, so it stays 'forward' for them, which is exactly right: those
// are always moving deeper into the app, never back out of it.
let pendingNavDirection = 'forward';

function initHistoryNav() {
  // Every pushState below reuses the same URL (only the state object
  // changes — {page: 'songs'} vs {page: 'song-view'}, etc.), since this is
  // a single-page app with no per-page URLs. Left on its default 'auto',
  // the browser tries to restore its own remembered scroll position on
  // top of ours whenever you navigate back/forward — and because all the
  // entries share one URL, it can restore the wrong one (typically 0),
  // silently overwriting the position showPage() just set. Switching to
  // 'manual' hands scroll restoration entirely to our own code below,
  // which is the only thing that actually knows which page is showing.
  if ('scrollRestoration' in history) {
    history.scrollRestoration = 'manual';
  }

  // Establish the app's root state so the very first back press has
  // something of ours to land on instead of leaving immediately.
  history.replaceState({ page: 'songs', seq: 0 }, '', location.href);
  navSeq = 0;
  currentNavSeq = 0;

  window.addEventListener('popstate', (e) => {
    const st = e.state;
    // Figure out which way we just moved before anything below touches
    // currentNavSeq, so showPage() can read pendingNavDirection once it
    // runs (see the direction comment near pendingNavDirection).
    if (st) {
      const newSeq = typeof st.seq === 'number' ? st.seq : 0;
      pendingNavDirection = newSeq < currentNavSeq ? 'back' : 'forward';
      currentNavSeq = newSeq;
    }
    if (st && st.page) {
      if (st.page === 'song-view' && st.songId) {
        const sourceKey = st.sourceKey || 'official';
        const source = state.sources[sourceKey];
        const song = source && source.songs.find(s => s.id === st.songId);
        if (song) { openSong(song, { pushHistory: false, sourceKey }); return; }
      }
      if (st.page === 'playlist-view' && st.playlistId) {
        if (state.playlists.byId[st.playlistId]) {
          openPlaylist(st.playlistId, { pushHistory: false });
          return;
        }
      }
      if (st.page === 'song-editor') {
        // editorSongId may be null (a "New song" form back/forward-ed to)
        // — that's a valid state to land back on as-is, same blank form.
        const song = st.editorSongId ? findSongByRef('user', st.editorSongId) : null;
        openSongEditor(song, { pushHistory: false });
        return;
      }
      showPage(st.page, { pushHistory: false });
      return;
    }

    // No app state left to land on — the next back would leave the app.
    const now = Date.now();
    if (now - lastBackPressAt < EXIT_CONFIRM_WINDOW_MS) {
      // Second press in time: let this one actually exit.
      return;
    }
    lastBackPressAt = now;
    // Re-plant the root state so this press doesn't leave the app, and
    // tell the person to press back again if they really want to exit.
    pushNavState({ page: 'songs' });
    showPage('songs', { pushHistory: false });
    showToast(t('toastPressBackAgain'));
  });
}

// ---------------------------------------------------------
// Splash screen: shown briefly on launch, then fades into the app
// ---------------------------------------------------------
function initSplash() {
  const splash = document.getElementById('splash-screen');
  if (!splash) return;
  const MIN_DISPLAY_MS = 900;
  const FADE_MS = 1100;
  const shownAt = Date.now();
  const hide = () => {
    const wait = Math.max(0, MIN_DISPLAY_MS - (Date.now() - shownAt));
    setTimeout(() => {
      splash.classList.add('is-hidden');
      setTimeout(() => splash.remove(), FADE_MS);
    }, wait);
  };
  if (document.readyState === 'complete') {
    hide();
  } else {
    window.addEventListener('load', hide);
  }
}

// ---------------------------------------------------------
// Preferences (persisted locally — offline-first, no cloud)
// ---------------------------------------------------------
// Builds/rebuilds the language <select>'s option list from whichever
// lang/*.js files actually registered themselves on window.SONGBOOK_LANG
// (see lang/config.js's SONGBOOK_LANG_ORDER for the preferred ordering).
// Pulled out of loadPrefs() so it can also be re-run live when the
// "Traditional Mongolian script" developer toggle flips — see
// applyDevOptions() — without redoing loadPrefs()'s once-only theme/accent
// setup. isInit=true (the loadPrefs() call site) additionally resolves
// state.lang itself; later re-runs just rebuild the visible option list
// and leave the already-chosen language alone.
function refreshLangPicker({ isInit = false } = {}) {
  const savedLang = localStorage.getItem('sb-ui-lang');
  let available = Object.keys(window.SONGBOOK_LANG || {});
  // "mn2" (traditional Mongolian script) is always loaded (see the
  // <script> tags in index.html) so its data is ready the instant the
  // developer toggle turns it on, but it stays out of the picker itself —
  // and gets silently reset back to the default language if it was
  // somehow the active choice — whenever that toggle is off. See
  // applyDevOptions() for where devTradMongolian is set/read.
  if (!state.devTradMongolian) available = available.filter(code => code !== 'mn2');

  const preferredOrder = window.SONGBOOK_LANG_ORDER || [];
  const orderedLangs = [
    ...preferredOrder.filter(code => available.includes(code)),
    ...available.filter(code => !preferredOrder.includes(code)).sort(),
  ];

  if (isInit) {
    state.lang = (savedLang && available.includes(savedLang)) ? savedLang
      : (available.includes(window.SONGBOOK_DEFAULT_LANG) ? window.SONGBOOK_DEFAULT_LANG : orderedLangs[0]);
  } else if (!available.includes(state.lang)) {
    // The toggle just turned off while mn2 was the active language —
    // fall back the same way isInit does, then re-render everything in
    // the new language so nothing is left showing mn2 text with mn2
    // missing from the picker.
    state.lang = available.includes(window.SONGBOOK_DEFAULT_LANG) ? window.SONGBOOK_DEFAULT_LANG : orderedLangs[0];
    localStorage.setItem('sb-ui-lang', state.lang);
  }
  document.documentElement.setAttribute('lang', state.lang);

  const langSelect = document.getElementById('ui-lang-select');
  if (langSelect) {
    langSelect.innerHTML = orderedLangs
      .map(code => `<option value="${code}">${(window.SONGBOOK_LANG[code].meta && window.SONGBOOK_LANG[code].meta.name) || code}</option>`)
      .join('');
    langSelect.value = state.lang;
  }
}

function loadPrefs() {
  // Default to the system's light/dark preference on first run (no saved
  // choice yet) rather than hardcoding 'light'. This matters beyond just
  // matching the phone's look: browsers that algorithmically "force dark"
  // pages which don't visibly follow prefers-color-scheme (Chrome's Auto
  // Dark Theme on Android, Samsung Internet's forced dark) back off once a
  // page's own colors actually track the system setting — so following it
  // ourselves, well, is also the fix for those forced/inverted-color
  // renders. Once the person picks a theme in Settings, that explicit
  // choice always wins over the system setting from then on.
  const savedTheme = localStorage.getItem('sb-theme');
  const systemPrefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = savedTheme || (systemPrefersDark ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme', theme);
  document.getElementById('theme-toggle').setAttribute('aria-checked', String(theme === 'dark'));

  // If the person has never explicitly chosen a theme, keep following the
  // system setting live (e.g. Android's scheduled dark mode kicking in at
  // sunset) instead of freezing whatever it was on first load.
  if (!savedTheme && window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onSystemThemeChange = (e) => {
      if (localStorage.getItem('sb-theme')) return; // person has since made an explicit choice
      const next = e.matches ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', next);
      const toggle = document.getElementById('theme-toggle');
      if (toggle) toggle.setAttribute('aria-checked', String(next === 'dark'));
    };
    if (mq.addEventListener) mq.addEventListener('change', onSystemThemeChange);
    else if (mq.addListener) mq.addListener(onSystemThemeChange); // older WebView/Samsung Internet
  }

  const accent = localStorage.getItem('sb-accent') || 'aqua';
  document.documentElement.setAttribute('data-accent', accent);
  document.querySelectorAll('.accent-swatch').forEach(btn => {
    btn.setAttribute('aria-pressed', String(btn.dataset.accent === accent));
  });

  refreshLangPicker({ isInit: true });

  const lyricsSize = parseFloat(localStorage.getItem('sb-lyrics-size'));
  const chordSize = parseFloat(localStorage.getItem('sb-chord-size'));
  if (!Number.isNaN(lyricsSize)) state.lyricsSize = lyricsSize;
  if (!Number.isNaN(chordSize)) state.chordSize = chordSize;
  applyFontSizes();

  const savedChordStyle = localStorage.getItem('sb-chord-style');
  if (savedChordStyle === 'chip' || savedChordStyle === 'text') state.chordStyle = savedChordStyle;
  applyChordStyle();

  state.hideChords = localStorage.getItem('sb-hide-chords') === 'true';
  applyHideChords();

  const savedLyricsWeight = localStorage.getItem('sb-lyrics-weight');
  if (savedLyricsWeight === 'normal' || savedLyricsWeight === 'semibold' || savedLyricsWeight === 'bold') {
    state.lyricsWeight = savedLyricsWeight;
  }
  applyLyricsWeight();

  const savedLyricsSpacing = localStorage.getItem('sb-lyrics-spacing');
  if (savedLyricsSpacing === 'tight' || savedLyricsSpacing === 'normal' || savedLyricsSpacing === 'loose') {
    state.lyricsSpacing = savedLyricsSpacing;
  }
  applyLyricsSpacing();

  // Restore which song database was active (see applyDbSource()). Reuses
  // the 'sb-db' key/values ('mn'/'en') the dbSelect dropdown itself
  // stores in bindSettings(), so a value saved by an older app version
  // that only ever wrote 'mn' still resolves correctly to 'official'.
  const savedDb = localStorage.getItem('sb-db');
  applyDbSource(savedDb === 'en' ? 'english' : 'official');
}

function applyFontSizes() {
  document.documentElement.style.setProperty('--lyrics-size', state.lyricsSize + 'rem');
  document.documentElement.style.setProperty('--chord-size', state.chordSize + 'rem');
}

// Chip (default, unchanged for existing users until they opt in) vs. text
// chord display — see the .chord-tag / html[data-chord-style="text"] rules
// in style.css for what actually changes visually. This just toggles the
// attribute CSS reads, updates the two segmented-control buttons' pressed
// state, and persists the choice the same way the font-size prefs do.
function applyChordStyle() {
  document.documentElement.setAttribute('data-chord-style', state.chordStyle);
  document.querySelectorAll('#chord-style-toggle [data-chord-style]').forEach(btn => {
    btn.setAttribute('aria-pressed', String(btn.dataset.chordStyle === state.chordStyle));
  });
  positionSegToggleThumb(document.getElementById('chord-style-toggle'));
}

// Slides/resizes a .seg-toggle-thumb (see the CSS) to sit exactly behind
// whichever button in `container` is currently aria-pressed="true" — sized
// to that button's own offsetWidth, so this works the same whether the
// options are equal-width (Chips/Text) or not (Normal/Semibold/Bold).
// Measured as the distance from the *first* button's left edge rather than
// the container's, so it comes out right regardless of exactly how a
// browser accounts for the container's own border/padding in offsetLeft —
// both buttons are measured the identical way, so that constant cancels
// out of the difference.
//
// opts.instant skips the CSS transition for this one update (container
// becoming visible, a language change re-flowing button widths, a window
// resize) so the thumb snaps straight to the right spot instead of
// visibly growing/sliding in from wherever it last was — reserved for
// updates the person didn't just tap themselves in this toggle.
// offsetParent is null while `container` sits on a hidden page (e.g. at
// startup, before Settings has ever been opened) — skip until it's
// actually on screen, since every measurement below would just come back
// zero; see the Settings page's onEnter and updateAllSegToggleThumbs()
// for where it gets corrected once that's no longer true.
function positionSegToggleThumb(container, opts = {}) {
  if (!container) return;
  const thumb = container.querySelector('.seg-toggle-thumb');
  const pressed = container.querySelector('.seg-toggle-btn[aria-pressed="true"]');
  const first = container.querySelector('.seg-toggle-btn');
  if (!thumb || !pressed || !first || container.offsetParent === null) return;

  const { instant = false } = opts;
  if (instant) thumb.style.transitionDuration = '0s';
  thumb.style.width = pressed.offsetWidth + 'px';
  thumb.style.transform = `translateX(${pressed.offsetLeft - first.offsetLeft}px)`;
  if (instant) {
    void thumb.offsetWidth; // apply the instant move before restoring the animated duration
    thumb.style.transitionDuration = '';
  }
}

function updateAllSegToggleThumbs(opts = {}) {
  document.querySelectorAll('.seg-toggle').forEach(el => positionSegToggleThumb(el, opts));
}

// A resize (rotation, desktop window resize, font-group rows wrapping
// differently) can change a seg-toggle-btn's own width without any
// aria-pressed change ever firing — nothing else above would notice, so
// this re-measures all of them directly. Debounced since 'resize' fires
// continuously while dragging; instant:true because a viewport resize
// isn't the person tapping a pill, so it shouldn't visibly slide.
let segToggleResizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(segToggleResizeTimer);
  segToggleResizeTimer = setTimeout(() => updateAllSegToggleThumbs({ instant: true }), 120);
});

// The very first positionSegToggleThumb() call (Settings opened before the
// person has tapped anything) can land before the real 'Inter' webfont has
// swapped in — offsetWidth at that moment reflects the fallback font's
// metrics, not Inter's, so the thumb can end up a few px off from the
// button it's meant to sit under. The container/button boxes themselves
// aren't affected (their width is plain CSS, so the browser keeps them in
// sync with whichever font is actually painted) — only this JS-measured,
// JS-set thumb width can go stale. document.fonts.ready resolves once
// every requested face has finished loading, so re-measuring then closes
// that gap; instant:true for the same reason as the resize handler above —
// this isn't the person tapping a pill, so it shouldn't visibly slide.
if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(() => updateAllSegToggleThumbs({ instant: true })).catch(() => {});
}

// Hide chords entirely (opt-in, sits right below the Chips/Text toggle):
// lyrics-only view for people who already know the song, or a leader who
// wants the words on screen without chord clutter. Doesn't touch song
// data or the Chips/Text choice underneath — see the
// html[data-hide-chords="true"] rule in style.css for what's actually
// hidden, same attribute-driven pattern as applyChordStyle() above.
function applyHideChords() {
  document.documentElement.setAttribute('data-hide-chords', String(state.hideChords));
  const toggle = document.getElementById('hide-chords-toggle');
  if (toggle) toggle.setAttribute('aria-checked', String(state.hideChords));
}

// Lyrics style (Settings → Appearance): font weight for lyric text only —
// see the html[data-lyrics-weight] rules by .lyric-word in style.css.
// Same attribute-driven segmented-control pattern as applyChordStyle().
function applyLyricsWeight() {
  document.documentElement.setAttribute('data-lyrics-weight', state.lyricsWeight);
  document.querySelectorAll('#lyrics-weight-toggle [data-lyrics-weight]').forEach(btn => {
    btn.setAttribute('aria-pressed', String(btn.dataset.lyricsWeight === state.lyricsWeight));
  });
  positionSegToggleThumb(document.getElementById('lyrics-weight-toggle'));
}

// Line spacing (Settings → Appearance): vertical rhythm between lyric
// lines only — general app UI spacing is untouched. See the
// html[data-lyrics-spacing] --lyric-line-* overrides by .lyric-line in
// style.css. Same attribute-driven segmented-control pattern as above.
function applyLyricsSpacing() {
  document.documentElement.setAttribute('data-lyrics-spacing', state.lyricsSpacing);
  document.querySelectorAll('#lyrics-spacing-toggle [data-lyrics-spacing]').forEach(btn => {
    btn.setAttribute('aria-pressed', String(btn.dataset.lyricsSpacing === state.lyricsSpacing));
  });
  positionSegToggleThumb(document.getElementById('lyrics-spacing-toggle'));
}

// Switches which song database (see DB_SOURCES) the Songs page, search,
// and playlist song-picker all browse — called from Settings → Song
// database's dbSelect (see bindSettings()) and on startup to restore the
// saved choice.
//
// Resets the search query on switch (a query typed against one source's
// titles/lyrics is unlikely to mean anything in the other, and leaving it
// behind would just show a confusing "no results"). If the new source has
// no song numbers (see DB_SOURCES' hasNumbers — the English database),
// this also hides the "Sort by number" button and snaps sortBy to 'alpha'
// so the Songs page never gets stuck showing a sort control for a field
// that doesn't exist; switching to a numbered source later restores it.
function applyDbSource(sourceKey) {
  state.activeDbSource = sourceKey;
  state.query = '';
  const searchInput = document.getElementById('search-input');
  if (searchInput) searchInput.value = '';

  const hasNumbers = (DB_SOURCES[sourceKey] || {}).hasNumbers !== false;
  const numBtn = document.querySelector('.sort-btn[data-sort-by="num"]');
  const alphaBtn = document.querySelector('.sort-btn[data-sort-by="alpha"]');
  if (numBtn) numBtn.hidden = !hasNumbers;
  if (!hasNumbers && state.sortBy === 'num') {
    state.sortBy = 'alpha';
    if (numBtn) numBtn.setAttribute('aria-pressed', 'false');
    if (alphaBtn) alphaBtn.setAttribute('aria-pressed', 'true');
  }

  renderSongList();
}

// ---------------------------------------------------------
// Developer options — its own dedicated page (#page-dev-options), same
// shape as the About page, for a few things that don't belong in front of
// every visitor: moving playlists between browsers (export/import), and
// toggles for content that's still being finished (traditional Mongolian
// script, the About page credits list) or that's just for fun (forcing
// each easter egg on individually to preview it without waiting for the
// right date or finding its own trigger).
//
// Unlocked per-session only (not persisted — see state.devUnlocked) by
// tapping the About page's app icon 3 times in a row, the same
// 3-tap-within-800ms pattern as the existing accent-color disco easter
// egg. Unlocking reveals a nav row in Settings' About section (below
// Contact us — see #dev-options-nav-row in index.html) that opens this
// page, the same way #about-nav-row opens the About page itself — see
// bindDevOptionsUnlock() for the tap trigger and
// initDevOptions()/applyDevOptions() for the page's own toggles and their
// effects.
// ---------------------------------------------------------

function unlockDevOptions() {
  if (state.devUnlocked) return;
  state.devUnlocked = true;
  const navRow = document.getElementById('dev-options-nav-row');
  if (navRow) navRow.hidden = false;
  showToast(t('toastDevUnlocked'));
}

function bindDevOptionsUnlock() {
  const icon = document.querySelector('.about-logo');
  if (!icon) return;
  let tapTimes = [];
  icon.addEventListener('click', () => {
    if (state.devUnlocked) return; // already unlocked, nothing left to trigger
    const now = Date.now();
    tapTimes = tapTimes.filter(ts => now - ts < 800).concat(now);
    if (tapTimes.length >= 3) {
      tapTimes = [];
      unlockDevOptions();
    }
  });
}

// Applies the current value of each developer toggle to the parts of the
// app they affect, and syncs the switches' own visual state. Called once
// on init (values are never persisted — every toggle starts OFF each
// fresh load, same as state.devUnlocked) and again after each toggle's
// own click handler flips its state field.
function applyDevOptions() {
  // Turning one of these three off doesn't disable that easter egg — it
  // just stops forcing it on; isSabbathToday()/isChristmasWeek() fall
  // back to their own date checks on their own next read, and party mode
  // falls back to its own 3-tap trigger (see discoForcedByDevToggle's
  // comment near startDiscoMode()). Only refresh the two that poll on an
  // interval rather than waiting for their own next check, so flipping
  // either switch shows an immediate result either way.
  const sabbathToggle = document.getElementById('dev-sabbath-toggle');
  if (sabbathToggle) sabbathToggle.setAttribute('aria-checked', String(state.devSabbathForced));
  const sabbathEl = document.getElementById('sabbath-mascot');
  if (sabbathEl) {
    const show = isSabbathToday();
    sabbathEl.hidden = !show;
    if (show) updateSabbathMascotText();
  }

  const christmasToggle = document.getElementById('dev-christmas-toggle');
  if (christmasToggle) christmasToggle.setAttribute('aria-checked', String(state.devChristmasForced));
  if (window.__ngwRefreshChristmasSnow) window.__ngwRefreshChristmasSnow();

  // Party mode (disco) has no polling loop to refresh — it's a
  // start/stop action, not a continuously-rechecked condition. Only act
  // on an actual state change here, and only take ownership of sessions
  // this same switch started (see discoForcedByDevToggle's comment).
  const partyToggle = document.getElementById('dev-party-toggle');
  if (partyToggle) partyToggle.setAttribute('aria-checked', String(state.devPartyForced));
  if (state.devPartyForced && !discoModeActive) {
    discoForcedByDevToggle = true;
    startDiscoMode();
  } else if (!state.devPartyForced && discoModeActive && discoForcedByDevToggle) {
    discoForcedByDevToggle = false;
    stopDiscoMode();
  }

  const mongolianToggle = document.getElementById('dev-trad-mongolian-toggle');
  if (mongolianToggle) mongolianToggle.setAttribute('aria-checked', String(state.devTradMongolian));
  refreshLangPicker();
  applyLanguage();

  const creditsToggle = document.getElementById('dev-credits-toggle');
  if (creditsToggle) creditsToggle.setAttribute('aria-checked', String(state.devCredits));
  renderCredits();

  // Hides the description line under a specific, curated set of settings
  // rows (see the .settings-desc-hideable class in index.html — NOT every
  // .settings-row-sub in the app) — a density option for people who
  // already know what each row does and just want the list more compact.
  const hideDescToggle = document.getElementById('dev-hide-desc-toggle');
  if (hideDescToggle) hideDescToggle.setAttribute('aria-checked', String(state.devHideDescriptions));
  document.documentElement.toggleAttribute('data-hide-setting-desc', state.devHideDescriptions);
}

function initDevOptions() {
  bindDevOptionsUnlock();

  document.getElementById('dev-options-nav-row').addEventListener('click', () => {
    showPage('dev-options', { pushHistory: true, resetScroll: true });
  });
  document.getElementById('dev-options-back-btn').addEventListener('click', () => history.back());

  document.getElementById('dev-sabbath-toggle').addEventListener('click', () => {
    state.devSabbathForced = !state.devSabbathForced;
    applyDevOptions();
  });
  document.getElementById('dev-christmas-toggle').addEventListener('click', () => {
    state.devChristmasForced = !state.devChristmasForced;
    applyDevOptions();
  });
  document.getElementById('dev-party-toggle').addEventListener('click', () => {
    state.devPartyForced = !state.devPartyForced;
    applyDevOptions();
  });
  document.getElementById('dev-trad-mongolian-toggle').addEventListener('click', () => {
    state.devTradMongolian = !state.devTradMongolian;
    applyDevOptions();
  });
  document.getElementById('dev-credits-toggle').addEventListener('click', () => {
    state.devCredits = !state.devCredits;
    applyDevOptions();
  });
  document.getElementById('dev-hide-desc-toggle').addEventListener('click', () => {
    state.devHideDescriptions = !state.devHideDescriptions;
    applyDevOptions();
  });
}

// ---------------------------------------------------------
// Language: apply the active language to every labeled element
// ---------------------------------------------------------
function applyLanguage() {
  document.documentElement.setAttribute('lang', state.lang);

  const map = {
    't-appTitle': 'appTitle',
    't-topbarAppName': 'appTitle',
    // The playlist-view page's topbar sits above a specific playlist, not
    // the songbook library, so it should read "Playlist(s)" not "Songbook"
    // — and it uses the same fuller title as the playlists list page's
    // heading (playlistsTitle), not the short bottom-nav label.
    't-topbarAppName2': 'playlistsTitle',
    // The About page's topbar sits above the settings context it was
    // opened from (same reasoning as playlist-view above), so it uses
    // settingsTitle ("Settings") rather than repeating "About" — the
    // page's own header already says "About" via t-sectionAbout2.
    't-topbarAppName3': 'settingsTitle',
    // The Developer options page's topbar follows the same pattern as the
    // About page's (t-topbarAppName3 above) — it sits above the settings
    // context it was opened from, so it reuses settingsTitle rather than
    // repeating "Developer options" (already said via t-sectionDevOptions2).
    't-topbarAppName4': 'settingsTitle',
    // The Song Editor's topbar sits above the User Songs context it was
    // opened from (same pattern as the two above), so it uses
    // userSongsTitle rather than repeating "New song"/"Edit song" — the
    // page's own header already says that via editor-page-title.
    't-topbarAppName5': 'userSongsTitle',
    't-navSongs': 'navSongs',
    't-navSettings': 'navSettings',
    't-navPlaylists': 'navPlaylists',
    't-navUserSongs': 'navUserSongs',
    't-userSongsTitle': 'userSongsTitle',
    't-playlistsTitle': 'playlistsTitle',
    't-playlistsBackupTitle': 'playlistsBackupTitle',
    't-playlistsBackupSub': 'playlistsBackupSub',
    't-editorTitleLabel': 'editorTitleLabel',
    't-editorArtistLabel': 'editorArtistLabel',
    't-editorKeyLabel': 'editorKeyLabel',
    't-editorAudioLabel': 'editorAudioLabel',
    't-editorLyricsLabel': 'editorLyricsLabel',
    't-editorLyricsHint': 'editorLyricsHint',
    't-editorPreviewLabel': 'editorPreviewLabel',
    't-keyLabel': 'keyLabel',
    't-lyricsGroup': 'lyricsGroup',
    't-chordsGroup': 'chordsGroup',
    't-chordStyleGroup': 'chordStyleGroup',
    't-chordStyleSub': 'chordStyleSub',
    't-chordStyleChip': 'chordStyleChip',
    't-chordStyleText': 'chordStyleText',
    't-hideChordsTitle': 'hideChordsTitle',
    't-hideChordsSub': 'hideChordsSub',
    't-lyricsWeightTitle': 'lyricsWeightTitle',
    't-lyricsWeightSub': 'lyricsWeightSub',
    't-lyricsWeightNormal': 'lyricsWeightNormal',
    't-lyricsWeightSemibold': 'lyricsWeightSemibold',
    't-lyricsWeightBold': 'lyricsWeightBold',
    't-lyricsSpacingTitle': 'lyricsSpacingTitle',
    't-lyricsSpacingSub': 'lyricsSpacingSub',
    't-lyricsSpacingTight': 'lyricsSpacingTight',
    't-lyricsSpacingNormal': 'lyricsSpacingNormal',
    't-lyricsSpacingLoose': 'lyricsSpacingLoose',
    't-settingsTitle': 'settingsTitle',
    't-sectionAppearance': 'sectionAppearance',
    't-darkModeTitle': 'darkModeTitle',
    't-darkModeSub': 'darkModeSub',
    't-accentTitle': 'accentTitle',
    't-accentSub': 'accentSub',
    't-sectionLangDb': 'sectionLangDb',
    't-uiLangTitle': 'uiLangTitle',
    't-uiLangSub': 'uiLangSub',
    't-dbTitle': 'dbTitle',
    't-dbSub': 'dbSub',
    't-sectionApp': 'sectionApp',
    't-reloadTitle': 'reloadTitle',
    't-reloadSub': 'reloadSub',
    't-sectionAbout': 'sectionAbout',
    't-sectionAbout2': 'sectionAbout',
    't-versionTitle': 'versionTitle',
    't-creditsHeading': 'creditsHeading',
    'about-nav-sub': 'aboutNavSub',
    't-sectionDevOptions': 'sectionDevOptions',
    't-sectionDevOptions2': 'sectionDevOptions',
    't-sectionDevEasterEggs': 'sectionDevEasterEggs',
    't-devSabbathTitle': 'devSabbathTitle',
    't-devSabbathSub': 'devSabbathSub',
    't-devChristmasTitle': 'devChristmasTitle',
    't-devChristmasSub': 'devChristmasSub',
    't-devPartyTitle': 'devPartyTitle',
    't-devPartySub': 'devPartySub',
    't-sectionDevInProgress': 'sectionDevInProgress',
    't-devTradMongolianTitle': 'devTradMongolianTitle',
    't-devTradMongolianSub': 'devTradMongolianSub',
    't-devCreditsTitle': 'devCreditsTitle',
    't-devCreditsSub': 'devCreditsSub',
    't-devHideDescTitle': 'devHideDescTitle',
    't-devHideDescSub': 'devHideDescSub',
  };
  Object.entries(map).forEach(([id, key]) => {
    const el = document.getElementById(id);
    if (el) el.textContent = t(key);
  });

  document.getElementById('search-input').placeholder = t('searchPlaceholder');
  document.getElementById('user-song-search-input').placeholder = t('searchPlaceholder');
  document.getElementById('editor-key').placeholder = t('editorKeyPlaceholder');
  document.getElementById('editor-audio').placeholder = t('editorAudioPlaceholder');
  document.getElementById('back-btn').setAttribute('aria-label', t('backAria'));
  document.getElementById('transpose-reset').textContent = t('transposeReset');
  document.getElementById('editor-save-btn').textContent = t('saveBtn');

  document.querySelector('.sort-btn[data-sort-by="alpha"]').textContent = t('sortByAlpha');
  document.querySelector('.sort-btn[data-sort-by="num"]').textContent = t('sortByNumber');
  document.querySelector('.sort-btn[data-sort-order="asc"]').textContent = t('sortAsc');
  document.querySelector('.sort-btn[data-sort-order="desc"]').textContent = t('sortDesc');

  document.getElementById('db-option-en').textContent = t('dbOptionEnglish');

  document.getElementById('empty-state').textContent = t('emptyState');
  document.getElementById('about-version-line').textContent = t('versionSub', APP_VERSION);
  document.getElementById('about-nav-title').textContent = t('appName');
  document.getElementById('scripture-verse-text').textContent = `«${t('scriptureVerse')}»`;
  document.getElementById('scripture-verse-ref').textContent = t('scriptureRef');

  const appConfig = window.SONGBOOK_APP_CONFIG || {};
  const orgName = appConfig.orgName || '';
  document.getElementById('about-copyright').textContent =
    `© ${new Date().getFullYear()} ${orgName}. All rights reserved.`;
  document.getElementById('about-copyright-terms').textContent = t('copyrightTerms');

  document.getElementById('t-contactBtn').textContent = t('contactBtn');
  document.getElementById('about-contact-copy').setAttribute('aria-label', t('copyEmailAria'));
  if (appConfig.contactEmail) {
    document.getElementById('about-contact-email').textContent = appConfig.contactEmail;
  }
  resetContactUI();

  const reloadBtn = document.getElementById('reload-songs-btn');
  if (!reloadBtn.disabled) reloadBtn.textContent = t('reloadBtn');
  const reloadAppBtn = document.getElementById('reload-app-btn');
  if (!reloadAppBtn.disabled) reloadAppBtn.textContent = t('reloadAppBtn');
  document.getElementById('export-playlists-btn').textContent = t('exportBtn');
  document.getElementById('import-playlists-btn').textContent = t('importBtn');

  renderSocialLinks();
  renderCredits();

  refreshInstallLabels();
  renderSongList();
  if (state.currentPage === 'user-songs') renderUserSongList();
  if (state.activeSong) updateTransposeUI();
  if (state.currentPage === 'playlists') renderPlaylistsList();
  updateSabbathMascotText(); // re-translate the mascot's bubble if it's showing
  if (state.currentPage === 'playlist-view') renderPlaylistView();
  if (state.activeSong) { updateFavoriteButtonUI(); updateSongViewMenuUI(); }
  // Translated labels (Normal/Semibold/Bold etc.) can be wider or narrower
  // in the new language — instant, since this isn't the person tapping a
  // pill themselves. No-ops harmlessly if Settings isn't the page on
  // screen right now (see positionSegToggleThumb's offsetParent guard).
  updateAllSegToggleThumbs({ instant: true });
}

// ---------------------------------------------------------
// Navigation — data-driven off PAGES above, so it doesn't need to change
// when a page is added; only PAGES (+ its markup) does.
// ---------------------------------------------------------
function bindNav() {
  document.querySelectorAll('.nav-btn[data-nav]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      const target = btn.dataset.nav;
      // Tapping a tab you're ALREADY on is a deliberate "jump to top of
      // the list" action — standard tab-bar behavior. Tapping it to come
      // back from a different page (settings, a song) is a normal "go
      // back" and should instead restore wherever that list was
      // scrolled to, same as the in-song back button.
      const alreadyThere = state.currentPage === target;
      showPage(target, { pushHistory: true, resetScroll: alreadyThere });
    });
  });
}

function showPage(name, opts = {}) {
  const { pushHistory = false, replaceHistory = false, resetScroll = false } = opts;
  const page = PAGES[name];
  if (!page) {
    console.error(`Songbook: showPage() called with unknown page "${name}"`);
    return;
  }

  // Re-navigating to the page already on screen (e.g. tapping the "Songs"
  // tab while already viewing the song list) normally shouldn't move the
  // scroll at all — just leave it exactly where it is. resetScroll is the
  // explicit override for that (see bindNav's already-there case): it
  // always wins and jumps to the top, even on the same page.
  const isSamePage = state.currentPage === name;

  // Leaving the song page for good (not just re-opening it) — stop any
  // audio that's playing there. Otherwise the browser/OS keeps the media
  // session (and its floating widget) alive for an <audio> element that's
  // no longer visible or reachable from the UI.
  if (!isSamePage && state.currentPage === 'song-view') {
    document.querySelectorAll('#sv-audio audio').forEach(a => a.pause());
  }

  // Otherwise, before switching away, remember where we were scrolled on
  // the page's own scroll container (see the CSS/.page notes for why it's
  // an element's scrollTop now, not window.scrollY) so coming back to it
  // later restores that exact spot.
  const prevName = state.currentPage;
  if (!isSamePage && (prevName in scrollMemory)) {
    const prevPage = PAGES[prevName];
    const prevEl = prevPage && document.getElementById(prevPage.elId);
    if (prevEl) scrollMemory[prevName] = prevEl.scrollTop;
  }

  const targetEl = document.getElementById(page.elId);

  // Slide transition for song-view/playlist-view: pushed forward (opened)
  // slides in from the right over whatever's underneath; popped (backed
  // out of) slides back out to the right, revealing what was underneath —
  // which was never hidden or moved, so nothing has to re-render for it.
  // See pendingNavDirection/SLIDE_PAGES for how the direction is decided.
  let transitionType = null;
  if (!isSamePage && !prefersReducedMotion()) {
    const prevEl = PAGES[prevName] && document.getElementById(PAGES[prevName].elId);
    if (pendingNavDirection === 'back' && SLIDE_PAGES.has(prevName) && prevEl) {
      transitionType = 'pop';
    } else if (pendingNavDirection !== 'back' && SLIDE_PAGES.has(name) && prevEl) {
      transitionType = 'push';
    } else if (TAB_PAGES.has(name) && TAB_PAGES.has(prevName) && prevEl) {
      transitionType = 'tabfade';
    }
  }
  pendingNavDirection = 'forward';

  if (transitionType === 'push' || transitionType === 'pop') {
    const prevEl = document.getElementById(PAGES[prevName].elId);
    runPageSlideTransition(transitionType, prevEl, targetEl, {
      onDone: name === 'song-view' ? fixNativeAudioControlsPaint : null,
    });
  } else if (transitionType === 'tabfade') {
    const prevEl = document.getElementById(PAGES[prevName].elId);
    runTabFadeTransition(prevEl, targetEl);
  } else {
    Object.values(PAGES).forEach(p => { document.getElementById(p.elId).hidden = true; });
    targetEl.hidden = false;
    // No slide animation ran (reduced-motion, or a non-slide page), but the
    // <audio controls> element in openSong() was still built while its page
    // was `hidden`. Chromium's native audio controls (play button, scrubber)
    // are a shadow-DOM widget that doesn't always get laid out properly for
    // elements constructed off-screen/hidden — they can render as blank or
    // half-drawn until something forces a reflow. A tap "fixes" it because
    // that's exactly the kind of forced reflow. Do that proactively instead
    // of waiting on the user to discover the trick.
    if (name === 'song-view') fixNativeAudioControlsPaint();
  }

  document.querySelectorAll('.nav-btn[data-nav]').forEach(b => b.classList.remove('is-active'));
  if (page.navKey) {
    const navBtn = document.querySelector(`.nav-btn[data-nav="${page.navKey}"]`);
    if (navBtn) navBtn.classList.add('is-active');
  }
  if (page.onEnter) page.onEnter();

  // A page can opt to hide the bottom tab bar so nothing competes with its
  // content (song-view does this — it has its own slim top bar instead).
  document.getElementById('bottom-nav').hidden = !!page.hideNav;
  document.body.classList.toggle('nav-hidden', !!page.hideNav);

  if (resetScroll) {
    // Explicit override: always end up at the top, same page or not.
    if (isSamePage) {
      // Already on this page (tapping the tab you're on) — animate back to
      // the top instead of an instant cut, so the jump reads as motion.
      targetEl.scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      // Landing on the page fresh (e.g. opening a song): nothing to
      // animate from, just start at the top.
      targetEl.scrollTop = 0;
    }
  } else if (!isSamePage) {
    if (name in scrollMemory) {
      // Returning to a page we've been on before: put the scroll back where it was.
      targetEl.scrollTop = scrollMemory[name];
    } else {
      // Fresh page (e.g. opening a song): start at the top.
      targetEl.scrollTop = 0;
    }
  }

  state.currentPage = name;

  if (pushHistory) {
    pushNavState({ page: name });
  } else if (replaceHistory) {
    history.replaceState({ page: name, seq: currentNavSeq }, '', location.href);
  }
}

// Whether the person has asked the OS/browser to minimize motion — the
// slide transition below is skipped entirely for them (falls back to the
// original instant cut) rather than trying to offer a "reduced" version.
function prefersReducedMotion() {
  return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

// Runs the push/pop slide for the two SLIDE_PAGES. Both pages involved are
// simple CSS transforms on their own compositor layer (no layout/paint
// work on the surrounding page), so this is cheap to animate even on
// low-end devices — it's the same technique native app frameworks use for
// this exact transition.
function runPageSlideTransition(type, fromEl, toEl, opts = {}) {
  const { onDone = null } = opts;
  // Anything other than the two pages actually involved stays hidden as
  // before — only these two are ever visible at once, and only briefly.
  Object.values(PAGES).forEach(p => {
    const el = document.getElementById(p.elId);
    if (el !== fromEl && el !== toEl) el.hidden = true;
  });
  fromEl.hidden = false;
  toEl.hidden = false;

  const topEl = type === 'push' ? toEl : fromEl;
  const bottomEl = type === 'push' ? fromEl : toEl;
  topEl.style.zIndex = '2';
  bottomEl.style.zIndex = '1';

  topEl.classList.remove('page-slide-in', 'page-slide-out');
  // Force a reflow so re-adding the same animation class (e.g. opening a
  // second song while one is already mid-transition) restarts it instead
  // of the browser treating it as a no-op.
  void topEl.offsetWidth;
  topEl.classList.add(type === 'push' ? 'page-slide-in' : 'page-slide-out');

  // If a previous transition on this same element got interrupted before
  // finishing (rapid back-to-back navigation), its 'animationend' listener
  // never fired and is still attached — drop it before attaching this
  // one so listeners can't pile up over a long session.
  if (topEl._slideCleanup) {
    topEl.removeEventListener('animationend', topEl._slideCleanup);
  }
  const cleanup = () => {
    topEl.classList.remove('page-slide-in', 'page-slide-out');
    topEl.style.zIndex = '';
    bottomEl.style.zIndex = '';
    // fromEl is always the page we're leaving — whether it was the one
    // visually sliding away (pop) or just sitting static underneath while
    // the new page slid over it (push) — so it's always the one to hide
    // once the transition's done; toEl (== the page showPage() is
    // switching to) always stays visible, same as the instant-cut path.
    fromEl.hidden = true;
    topEl.removeEventListener('animationend', cleanup);
    topEl._slideCleanup = null;
    if (onDone) onDone();
  };
  topEl._slideCleanup = cleanup;
  topEl.addEventListener('animationend', cleanup);
}

// Crossfade for TAB_PAGES switches (tapping a different bottom-nav
// button). The incoming page fades/rises in on top of the outgoing one —
// see the .tab-fade-in CSS comment for why the outgoing page doesn't need
// its own fade-out animation.
function runTabFadeTransition(fromEl, toEl) {
  Object.values(PAGES).forEach(p => {
    const el = document.getElementById(p.elId);
    if (el !== fromEl && el !== toEl) el.hidden = true;
  });
  fromEl.hidden = false;
  toEl.hidden = false;
  toEl.style.zIndex = '2';
  fromEl.style.zIndex = '1';

  toEl.classList.remove('tab-fade-in');
  void toEl.offsetWidth; // restart the animation if one is already mid-flight
  toEl.classList.add('tab-fade-in');

  if (toEl._tabFadeCleanup) {
    toEl.removeEventListener('animationend', toEl._tabFadeCleanup);
  }
  const cleanup = () => {
    toEl.classList.remove('tab-fade-in');
    toEl.style.zIndex = '';
    fromEl.style.zIndex = '';
    fromEl.hidden = true;
    toEl.removeEventListener('animationend', cleanup);
    toEl._tabFadeCleanup = null;
  };
  toEl._tabFadeCleanup = cleanup;
  toEl.addEventListener('animationend', cleanup);
}

// ---------------------------------------------------------
// Songs page: search + sort + list rendering
// ---------------------------------------------------------
function bindSongsPage() {
  const input = document.getElementById('search-input');
  input.addEventListener('input', () => {
    state.query = input.value.trim().toLowerCase();
    renderSongList({ animate: true });
  });

  document.querySelectorAll('.sort-btn[data-sort-by]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.sortBy = btn.dataset.sortBy;
      document.querySelectorAll('.sort-btn[data-sort-by]').forEach(b => b.setAttribute('aria-pressed', 'false'));
      btn.setAttribute('aria-pressed', 'true');
      renderSongList({ animate: true });
    });
  });

  document.querySelectorAll('.sort-btn[data-sort-order]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.sortOrder = btn.dataset.sortOrder;
      document.querySelectorAll('.sort-btn[data-sort-order]').forEach(b => b.setAttribute('aria-pressed', 'false'));
      btn.setAttribute('aria-pressed', 'true');
      renderSongList({ animate: true });
    });
  });
}

// ---------------------------------------------------------
// User Songs page: its own list, search, and "+ New song" entry point.
// Deliberately no sort controls (see the planning doc: "Sorting systems
// are not required because Official Songs and User Songs are separate
// sections") — renderSongList() falls back to alphabetical for this
// source on its own (see its hasNumbers note), so there's nothing this
// page needs to drive that itself.
// ---------------------------------------------------------
function bindUserSongsPage() {
  const input = document.getElementById('user-song-search-input');
  input.addEventListener('input', () => {
    state.userSongQuery = input.value.trim().toLowerCase();
    renderUserSongList({ animate: true });
  });

  document.getElementById('new-user-song-btn').addEventListener('click', () => {
    openSongEditor(null);
  });
}

function renderUserSongList(opts = {}) {
  renderSongList({
    sourceKey: 'user',
    listElId: 'user-song-list',
    emptyElId: 'user-songs-empty-state',
    countElId: 'user-songs-results-count',
    query: state.userSongQuery,
    animate: opts.animate,
  });
  document.getElementById('user-songs-empty-state').textContent = t('userSongsEmptyState');
}

function stripChords(lyricsArr) {
  return lyricsArr.join(' \n ').replace(/\[[^\]]+\]/g, '');
}

function matchesQuery(song, q) {
  if (!q) return true;

  const haystack = [
    song.title,
    song.number != null ? String(song.number) : '', // some sources' songs have no number — see DB_SOURCES' hasNumbers
    ...(song.alternateTitles || []),
    song.artist || '',
    stripChords(song.lyrics),
  ].join(' \n ').toLowerCase();

  // Every word in the query must appear somewhere in the combined text,
  // in any order — so "God awesome" matches "God Is an Awesome God"
  // even though that exact phrase never appears contiguously.
  const words = q.split(/\s+/).filter(Boolean);
  return words.every(word => haystack.includes(word));
}

// Lower rank = more relevant. Used only while a search query is active,
// so exact/close title matches float to the top instead of being buried
// among "contains the word somewhere in the lyrics" results.
function relevanceRank(song, q) {
  const query = q.trim().toLowerCase();
  if (!query) return 6;

  const title = (song.title || '').toLowerCase();
  const altTitles = (song.alternateTitles || []).filter(Boolean).map(a => a.toLowerCase());
  const artist = (song.artist || '').toLowerCase();

  if (title === query) return 0;                              // exact title match
  if (title.startsWith(query)) return 1;                       // title starts with query
  if (title.includes(query)) return 2;                         // title contains query
  if (altTitles.some(a => a === query)) return 3;               // exact alternate title
  if (altTitles.some(a => a.includes(query))) return 4;         // alternate title contains query
  if (artist.includes(query)) return 5;                         // artist match
  return 6;                                                     // everything else (e.g. lyrics)
}

// sourceKey (optional) lets this fall back to alphabetical even if
// state.sortBy is still 'num' from a previous source that had numbers —
// e.g. right after switching Settings → Song database from Mongolian to
// English, before the person has had a chance to notice/change the sort
// buttons themselves (which applyDbSource() also updates — see there for
// the other half of this).
function sortSongs(list, q, sourceKey = state.activeDbSource) {
  const arr = [...list];
  const dir = state.sortOrder === 'desc' ? -1 : 1;
  const query = (q || '').trim();
  // Same "user songs aren't in DB_SOURCES" reasoning as renderSongList's
  // own hasNumbers — see the comment there.
  const hasNumbers = sourceKey === 'user' ? false : (DB_SOURCES[sourceKey] || {}).hasNumbers !== false;

  arr.sort((a, b) => {
    if (query) {
      const rankA = relevanceRank(a, query);
      const rankB = relevanceRank(b, query);
      if (rankA !== rankB) return rankA - rankB;
    }
    if (state.sortBy === 'num' && hasNumbers) {
      return (a.number - b.number) * dir;
    }
    return a.title.localeCompare(b.title) * dir;
  });

  return arr;
}

function highlight(text, q) {
  if (!q) return escapeHtml(text);
  const idx = text.toLowerCase().indexOf(q);
  if (idx === -1) return escapeHtml(text);
  return escapeHtml(text.slice(0, idx)) + '<mark>' + escapeHtml(text.slice(idx, idx + q.length)) + '</mark>' + escapeHtml(text.slice(idx + q.length));
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// sourceKey picks which state.sources entry to render — defaults to
// whichever database is active in Settings → Song database
// (state.activeDbSource), not a hardcoded 'official', so every Songs-page
// call site below (search, sort, switching databases) automatically
// tracks that choice with no per-call-site plumbing. listElId/emptyElId/
// countElId let a future second list page (e.g. User Songs) reuse this
// same function against its own DOM ids instead of needing its own copy.
// sourceKey/listElId/emptyElId/countElId let a second list page (User
// Songs) reuse this same function against its own DOM ids instead of
// needing its own copy (see bindUserSongsPage/renderUserSongList). query
// likewise defaults to state.query (the Songs page's own search box) but
// can be overridden — User Songs keeps its search text in the separate
// state.userSongQuery instead, so switching tabs never clobbers whichever
// box the person was mid-typing in on the other page.
function renderSongList(opts = {}) {
  const {
    sourceKey = state.activeDbSource,
    listElId = 'song-list',
    emptyElId = 'empty-state',
    countElId = 'results-count',
    query = state.query,
    // Set by the search inputs and sort buttons (see bindSongsPage/
    // bindUserSongsPage) — everything else that re-renders a list (tab
    // navigation, language change, db switch) leaves this off, since an
    // animation there would fire on every page visit rather than reading
    // as a response to something the person just did.
    animate = false,
  } = opts;

  const source = state.sources[sourceKey];
  const listEl = document.getElementById(listElId);
  const emptyEl = document.getElementById(emptyElId);
  const countEl = document.getElementById(countElId);

  if (!source || source.loadFailed) {
    listEl.innerHTML = `<li class="load-error">${escapeHtml(t('songLoadError'))}</li>`;
    emptyEl.hidden = true;
    countEl.textContent = '';
    if (animate) animateListRefresh(listEl, emptyEl, countEl);
    return;
  }

  const filtered = sortSongs(source.songs.filter(s => matchesQuery(s, query)), query, sourceKey);

  countEl.textContent = filtered.length === source.songs.length
    ? t('resultsAll', filtered.length)
    : t('resultsFiltered', filtered.length, source.songs.length);

  emptyEl.hidden = filtered.length !== 0;

  // Some sources' songs have no `number` field at all (see DB_SOURCES'
  // hasNumbers) — the badge that normally shows it is dropped instead of
  // rendering "undefined" for those. User Songs aren't in DB_SOURCES at
  // all (they're not a fetched database — see state.sources.user's own
  // comment), so they're treated the same as an explicit hasNumbers:
  // false rather than falling through to DB_SOURCES' "unknown key means
  // true" default, which would try to show a number none of these songs
  // actually have.
  const hasNumbers = sourceKey === 'user' ? false : (DB_SOURCES[sourceKey] || {}).hasNumbers !== false;

  const q = query;

  if (!animate || prefersReducedMotion()) {
    // Plain rebuild for non-search-driven renders (tab visits, db switch,
    // language change, reduced-motion) — nothing is animating, so there's
    // no reason to pay for the diff below.
    listEl.innerHTML = '';
    filtered.forEach(song => listEl.appendChild(buildSongRow(song, hasNumbers, q, sourceKey)));
    return;
  }

  // Diffed render: only songs that are newly appearing or dropping out of
  // the results fade — anything present both before and after this render
  // (the common case, since one keystroke usually only trims a few songs)
  // is reused as-is and just repositioned, so it never flickers. Rows are
  // keyed by sourceKey+id rather than id alone so a db switch (which
  // reuses this same function against a different source but can, in
  // principle, share this listEl across renders) can never accidentally
  // treat a same-numbered song from a different source as a match.
  const existingRows = new Map();
  Array.from(listEl.children).forEach(li => {
    if (li.dataset.rowKey) existingRows.set(li.dataset.rowKey, li);
  });

  const fragment = document.createDocumentFragment();
  const keptKeys = new Set();

  filtered.forEach(song => {
    const key = `${sourceKey}:${song.id}`;
    keptKeys.add(key);
    let li = existingRows.get(key);
    if (li) {
      // Already on screen — bring back from a leave-animation if this
      // song reappeared mid-fade (e.g. one character got backspaced),
      // and refresh its highlighted title text for the new query.
      if (li.dataset.state === 'exiting') {
        delete li.dataset.state;
        li.classList.remove('song-row-exit');
        if (li._exitCleanup) {
          li.removeEventListener('animationend', li._exitCleanup);
          li._exitCleanup = null;
        }
      }
      updateSongRowContent(li, song, hasNumbers, q);
    } else {
      li = buildSongRow(song, hasNumbers, q, sourceKey);
      li.dataset.rowKey = key;
      li.classList.add('song-row-enter');
      li.addEventListener('animationend', function onEnd() {
        li.classList.remove('song-row-enter');
        li.removeEventListener('animationend', onEnd);
      }, { once: true });
    }
    fragment.appendChild(li); // detaches reused rows from listEl, leaving only dropped-out ones behind
  });

  // Whatever's left in listEl now fell out of the results — fade each one
  // out and remove it once its animation finishes, instead of cutting it
  // instantly.
  existingRows.forEach((li, key) => {
    if (keptKeys.has(key) || li.dataset.state === 'exiting') return;
    li.dataset.state = 'exiting';
    li.classList.add('song-row-exit');
    const cleanup = () => {
      li.removeEventListener('animationend', cleanup);
      li._exitCleanup = null;
      li.remove();
    };
    li._exitCleanup = cleanup;
    li.addEventListener('animationend', cleanup);
  });

  // New order goes in ahead of anything still fading out, so the visible
  // results read top-to-bottom correctly while leaving rows finish
  // underneath.
  listEl.insertBefore(fragment, listEl.firstChild);
}

function buildSongRow(song, hasNumbers, q, sourceKey) {
  const li = document.createElement('li');
  const row = document.createElement('button');
  row.className = 'song-row';
  row.addEventListener('click', () => openSong(song, { sourceKey }));
  li.appendChild(row);
  updateSongRowContent(li, song, hasNumbers, q);
  return li;
}

function updateSongRowContent(li, song, hasNumbers, q) {
  const row = li.firstElementChild;
  row.innerHTML = `
    ${hasNumbers ? `<span class="song-badge">${song.number}</span>` : ''}
    <span class="song-row-text">
      <span class="song-row-title">${highlight(song.title, q)}</span>
      ${song.artist ? `<span class="song-row-sub">${escapeHtml(song.artist)}</span>` : ''}
    </span>
  `;
}

// Whole-block opacity/translate dip-and-recover. Ordinary search/sort
// updates no longer use this — see the per-row song-row-enter/exit
// animations in renderSongList's diffed render — but it's kept here for
// the "source failed to load" branch above, where there's no song list to
// diff against, just the list/empty-state/count settling in together.
// Restarting a CSS animation that's already mid-flight needs the
// remove/reflow/re-add dance (same trick used for the page-slide and
// heart-pop animations elsewhere in this file), since re-adding a class
// that's already present is a no-op.
function animateListRefresh(...els) {
  if (prefersReducedMotion()) return;
  const targets = els.filter(Boolean);
  if (!targets.length) return;
  targets.forEach(el => el.classList.remove('list-refresh-flash'));
  void targets[0].offsetWidth;
  targets.forEach(el => el.classList.add('list-refresh-flash'));
}

// ---------------------------------------------------------
// Song view: chord-over-lyric rendering + transpose
// ---------------------------------------------------------
function bindSongView() {
  document.getElementById('back-btn').addEventListener('click', () => history.back());

  document.getElementById('transpose-up').addEventListener('click', () => {
    if (state.transpose >= TRANSPOSE_LIMIT) return;
    state.transpose += 1;
    updateTransposeUI({ animate: true });
  });
  document.getElementById('transpose-down').addEventListener('click', () => {
    if (state.transpose <= -TRANSPOSE_LIMIT) return;
    state.transpose -= 1;
    updateTransposeUI({ animate: true });
  });
  document.getElementById('transpose-reset').addEventListener('click', () => {
    if (state.transpose === 0) return;
    state.transpose = 0;
    updateTransposeUI({ animate: true });
  });

  document.querySelectorAll('[data-font]').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.font;
      if (action === 'lyrics-up') state.lyricsSize = Math.min(1.6, state.lyricsSize + 0.08);
      if (action === 'lyrics-down') state.lyricsSize = Math.max(0.75, state.lyricsSize - 0.08);
      if (action === 'chords-up') state.chordSize = Math.min(1.2, state.chordSize + 0.06);
      if (action === 'chords-down') state.chordSize = Math.max(0.6, state.chordSize - 0.06);
      applyFontSizes();
      localStorage.setItem('sb-lyrics-size', state.lyricsSize);
      localStorage.setItem('sb-chord-size', state.chordSize);
    });
  });

  document.getElementById('sv-favorite-btn').addEventListener('click', () => {
    const song = state.activeSong;
    if (!song) return;
    toggleFavorite(state.activeSourceKey, song.id);
    updateFavoriteButtonUI();
    const favBtn = document.getElementById('sv-favorite-btn');
    favBtn.classList.remove('heart-pop');
    void favBtn.offsetWidth; // restart the animation if a previous tap's spin hasn't finished
    favBtn.classList.add('heart-pop');
    favBtn.addEventListener('animationend', () => favBtn.classList.remove('heart-pop'), { once: true });
  });

  document.getElementById('sv-menu-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleSongViewMenu();
  });
  document.addEventListener('click', () => closeSongViewMenu());
}

// The "…" menu itself has no reason to hide anymore — "Add to playlist"
// applies to every song, official or user-authored — so this is now just
// a safety net that closes any open dropdown when the active song or
// language changes out from under it (called from openSong() and again
// from applyLanguage()).
function updateSongViewMenuUI() {
  closeSongViewMenu();
}

let songViewMenuOpen = false;
function toggleSongViewMenu() {
  songViewMenuOpen ? closeSongViewMenu() : openSongViewMenu();
}

function openSongViewMenu() {
  const song = state.activeSong;
  if (!song) return;
  closeSongViewMenu();
  const isUserSong = state.activeSourceKey === 'user';
  const btn = document.getElementById('sv-menu-btn');
  const wrap = document.createElement('div');
  wrap.className = 'kebab-dropdown';
  wrap.id = 'sv-kebab-dropdown';
  wrap.innerHTML = `
    <button type="button" id="sv-kebab-add-playlist"><svg data-icon="plus" viewBox="0 0 24 24"></svg>${escapeHtml(t('addToPlaylistTitle'))}</button>
    ${isUserSong ? `
    <button type="button" id="sv-kebab-edit"><svg data-icon="pencil" viewBox="0 0 24 24"></svg>${escapeHtml(t('editBtn'))}</button>
    <button type="button" id="sv-kebab-delete" class="is-danger"><svg data-icon="trash" viewBox="0 0 24 24"></svg>${escapeHtml(t('menuDelete'))}</button>
    ` : ''}
  `;
  btn.parentElement.style.position = 'relative';
  btn.parentElement.appendChild(wrap);
  initIcons(wrap);
  songViewMenuOpen = true;

  wrap.querySelector('#sv-kebab-add-playlist').addEventListener('click', (e) => {
    e.stopPropagation();
    closeSongViewMenu();
    openAddToPlaylistModal(state.activeSourceKey, song.id);
  });
  const editBtn = wrap.querySelector('#sv-kebab-edit');
  if (editBtn) editBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeSongViewMenu();
    openSongEditor(song);
  });
  const deleteBtn = wrap.querySelector('#sv-kebab-delete');
  if (deleteBtn) deleteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeSongViewMenu();
    confirmDeleteUserSong(song);
  });
  wrap.addEventListener('click', (e) => e.stopPropagation());
}

function closeSongViewMenu() {
  const wrap = document.getElementById('sv-kebab-dropdown');
  songViewMenuOpen = false;
  if (!wrap) return;
  if (prefersReducedMotion()) { wrap.remove(); return; }
  // See closePlaylistMenu()'s comment on why the id is freed up-front.
  wrap.removeAttribute('id');
  wrap.classList.add('kebab-dropdown-exit');
  wrap.addEventListener('animationend', () => wrap.remove(), { once: true });
}

function updateFavoriteButtonUI() {
  const song = state.activeSong;
  const btn = document.getElementById('sv-favorite-btn');
  if (!btn || !song) return;
  const isFav = isSongInPlaylist('favorites', state.activeSourceKey, song.id);
  btn.setAttribute('aria-pressed', String(isFav));
  const svg = btn.querySelector('svg');
  if (svg) svg.setAttribute('data-icon', isFav ? 'heart-filled' : 'heart-outline');
  injectIcon(svg);
}

// Chromium's native <audio controls> is a shadow-DOM widget (play button,
// scrubber, time, volume) that's laid out once when the element becomes
// visible. openSong() below builds it via innerHTML while the song-view
// page is still hidden/off-screen (so its content is ready the instant the
// page transition starts), which means that first layout pass can happen
// before the element has real size — the controls then render blank or as
// disconnected fragments, and stay that way until something forces a
// reflow. A tap does that by accident; this does it on purpose, right
// after the page has actually become visible; toggling `hidden` twice is a
// no-op visually but makes the browser redo layout for the audio controls.
function fixNativeAudioControlsPaint() {
  document.querySelectorAll('#sv-audio audio').forEach(a => {
    a.hidden = true;
    // eslint-disable-next-line no-unused-expressions
    void a.offsetHeight;
    a.hidden = false;
  });
}

function openSong(song, opts = {}) {
  const { pushHistory = true, sourceKey = state.activeDbSource } = opts;
  state.activeSong = song;
  state.activeSourceKey = sourceKey;
  state.transpose = 0;

  const numberEl = document.getElementById('sv-number');
  if (song.number != null) {
    numberEl.textContent = `#${song.number}`;
    numberEl.hidden = false;
  } else {
    // Some sources' songs have no number (see DB_SOURCES' hasNumbers) —
    // hide the badge entirely rather than show "#undefined".
    numberEl.textContent = '';
    numberEl.hidden = true;
  }
  document.getElementById('sv-title').textContent = song.title;

  const altEl = document.getElementById('sv-alt-title');
  const altTitles = (song.alternateTitles || []).filter(Boolean);
  if (altTitles.length) {
    altEl.textContent = altTitles.join(' • ');
    altEl.hidden = false;
  } else {
    altEl.textContent = '';
    altEl.hidden = true;
  }

  const artistEl = document.getElementById('sv-artist');
  if (song.artist) {
    artistEl.textContent = song.artist;
    artistEl.hidden = false;
  } else {
    artistEl.textContent = '';
    artistEl.hidden = true;
  }

  const labelsEl = document.getElementById('sv-labels');
  labelsEl.innerHTML = (song.labels || [])
    .map(l => `<span class="sv-label-chip">${escapeHtml(l)}</span>`).join('');

  const audioEl = document.getElementById('sv-audio');
  // Pause/release whatever's currently playing before we blow it away with
  // innerHTML below. If a track is mid-playback, the browser/OS may have
  // already registered it with the system media session (that's the little
  // floating play-bar widget Android shows) — just overwriting innerHTML
  // destroys the <audio> element without telling the OS, so that widget is
  // left behind with nothing playing underneath it, which is what made it
  // look broken/shrunk. Explicitly pausing and clearing src first makes the
  // browser tear the media session down cleanly.
  audioEl.querySelectorAll('audio').forEach(a => {
    a.pause();
    a.removeAttribute('src');
    a.load();
  });
  if (song.audio && song.audio.length) {
    audioEl.hidden = false;
    audioEl.innerHTML = song.audio.map(a => {
      const url = escapeHtml(a.url || a);
      return `
        <div class="audio-item">
          <audio controls style="width:100%" src="${url}"></audio>
        </div>`;
    }).join('');
  } else {
    audioEl.hidden = true;
    audioEl.innerHTML = '';
  }

  const linksEl = document.getElementById('sv-links');
  if (song.links && song.links.length) {
    linksEl.hidden = false;
    linksEl.innerHTML = song.links.map(l => {
      const url = typeof l === 'string' ? l : l.url;
      const label = (typeof l === 'object' && l.label) ? l.label : t('listenLink');
      return `<a class="sv-link-btn" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
    }).join('');
  } else {
    linksEl.hidden = true;
    linksEl.innerHTML = '';
  }

  updateTransposeUI();
  updateFavoriteButtonUI();
  updateSongViewMenuUI();
  showPage('song-view', { resetScroll: true });
  if (pushHistory) {
    pushNavState({ page: 'song-view', songId: song.id, sourceKey });
  }
}

function updateTransposeUI(opts = {}) {
  const { animate = false } = opts;
  document.getElementById('transpose-offset').textContent =
    (state.transpose > 0 ? '+' : '') + state.transpose;
  document.getElementById('transpose-up').disabled = state.transpose >= TRANSPOSE_LIMIT;
  document.getElementById('transpose-down').disabled = state.transpose <= -TRANSPOSE_LIMIT;
  const song = state.activeSong;
  document.getElementById('sv-key').textContent = song ? transposeChord(song.key, state.transpose) : '—';
  renderLyrics({ animateChords: animate });
}

function transposeChord(chord, steps) {
  if (!chord || !steps) return chord;
  // Split root (+ optional accidental) from the rest (quality/extensions), and handle slash bass.
  const parts = chord.split('/');
  const transposedParts = parts.map(part => transposeSingle(part, steps));
  return transposedParts.join('/');
}

function transposeSingle(token, steps) {
  const m = token.match(/^([A-G])(#|b)?(.*)$/);
  if (!m) return token;
  const [, letter, accidental, rest] = m;
  const useFlats = FLAT_KEYS.has(letter + (accidental || '') + (rest.startsWith('m') ? 'm' : ''));
  const name = letter + (accidental || '');
  let idx = CHROMATIC_SHARP.indexOf(name);
  if (idx === -1) idx = CHROMATIC_FLAT.indexOf(name);
  if (idx === -1) return token;
  const newIdx = ((idx + steps) % 12 + 12) % 12;
  const table = useFlats ? CHROMATIC_FLAT : CHROMATIC_SHARP;
  return table[newIdx] + rest;
}

// containerId/song/transpose default to the real song-view page (its
// container id, state.activeSong, state.transpose) so every existing call
// site keeps working unchanged. The song editor's live preview (see
// renderEditorPreview()) overrides all three to render a draft song's
// lyrics — built from the same textarea the person is actively typing
// into, not yet saved anywhere — into its own #editor-preview container
// instead, through this exact same chord/lyric engine rather than a
// second, separate implementation that could drift out of sync with how
// a saved song actually renders.
function renderLyrics(opts = {}) {
  const {
    animateChords = false,
    containerId = 'lyrics-container',
    song = state.activeSong,
    transpose = state.transpose,
  } = opts;
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  if (!song) return;

  // Running count of chord tags placed so far, used only to stagger the
  // chord-pop animation slightly per chord (a light ripple down the
  // page). Capped so long songs don't end up with a sluggish tail.
  let chordAnimIndex = 0;

  // Group lines into sections (verses/choruses) using blank lines as
  // boundaries — the same simple convention a future song editor can
  // produce by just leaving a blank line between parts. A section whose
  // first line starts with leading whitespace in the source is treated as
  // an indented part (e.g. a chorus set off from the verses), matching how
  // it's laid out in the original songbook document.
  const sections = [];
  let current = [];
  song.lyrics.forEach(rawLine => {
    if (rawLine.trim() === '') {
      if (current.length) { sections.push(current); current = []; }
    } else {
      current.push(rawLine);
    }
  });
  if (current.length) sections.push(current);

  // Only number parts when there's more than one — a single-section song
  // has nothing to distinguish, so a lone "1" would just be noise.
  const numberParts = sections.length > 1;

  sections.forEach((sectionLines, sectionIdx) => {
    const isIndented = /^\s{2,}/.test(sectionLines[0]);

    const sectionEl = document.createElement('div');
    sectionEl.className = 'lyric-section' + (isIndented ? ' is-indented' : '');

    // A section's first line can open with an explicit label like "Гүүр:"
    // (Bridge:) or "Дахилт:" (Chorus:) instead of relying on the plain
    // sequence number — the label is whatever text (letters/spaces only,
    // no digits or [chord] markers) sits before the FIRST colon on that
    // line. When present it's stripped from the line before chord
    // tokenizing and rendered in place of the number; when absent, the
    // section falls back to the existing "1, 2, 3…" numbering below.
    const firstLineTrimmed = sectionLines[0].replace(/^\s+/, '');
    const labelMatch = firstLineTrimmed.match(/^([^\d\[\]:]+):(.*)$/);
    const sectionLabel = labelMatch ? labelMatch[1].trim() : null;

    if (sectionLabel) {
      const numEl = document.createElement('div');
      numEl.className = 'lyric-section-number';
      numEl.textContent = sectionLabel;
      sectionEl.appendChild(numEl);
    } else if (numberParts) {
      const numEl = document.createElement('div');
      numEl.className = 'lyric-section-number';
      numEl.textContent = String(sectionIdx + 1);
      sectionEl.appendChild(numEl);
    }

    sectionLines.forEach((rawLine, lineIdx) => {
      // Leading whitespace on the first line is only a structural indent
      // marker (see isIndented above), not literal spacing to render. The
      // section label (if any) was already pulled out above and is
      // likewise stripped here so it isn't rendered twice.
      let line = lineIdx === 0 ? rawLine.replace(/^\s+/, '') : rawLine;
      if (lineIdx === 0 && labelMatch) line = labelMatch[2].replace(/^\s+/, '');

      const lineEl = document.createElement('div');
      lineEl.className = 'lyric-line';

      // Tokenize on [Chord] markers: each chord attaches to the text run that follows it,
      // up to the next chord marker (or end of line). Leading text with no chord is its own run.
      // `precededByBreak` records whether an actual word boundary (whitespace, or start of
      // line) separates this run from whatever text came right before it. Chords are
      // routinely dropped in the middle of a word to mark the exact syllable they land on
      // (e.g. "алдар[Em]шаач", "A[E]а" in this songbook's own data) — that split must NOT be
      // treated as a word break, or the two halves get rendered as separate words with a gap
      // torn into the middle of one, which is the "chords splitting text" bug.
      const chordPositions = [...line.matchAll(/\[([^\]]+)\]/g)];
      const runs = [];
      if (chordPositions.length === 0) {
        runs.push({ chord: null, text: line, precededByBreak: true });
      } else {
        if (chordPositions[0].index > 0) {
          runs.push({ chord: null, text: line.slice(0, chordPositions[0].index), precededByBreak: true });
        }
        chordPositions.forEach((cm, i) => {
          const textStart = cm.index + cm[0].length;
          const textEnd = i + 1 < chordPositions.length ? chordPositions[i + 1].index : line.length;
          const precedingChar = cm.index > 0 ? line[cm.index - 1] : '';
          const precededByBreak = cm.index === 0 || /\s/.test(precedingChar);
          runs.push({ chord: cm[1], text: line.slice(textStart, textEnd), precededByBreak });
        });
      }

      // Flatten each run into per-word "pieces". A chord can also cover a run of several
      // whole words before the next chord change (e.g. "[G]word1 word2 word3") — splitting
      // those into one piece per word (chord on the first only) gives flex-wrap normal
      // word-level wrapping granularity, so only the word that doesn't fit moves down, not
      // the whole run. Each piece remembers whether it starts a new word (normal spacing
      // before it) or is a mid-word continuation of the piece before it (no space in the
      // source — must render with zero gap so the letters stay visually joined).
      const pieces = [];
      runs.forEach(run => {
        const words = run.text.split(/\s+/).filter(Boolean);
        if (words.length === 0) {
          pieces.push({ chord: run.chord, text: '', startsNewWord: run.precededByBreak });
        } else {
          words.forEach((w, i) => {
            pieces.push({ chord: i === 0 ? run.chord : null, text: w, startsNewWord: i === 0 ? run.precededByBreak : true });
          });
        }
      });

      // Group consecutive continuation pieces (mid-word chord splits) together — each group
      // is rendered as ONE flex item on the line, so the outer line's word-gap only ever
      // appears between real words, never inside one.
      const groups = [];
      pieces.forEach(piece => {
        if (piece.startsNewWord || groups.length === 0) {
          groups.push([piece]);
        } else {
          groups[groups.length - 1].push(piece);
        }
      });

      // A line with no chord at all shouldn't still reserve a chord
      // badge's worth of height above its words — that leaves a "phantom"
      // gap with nothing filling it, which reads as loose and inconsistent
      // next to chorded lines where that space is doing visible work. Only
      // give this line the reserved chord row (and its tighter, chord-chart
      // line-height) when it actually has a chord on it; otherwise fall
      // back to normal, closer-set body-text spacing — same idea WorshipLeader
      // and similar chord-chart apps use for spoken/plain lyric lines.
      const lineHasChord = pieces.some(p => p.chord);
      lineEl.classList.toggle('is-plain', !lineHasChord);

      groups.forEach(group => {
        const wrap = document.createElement('span');
        wrap.className = 'lyric-token';
        group.forEach(piece => {
          const pieceEl = document.createElement('span');
          pieceEl.className = 'lyric-piece';
          if (piece.chord) {
            const chordEl = document.createElement('span');
            chordEl.className = 'chord-tag';
            chordEl.textContent = transposeChord(piece.chord, transpose);
            if (animateChords) {
              chordEl.classList.add('chord-pop');
              chordEl.style.setProperty('--chord-pop-delay', Math.min(chordAnimIndex * 12, 380) + 'ms');
              chordAnimIndex += 1;
            }
            pieceEl.appendChild(chordEl);
          } else if (piece.text && lineHasChord) {
            const spacer = document.createElement('span');
            spacer.className = 'chord-tag-spacer';
            pieceEl.appendChild(spacer);
          }
          const textEl = document.createElement('span');
          textEl.className = 'lyric-word';
          textEl.textContent = piece.text || '\u00A0';
          pieceEl.appendChild(textEl);
          wrap.appendChild(pieceEl);
        });
        lineEl.appendChild(wrap);
      });

      sectionEl.appendChild(lineEl);
    });

    container.appendChild(sectionEl);
  });
}

// ---------------------------------------------------------
// Song editor (v3): shared by both "New song" and "Edit song" (see
// state.editorSongId). Parses the same [Am]-before-syllable notation
// official songs use straight out of a plain textarea — no separate
// chord-entry UI — and previews it live through the real renderLyrics()
// engine, so what's shown while editing is exactly how the song will
// look once saved (see renderLyrics()'s containerId/song/transpose
// params, added specifically so this could reuse it as-is).
// ---------------------------------------------------------
function bindSongEditor() {
  document.getElementById('editor-back-btn').addEventListener('click', () => history.back());
  document.getElementById('editor-save-btn').addEventListener('click', saveSongFromEditor);
  document.getElementById('editor-lyrics').addEventListener('input', renderEditorPreview);
  document.getElementById('editor-delete-btn').addEventListener('click', () => {
    const song = findSongByRef('user', state.editorSongId);
    if (song) confirmDeleteUserSong(song, { fromEditor: true });
  });
}

// song: null opens a blank "New song" form; an existing user-song object
// opens it pre-filled for editing. Always navigates via showPage (pushing
// history), same as openSong/openPlaylist, so the hardware/gesture back
// button leaves the editor the same way it leaves anywhere else in the app.
function openSongEditor(song, opts = {}) {
  const { pushHistory = true } = opts;
  state.editorSongId = song ? song.id : null;

  document.getElementById('editor-page-title').textContent =
    song ? t('editSongTitle') : t('newSongTitle');
  document.getElementById('editor-title').value = song ? song.title || '' : '';
  document.getElementById('editor-artist').value = song ? song.artist || '' : '';
  document.getElementById('editor-key').value = song ? song.key || '' : '';
  document.getElementById('editor-audio').value =
    (song && song.audio && song.audio[0] && song.audio[0].url) || '';
  document.getElementById('editor-lyrics').value = song ? (song.lyrics || []).join('\n') : '';

  document.getElementById('editor-delete-btn').hidden = !song;
  document.getElementById('editor-delete-btn').textContent = t('deleteSongBtn');

  renderEditorPreview();
  showPage('song-editor', { resetScroll: true });
  if (pushHistory) {
    pushNavState({ page: 'song-editor', editorSongId: state.editorSongId });
  }
}

// Renders the textarea's CURRENT (unsaved) content through the same
// renderLyrics() engine a real song view uses, into #editor-preview
// instead of #lyrics-container — see renderLyrics()'s containerId param.
// Runs on every keystroke (see bindSongEditor's input listener), so chord
// placement is visibly correct before the person ever taps Save.
function renderEditorPreview() {
  const raw = document.getElementById('editor-lyrics').value;
  const lyrics = raw.split('\n');
  const hasContent = raw.trim() !== '';
  const previewEl = document.getElementById('editor-preview');

  if (!hasContent) {
    previewEl.innerHTML = `<p class="editor-preview-empty">${escapeHtml(t('editorPreviewEmpty'))}</p>`;
    return;
  }

  renderLyrics({
    containerId: 'editor-preview',
    song: { lyrics },
    transpose: 0, // preview always shows the song's own written key — transposing is a song-view-only control
  });
}

function saveSongFromEditor() {
  const title = document.getElementById('editor-title').value.trim();
  if (!title) {
    showToast(t('toastSongTitleRequired'));
    document.getElementById('editor-title').focus();
    return;
  }

  const artist = document.getElementById('editor-artist').value.trim();
  const key = document.getElementById('editor-key').value.trim();
  const audioUrl = document.getElementById('editor-audio').value.trim();
  const lyrics = document.getElementById('editor-lyrics').value.split('\n');

  const existing = state.editorSongId ? findSongByRef('user', state.editorSongId) : null;
  const song = {
    id: existing ? existing.id : genUserSongId(),
    title,
    artist: artist || undefined,
    key: key || undefined,
    lyrics,
    audio: audioUrl ? [{ url: audioUrl, label: t('listenLink') }] : [],
    // labels/sheetMusic are wired into the data model now (matching how
    // official songs already carry these fields — see README's "Song data
    // structure") so v3.5's label UI can start writing here without any
    // schema change to songs saved today.
    labels: existing ? existing.labels || [] : [],
    sheetMusic: existing ? existing.sheetMusic || [] : [],
  };

  saveUserSong(song).then(() => {
    showToast(existing ? t('toastSongUpdated') : t('toastSongCreated'));
    if (state.currentPage === 'user-songs') renderUserSongList({ animate: true });
    // Whatever page this editor was opened from (the User Songs list, or
    // song-view via the kebab menu) is one history entry back — its
    // popstate handler re-resolves the song by id from
    // state.sources.user.songs (see initHistoryNav's song-view branch),
    // which saveUserSong() above already updated in place, so backing out
    // shows the edit immediately with no separate refresh call needed here.
    history.back();
  }).catch(err => {
    console.error('Songbook: failed to save user song —', err);
    showToast(t('toastSongSaveFailed'));
  });
}

function confirmDeleteUserSong(song, opts = {}) {
  const { fromEditor = false } = opts;
  const wrap = document.createElement('div');
  const p = document.createElement('p');
  p.className = 'modal-hint';
  p.style.marginTop = '0';
  p.textContent = t('deleteSongConfirm', song.title);
  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  actions.innerHTML = `
    <button type="button" class="btn-secondary" id="delete-song-cancel"></button>
    <button type="button" class="btn-primary" id="delete-song-confirm" style="background:var(--danger)"></button>
  `;
  wrap.appendChild(p);
  wrap.appendChild(actions);
  actions.querySelector('#delete-song-cancel').textContent = t('cancelBtn');
  actions.querySelector('#delete-song-confirm').textContent = t('deleteBtn');

  actions.querySelector('#delete-song-cancel').addEventListener('click', closeModal);
  actions.querySelector('#delete-song-confirm').addEventListener('click', () => {
    closeModal();
    // Decide how many history entries to pop BEFORE deleting/navigating —
    // once the song is gone, state.currentPage will have changed by the
    // time any of this runs async, so this can't be figured out after the
    // fact. Two cases need two pops, not one: deleting from the editor
    // when it was opened from this exact song's song-view (editor sits on
    // top of a song-view that also has nothing left to show once the song
    // is gone), and deleting from song-view's own kebab menu never has an
    // editor above it, so needs just one.
    const wasOnEditorOverSongView =
      fromEditor && state.activeSong && state.activeSourceKey === 'user' && state.activeSong.id === song.id;
    const popCount = wasOnEditorOverSongView ? 2 : (state.currentPage === 'song-editor' || state.currentPage === 'song-view') ? 1 : 0;

    deleteUserSong(song.id).then(() => {
      showToast(t('toastSongDeleted'));
      if (state.currentPage === 'user-songs') renderUserSongList({ animate: true });
      for (let i = 0; i < popCount; i++) history.back();
    }).catch(err => {
      console.error('Songbook: failed to delete user song —', err);
      showToast(t('toastSongSaveFailed'));
    });
  });

  openModal(t('deleteSongTitle'), wrap);
}

// ---------------------------------------------------------
// Playlists (v2): a permanent "Favorites" playlist plus any number of
// user-created playlists. Each playlist just holds a list of song
// references — {sourceKey, songId} — rather than copies of the song data
// itself, so a playlist always reflects the current song content and
// works against any source (state.sources.official and state.sources.english
// today, a future state.sources.user tomorrow) without extra plumbing.
//
// Storage: playlists are saved on-device via IndexedDB (primary) with a
// localStorage mirror as a fallback for browsers/contexts where
// IndexedDB isn't available. This is intentionally isolated behind the
// small load/persist functions below (PlaylistStorage) so it can be
// swapped later — e.g. for a real on-disk file via the File System
// Access API — without touching any of the playlist logic that calls it.
// Note: browser storage (IndexedDB/localStorage) is scoped per-browser,
// not shared between different browsers on the same phone. Use
// Settings → Export/Import playlists to carry playlists from one browser
// to another on the same device.
// ---------------------------------------------------------
const PLAYLIST_DB_NAME = 'ngworship-playlists-db';
const PLAYLIST_DB_STORE = 'kv';
const PLAYLIST_DB_KEY = 'playlists';
const PLAYLIST_LS_KEY = 'ngw-playlists';

const PlaylistStorage = {
  _openDb() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) { reject(new Error('IndexedDB unavailable')); return; }
      const req = indexedDB.open(PLAYLIST_DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(PLAYLIST_DB_STORE)) db.createObjectStore(PLAYLIST_DB_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
  async load() {
    try {
      const db = await this._openDb();
      const data = await new Promise((resolve, reject) => {
        const tx = db.transaction(PLAYLIST_DB_STORE, 'readonly');
        const req = tx.objectStore(PLAYLIST_DB_STORE).get(PLAYLIST_DB_KEY);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
      db.close();
      if (data) return data;
    } catch (err) {
      console.warn('Songbook: playlist IndexedDB load failed, trying localStorage —', err);
    }
    try {
      const raw = localStorage.getItem(PLAYLIST_LS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      console.warn('Songbook: playlist localStorage load failed —', err);
      return null;
    }
  },
  async save(data) {
    try {
      localStorage.setItem(PLAYLIST_LS_KEY, JSON.stringify(data));
    } catch (err) {
      console.warn('Songbook: playlist localStorage save failed —', err);
    }
    try {
      const db = await this._openDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(PLAYLIST_DB_STORE, 'readwrite');
        tx.objectStore(PLAYLIST_DB_STORE).put(data, PLAYLIST_DB_KEY);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    } catch (err) {
      console.warn('Songbook: playlist IndexedDB save failed (localStorage copy still saved) —', err);
    }
  },
};

function genPlaylistId() {
  return 'pl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

async function loadPlaylists() {
  const saved = await PlaylistStorage.load();
  if (saved && saved.byId && saved.byId.favorites) {
    state.playlists = saved;
  } else {
    state.playlists = {
      order: ['favorites'],
      byId: { favorites: { id: 'favorites', name: '', isFavorites: true, songs: [] } },
    };
  }
}

function persistPlaylists() {
  PlaylistStorage.save(state.playlists); // fire-and-forget
}

// Manual export/import: browser storage (IndexedDB/localStorage) is
// scoped to one browser on the device, so it's the honest way to carry
// playlists to a different browser on the same phone (or as a manual
// backup) without needing a server.
function exportPlaylists() {
  const blob = new Blob([JSON.stringify(state.playlists, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'ngworship-playlists.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast(t('toastPlaylistsExported'));
}

async function importPlaylistsFromFile(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data || !data.byId || !data.byId.favorites) throw new Error('not a playlists export file');
    state.playlists = data;
    persistPlaylists();
    if (state.currentPage === 'playlists') renderPlaylistsList();
    if (state.currentPage === 'playlist-view') renderPlaylistView();
    if (state.activeSong) updateFavoriteButtonUI();
    showToast(t('toastPlaylistsImported'));
  } catch (err) {
    console.error('Songbook: playlist import failed —', err);
    showToast(t('toastPlaylistsImportFailed'));
  }
}

function getPlaylist(id) {
  return state.playlists.byId[id] || null;
}

function playlistDisplayName(pl) {
  return pl.isFavorites ? t('favoritesName') : pl.name;
}

function findSongByRef(sourceKey, songId) {
  const source = state.sources[sourceKey];
  if (!source) return null;
  return source.songs.find(s => s.id === songId) || null;
}

function isSongInPlaylist(playlistId, sourceKey, songId) {
  const pl = getPlaylist(playlistId);
  if (!pl) return false;
  return pl.songs.some(ref => ref.sourceKey === sourceKey && ref.songId === songId);
}

function addSongToPlaylist(playlistId, sourceKey, songId) {
  const pl = getPlaylist(playlistId);
  if (!pl || isSongInPlaylist(playlistId, sourceKey, songId)) return;
  pl.songs.push({ sourceKey, songId });
  persistPlaylists();
}

function removeSongFromPlaylist(playlistId, sourceKey, songId) {
  const pl = getPlaylist(playlistId);
  if (!pl) return;
  pl.songs = pl.songs.filter(ref => !(ref.sourceKey === sourceKey && ref.songId === songId));
  persistPlaylists();
}

function toggleSongInPlaylist(playlistId, sourceKey, songId) {
  const nowIn = !isSongInPlaylist(playlistId, sourceKey, songId);
  if (nowIn) addSongToPlaylist(playlistId, sourceKey, songId);
  else removeSongFromPlaylist(playlistId, sourceKey, songId);
  return nowIn;
}

function toggleFavorite(sourceKey, songId) {
  const nowFav = toggleSongInPlaylist('favorites', sourceKey, songId);
  return nowFav;
}

function createPlaylist(name) {
  const id = genPlaylistId();
  state.playlists.byId[id] = { id, name, isFavorites: false, songs: [], createdAt: Date.now() };
  state.playlists.order.push(id);
  persistPlaylists();
  return id;
}

function renamePlaylist(id, name) {
  const pl = getPlaylist(id);
  if (!pl || pl.isFavorites) return;
  pl.name = name;
  persistPlaylists();
}

function deletePlaylist(id) {
  const pl = getPlaylist(id);
  if (!pl || pl.isFavorites) return;
  delete state.playlists.byId[id];
  state.playlists.order = state.playlists.order.filter(pid => pid !== id);
  persistPlaylists();
}

// ---------------------------------------------------------
// Playlists page: list of playlists (Favorites pinned first)
// ---------------------------------------------------------
function bindPlaylistsPage() {
  document.getElementById('new-playlist-btn').addEventListener('click', () => {
    promptCreatePlaylist((id) => openPlaylist(id));
  });
}

// Builds one playlist row <li> from scratch (icon + title + song count +
// click handler). Used for every row on a plain rebuild, and for rows
// that are newly entering on a diffed (animate: true) render — see
// updatePlaylistRowContent() for the reused-row counterpart.
function buildPlaylistRow(id, pl) {
  const li = document.createElement('li');
  li.dataset.plId = id;
  const row = document.createElement('button');
  row.className = 'playlist-row' + (pl.isFavorites ? ' is-favorites' : '');
  row.innerHTML = `
    <span class="playlist-icon"><svg viewBox="0 0 24 24" data-icon="${pl.isFavorites ? 'heart-filled' : 'nav-playlist'}"></svg></span>
    <span class="playlist-row-text">
      <span class="playlist-row-title">${escapeHtml(playlistDisplayName(pl))}</span>
      <span class="playlist-row-sub">${t('playlistSongCount', pl.songs.length)}</span>
    </span>
  `;
  row.addEventListener('click', () => openPlaylist(id));
  li.appendChild(row);
  initIcons(li);
  return li;
}

// Refreshes an existing row's text in place (name/song-count can change —
// e.g. a rename, or a song added elsewhere) without touching its icon or
// click handler. isFavorites never changes for a given id, so the icon
// never needs to be re-picked here.
function updatePlaylistRowContent(li, pl) {
  const row = li.firstElementChild;
  row.querySelector('.playlist-row-title').textContent = playlistDisplayName(pl);
  row.querySelector('.playlist-row-sub').textContent = t('playlistSongCount', pl.songs.length);
}

// animate: true fades newly-created/newly-removed playlists in/out
// (see the song-row-enter/song-row-exit pair renderSongList's diffed
// render uses for the same purpose) instead of the whole list just
// popping to its new state — pass this from the specific action that
// added or removed a playlist (create/delete), not from routine
// re-renders like a tab visit or a language change, so the animation
// reads as a response to what the person just did rather than firing on
// every page visit.
function renderPlaylistsList(opts = {}) {
  const { animate = false } = opts;
  const listEl = document.getElementById('playlist-list');
  const emptyEl = document.getElementById('playlists-empty-state');
  emptyEl.textContent = t('playlistsEmptyState');

  const ids = state.playlists.order.filter(id => state.playlists.byId[id]);
  // Favorites is always pinned in (see loadPlaylists), so ids.length is
  // never actually 0 — only count the user's own playlists when deciding
  // whether to show the "no playlists yet" text below Favorites.
  const ownCount = ids.filter(id => !state.playlists.byId[id].isFavorites).length;
  const hasFavoritesPinned = ids.length > 0 && state.playlists.byId[ids[0]].isFavorites;
  emptyEl.hidden = ownCount !== 0;
  // When Favorites is the only playlist, the empty-state text sits right
  // below it — use the tighter, divider-attached spacing instead of the
  // large centered gap meant for a page with nothing in it at all.
  emptyEl.classList.toggle('playlists-empty-state--pinned', ownCount === 0 && hasFavoritesPinned);

  if (!animate || prefersReducedMotion()) {
    // Plain rebuild — used for routine re-renders (tab visits, language
    // change, import) where nothing is animating, so there's no reason to
    // pay for the diff below.
    listEl.innerHTML = '';
    ids.forEach((id, index) => {
      // Favorites is always pinned first (see loadPlaylists/createPlaylist),
      // so a divider right after it visually separates it from the user's
      // own playlists below — shown whether or not there are any yet, so it
      // also sits between Favorites and the "no playlists yet" text.
      if (index === 1 && hasFavoritesPinned) {
        const divider = document.createElement('li');
        divider.className = 'playlist-list-divider';
        listEl.appendChild(divider);
      }
      listEl.appendChild(buildPlaylistRow(id, state.playlists.byId[id]));
    });
    // Only Favorites exists — the index===1 divider above never runs
    // (there's no second item to trigger it), so add it here instead,
    // right before the "no playlists yet" text.
    if (ownCount === 0 && hasFavoritesPinned) {
      const divider = document.createElement('li');
      divider.className = 'playlist-list-divider';
      listEl.appendChild(divider);
    }
    return;
  }

  // Diffed render: only the playlist actually being added or removed
  // animates — every other row is reused in place (just its text
  // refreshed) so it never flickers. Same approach as renderSongList's
  // diffed render, keyed by playlist id instead of song id.
  const existingRows = new Map();
  Array.from(listEl.children).forEach(li => {
    if (li.dataset.plId) existingRows.set(li.dataset.plId, li);
  });

  const fragment = document.createDocumentFragment();
  const keptIds = new Set();

  ids.forEach((id, index) => {
    if (index === 1 && hasFavoritesPinned) {
      const divider = document.createElement('li');
      divider.className = 'playlist-list-divider';
      fragment.appendChild(divider);
    }
    keptIds.add(id);
    const pl = state.playlists.byId[id];
    let li = existingRows.get(id);
    if (li) {
      // Already on screen — bring back from a leave-animation if this
      // playlist reappears mid-fade (shouldn't normally happen, but
      // mirrors renderSongList's same safeguard), and refresh its text.
      if (li.dataset.state === 'exiting') {
        delete li.dataset.state;
        li.classList.remove('song-row-exit');
        if (li._exitCleanup) {
          li.removeEventListener('animationend', li._exitCleanup);
          li._exitCleanup = null;
        }
      }
      updatePlaylistRowContent(li, pl);
    } else {
      li = buildPlaylistRow(id, pl);
      li.classList.add('song-row-enter');
      li.addEventListener('animationend', function onEnd() {
        li.classList.remove('song-row-enter');
        li.removeEventListener('animationend', onEnd);
      }, { once: true });
    }
    fragment.appendChild(li); // detaches reused rows from listEl, leaving only dropped-out ones (and stale dividers) behind
  });

  if (ownCount === 0 && hasFavoritesPinned) {
    const divider = document.createElement('li');
    divider.className = 'playlist-list-divider';
    fragment.appendChild(divider);
  }

  // Whatever's left in listEl now got deleted — fade it out and remove it
  // once its animation finishes, instead of cutting it instantly.
  existingRows.forEach((li, id) => {
    if (keptIds.has(id) || li.dataset.state === 'exiting') return;
    li.dataset.state = 'exiting';
    li.classList.add('song-row-exit');
    const cleanup = () => {
      li.removeEventListener('animationend', cleanup);
      li._exitCleanup = null;
      li.remove();
    };
    li._exitCleanup = cleanup;
    li.addEventListener('animationend', cleanup);
  });

  // Old dividers are cheap to just drop and recreate fresh above (they
  // carry no content worth preserving), rather than diffing them too.
  Array.from(listEl.children).forEach(li => {
    if (!li.dataset.plId) li.remove();
  });

  // New order goes in ahead of anything still fading out, so the visible
  // list reads top-to-bottom correctly while leaving rows finish
  // underneath.
  listEl.insertBefore(fragment, listEl.firstChild);
}

// ---------------------------------------------------------
// Playlist-view page: songs inside one playlist
// ---------------------------------------------------------
function bindPlaylistView() {
  document.getElementById('playlist-back-btn').addEventListener('click', () => history.back());

  document.getElementById('playlist-menu-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    togglePlaylistMenu();
  });

  document.getElementById('playlist-done-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    setPlaylistEditMode(false);
  });

  document.addEventListener('click', () => closePlaylistMenu());

  // Drag-to-reorder (pointer events cover touch + mouse). Only active
  // while playlistEditMode is on; see renderPlaylistView for handle setup.
  document.addEventListener('pointermove', onPlaylistDragMove);
  document.addEventListener('pointerup', onPlaylistDragEnd);
  document.addEventListener('pointercancel', onPlaylistDragEnd);
}

let playlistMenuOpen = false;
function togglePlaylistMenu() {
  playlistMenuOpen ? closePlaylistMenu() : openPlaylistMenu();
}

function openPlaylistMenu() {
  const pl = getPlaylist(state.activePlaylistId);
  if (!pl) return;
  closePlaylistMenu();
  const btn = document.getElementById('playlist-menu-btn');
  const wrap = document.createElement('div');
  wrap.className = 'kebab-dropdown';
  wrap.id = 'playlist-kebab-dropdown';
  wrap.innerHTML = `
    <button type="button" id="kebab-add-songs"><svg data-icon="plus" viewBox="0 0 24 24"></svg>${escapeHtml(t('addSongsTitle'))}</button>
    <button type="button" id="kebab-edit"><svg data-icon="${playlistEditMode ? 'check' : 'pencil'}" viewBox="0 0 24 24"></svg>${escapeHtml(playlistEditMode ? t('doneBtn') : t('editBtn'))}</button>
    ${pl.isFavorites ? '' : `
    <button type="button" id="kebab-delete" class="is-danger"><svg data-icon="trash" viewBox="0 0 24 24"></svg>${escapeHtml(t('menuDelete'))}</button>
    `}
  `;
  btn.parentElement.style.position = 'relative';
  btn.parentElement.appendChild(wrap);
  initIcons(wrap);
  playlistMenuOpen = true;

  wrap.querySelector('#kebab-add-songs').addEventListener('click', (e) => {
    e.stopPropagation();
    closePlaylistMenu();
    openAddSongsModal(state.activePlaylistId);
  });
  wrap.querySelector('#kebab-edit').addEventListener('click', (e) => {
    e.stopPropagation();
    closePlaylistMenu();
    setPlaylistEditMode(!playlistEditMode);
  });
  const deleteBtn = wrap.querySelector('#kebab-delete');
  if (deleteBtn) deleteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closePlaylistMenu();
    confirmDeletePlaylist(state.activePlaylistId);
  });
  wrap.addEventListener('click', (e) => e.stopPropagation());
}

function closePlaylistMenu() {
  const wrap = document.getElementById('playlist-kebab-dropdown');
  playlistMenuOpen = false;
  if (!wrap) return;
  if (prefersReducedMotion()) { wrap.remove(); return; }
  // Free the id immediately (rather than waiting for the exit animation to
  // finish) so a fast re-open — which looks up this same id — never
  // collides with the copy that's still fading out underneath it.
  wrap.removeAttribute('id');
  wrap.classList.add('kebab-dropdown-exit');
  wrap.addEventListener('animationend', () => wrap.remove(), { once: true });
}

let playlistEditMode = false;
function setPlaylistEditMode(on) {
  // Leaving edit mode commits any pending title edit first, so Done
  // (or backing out) always saves rather than silently discarding it.
  if (playlistEditMode && !on) commitPlaylistTitleEdit();

  playlistEditMode = on;
  document.getElementById('playlist-song-list').classList.toggle('is-editing', on);
  const doneBtn = document.getElementById('playlist-done-btn');
  doneBtn.hidden = !on;
  doneBtn.textContent = t('doneBtn');

  renderPlaylistTitle();
}

// Renders pv-title as either a static heading (normal browsing) or an
// inline text input (edit mode) — the "rename" affordance IS the title
// itself while editing, rather than a separate menu item + popup.
function renderPlaylistTitle() {
  const pl = getPlaylist(state.activePlaylistId);
  if (!pl) return;
  const titleEl = document.getElementById('pv-title');

  if (playlistEditMode && !pl.isFavorites) {
    titleEl.innerHTML = '';
    const input = document.createElement('input');
    input.type = 'text';
    input.id = 'pv-title-input';
    input.className = 'pv-title-input';
    input.maxLength = 60;
    input.autocomplete = 'off';
    input.value = pl.name;
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    });
    input.addEventListener('blur', () => commitPlaylistTitleEdit());
    titleEl.appendChild(input);
  } else {
    titleEl.textContent = playlistDisplayName(pl);
  }
}

function commitPlaylistTitleEdit() {
  const pl = getPlaylist(state.activePlaylistId);
  const input = document.getElementById('pv-title-input');
  if (!pl || !input || pl.isFavorites) return;
  const name = input.value.trim();
  if (name && name !== pl.name) {
    renamePlaylist(pl.id, name);
    if (state.currentPage === 'playlists') renderPlaylistsList();
  }
}

function openPlaylist(id, opts = {}) {
  const { pushHistory = true } = opts;
  const pl = getPlaylist(id);
  if (!pl) return;
  state.activePlaylistId = id;
  setPlaylistEditMode(false); // always open a playlist fresh, not mid-edit
  renderPlaylistView();
  showPage('playlist-view', { resetScroll: true });
  if (pushHistory) {
    pushNavState({ page: 'playlist-view', playlistId: id });
  }
}

function renderPlaylistView() {
  const pl = getPlaylist(state.activePlaylistId);
  const listEl = document.getElementById('playlist-song-list');
  const emptyEl = document.getElementById('playlist-view-empty-state');
  if (!pl) return;

  document.getElementById('pv-count').textContent = t('playlistSongCount', pl.songs.length);
  emptyEl.textContent = pl.isFavorites ? t('playlistViewEmptyStateFavorites') : t('playlistViewEmptyState');

  listEl.innerHTML = '';
  const resolved = pl.songs
    .map(ref => ({ ref, song: findSongByRef(ref.sourceKey, ref.songId) }))
    .filter(x => x.song);
  emptyEl.hidden = resolved.length !== 0;

  resolved.forEach(({ ref, song }, index) => {
    const li = document.createElement('li');
    li.className = 'song-row-with-remove';
    li.dataset.sourceKey = ref.sourceKey;
    li.dataset.songId = song.id;

    const queueIndex = document.createElement('span');
    queueIndex.className = 'queue-index';
    queueIndex.textContent = String(index + 1);
    queueIndex.setAttribute('aria-hidden', 'true');
    li.appendChild(queueIndex);

    const handle = document.createElement('button');
    handle.type = 'button';
    handle.className = 'drag-handle';
    handle.setAttribute('aria-label', t('reorderHandle'));
    handle.innerHTML = '<svg data-icon="menu-kebab" viewBox="0 0 24 24" style="transform:rotate(90deg)"></svg>';
    handle.addEventListener('pointerdown', (e) => onPlaylistDragStart(e, li));

    const row = document.createElement('button');
    row.className = 'song-row';
    // Some sources' songs have no number (see DB_SOURCES' hasNumbers) —
    // drop the badge entirely for those rather than show "undefined".
    const hasNumbers = (DB_SOURCES[ref.sourceKey] || {}).hasNumbers !== false;
    row.innerHTML = `
      ${hasNumbers ? `<span class="song-badge">${song.number}</span>` : ''}
      <span class="song-row-text">
        <span class="song-row-title">${escapeHtml(song.title)}</span>
        ${song.artist ? `<span class="song-row-sub">${escapeHtml(song.artist)}</span>` : ''}
      </span>
    `;
    row.addEventListener('click', () => { if (!playlistEditMode) openSong(song, { sourceKey: ref.sourceKey }); });

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'song-row-remove';
    removeBtn.setAttribute('aria-label', t('removeFromPlaylist'));
    removeBtn.innerHTML = '<svg data-icon="close" viewBox="0 0 24 24"></svg>';
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      // Optimistically remove from the UI right away, but hold off on
      // persisting it — a mistaken tap here (no confirm dialog, on
      // purpose, since this happens often) is only one "Undo" tap away
      // from being fixed for the next few seconds.
      const originalIndex = pl.songs.findIndex(r => r.sourceKey === ref.sourceKey && r.songId === ref.songId);
      pl.songs = pl.songs.filter(r => !(r.sourceKey === ref.sourceKey && r.songId === ref.songId));
      renderPlaylistView();
      if (pl.isFavorites && state.activeSong && state.activeSong.id === ref.songId) updateFavoriteButtonUI();

      showToast(t('toastSongRemoved'), {
        label: t('undoBtn'),
        onAction: () => {
          // Put it back where it was, not just at the end.
          const idx = Math.min(originalIndex, pl.songs.length);
          pl.songs.splice(idx, 0, ref);
          renderPlaylistView();
          if (pl.isFavorites && state.activeSong && state.activeSong.id === ref.songId) updateFavoriteButtonUI();
        },
        onCommit: () => persistPlaylists(),
      }, 4000);
    });

    li.appendChild(handle);
    li.appendChild(row);
    li.appendChild(removeBtn);
    listEl.appendChild(li);
    initIcons(li);
  });

  // Re-apply edit-mode class/label (keeps Edit/Done in sync with language
  // changes) without re-running the commit-on-exit logic in
  // setPlaylistEditMode, since we're not actually toggling anything here.
  document.getElementById('playlist-song-list').classList.toggle('is-editing', playlistEditMode);
  const doneBtn = document.getElementById('playlist-done-btn');
  doneBtn.hidden = !playlistEditMode;
  doneBtn.textContent = t('doneBtn');
  renderPlaylistTitle();
}

// ---------------------------------------------------------
// Drag-to-reorder for the playlist-view list (edit mode only). Uses
// Pointer Events so it works with touch (phones) as well as mouse.
// ---------------------------------------------------------
let dragLi = null;
let dragStartY = 0;

function onPlaylistDragStart(e, li) {
  if (!playlistEditMode) return;
  dragLi = li;
  dragStartY = e.clientY;
  li.classList.add('is-dragging');
  try { e.target.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  e.preventDefault();
}

function onPlaylistDragMove(e) {
  if (!dragLi) return;
  const dy = e.clientY - dragStartY;
  dragLi.style.transform = `translateY(${dy}px)`;

  const listEl = document.getElementById('playlist-song-list');
  const dragRect = dragLi.getBoundingClientRect();
  const dragCenter = dragRect.top + dragRect.height / 2;

  for (const sib of Array.from(listEl.children)) {
    if (sib === dragLi) continue;
    const sRect = sib.getBoundingClientRect();
    const sCenter = sRect.top + sRect.height / 2;
    const dragIsBeforeSib = !!(dragLi.compareDocumentPosition(sib) & Node.DOCUMENT_POSITION_FOLLOWING);
    if (dragIsBeforeSib && dragCenter > sCenter) {
      listEl.insertBefore(dragLi, sib.nextSibling);
      dragStartY = e.clientY;
      dragLi.style.transform = 'translateY(0)';
      break;
    }
    if (!dragIsBeforeSib && dragCenter < sCenter) {
      listEl.insertBefore(dragLi, sib);
      dragStartY = e.clientY;
      dragLi.style.transform = 'translateY(0)';
      break;
    }
  }
}

function onPlaylistDragEnd() {
  if (!dragLi) return;
  dragLi.style.transform = '';
  dragLi.classList.remove('is-dragging');
  dragLi = null;
  commitPlaylistOrderFromDom();
  renderPlaylistView(); // refresh the small queue-position numbers to match the new order
}

function commitPlaylistOrderFromDom() {
  const pl = getPlaylist(state.activePlaylistId);
  if (!pl) return;
  const listEl = document.getElementById('playlist-song-list');
  const newOrder = Array.from(listEl.children).map(li => ({
    sourceKey: li.dataset.sourceKey,
    songId: li.dataset.songId,
  }));
  // songId in the dataset is always a string; match loosely so numeric ids still line up.
  pl.songs = newOrder
    .map(ref => pl.songs.find(s => s.sourceKey === ref.sourceKey && String(s.songId) === String(ref.songId)))
    .filter(Boolean);
  persistPlaylists();
}

// ---------------------------------------------------------
// Shared modal shell
// ---------------------------------------------------------
// This one overlay/card pair is reused for every modal in the app (Add
// Songs, rename/create playlist, etc.) — see bindModalShell() below.
function openModal(title, bodyEl) {
  document.getElementById('modal-title').textContent = title;
  const body = document.getElementById('modal-body');
  body.innerHTML = '';
  body.appendChild(bodyEl);
  const overlay = document.getElementById('modal-overlay');
  const card = overlay.querySelector('.modal-card');

  // A previous modal's close animation may still be in flight (e.g. this
  // one was opened immediately after closing another) — cancel it rather
  // than letting its transitionend fire later and hide the modal we're
  // opening right now out from under the person.
  if (overlay._closeCleanup) {
    overlay.removeEventListener('transitionend', overlay._closeCleanup);
    overlay._closeCleanup = null;
  }
  overlay.classList.remove('modal-overlay-closing');
  overlay.hidden = false;

  if (prefersReducedMotion()) {
    overlay.style.opacity = '';
  } else {
    // The card's slide-up-and-fade is a plain CSS animation (see
    // .modal-card in style.css), which only plays once per element
    // unless explicitly restarted — the remove/reflow/re-add trick used
    // elsewhere in this file (e.g. the kebab menus) so it replays on
    // every open, not just the first.
    if (card) {
      card.style.animation = 'none';
      void card.offsetWidth;
      card.style.animation = '';
    }
    // The backdrop fade needs an actual "from" state to animate out of —
    // clearing `hidden` alone would otherwise just snap it straight to
    // its resting opacity:1 the instant it becomes visible. Setting 0 now
    // and clearing it (back to that CSS resting value) on the next frame
    // is what gives the transition something to animate across.
    overlay.style.opacity = '0';
    requestAnimationFrame(() => { overlay.style.opacity = ''; });
  }
  initIcons(overlay);
}

function closeModal() {
  const overlay = document.getElementById('modal-overlay');
  if (overlay.hidden) return;

  if (prefersReducedMotion()) {
    overlay.hidden = true;
    document.getElementById('modal-body').innerHTML = '';
    return;
  }

  // .modal-overlay-closing plays the card's slide-down (see style.css)
  // alongside this opacity fade, instead of the whole modal just
  // disappearing the instant this function runs.
  overlay.classList.add('modal-overlay-closing');
  overlay.style.opacity = '0';
  const cleanup = (e) => {
    if (e && e.propertyName !== 'opacity') return;
    overlay.removeEventListener('transitionend', cleanup);
    overlay._closeCleanup = null;
    overlay.hidden = true;
    overlay.classList.remove('modal-overlay-closing');
    overlay.style.opacity = '';
    document.getElementById('modal-body').innerHTML = '';
  };
  overlay._closeCleanup = cleanup;
  overlay.addEventListener('transitionend', cleanup);
}

function bindModalShell() {
  document.getElementById('modal-close-btn').addEventListener('click', closeModal);
  document.getElementById('modal-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'modal-overlay') closeModal();
  });
  initViewportSync();
}

// ---------------------------------------------------------
// Mobile keyboard / viewport fix
// ---------------------------------------------------------
// On phones (mainly Android Chrome), opening the on-screen keyboard
// resizes the *visual* viewport but not the *layout* viewport. Our
// modal overlay is `position: fixed; inset: 0`, which is sized against
// the layout viewport — so it doesn't know the keyboard ate the bottom
// half of the screen. Depending on the device this makes the sheet
// jump upward, get clipped, or appear to only show part of its content.
//
// The fix: mirror window.visualViewport's height/offset into CSS custom
// properties (--vvh, --vv-top) that the modal uses instead of 100vh/0.
// Browsers without visualViewport support just keep the old 100vh/0
// fallback defined in the CSS.
function initViewportSync() {
  if (!window.visualViewport) return;
  const root = document.documentElement;
  const sync = () => {
    const vv = window.visualViewport;
    root.style.setProperty('--vvh', `${vv.height}px`);
    root.style.setProperty('--vv-top', `${vv.offsetTop}px`);
  };
  sync();
  window.visualViewport.addEventListener('resize', sync);
  window.visualViewport.addEventListener('scroll', sync);
}

// Focuses `input` only after any in-flight modal-open animation has
// settled, then — once the keyboard has actually finished animating in —
// scrolls the input into view within the modal body. Opening the
// keyboard the instant the sheet starts sliding up was the other half
// of the "jumps/only shows part of itself" behavior; giving the sheet
// a moment to land first avoids the two animations fighting each other.
function focusModalInput(input, delay = 260) {
  if (!input) return;
  setTimeout(() => {
    input.focus();
    setTimeout(() => {
      input.scrollIntoView({ block: 'nearest' });
    }, 300);
  }, delay);
}

// ---------------------------------------------------------
// Create / rename playlist modal
// ---------------------------------------------------------
function playlistNameForm(initialValue, onSave) {
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <input type="text" class="modal-text-input" id="playlist-name-input" maxlength="60" autocomplete="off">
    <div class="modal-actions">
      <button type="button" class="btn-secondary" id="playlist-name-cancel"></button>
      <button type="button" class="btn-primary" id="playlist-name-save"></button>
    </div>
  `;
  const input = wrap.querySelector('#playlist-name-input');
  input.placeholder = t('playlistNamePlaceholder');
  input.value = initialValue || '';
  wrap.querySelector('#playlist-name-cancel').textContent = t('cancelBtn');
  wrap.querySelector('#playlist-name-save').textContent = t('saveBtn');

  wrap.querySelector('#playlist-name-cancel').addEventListener('click', closeModal);
  const submit = () => {
    const name = input.value.trim();
    if (!name) { input.focus(); return; }
    onSave(name);
  };
  wrap.querySelector('#playlist-name-save').addEventListener('click', submit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });

  focusModalInput(input);
  return wrap;
}

function promptCreatePlaylist(onCreated) {
  const form = playlistNameForm('', (name) => {
    const id = createPlaylist(name);
    closeModal();
    showToast(t('toastPlaylistCreated'));
    if (state.currentPage === 'playlists') renderPlaylistsList({ animate: true });
    if (onCreated) onCreated(id);
  });
  openModal(t('newPlaylistTitle'), form);
}

function confirmDeletePlaylist(id) {
  const pl = getPlaylist(id);
  if (!pl) return;
  const wrap = document.createElement('div');
  const p = document.createElement('p');
  p.className = 'modal-hint';
  p.style.marginTop = '0';
  p.textContent = t('deletePlaylistConfirm', playlistDisplayName(pl));
  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  actions.innerHTML = `
    <button type="button" class="btn-secondary" id="delete-cancel"></button>
    <button type="button" class="btn-primary" id="delete-confirm" style="background:var(--danger)"></button>
  `;
  wrap.appendChild(p);
  wrap.appendChild(actions);
  actions.querySelector('#delete-cancel').textContent = t('cancelBtn');
  actions.querySelector('#delete-confirm').textContent = t('deleteBtn');

  actions.querySelector('#delete-cancel').addEventListener('click', closeModal);
  actions.querySelector('#delete-confirm').addEventListener('click', () => {
    deletePlaylist(id);
    closeModal();
    showToast(t('toastPlaylistDeleted'));
    if (state.activePlaylistId === id) {
      state.activePlaylistId = null;
      history.back();
    }
    if (state.currentPage === 'playlists') renderPlaylistsList({ animate: true });
  });

  openModal(t('deletePlaylistTitle'), wrap);
}

// ---------------------------------------------------------
// "Add to playlist" modal — opened from inside a song. Lists every
// playlist (Favorites first) as a toggleable checklist, plus a row to
// create a brand-new playlist and add the song to it in one step.
// ---------------------------------------------------------
function openAddToPlaylistModal(sourceKey, songId) {
  const wrap = document.createElement('div');
  const list = document.createElement('ul');
  list.className = 'checklist';
  wrap.appendChild(list);

  const renderItems = () => {
    list.innerHTML = '';
    // Favorites is deliberately excluded here: it already has its own
    // dedicated heart button right on this same song page (see
    // #sv-favorite-btn), so offering a second way to do the same thing
    // from inside this "add to a playlist" picker is redundant — and
    // worse, easy to mix up with an actual playlist since it renders in
    // the same list. This modal is only ever opened from that song-page
    // "+" button (see openAddToPlaylistModal's call sites), so filtering
    // it out here doesn't affect Favorites anywhere else in the app.
    state.playlists.order.filter(id => state.playlists.byId[id] && !state.playlists.byId[id].isFavorites).forEach(id => {
      const pl = state.playlists.byId[id];
      const inIt = isSongInPlaylist(id, sourceKey, songId);
      const li = document.createElement('li');
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'checklist-item' + (pl.isFavorites ? ' is-favorites' : '');
      item.setAttribute('aria-pressed', String(inIt));
      item.innerHTML = `
        <span class="checklist-item-icon"><svg data-icon="${pl.isFavorites ? 'heart-filled' : 'nav-playlist'}" viewBox="0 0 24 24"></svg></span>
        <span style="flex:1">${escapeHtml(playlistDisplayName(pl))}</span>
        <span class="checklist-check"><svg data-icon="check" viewBox="0 0 24 24"></svg></span>
      `;
      item.addEventListener('click', () => {
        toggleSongInPlaylist(id, sourceKey, songId);
        if (id === 'favorites') updateFavoriteButtonUI();
        renderItems();
      });
      li.appendChild(item);
      list.appendChild(li);
    });
    initIcons(list);
  };
  renderItems();

  const newRow = document.createElement('button');
  newRow.type = 'button';
  newRow.className = 'modal-new-playlist-row';
  newRow.innerHTML = `<svg data-icon="plus" viewBox="0 0 24 24"></svg><span>${escapeHtml(t('newPlaylistTitle'))}</span>`;
  newRow.addEventListener('click', () => {
    promptCreatePlaylist((id) => {
      addSongToPlaylist(id, sourceKey, songId);
      openAddToPlaylistModal(sourceKey, songId); // reopen this modal with the new playlist checked
    });
  });
  wrap.appendChild(newRow);

  openModal(t('addToPlaylistTitle'), wrap);
}

// ---------------------------------------------------------
// "Add songs" modal — opened from inside a playlist. Lets the person
// search the official song list and toggle songs in or out of the
// current playlist.
// ---------------------------------------------------------
// Smoothly animates el's height from its current value to targetHeight
// (a FLIP-style height transition), instead of letting a content change
// snap the box to its new size instantly — used by openAddSongsModal's
// search results, where the result count (and so the popup's height)
// changes on every keystroke. fromHeight lets a caller pass an
// already-known starting height instead of re-measuring (useful right
// before the DOM is mutated, since measuring after would read the new
// size instead of the old one).
// Re-triggering this while a previous call is still mid-flight (e.g. two
// keystrokes in quick succession) cleanly takes over from wherever the
// box currently is, the same remove/reflow/re-add approach used for the
// page-slide and heart-pop animations elsewhere in this file.
function animateWrapHeightTo(el, targetHeight, fromHeight) {
  if (prefersReducedMotion()) { el.style.height = ''; return; }
  if (el._heightTransitionCleanup) {
    el.removeEventListener('transitionend', el._heightTransitionCleanup);
    el._heightTransitionCleanup = null;
  }
  const start = fromHeight != null ? fromHeight : el.getBoundingClientRect().height;
  el.style.transition = 'none';
  el.style.height = start + 'px';
  void el.offsetHeight; // force the browser to register the start height before animating away from it
  el.style.transition = 'height .28s cubic-bezier(.2, .8, .2, 1)';
  requestAnimationFrame(() => { el.style.height = targetHeight + 'px'; });
  const cleanup = (e) => {
    if (e && e.propertyName !== 'height') return;
    el.style.height = '';
    el.style.transition = '';
    el.removeEventListener('transitionend', cleanup);
    el._heightTransitionCleanup = null;
  };
  el._heightTransitionCleanup = cleanup;
  el.addEventListener('transitionend', cleanup);
}

function openAddSongsModal(playlistId) {
  const wrap = document.createElement('div');
  const searchWrap = document.createElement('div');
  searchWrap.className = 'search-bar modal-search';
  searchWrap.innerHTML = `
    <svg class="search-icon" data-icon="search" viewBox="0 0 24 24" aria-hidden="true"></svg>
    <input type="search" id="add-songs-search" class="search-field" inputmode="search" autocomplete="off">
  `;
  // listWrap clips and height-animates around the list (see
  // animateWrapHeightTo) — the list itself is left free to just hold rows,
  // same as every other checklist/song list in the app.
  const listWrap = document.createElement('div');
  listWrap.className = 'add-songs-list-wrap';
  const list = document.createElement('ul');
  list.className = 'checklist';
  listWrap.appendChild(list);
  wrap.appendChild(searchWrap);
  wrap.appendChild(listWrap);

  const input = searchWrap.querySelector('#add-songs-search');
  input.placeholder = t('searchPlaceholder');

  const buildChecklistItem = (song, sourceKey, hasNumbers) => {
    const li = document.createElement('li');
    li.dataset.songKey = `${sourceKey}:${song.id}`;
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'checklist-item';
    item.setAttribute('aria-pressed', String(isSongInPlaylist(playlistId, sourceKey, song.id)));
    item.innerHTML = `
      ${hasNumbers ? `<span class="checklist-badge">${song.number}</span>` : ''}
      <span style="flex:1">
        ${escapeHtml(song.title)}
        ${song.artist ? `<div class="checklist-item-sub">${escapeHtml(song.artist)}</div>` : ''}
      </span>
      <span class="checklist-check"><svg data-icon="check" viewBox="0 0 24 24"></svg></span>
    `;
    item.addEventListener('click', () => {
      const nowIn = toggleSongInPlaylist(playlistId, sourceKey, song.id);
      item.setAttribute('aria-pressed', String(nowIn));
      if (state.activeSong && state.activeSong.id === song.id) updateFavoriteButtonUI();
      renderPlaylistView();
      document.getElementById('pv-count').textContent = t('playlistSongCount', getPlaylist(playlistId).songs.length);
    });
    li.appendChild(item);
    return li;
  };

  let firstRender = true;
  const renderItems = () => {
    const q = input.value.trim().toLowerCase();
    const sourceKey = state.activeDbSource;
    const songs = sortSongs(state.sources[sourceKey].songs.filter(s => matchesQuery(s, q)), q, sourceKey);
    const hasNumbers = (DB_SOURCES[sourceKey] || {}).hasNumbers !== false;

    if (firstRender || prefersReducedMotion()) {
      // Plain build for the very first render (opening the modal shouldn't
      // animate its own initial contents in) and for reduced-motion.
      firstRender = false;
      list.innerHTML = '';
      songs.forEach(song => list.appendChild(buildChecklistItem(song, sourceKey, hasNumbers)));
      initIcons(list);
      return;
    }

    // Diffed render, same approach as renderSongList's search results:
    // only rows actually entering or leaving the filtered results fade —
    // a row present both before and after this keystroke is reused as-is
    // instead of being torn down and rebuilt, so it never flickers.
    const existingItems = new Map();
    Array.from(list.children).forEach(li => {
      if (li.dataset.songKey) existingItems.set(li.dataset.songKey, li);
    });

    const startHeight = listWrap.getBoundingClientRect().height;
    const fragment = document.createDocumentFragment();
    const keptKeys = new Set();

    songs.forEach(song => {
      const key = `${sourceKey}:${song.id}`;
      keptKeys.add(key);
      let li = existingItems.get(key);
      if (li) {
        if (li.dataset.state === 'exiting') {
          delete li.dataset.state;
          li.classList.remove('song-row-exit');
          if (li._exitCleanup) {
            li.removeEventListener('animationend', li._exitCleanup);
            li._exitCleanup = null;
          }
        }
        li.firstElementChild.setAttribute('aria-pressed', String(isSongInPlaylist(playlistId, sourceKey, song.id)));
      } else {
        li = buildChecklistItem(song, sourceKey, hasNumbers);
        li.classList.add('song-row-enter');
        li.addEventListener('animationend', function onEnd() {
          li.classList.remove('song-row-enter');
          li.removeEventListener('animationend', onEnd);
        }, { once: true });
      }
      fragment.appendChild(li);
    });

    // Whatever's left fell out of the results — fade it out and shrink the
    // popup the rest of the way down once it's actually gone, instead of
    // cutting it (and the space it took up) instantly.
    existingItems.forEach((li, key) => {
      if (keptKeys.has(key) || li.dataset.state === 'exiting') return;
      li.dataset.state = 'exiting';
      li.classList.add('song-row-exit');
      const cleanup = () => {
        li.removeEventListener('animationend', cleanup);
        li._exitCleanup = null;
        const startH = listWrap.getBoundingClientRect().height;
        li.remove();
        listWrap.style.height = 'auto'; // momentarily un-clip so scrollHeight below reads the true post-removal size, not a still-mid-transition inline height
        animateWrapHeightTo(listWrap, listWrap.scrollHeight, startH);
      };
      li._exitCleanup = cleanup;
      li.addEventListener('animationend', cleanup);
    });

    list.insertBefore(fragment, list.firstChild);
    initIcons(list);

    // FLIP the popup's height from what it was a moment ago to what the
    // list actually occupies now (rows still fading out are still in the
    // DOM, so they still count) — smooths over the "popup changes shape
    // drastically" jump a plain height snap would otherwise cause.
    listWrap.style.height = 'auto'; // see the exit cleanup's comment above on why this precedes the scrollHeight read
    animateWrapHeightTo(listWrap, listWrap.scrollHeight, startHeight);
  };
  input.addEventListener('input', renderItems);
  renderItems();

  openModal(t('addSongsTitle'), wrap);
  focusModalInput(input);
}


async function copyContactEmail(opts = {}) {
  const { silent = false } = opts;
  const email = (window.SONGBOOK_APP_CONFIG && window.SONGBOOK_APP_CONFIG.contactEmail) || '';
  if (!email) return;
  try {
    await navigator.clipboard.writeText(email);
    if (!silent) showToast(t('toastEmailCopied'));
  } catch (err) {
    console.error('Songbook: clipboard copy failed —', err);
    if (!silent) showToast(t('toastEmailCopyFailed'));
  }
}

// Puts the contact button/email-fallback back to its starting state: button
// visible, fallback hidden. Called on language refresh and every time the
// Settings page is (re)opened, so the button reliably comes back after
// switching pages, reloading, or reopening the app — even though within a
// single visit to Settings it disappears the moment it's clicked.
function resetContactUI() {
  const contactBtn = document.getElementById('about-contact-btn');
  const contactFallback = document.getElementById('about-contact-fallback');
  if (!contactBtn || !contactFallback) return;
  const email = (window.SONGBOOK_APP_CONFIG && window.SONGBOOK_APP_CONFIG.contactEmail) || '';
  if (!email) {
    contactBtn.hidden = true;
    contactFallback.hidden = true;
    return;
  }
  contactBtn.href = `mailto:${email}`;
  contactBtn.hidden = false;
  contactFallback.hidden = true;
}

function bindAboutPage() {
  document.getElementById('about-back-btn').addEventListener('click', () => history.back());
}

function bindSettings() {
  document.getElementById('about-nav-row').addEventListener('click', () => {
    showPage('about', { pushHistory: true, resetScroll: true });
  });

  document.getElementById('reload-songs-btn').addEventListener('click', reloadSongLibrary);
  document.getElementById('reload-app-btn').addEventListener('click', reloadApp);
  document.getElementById('export-playlists-btn').addEventListener('click', exportPlaylists);
  document.getElementById('import-playlists-btn').addEventListener('click', () => {
    document.getElementById('import-playlists-file').click();
  });
  document.getElementById('import-playlists-file').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) importPlaylistsFromFile(file);
    e.target.value = '';
  });

  document.getElementById('about-contact-btn').addEventListener('click', () => {
    // Let the mailto: link proceed as normal (opens the person's mail app,
    // where available) — this fires alongside that, not instead of it.
    copyContactEmail({ silent: true });
    document.getElementById('about-contact-btn').hidden = true;
    document.getElementById('about-contact-fallback').hidden = false;
  });

  document.getElementById('about-contact-copy').addEventListener('click', () => {
    copyContactEmail();
  });

  const toggle = document.getElementById('theme-toggle');
  toggle.addEventListener('click', () => {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const next = isDark ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    toggle.setAttribute('aria-checked', String(next === 'dark'));
    localStorage.setItem('sb-theme', next);
  });

  document.querySelectorAll('.accent-swatch').forEach(btn => {
    btn.addEventListener('click', () => {
      if (discoModeActive) stopDiscoMode(); // manual pick wins over the easter egg
      const accent = btn.dataset.accent;
      document.documentElement.setAttribute('data-accent', accent);
      localStorage.setItem('sb-accent', accent);
      document.querySelectorAll('.accent-swatch').forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
    });
  });

  document.querySelectorAll('#chord-style-toggle [data-chord-style]').forEach(btn => {
    btn.addEventListener('click', () => {
      const style = btn.dataset.chordStyle;
      if (style === state.chordStyle) return;
      state.chordStyle = style;
      applyChordStyle();
      localStorage.setItem('sb-chord-style', state.chordStyle);
    });
  });

  const hideChordsToggle = document.getElementById('hide-chords-toggle');
  hideChordsToggle.addEventListener('click', () => {
    state.hideChords = !state.hideChords;
    applyHideChords();
    localStorage.setItem('sb-hide-chords', String(state.hideChords));
  });

  document.querySelectorAll('#lyrics-weight-toggle [data-lyrics-weight]').forEach(btn => {
    btn.addEventListener('click', () => {
      const weight = btn.dataset.lyricsWeight;
      if (weight === state.lyricsWeight) return;
      state.lyricsWeight = weight;
      applyLyricsWeight();
      localStorage.setItem('sb-lyrics-weight', state.lyricsWeight);
    });
  });

  document.querySelectorAll('#lyrics-spacing-toggle [data-lyrics-spacing]').forEach(btn => {
    btn.addEventListener('click', () => {
      const spacing = btn.dataset.lyricsSpacing;
      if (spacing === state.lyricsSpacing) return;
      state.lyricsSpacing = spacing;
      applyLyricsSpacing();
      localStorage.setItem('sb-lyrics-spacing', state.lyricsSpacing);
    });
  });

  const langSelect = document.getElementById('ui-lang-select');
  langSelect.addEventListener('change', () => {
    state.lang = langSelect.value;
    localStorage.setItem('sb-ui-lang', state.lang);
    applyLanguage();
  });

  const dbSelect = document.getElementById('db-select');
  dbSelect.value = state.activeDbSource === 'english' ? 'en' : 'mn';
  dbSelect.addEventListener('change', () => {
    applyDbSource(dbSelect.value === 'en' ? 'english' : 'official');
    localStorage.setItem('sb-db', dbSelect.value);
    showToast(t('toastDbSaved'));
  });
}

// `action`, if provided, is { label, onAction } — shows an inline button
// (e.g. "Undo") inside the toast. Its handler fires once, then the toast
// is dismissed immediately. Duration defaults to 2200ms but callers that
// offer an undo action pass a longer window so it's actually usable.
function showToast(msg, action, duration = 2200) {
  const el = document.getElementById('toast');
  const msgEl = document.getElementById('toast-msg');
  const actionEl = document.getElementById('toast-action');
  msgEl.textContent = msg;

  // Any pending undo from a previous toast must resolve *now* (i.e. the
  // removal it was guarding becomes permanent) before we repurpose the
  // shared toast element for a new message.
  if (showToast._pendingCommit) {
    const commit = showToast._pendingCommit;
    showToast._pendingCommit = null;
    commit();
  }

  if (action) {
    actionEl.textContent = action.label;
    actionEl.hidden = false;
    actionEl.disabled = false;
    actionEl.onclick = () => {
      // Guard against spam-clicks/double-taps firing this twice — once the
      // action has run once it's done, even if the button is still visible
      // for the duration of the hide transition.
      if (actionEl.disabled) return;
      actionEl.disabled = true;
      clearTimeout(showToast._t);
      showToast._pendingCommit = null;
      actionEl.onclick = null;
      el.hidden = true;
      action.onAction();
    };
    showToast._pendingCommit = action.onCommit || null;
  } else {
    actionEl.hidden = true;
    actionEl.onclick = null;
  }

  el.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => {
    el.hidden = true;
    if (showToast._pendingCommit) {
      const commit = showToast._pendingCommit;
      showToast._pendingCommit = null;
      commit();
    }
  }, duration);
}

// ---------------------------------------------------------
// PWA: install prompt (Android/Desktop) + iOS fallback
// ---------------------------------------------------------
let deferredPrompt = null;
let installState = 'unavailable'; // 'unavailable' | 'insecure' | 'ios' | 'promptable' | 'installed'

function isStandaloneNow() {
  return window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;
}

function setupInstallPrompt() {
  if (isStandaloneNow()) {
    installState = 'installed';
    refreshInstallLabels();
    return;
  }

  // Install (and the underlying service worker) only work on HTTPS or localhost —
  // this is a browser security requirement, not something the app can work around.
  if (!window.isSecureContext) {
    installState = 'insecure';
    refreshInstallLabels();
    return;
  }

  // Modern iPadOS (13+) spoofs its user agent as a desktop Mac by default, so a
  // plain UA check misses iPads. We additionally detect that case: a "MacIntel"
  // platform that actually has touch support is an iPad, not a real Mac.
  const ua = window.navigator.userAgent;
  const isSpoofedIPad = window.navigator.platform === 'MacIntel'
    && navigator.maxTouchPoints > 1
    && !window.MSStream;
  const isIOS = /iphone|ipad|ipod/i.test(ua) || isSpoofedIPad;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    installState = 'promptable';
    refreshInstallLabels();
  });

  document.getElementById('install-btn').addEventListener('click', async () => {
    if (deferredPrompt) {
      // The prompt is single-use: capture and clear it before awaiting, so a
      // stray second click can't reuse an already-consumed prompt event.
      const promptEvent = deferredPrompt;
      deferredPrompt = null;
      promptEvent.prompt();
      await promptEvent.userChoice;
      // Intentionally not branching on `outcome` here: accepting the native
      // dialog does not guarantee installation actually completed. The
      // `appinstalled` event (and isStandaloneNow() as a fallback) is the
      // only source of truth for "installed" — see the listener below.
      if (!isStandaloneNow()) {
        installState = 'unavailable';
        refreshInstallLabels();
      }
    } else if (isIOS) {
      showToast(t('toastIosHint'));
    }
  });

  installState = isIOS ? 'ios' : 'unavailable';
  refreshInstallLabels();

  window.addEventListener('appinstalled', () => {
    installState = 'installed';
    refreshInstallLabels();
  });
}

function refreshInstallLabels() {
  const installBtn = document.getElementById('install-btn');
  const installedBadge = document.getElementById('installed-badge');
  const installSub = document.getElementById('install-sub');
  const installTitle = document.getElementById('install-title');

  installTitle.textContent = t('installTitle');
  installBtn.textContent = t('installBtn');

  switch (installState) {
    case 'installed':
      installBtn.hidden = true;
      installedBadge.hidden = false;
      installedBadge.textContent = t('installedBadgeDone');
      installSub.textContent = t('installSubInstalled');
      break;
    case 'insecure':
      installBtn.hidden = true;
      installedBadge.hidden = true;
      installSub.textContent = t('installSubInsecure');
      break;
    case 'ios':
      installBtn.hidden = false;
      installedBadge.hidden = true;
      installSub.textContent = t('installSubIOS');
      break;
    case 'promptable':
      installBtn.hidden = false;
      installedBadge.hidden = true;
      installSub.textContent = t('installSub');
      break;
    default:
      installBtn.hidden = true;
      installedBadge.hidden = true;
      installSub.textContent = t('installSub');
  }
}

// ---------------------------------------------------------
// Service worker registration (offline-first)
// Requires HTTPS or localhost — browsers refuse to register
// service workers on plain http:// or file:// origins.
// ---------------------------------------------------------
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    console.warn('Songbook: service workers are not supported in this browser — offline mode and Install are unavailable.');
    return;
  }
  if (!window.isSecureContext) {
    console.warn('Songbook: not a secure context (HTTPS or localhost) — service worker registration skipped.');
    return;
  }

  // When an updated service worker takes over an already-open tab/PWA
  // window, the JS that's already parsed and running in memory here is
  // still the OLD version — only the *next* navigation gets the new files.
  // A single manual reload isn't reliably enough to trigger that either:
  // per the spec, a reload's navigation request can start (and still get
  // served by the outgoing worker) before the new one has fully taken
  // over. So instead of relying on the person to notice something's stale
  // and refresh, reload automatically — exactly once — the moment control
  // actually changes hands.
  //
  // Two things used to make this fire way more than that "exactly once":
  //
  // 1. `controllerchange` also fires the FIRST time a page ever gets a
  //    service worker (no previous controller to hand off from — this
  //    page was just loaded plain and a worker claimed it a moment
  //    later). There's nothing stale to fix in that case; the page in
  //    memory already matches what just got installed. hadController
  //    below distinguishes a real handoff from that harmless first claim.
  //
  // 2. reloadApp() (the "Reload app" button) unregisters the old worker,
  //    wipes caches, and calls location.reload() itself to force a fully
  //    fresh load — but the fresh load then registers a brand new worker,
  //    which activates and claims this same page, firing controllerchange
  //    all over again and triggering a SECOND, redundant reload right on
  //    top of the one the button already did. skipNextAutoReload (written
  //    to sessionStorage by reloadApp() just before it reloads, so it
  //    survives the reload) tells this run "the reload already happened
  //    on purpose — sit this one cycle out."
  const hadController = !!navigator.serviceWorker.controller;
  let reloadedForUpdate = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloadedForUpdate) return;
    reloadedForUpdate = true;
    if (!hadController) return;
    let skip = false;
    try {
      skip = sessionStorage.getItem('ngw_skip_next_auto_reload') === '1';
      sessionStorage.removeItem('ngw_skip_next_auto_reload');
    } catch (e) {
      // sessionStorage unavailable — fall through and reload as normal;
      // worst case here is the rare double-reload this was added to
      // prevent, not a stuck/stale app.
    }
    if (skip) return;
    markVersionSeen();
    window.location.reload();
  });

  window.addEventListener('load', () => {
    // updateViaCache: 'none' makes the browser always fetch this script
    // (and anything it imports) fresh over the network when checking for
    // updates, rather than potentially reusing an HTTP-cached copy.
    navigator.serviceWorker.register('service-worker.js', { updateViaCache: 'none' }).then((reg) => {
      console.log('Songbook: service worker registered with scope', reg.scope);
    }).catch(err => {
      console.error('Songbook: service worker registration failed —', err);
    });
  });
}

// ---------------------------------------------------------
// Easter egg #1: a tiny mascot that gently bobs on Saturdays (the
// Sabbath), top-right of the Songbook page, with a speech bubble to its
// left. The hand stays still — no waving. Markup lives in index.html
// (#sabbath-mascot); look/animation in css/style.css (.sabbath-mascot).
// ---------------------------------------------------------
function isSabbathToday() {
  // Sabbath runs Friday 7:00 PM through Saturday 8:00 PM, per the device's
  // own local clock/timezone — there's no one global "Friday evening", so
  // this deliberately goes with whatever time it is wherever the person
  // actually is. (Previously just "is it Saturday" all day; narrowed to
  // this window to better match when Sabbath is actually observed.)
  //
  // Testing hook: open the app with ?previewSabbath=1 in the URL (e.g.
  // index.html?previewSabbath=1) to force the mascot on regardless of
  // what day/time it actually is — no need to change the device's clock
  // just to preview it. Harmless to leave in; nobody stumbles into it by
  // accident since it takes a deliberate query param.
  if (new URLSearchParams(location.search).get('previewSabbath') === '1') return true;
  // Developer options → "Force Sabbath mascot on": force this on
  // regardless of the actual day/time. Off by default and does NOT
  // change the date logic below when off — see state.devSabbathForced.
  if (state.devSabbathForced) return true;
  const now = new Date();
  const day = now.getDay(); // Sunday=0 ... Friday=5, Saturday=6
  const minutesOfDay = now.getHours() * 60 + now.getMinutes();
  const FRIDAY_START = 19 * 60;     // 7:00 PM
  const SATURDAY_END = 20 * 60;     // 8:00 PM
  if (day === 5) return minutesOfDay >= FRIDAY_START;
  if (day === 6) return minutesOfDay < SATURDAY_END;
  return false;
}

function updateSabbathMascotText() {
  const bubble = document.getElementById('sabbath-bubble');
  if (bubble) bubble.textContent = t('sabbathGreeting');
}

function initSabbathMascot() {
  const el = document.getElementById('sabbath-mascot');
  if (!el) return;

  const refresh = () => {
    const show = isSabbathToday();
    el.hidden = !show;
    if (show) updateSabbathMascotText();
  };
  refresh();

  // Covers the rare case of the app being left open across midnight —
  // cheap enough to just poll rather than schedule a precise timeout.
  setInterval(refresh, 5 * 60 * 1000);
}

// ---------------------------------------------------------
// Easter egg #1b: light snow falling along the top of the screen during
// Christmas week (Dec 15 – Jan 1 inclusive, device's own local clock).
// Fixed to the viewport, not any one .page, so it's visible everywhere
// and isn't rebuilt on every page transition. Deliberately confined to a
// short strip along the top (see .christmas-snow's fixed height in
// style.css) rather than the whole screen, and kept sparse/low-opacity —
// this is meant to be a quiet seasonal touch sitting above the content,
// not something that competes with it for attention.
// ---------------------------------------------------------
function isChristmasWeek() {
  // Testing hook: ?previewChristmas=1 forces it on regardless of the
  // actual date — same idea as ?previewSabbath=1 above.
  if (new URLSearchParams(location.search).get('previewChristmas') === '1') return true;
  // Developer options → "Force Christmas snow on": same idea as
  // isSabbathToday()'s own override above — see state.devChristmasForced.
  if (state.devChristmasForced) return true;
  const now = new Date();
  const month = now.getMonth(); // 0-indexed: 11 = December, 0 = January
  const date = now.getDate();
  return (month === 11 && date >= 15) || (month === 0 && date === 1);
}

function initChristmasSnow() {
  const el = document.getElementById('christmas-snow');
  if (!el) return;

  // Poll like the Sabbath mascot below — covers the app being left open
  // across the moment Christmas week actually ends (or, for previewing,
  // across a manual system-clock change), so the fade-out is something a
  // person could actually see happen rather than only ever applying
  // silently on next load.
  const CHECK_INTERVAL = 5 * 60 * 1000;
  let fadeOutTimer = null;

  const buildFlakes = () => {
    if (el.childElementCount) return; // already built for this session
    // Built once as plain positioned/animated <span>s (no canvas/JS-driven
    // rAF loop needed for something this simple) — each flake gets a
    // randomized horizontal position, size, fall speed, start delay, drift,
    // and opacity so the field doesn't look mechanically uniform.
    const COUNT = 20;
    const frag = document.createDocumentFragment();
    for (let i = 0; i < COUNT; i++) {
      const flake = document.createElement('span');
      flake.className = 'snowflake';
      const size = 3 + Math.random() * 4; // 3–7px
      const duration = 7 + Math.random() * 6; // 7–13s to fall through the strip
      const delay = Math.random() * duration; // stagger start so they don't fall in sync
      const drift = (Math.random() * 30 - 15).toFixed(1); // -15..15px sideways over the fall
      flake.style.left = `${(Math.random() * 100).toFixed(1)}%`;
      flake.style.width = `${size}px`;
      flake.style.height = `${size}px`;
      flake.style.opacity = (0.3 + Math.random() * 0.45).toFixed(2);
      flake.style.animationDuration = `${duration.toFixed(1)}s`;
      flake.style.animationDelay = `-${delay.toFixed(1)}s`; // negative delay = starts mid-fall, so the strip isn't empty on first render
      flake.style.setProperty('--drift', `${drift}px`);
      frag.appendChild(flake);
    }
    el.appendChild(frag);
  };

  const refresh = () => {
    const show = isChristmasWeek();

    if (show) {
      // Coming back on (e.g. the clock rolled back during a preview, or
      // this is the very first check) — cancel any fade-out in progress
      // and show immediately; only the ending needs to be gentle.
      if (fadeOutTimer) { clearTimeout(fadeOutTimer); fadeOutTimer = null; }
      el.hidden = false;
      el.classList.remove('christmas-snow-hiding');
      buildFlakes();
      return;
    }

    if (el.hidden) return; // already fully hidden, nothing to fade
    if (fadeOutTimer) return; // fade already in progress

    // Start the fade (CSS transition on .christmas-snow-hiding, see
    // style.css) rather than snapping straight to [hidden] — that's the
    // instant cut this replaces. Only actually hide + clear the flakes
    // once the transition has had time to finish.
    el.classList.add('christmas-snow-hiding');
    fadeOutTimer = setTimeout(() => {
      el.hidden = true;
      el.classList.remove('christmas-snow-hiding');
      el.innerHTML = '';
      fadeOutTimer = null;
    }, 2500); // slightly longer than style.css's 2.4s transition
  };

  refresh();
  setInterval(refresh, CHECK_INTERVAL);
  // Exposed so Developer options' Easter eggs switch (see
  // applyDevOptions()) can trigger an immediate re-check instead of
  // waiting up to CHECK_INTERVAL for the toggle's effect to show.
  window.__ngwRefreshChristmasSnow = refresh;
}

// ---------------------------------------------------------
// Easter egg #2: tap "Accent color" in Settings 3 times to send the
// accent hues on a slow, continuous drift through the color wheel; tap
// 3 times again to stop. Only --accent/--accent-strong/--accent-tint
// drift — ink/paper/surface stay put, so the app stays readable.
// ---------------------------------------------------------

// Mirrors the values in css/style.css's html[data-accent="…"] rules —
// kept here (rather than read live off computed styles) so disco mode
// always starts from the *true* base color, even if it's re-triggered
// mid-animation.
const ACCENT_PALETTE = {
  periwinkle: { light: ['#5B7FDE', '#3A56AE', '#E4EAFB'], dark: ['#8CA6EE', '#C7D4F8', '#1E2A44'] },
  sage:       { light: ['#6FA37E', '#3F6350', '#E3EEE6'], dark: ['#8FC29E', '#C8E6D0', '#1C2E22'] },
  lavender:   { light: ['#8C7FCB', '#5B4FA8', '#EDEAFB'], dark: ['#B3A8E8', '#DCD5F5', '#241F3D'] },
  aqua:       { light: ['#44CAFD', '#0E86B8', '#E1F6FE'], dark: ['#6FDBFF', '#BEEFFF', '#113247'] },
  cinnamon:   { light: ['#A9762F', '#8C6526', '#F1E4C8'], dark: ['#D9A94B', '#E7BE6C', '#2C2618'] },
  red:        { light: ['#E8919E', '#B5586B', '#FBEBEE'], dark: ['#F0A3AF', '#FBD6DC', '#3A252A'] },
};

function hexToHsl(hex) {
  const n = hex.replace('#', '');
  const r = parseInt(n.substring(0, 2), 16) / 255;
  const g = parseInt(n.substring(2, 4), 16) / 255;
  const b = parseInt(n.substring(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s;
  const l = (max + min) / 2;
  if (max === min) {
    h = s = 0;
  } else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4;
    }
    h *= 60;
  }
  return { h, s, l };
}

function hslToHex(h, s, l) {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - c / 2;
  let r, g, b;
  if (h < 60)       { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else              { r = c; g = 0; b = x; }
  const toHex = (v) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

let discoModeActive = false;
let discoInterval = null;
let discoHue = 0;
// Tracks *why* disco mode is currently running — set when Developer
// options' "Force party mode on" switch turned it on, so turning that
// switch back off only stops it if it's still the reason disco mode is
// active. If the person separately 3-tapped "Accent color" (the original
// secret trigger) either before or after, that manual session is left
// alone — the dev switch never stops a session it didn't start. See
// applyDevOptions() and bindAccentDiscoEasterEgg() below for both sides
// of this handoff.
let discoForcedByDevToggle = false;

const DISCO_TICK_MS = 300;
const DISCO_PERIOD_SECONDS = 48; // one full hue rotation every 48s — slow, not fast

function startDiscoMode() {
  if (discoModeActive) return;
  discoModeActive = true;

  const currentAccent = document.documentElement.getAttribute('data-accent') || 'aqua';
  const currentTheme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  const base = (ACCENT_PALETTE[currentAccent] || ACCENT_PALETTE.aqua)[currentTheme];
  const baseHsl = base.map(hexToHsl);

  discoHue = 0;
  const root = document.documentElement;
  const step = () => {
    discoHue = (discoHue + (360 * DISCO_TICK_MS / 1000) / DISCO_PERIOD_SECONDS) % 360;
    root.style.setProperty('--accent', hslToHex(baseHsl[0].h + discoHue, baseHsl[0].s, baseHsl[0].l));
    root.style.setProperty('--accent-strong', hslToHex(baseHsl[1].h + discoHue, baseHsl[1].s, baseHsl[1].l));
    root.style.setProperty('--accent-tint', hslToHex(baseHsl[2].h + discoHue, baseHsl[2].s, baseHsl[2].l));
  };
  step();
  discoInterval = setInterval(step, DISCO_TICK_MS);
}

function stopDiscoMode() {
  discoModeActive = false;
  if (discoInterval) clearInterval(discoInterval);
  discoInterval = null;
  // Drop the inline overrides — the transition already registered on
  // :root (see css/style.css) fades this back to the real selected
  // accent smoothly instead of snapping.
  const root = document.documentElement;
  root.style.removeProperty('--accent');
  root.style.removeProperty('--accent-strong');
  root.style.removeProperty('--accent-tint');
}

function bindAccentDiscoEasterEgg() {
  const title = document.getElementById('t-accentTitle');
  if (!title) return;
  let clickTimes = [];
  title.addEventListener('click', () => {
    const now = Date.now();
    clickTimes = clickTimes.filter(ts => now - ts < 800).concat(now);
    if (clickTimes.length >= 3) {
      clickTimes = [];
      // A manual tap always takes ownership of whatever state disco mode
      // ends up in — if the dev switch had forced it on, tapping now
      // stops it (the person's own 3-tap should always be able to turn it
      // off); starting it manually also clears the forced flag so a later
      // dev-switch-off doesn't retroactively kill this session.
      discoForcedByDevToggle = false;
      discoModeActive ? stopDiscoMode() : startDiscoMode();
    }
  });
}
