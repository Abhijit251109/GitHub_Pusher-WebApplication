# Android app

The Android wrapper opens the live GitHub Project Pusher service and uses the same account, project library, and GitHub sign-in flow as the website. It needs an internet connection.

## Build an APK

GitHub Actions can build the Android APK on demand:

1. Open the repository's Actions tab.
2. Select Build Android APK and choose Run workflow.
3. Download the github_pusher-android-apk artifact from the completed run.

Pushing a version tag such as v3.0.0 runs the all-platform release workflow. It publishes the Windows MSI, Intel and Apple Silicon macOS DMGs, and Android APK to the GitHub Releases page. The website's Downloads area reads the latest published release.

The APK is a debug-signed sideloading build for installation and testing. It is not a Play Store release. Play Store distribution requires a protected release signing key.

For a local build, install Node.js 22, JDK 21, and Android SDK API 36 with build tools 36.0.0, then run:

    npm ci
    npm run build:android

The generated APK is at android/app/build/outputs/apk/debug/app-debug.apk.
