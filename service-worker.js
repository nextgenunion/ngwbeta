// Songbook service worker — offline-first app shell + data cache.
// Copyright (c) 2026 Next Gen Union. All rights reserved.
// Proprietary and confidential. No unauthorized copying, modification,
// or redistribution, in whole or in part, without prior written
// permission from Next Gen Union. See LICENSE for full terms.
//
// Service workers can't use <script> tags, so importScripts() is the
// standard way to pull in shared code — this runs version.js in this
// worker's global scope, which sets self.SONGBOOK_CACHE_VERSION etc.
// The actual version number lives in ONE place, version.js — bump it
// there, not here.
importScripts('./version.js');
const CACHE_VERSION = self.SONGBOOK_CACHE_VERSION;

// Separate, fixed-name cache just for the offline fallback page. Deliberately
// NOT part of CACHE_VERSION (the main versioned cache) for two reasons:
//
// 1. activate() below deletes every cache bucket except the current
//    CACHE_VERSION, to drop stale versions on update. If offline.html lived
//    in that same bucket, a wipe of the main cache (a full "clear site
//    data", or the person clearing their browser cache/storage by hand)
//    would take offline.html down with it — so the one time it's actually
//    needed most (this device has nothing left cached), it wouldn't be
//    there either, and the fetch handler's fallback would silently resolve
//    to nothing instead of the offline screen.
// 2. Because this bucket's name never changes between versions, it isn't
//    touched by the version-rotation cleanup at all — it survives updates
//    the same way it survives a manual cache clear, without needing to be
//    re-downloaded on every single version bump.
const OFFLINE_CACHE = 'songbook-offline-fallback';

// Same idea as OFFLINE_CACHE above, and for the same "must survive a
// version bump" reason — but for song data instead of the offline page.
//
// Bug this fixes: song files (hundreds of small JSON files under data/)
// used to live in the versioned CACHE_VERSION bucket alongside the app
// shell. Every version bump's activate() wipes every bucket except the
// new CACHE_VERSION — so a routine app update was ALSO silently deleting
// every song file that had already been downloaded, at the exact moment
// registerServiceWorker()'s controllerchange handler auto-reloads the
// page to pick up that update. A person on a slow/metered connection who
// happened to have the app open when an update landed would get the new
// app shell instantly (tiny, and already downloaded during the update
// check) but then hit a fully-empty song cache and have to re-download
// every song file from scratch over that slow connection — looking
// exactly like "the app reloaded and now the songs won't load" even
// though their device had a perfectly good copy moments earlier.
//
// Keeping song data in its own never-versioned bucket means a version
// bump only replaces the (small, fast) app-shell files; already-cached
// songs simply carry over untouched across every update, version after
// version, the same way OFFLINE_CACHE always has. Song content updates
// still reach the device — see the fetch handler's stale-while-revalidate
// below, plus the explicit "Refresh song database" button — just not by
// blowing away the whole library first.
const SONGDATA_CACHE = 'songbook-data';

// Whether a request is for song data (manifest.json or a song's own JSON
// file under any data/<folder>/ — see SONG_DB_FOLDERS below) rather than
// an app-shell file. Used by the fetch handler and the background
// precache below to route song requests to SONGDATA_CACHE instead of the
// versioned CACHE_VERSION bucket — see the comment on SONGDATA_CACHE
// above for why that split exists.
function isSongDataRequest(url) {
  return url.pathname.includes('/data/');
}

// The core shell: without any one of these the app can't run at all, so
// these are cached atomically — if even one fails, the whole install fails
// and the OLD service worker (and its cache) stays in control until a
// retry succeeds. This is intentional for the core shell.
const CORE_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './version.js',
  './css/style.css',
  './js/app.js',
  './config.js',
  './lang/config.js',
  './lang/eng.js',
  './lang/mn.js',
  './lang/mn2.js', // always loaded now — see index.html's script tag comment
  './lang/kr.js',
];

// Icons and other assets: cached best-effort, one at a time. A single
// missing or renamed file here (e.g. after swapping in a custom icon)
// must NEVER be able to fail the whole install — that would leave every
// visitor stuck on an old cached version indefinitely, with no way to
// pick up a fix short of manually clearing site data.
const BEST_EFFORT_ASSETS = [
  './icons/app-icon.png',
  './icons/app-icon-maskable.png',
  './icons/splash-logo.png',

  './icons/svg/brand-music-note.svg',
  './icons/svg/search.svg',
  './icons/svg/back-arrow.svg',
  './icons/svg/mail-contact.svg',
  './icons/svg/copy.svg',
  './icons/svg/nav-songs-bookmark.svg',
  './icons/svg/nav-settings-gear.svg',
  './icons/svg/nav-playlist.svg',
  './icons/svg/heart-outline.svg',
  './icons/svg/heart-filled.svg',
  './icons/svg/menu-kebab.svg',
  './icons/svg/plus.svg',
  './icons/svg/trash.svg',
  './icons/svg/pencil.svg',
  './icons/svg/close.svg',
  './icons/svg/check.svg',
  './icons/svg/download.svg',
  './icons/svg/upload.svg',
  './icons/svg/social-facebook.svg',
  './icons/svg/social-youtube.svg',
  './icons/svg/social-instagram.svg',
  './icons/svg/social-website.svg',
];

function cacheBestEffort(cache, urls) {
  return Promise.allSettled(
    urls.map((url) =>
      cache.add(url).catch((err) => {
        console.warn('Songbook SW: could not precache', url, '—', err);
      })
    )
  );
}

