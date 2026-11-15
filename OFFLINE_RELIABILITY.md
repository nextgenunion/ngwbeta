# NGWorship 3.0.7 — offline reliability update

- All required app shell assets, local web fonts, one audio sample, and complete song-library snapshots are part of service-worker installation.
- An incomplete installation cannot take over an older working release; no precaching is left dangling after activation.
- App reload and automatic version checks do not unregister working service workers or erase cached song data.
- Song content from bundled snapshots is available after a successful install even without a connection.
- New announcements are optional live content and never block the offline app.
- Per-song online refresh is kept where already supported; old snapshots remain a usable offline fallback.
- Cache cleanup only targets this major version's own new shell caches; other app versions must be hosted on separate origins for complete isolation of storage and PWA identity.

## Verify on real devices
1. Install over HTTPS while online. Confirm the service worker reaches `activated`, then close all tabs.
2. Enable airplane mode and launch from the installed PWA icon. Open several songs including the last song, and check icons and typography.
3. Update from the previously deployed version while online; test a network interruption mid-install (the old version should remain usable).
4. Reload and switch screens while offline; verify playlists and (where supported) User Songs.
5. Return online; check manual song refresh and live announcements on v2–v4.
6. Simulate a deleted app cache: verify that the worker returns a controlled offline screen rather than a rejected navigation, then repairs itself when online.

Browser data clearing or complete OS eviction can still remove all offline files; no browser-only app can guarantee survival after that.
