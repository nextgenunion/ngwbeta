# Live announcements — NGWorship

The optional `announcements.json` file lives beside `index.html` and is **not**
part of the offline installation cache. The app loads it on opening, checks
for updates every five minutes while visible, and checks when users return
if the last check is at least five minutes old. A network reconnect triggers
a fresh check. No app rebuild/reload is required to publish new content.

```json
[
  {
    "id": "release-note-2026-11",
    "mode": "once",
    "title": "What's new",
    "text": "The offline songbook is ready for your next worship service."
  },
  {
    "id": "important-notice-2026-12",
    "mode": "every-open",
    "display": "banner",
    "title": "Important notice",
    "text": "Offline song reading remains available during maintenance.",
    "startsAt": "2026-12-01T00:00:00+08:00",
    "endsAt": "2026-12-02T00:00:00+08:00"
  }
]
```

The shipped file is `[]` (no announcements). Change the JSON on your host
to publish a notice; give every **new** notice a unique `id`.

- Required: `id` (unique nonempty string), `mode` (`once` or `every-open`),
  `text` (nonempty plain text).
- Optional: `title`, `display` (`dialog` default, `banner` for rare important
  notices), `startsAt` and `endsAt` (ISO timestamps with timezone).
- `once` is remembered in localStorage when displayed on that device.
- `every-open` shows once per fresh page launch/reload, **not every five minutes**.
- Both styles show a new ID without a reload. Standard dialogs wait until
  the splash is gone, the Songbook list is open and no other modal is open;
  banners appear only when the main navigation is visible.
- `[]`, 404, invalid JSON, and an offline request all mean "no live notices".
  Timed-out requests are cancelled after five seconds; no failure blocks
  normal songs, playlists or offline startup.
- The service worker treats exactly this JSON URL as **network-only** and
  returns `[]` when offline. Never add `announcements.json` to pre-cache.
- Browsers can throttle timers in the background. Returning to a visible
  app triggers a check when due; this is not an instant push system.
- For CDN hosting, configure the JSON to revalidate promptly if possible.

This backport intentionally does **not** change existing song loading,
playlist storage, import logic or the appearance of ordinary song pages.
