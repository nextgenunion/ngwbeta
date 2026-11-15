// NGWorship v3: complete offline release cache.
// The previous worker remains in control if any required asset fails to cache.
importScripts('./version.js');
const CACHE_VERSION = 'ngw-v3-shell-' + self.SONGBOOK_CACHE_VERSION;
const REQUIRED_OFFLINE = [
  "./",
  "./index.html",
  "./offline.html",
  "./manifest.json",
  "./css/style.css",
  "./css/offline-fonts.css",
  "./js/app.js",
  "./config.js",
  "./lang/config.js",
  "./lang/eng.js",
  "./lang/kr.js",
  "./lang/mn.js",
  "./lang/mn2.js",
  "./version.js",
  "./css/announcements.css",
  "./js/announcements.js",
  "./icons/app-icon-maskable.png",
  "./icons/app-icon.png",
  "./icons/app-icon-192.png",
  "./icons/app-icon-512.png",
  "./icons/splash-logo.png",
  "./icons/svg/back-arrow.svg",
  "./icons/svg/brand-music-note.svg",
  "./icons/svg/check.svg",
  "./icons/svg/close.svg",
  "./icons/svg/copy.svg",
  "./icons/svg/download.svg",
  "./icons/svg/heart-filled.svg",
  "./icons/svg/heart-outline.svg",
  "./icons/svg/mail-contact.svg",
  "./icons/svg/mascot-sabbath.svg",
  "./icons/svg/menu-kebab.svg",
  "./icons/svg/music.svg",
  "./icons/svg/nav-playlist.svg",
  "./icons/svg/nav-settings-gear.svg",
  "./icons/svg/nav-songs-bookmark.svg",
  "./icons/svg/nav-user-songs.svg",
  "./icons/svg/pencil.svg",
  "./icons/svg/plus.svg",
  "./icons/svg/search.svg",
  "./icons/svg/social-facebook.svg",
  "./icons/svg/social-instagram.svg",
  "./icons/svg/social-website.svg",
  "./icons/svg/social-youtube.svg",
  "./icons/svg/trash.svg",
  "./icons/svg/upload.svg",
  "./fonts/fraunces_latin-wght-normal.woff2",
  "./fonts/ibm-plex-mono_latin-500-normal.woff2",
  "./fonts/ibm-plex-mono_latin-600-normal.woff2",
  "./fonts/inter_cyrillic-wght-normal.woff2",
  "./fonts/inter_latin-ext-wght-normal.woff2",
  "./fonts/inter_latin-wght-normal.woff2",
  "./fonts/noto-sans_cyrillic-ext-wght-italic.woff2",
  "./fonts/noto-sans_cyrillic-ext-wght-normal.woff2",
  "./fonts/noto-sans_cyrillic-wght-italic.woff2",
  "./fonts/noto-sans_cyrillic-wght-normal.woff2",
  "./fonts/noto-sans_latin-ext-wght-italic.woff2",
  "./fonts/noto-sans_latin-ext-wght-normal.woff2",
  "./fonts/noto-sans_latin-wght-italic.woff2",
  "./fonts/noto-sans_latin-wght-normal.woff2",
  "./audio/001-esus-ta-mongold-aldarshaach.mp3",
  "./data/mongolian/manifest.json",
  "./data/mongolian/database.json",
  "./data/english/manifest.json",
  "./data/english/database.json"
];
const SONG_UPDATES_CACHE = 'ngw-v3-song-updates';
const fresh = path => new Request(new URL(path, self.location.href), { cache: 'reload' });

