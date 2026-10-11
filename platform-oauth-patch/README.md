# GitHub Project Pusher — platform OAuth patch

This bundle is an **overlay patch**, not a replacement copy of the whole project. Use it on a fresh checkout of the latest `master` branch so the latest dashboard/UI and backend improvements stay intact.

## Apply it

1. Extract this ZIP into the root of the current repository. It creates a separate `platform-oauth-patch/` folder and does not overwrite the repository's `README.md` or application files during extraction.
2. Open a terminal in the **repository root** and run:

   ```bash
   node platform-oauth-patch/apply-platform-oauth-fix.mjs
   ```

3. Review the changed files and run your normal tests/builds. Remove the temporary `platform-oauth-patch/` folder before committing.

The script patches only the OAuth blocks in `server.js` and `public/login.js`; it deliberately does **not** touch `public/app.js`, so recent GUI and dashboard features are preserved. It copies the Electron desktop protocol handler, Android callback activity/configurator, corrected Electron Builder config, and a Linux AppImage workflow. Running it twice is safe.

## Behavior and requirements

- Web sign-in continues to require the browser-binding cookie.
- Android and Electron desktop sign-in use a validated nonce and single-use server login code to hand off from the system browser to the app.
- Keep the GitHub OAuth App callback at `https://github-pusher-g3ac.onrender.com/auth/github/callback`; do not set the custom app scheme as the GitHub callback.
- Linux uses a desktop entry with `x-scheme-handler/com.githubprojectpusher.app`. The AppImage must be integrated by the user's desktop environment for OS-level URI links to open the app.

The patch does not build an APK, MSI, DMG, or AppImage, and it does not push to GitHub or deploy to Render.
