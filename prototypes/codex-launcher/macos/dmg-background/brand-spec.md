# GatherThread DMG asset selection

The canonical brand rules remain in [`logo/README.md`](../../../../logo/README.md).
This installer changes layout only, never logo paths, shapes, color or wordmark.

- Background wordmark: `logo/png/lockup-color-transparent-light-1200px.png`,
  SHA-256 `25d384f65a331c578703232b11e7c907a4ae5de3f50cac3666b2131f09707073`.
- App/Finder icon: the existing `prototypes/codex-launcher/assets/GatherThread.icns`,
  SHA-256 `6d13850affd2e0520b58ebd7f43c52078a066ca451c667e7e021f2d584999552`.
- No product mockup or alternative logo is needed: the actual mounted Finder
  icons are the installation interface. Validation captures that real window.
- Warm approved background `#FBFAF7`, dark approved ink `#08111F`; neutral gray
  instructions and arrow. Native macOS system UI type is used for bilingual
  installation text; the approved outlined wordmark is not re-typeset.
- The native renderer produces a 720 × 560 point, 2× PNG. No animated,
  interactive or network-loaded content enters the DMG background.