async function precacheAll() {
  const cache = await caches.open(CACHE_VERSION);
  await cache.addAll(REQUIRED_OFFLINE.map(fresh));
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    await precacheAll();
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    // Only clean caches belonging to THIS release family, not other apps.
    for (const key of await caches.keys()) {
      if ((key.startsWith('ngw-v3-shell-') && key !== CACHE_VERSION) || key.startsWith('songbook-v3.')) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

const NO_SHELL_HTML = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Offline</title>'
  + '<main style="font:16px/1.5 system-ui;padding:2rem;max-width:35rem;margin:auto"><h2>Офлайн · Offline</h2>'
  + '<p>Хадгалсан апп олдсонгүй. Интернэттэй үед дахин нээнэ үү.</p>'
  + '<p>App files are unavailable. Reopen while connected to the internet.</p></main>';
let repairing = null;
function repairCache() {
  if (!repairing) repairing = precacheAll().catch(() => {}).finally(() => { repairing = null; });
  return repairing;
}

async function navigationResponse(event) {
  try {
    const cache = await caches.open(CACHE_VERSION);
    const app = await cache.match('./index.html') || await cache.match('./');
    if (app) return app;
    try {
      const live = await fetch(fresh('./index.html'));
      if (live.ok) { event.waitUntil(repairCache()); return live; }
    } catch (_) {}
    const offline = await cache.match('./offline.html');
    if (offline) return offline;
  } catch (_) {}
  return new Response(NO_SHELL_HTML, {status:503, headers:{'Content-Type':'text/html; charset=utf-8'}});
}

async function readCached(request) {
  try {
    const updates = await caches.open(SONG_UPDATES_CACHE);
    const url = new URL(request.url);
    if (url.pathname.endsWith('/manifest.json')) {
      const recent = await updates.match(request, {ignoreSearch:true});
      if (recent) return recent;
    }
    const shell = await caches.open(CACHE_VERSION);
    const hit = await shell.match(request, {ignoreSearch:true});
    if (hit) return hit;
    const recent = await updates.match(request, {ignoreSearch:true});
    if (recent) return recent;
    // Preserve song JSON downloaded by the previous v2/v3 service worker.
    const legacy = await caches.open('songbook-data');
    return await legacy.match(request, {ignoreSearch:true});
  } catch (_) { return undefined; }
}

async function dataResponse(event) {
  const request = event.request;
  const url = new URL(request.url);
  const isSnapshot = url.pathname.endsWith('/database.json');
  const isManifest = url.pathname.endsWith('/manifest.json');
  const force = request.headers.get('X-Force-Refresh') === '1';
  // Immutable release snapshots are the reliable offline bootstrap.
  if (isSnapshot) {
    const cached = await readCached(request);
    if (cached && !force) return cached;
  }
  // Existing individual song caches should open instantly. Network
  // validation continues under waitUntil so it can survive page closing.
  if (!force && !isSnapshot) {
    const cached = await readCached(request);
    if (cached) {
      event.waitUntil(fetch(request).then(async response => {
        if (!response.ok) return;
        try {
          const updates = await caches.open(SONG_UPDATES_CACHE);
          await updates.put(request, response.clone());
        } catch (_) {}
      }).catch(() => {}));
      return cached;
    }
  }
  // Individual song JSON files remain updatable online, and a failed
  // refresh cannot discard any previously downloaded copy.
  try {
    const response = await fetch(request);
    if (response.ok) {
      try {
        const cache = await caches.open(SONG_UPDATES_CACHE);
        await cache.put(request, response.clone());
      } catch (_) { /* Saving is optional; serving the response is not. */ }
      return response;
    }
    const cached = await readCached(request);
    return cached || response;
  } catch (_) {
    const cached = await readCached(request);
    if (cached) return cached;
    return Response.error();
  }
}

async function cachedResponse(request, cached) {
  const range = request.headers.get('Range');
  if (!range) return cached;
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match || (!match[1] && !match[2])) return cached;
  const bytes = await cached.arrayBuffer(), size = bytes.byteLength;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] ? (match[2] ? Math.min(size - 1, Number(match[2])) : size - 1) : size - 1;
  if (start >= size || end < start || !size) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }
  const headers = new Headers(cached.headers);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
  headers.set('Content-Length', String(end - start + 1));
  return new Response(bytes.slice(start, end + 1), { status: 206, headers });
}

async function assetResponse(request) {
  const cached = await readCached(request);
  if (cached) return cachedResponse(request, cached);
  try {
    const live = await fetch(request);
    if (live.ok) {
      try { const cache = await caches.open(CACHE_VERSION); await cache.put(request, live.clone()); } catch (_) {}
    }
    return live;
  } catch (_) { return Response.error(); }
}

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  // Optional announcement content is deliberately never part of the offline cache.
  if (url.pathname === new URL('./announcements.json', self.location.href).pathname) {
    event.respondWith(fetch(event.request).catch(() => new Response('[]', {headers:{'Content-Type':'application/json'}})));
    return;
  }
  if (event.request.mode === 'navigate' || event.request.destination === 'document') {
    event.respondWith(navigationResponse(event));
  } else if (url.pathname.includes('/data/')) {
    event.respondWith(dataResponse(event));
  } else {
    event.respondWith(assetResponse(event.request));
  }
});
