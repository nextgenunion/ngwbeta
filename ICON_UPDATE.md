# NGWorship uploaded icon update

The PWA icon images were replaced with the exact user-provided
`Alt 192x.png` (192x192), `Alt 512x.png` (512x512), and `Althq.png` (960x958).
Icons and PWA manifest declarations were corrected for their actual sizes.
The maskable icon uses the supplied 512x512 design; Android may crop
background details depending on launcher mask shape.
The 180x180 Apple touch icon and 32x32 favicon in v5 are resized
from the supplied 512x512 artwork using Lanczos sampling.
The separate widescreen splash-logo was not changed.
App version/cache was incremented to publish the new icons.
