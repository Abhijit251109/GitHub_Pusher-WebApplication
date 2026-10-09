# Android application source

The Capacitor Android source lives here. The root `npm run build:android` script prepares or synchronizes the Android platform and builds a debug APK.

For the automated build, open GitHub Actions and run **Build Android APK**. A version tag (`v*`) runs the multi-platform release workflow and uploads the Android APK along with desktop installers to GitHub Releases. The APK is debug-signed for testing and sideloading, not Play Store distribution.
