// Single source of truth for the app's version number.
// Bump SONGBOOK_VERSION_NUMBER here — and ONLY here — on every release that
// ships changed files. Everything else (the on-screen "Next Gen Worship
// v3.0.3-beta" label, the service worker's cache-busting tag) is derived
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
// Format: plain "major.minor.patch". Pre-release/build tags (e.g. "-beta")
// are handled separately below, not folded into this number.
var SONGBOOK_VERSION_NUMBER = '3.0.3';

// Pre-release label appended to both the on-screen version and the cache
// tag (e.g. 'beta', 'rc', or '' for a stable, non-beta release).
//
// This is a flat stage name only — no trailing build number. Earlier
// versions of this file used a "beta.1", "beta.2", "beta.3", ... counter
// so a re-cut of the same pre-release stage could still bump
// SONGBOOK_CACHE_VERSION (and so still reach devices) without moving
// SONGBOOK_VERSION_NUMBER. That's gone: every release that ships changed
// files — including a same-stage re-cut that used to just bump the
// counter — now bumps SONGBOOK_VERSION_NUMBER's patch digit instead
// (3.0.3-beta -> 3.0.4-beta -> 3.0.5-beta, ...). See "Versioning scheme"
// in README.md for the full policy.
var SONGBOOK_VERSION_PRERELEASE = 'beta';

// Derived — do not edit below this line.

// On-screen label, e.g. "v3.0.3-beta" (shown as "Next Gen Worship
// v3.0.3-beta" via versionSub(v) in every lang/*.js file on the About
// page). Reuses SONGBOOK_VERSION_PRERELEASE below so the label and the
// cache tag can never drift to different pre-release suffixes.
var SONGBOOK_APP_VERSION =
  'v' + SONGBOOK_VERSION_NUMBER +
  (SONGBOOK_VERSION_PRERELEASE ? '-' + SONGBOOK_VERSION_PRERELEASE : '');

// Service-worker cache bucket name, e.g. "songbook-v3.0.3-beta".
// Changing this string is what makes caches.open() start a fresh cache and
// evict the old one — see the comment above CACHE_VERSION's use in
// service-worker.js for why that matters. Now that SONGBOOK_VERSION_PRERELEASE
// carries no build number of its own, this string only changes when
// SONGBOOK_VERSION_NUMBER changes — so bump that on every release, with
// no "it's just a beta re-cut" exception.
var SONGBOOK_CACHE_VERSION =
  'songbook-v' +
  SONGBOOK_VERSION_NUMBER +
  (SONGBOOK_VERSION_PRERELEASE ? '-' + SONGBOOK_VERSION_PRERELEASE : '');
