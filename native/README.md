# Native Applications

The native apps are thin shells around the hosted GitHub Project Pusher service. They use the same GitHub account, project library, sync worker, and snapshot history as the website.

## Desktop

The desktop target is implemented by the Electron shell in `electron/`; `native/desktop/` contains target documentation. It loads the root `.env` automatically and uses `GPP_APP_URL` when set, otherwise `PUBLIC_BASE_URL` or the hosted service URL. Packaged builds default to the hosted service and do not include `.env`.

Build from the project root:

```bash
npm install
GPP_APP_URL=https://YOUR-DOMAIN npm run desktop
npm run build:desktop
```

Build the Windows MSI locally with `npm run build:windows-installer -- --x64 --publish never`. Build a macOS DMG from **Actions → Build macOS App → Run workflow**; that workflow runs on macOS and uploads the DMG as an artifact.

## Android

The checked-in Android scaffold is in `native/android/`; the supported Capacitor build generates the canonical root `android/` project. Capacitor loads the root `.env` and uses `GPP_APP_URL` when set, otherwise `PUBLIC_BASE_URL`.

```bash
npm install
npx cap sync android
cd android
./gradlew assembleDebug
```

The Android APK is debug-signed for sideloading and testing, not for Play Store submission. Desktop packages are not publisher-signed, so Windows and macOS may show standard publisher verification prompts.

For a release AAB/APK, configure signing in Android Studio or Gradle and use the release build task.

Capacitor writes the buildable Android project to the standard root `android/` directory. The hosted HTTPS URL is configured through `GPP_APP_URL`; HTTP is only enabled when that variable explicitly uses `http://`.
