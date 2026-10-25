# Application downloads

Put distributable application builds in the platform folders below. The website automatically discovers supported files and shows download buttons.

- `windows/`: `.msi`, `.exe`
- `android/`: `.apk`, `.aab`

Do not put secrets or unrelated files here. The server exposes only the supported installer/package extensions through the public download endpoint.

## Supported desktop/mobile downloads

- `application/windows/` — `.msi`, `.exe`
- `application/macos/` — `.dmg`, `.pkg`, `.zip`
- `application/android/` — `.apk`, `.aab`
- `application/linux/` — `.AppImage`, `.deb`, `.rpm`, `.zip`

The website scans these folders automatically and shows download buttons for builds that are present.
