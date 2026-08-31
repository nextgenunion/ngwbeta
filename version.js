// Single source of truth for the app's version number.
// Bump SONGBOOK_VERSION_NUMBER here — and ONLY here — on every release that
// ships changed files. Everything else (the on-screen "Next Gen Worship
// v2.0.7-beta" label, the service worker's cache-busting tag) is derived
// from this one value, so there is no second or third place that can drift
// out of sync with it.
//
// Loaded two ways:
//   - As a normal <script> in index.html, same as config.js, which sets
//     these as plain globals on `window`.
//   - Via importScripts('../version.js') from service-worker.js, since
//     service workers can't use <script> tags. importScripts() runs this
//     same file in the worker's global scope, so `self.SONGBOOK_...` (same
//     object as `window.SONGBOOK_...` in a page) ends up set there too.
//
// Format: plain "major.minor.patch". Pre-release/build tags (e.g. "-beta.1")
// are handled separately below, not folded into this number.
var SONGBOOK_VERSION_NUMBER = '2.1.2';

// Pre-release label appended to the cache tag only (not shown to users).
// Set to '' for a stable, non-beta release.
var SONGBOOK_VERSION_PRERELEASE = 'beta.1';

// Derived — do not edit below this line.

// On-screen label, e.g. "v2.0.22-beta" (shown as "Next Gen Worship
// v2.0.22-beta" via versionSub(v) in every lang/*.js file on the About
// page). Reuses SONGBOOK_VERSION_PRERELEASE below so the label and the
// cache tag can never drift to different pre-release suffixes.
var SONGBOOK_APP_VERSION =
  'v' + SONGBOOK_VERSION_NUMBER +
  (SONGBOOK_VERSION_PRERELEASE ? '-' + SONGBOOK_VERSION_PRERELEASE.replace(/\.\d+$/, '') : '');

// Service-worker cache bucket name, e.g. "songbook-v2.0.7-beta.1".
// Changing this string is what makes caches.open() start a fresh cache and
// evict the old one — see the comment above CACHE_VERSION's use in
// service-worker.js for why that matters.
var SONGBOOK_CACHE_VERSION =
  'songbook-v' +
  SONGBOOK_VERSION_NUMBER +
  (SONGBOOK_VERSION_PRERELEASE ? '-' + SONGBOOK_VERSION_PRERELEASE : '');
