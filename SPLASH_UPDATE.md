# NGWorship splash logo update

This release uses the **NGU — Next Generation Union** image supplied for the startup splash, consistently across NGWorship v1–v5.

- `icons/splash-logo.png` is a cropped, optimized transparent PNG of the supplied `downscaled_960x540.webp` logo, with a black CSS splash background. The visible artwork is retained, without AI recreation.
- The old splash asset was about 236 KB; this version is about 31 KB. The main benefit is less asset data to load and cache. Startup timing still depends on application loading and splash animations.
- The logo uses responsive sizing, avoiding the previous 120px maximum that made the horizontal wordmark difficult to read.
- App/launcher icons and About-page graphics remain unchanged.
- The patch version and PWA cache version were advanced so the new splash replaces the installed cached image. The existing offline-first loading and cache architecture is unchanged.

**Installation note:** Native Android/iOS PWA launch screens may initially use the manifest app icon and system splash before this HTML splash displays; those platform-managed screens are distinct from this update.
