# Desktop Native Shell

The desktop implementation lives in `../../electron/main.cjs` and is packaged with Electron Builder. This folder documents the native target so platform-specific packaging is kept separate from web/server code.

Targets:

- Windows — NSIS installer
- macOS — DMG
- Linux — AppImage

Build prerequisites:

- Node.js 22.9 or newer in the 22.x line
- The production Render server URL is the default; set `GPP_APP_URL` to override it
- Platform-native signing tools when creating release installers