self.addEventListener('install', (event) => {
  // Deliberately minimal and fast: only the small core shell is required
  // for the install to succeed. A slow or interrupted install is exactly
  // the kind of thing aggressive mobile battery/task managers cut short —
  // keeping this fast is what makes the install itself reliable.
  //
  // offline.html goes into its own OFFLINE_CACHE bucket (see the comment
  // by its declaration above), cached alongside the core shell but kept
  // as a fully separate step — if it fails for some reason, the core
  // shell install (the one thing that's required to succeed) isn't put
  // at risk by it.
  event.waitUntil(
    Promise.all([
      caches.open(CACHE_VERSION).then((cache) => cache.addAll(CORE_SHELL)),
      caches.open(OFFLINE_CACHE).then((cache) => cache.addAll(['./offline.html'])),
    ]).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      // Drop every cache bucket except the current version's and the two
      // stable, never-versioned buckets — anything else is a stale
      // versioned cache left over from before an update. OFFLINE_CACHE
      // and SONGDATA_CACHE are deliberately exempt here even though their
      // names never change: this cleanup is about dropping old
      // *versions* of the app shell, not about deciding what belongs in
      // the current one, and neither of them is part of CACHE_VERSION at
      // all (see the comments on each above).
      Promise.all(keys.filter((k) => k !== CACHE_VERSION && k !== OFFLINE_CACHE && k !== SONGDATA_CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );

  // Bulk precaching of icons + all song files happens here, in the
  // background, deliberately OUTSIDE of event.waitUntil — so activation
  // itself completes fast and unconditionally, and this can never delay or
  // break it. If it gets interrupted partway (tab closed, device sleeps),
  // it simply doesn't finish this time; nothing is left broken, and songs
  // still get cached individually as they're viewed via the fetch handler
  // below, plus the IndexedDB backup in app.js covers the rest.
  precacheEverythingElseInBackground();
});

// One entry per song database (see DB_SOURCES in app.js — kept in sync
// with it manually, since a service worker can't just import app.js's
// module-scoped const). Adding a new database here is the same one-line
// addition as adding it to DB_SOURCES.
const SONG_DB_FOLDERS = ['mongolian', 'english'];

function precacheEverythingElseInBackground() {
  caches.open(CACHE_VERSION).then((cache) => {
    cacheBestEffort(cache, BEST_EFFORT_ASSETS);
  });
  // Song files go in SONGDATA_CACHE, not CACHE_VERSION — see the comment
  // on SONGDATA_CACHE up top for why that split matters (in short: so a
  // later app-version bump doesn't wipe every already-downloaded song).
  caches.open(SONGDATA_CACHE).then((cache) => {
    SONG_DB_FOLDERS.forEach((folder) => {
      fetch(`./data/${folder}/manifest.json`)
        .then((res) => res.json())
        .then((songFiles) => {
          const songUrls = songFiles.map((f) => `./data/${folder}/${f}`);
          return cacheBestEffort(cache, [`./data/${folder}/manifest.json`, ...songUrls]);
        })
        .catch((err) => {
          console.warn(`Songbook SW: background song precache skipped for "${folder}" —`, err);
        });
    });
  });
}

// Strategy: cache-first for everything, EXCEPT requests explicitly marked
// as a manual refresh (X-Force-Refresh header) — those go network-first,
// updating the cache on success, and fall back to whatever's already
// cached if the network fails. This means a manual refresh attempted while
// offline just silently keeps the existing offline copy instead of ever
// deleting it — the cache is only ever replaced by data that's confirmed
// to have loaded successfully, never cleared ahead of time "just in case".
//
// Every read/write below goes through targetCacheFor() rather than always
// using CACHE_VERSION — song-data requests (see isSongDataRequest above)
// have to land in SONGDATA_CACHE, or a song fetched here (e.g. during
// app.js's normal per-song loading, not just the background precache)
// would end up back in the versioned bucket and get wiped by the very
// next version bump anyway, undoing the fix SONGDATA_CACHE exists for.
function targetCacheFor(request) {
  return isSongDataRequest(new URL(request.url)) ? SONGDATA_CACHE : CACHE_VERSION;
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  if (event.request.headers.get('X-Force-Refresh') === '1') {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response && response.ok) {
            const clone = response.clone();
            caches.open(targetCacheFor(event.request)).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networkFetch = fetch(event.request)
        .then((response) => {
          if (response && response.ok) {
            const clone = response.clone();
            caches.open(targetCacheFor(event.request)).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => {
          if (cached) return cached;
          // Nothing cached AND the network failed. For a page navigation,
          // this is the case that used to fall through to the browser's
          // own generic "no internet" page — jarring in an installed app.
          // Show our own offline screen instead (cached separately in its
          // own bucket — see OFFLINE_CACHE above — specifically so it
          // survives even if this main cache is empty or was just wiped).
          // Any other kind of request (a script, an image, song data)
          // just fails as before; the app's own code already handles
          // those (e.g. loadSongDataFor()'s IndexedDB fallback).
          const isNavigation = event.request.mode === 'navigate'
            || event.request.destination === 'document';
          // Read from OFFLINE_CACHE specifically (not a plain caches.match,
          // which would search every bucket) — this is the one thing that
          // has to keep working even if CACHE_VERSION's bucket is gone
          // entirely, so it shouldn't depend on default cross-cache lookup
          // behavior to find it.
          return isNavigation ? caches.open(OFFLINE_CACHE).then((cache) => cache.match('./offline.html')) : undefined;
        });

      return cached || networkFetch;
    })
  );
});
