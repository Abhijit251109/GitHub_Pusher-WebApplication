# Desktop Native Shell

The desktop implementation lives in `../../electron/main.cjs` and is packaged with Electron Builder. This folder documents the native target so platform-specific packaging is kept separate from web/server code.

Targets:

- Windows — NSIS installer
- macOS — DMG
- Linux — AppImage

Build prerequisites:

- Node.js 22+
- The public server URL in `GPP_APP_URL`
- Platform-native signing tools when creating release installers
