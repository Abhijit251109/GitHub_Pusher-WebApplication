# Cross-platform GitHub OAuth fix

## Scope

This patch keeps the ordinary browser flow unchanged and adds a native callback flow for Android and Electron desktop builds (Windows, macOS, Linux). It contains source changes only; it does not build an APK, MSI, DMG, or AppImage.

## Flow by platform

- **Web / GitHub Pages:** The existing callback continues to validate OAuth state, PKCE, and the browser-binding cookie.
- **Android:** The generated Capacitor Android project registers `com.githubprojectpusher.app://auth/callback` and forwards the one-time login code back into the hosted login page.
- **Windows:** Electron registers the custom URI protocol when the app starts, opens the desktop OAuth-start URL in the system browser, receives the callback, and resumes at `login.html` with the one-time code.
- **macOS:** The DMG declares the custom URI scheme in the app bundle and the early `open-url` listener receives callbacks.
- **Linux:** The AppImage desktop entry declares `x-scheme-handler/com.githubprojectpusher.app`; the desktop environment must integrate the AppImage/desktop entry for URI routing to work.

For native clients, the backend still creates a server-side OAuth attempt with a random `state` and PKCE verifier. The callback only skips the browser-cookie comparison when the stored return target is the fixed app URI with a valid nonce; normal web attempts still require the cookie. The native callback code is one-time and short-lived.

## Render and GitHub OAuth settings

No new Render environment variables are required. Keep the GitHub OAuth App's authorization callback set to the backend HTTPS route, for example:

`https://github-pusher-g3ac.onrender.com/auth/github/callback`

Do not configure the custom `com.githubprojectpusher.app://` URI as the GitHub OAuth callback. It is only the final handoff from the backend to an installed native app.

## Source checks performed

- Node.js syntax checks for the backend, login scripts, Electron launcher and Android build scripts.
- JSON, YAML and Android manifest XML parsing.
- Static checks that native client detection, nonce validation, desktop system-browser interception, and desktop protocol declarations are present.

These checks do not replace actual install-and-login testing on Windows, macOS, Linux, or Android. The native builds were intentionally not generated as part of this source patch.
