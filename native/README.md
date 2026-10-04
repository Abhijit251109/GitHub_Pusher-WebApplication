# Native Applications

The native apps are thin shells around the hosted GitHub Project Pusher service. They use the same GitHub account, project library, sync worker, and snapshot history as the website.

## Desktop

The desktop target is implemented by the Electron shell in `electron/`; `native/desktop/` contains target documentation.

Build from the project root:

```bash
npm install
GPP_APP_URL=https://YOUR-DOMAIN npm run desktop
npm run build:desktop
```

Build the installer on Windows, macOS, or Linux (or use a CI matrix for all three).

## Android

The checked-in Android scaffold is in `native/android/`; the supported Capacitor build generates the canonical root `android/` project.

```bash
npm install
npx cap sync android
cd android
./gradlew assembleDebug
```

For a release AAB/APK, configure signing in Android Studio or Gradle and use the release build task.

Capacitor writes the buildable Android project to the standard root `android/` directory. The hosted HTTPS URL defaults to the production Render service. Set `GPP_APP_URL` to override it for local or custom deployments; HTTP is only enabled when that variable explicitly uses `http://`.
