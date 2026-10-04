# Architecture

GitHub Project Pusher is split into a static frontend and a lightweight Node backend. Important state never depends on the backend instance filesystem.

## Components

- `public/` — responsive web UI and PWA shell. This directory is independently deployable to GitHub Pages.
- `server.js` — Express API, Auth0 JWT validation, GitHub OAuth/PKCE connection handling, encrypted GitHub token storage, project operations, snapshot management, and sync worker.
- Supabase Postgres — users, sessions, OAuth attempts, one-time login codes, SSE tickets, projects, and snapshot metadata.
- Supabase Storage — private compressed archives containing project working trees (including `.git`) and before/after snapshots.
- `electron/` — desktop shell.
- `native/android/` — checked-in Android scaffold/reference; Capacitor builds the canonical `android/` directory.

## Authentication flow

1. The browser starts Auth0 Universal Login using the Auth0 SPA JS SDK (authorization code + PKCE).
2. Auth0 returns a JWT access token for the configured API audience.
3. The browser sends that bearer token to Render; the backend validates issuer, audience, signature, and expiry before mapping `sub` to a persistent application user.
4. Auth0 users can then choose **Connect GitHub** in the dashboard. The backend starts a separate GitHub OAuth/PKCE flow and attaches the encrypted GitHub access/refresh tokens to that Auth0 user.
5. Existing GitHub-only sessions remain supported for backwards compatibility.

## Project persistence

1. An uploaded project is assembled in temporary local space.
2. The working tree is compressed and uploaded to the private Storage bucket.
3. Git operations run against a temporary hydrated working tree after sanitizing attacker-controlled Git config/hooks.
4. After a successful change, the working tree (including `.git`) is archived back to Storage.
5. Snapshots exclude `.git` and are retained separately in Storage.
6. All project metadata and snapshot metadata are stored in Postgres.

Because the Render filesystem is disposable, a restart or redeploy only removes temporary working directories. The durable project copy remains in Supabase.

## GitHub Pages

`.github/workflows/pages.yml` copies `public/` to a Pages artifact and deploys it without executing Node code. Static assets use relative paths so repository-path Pages sites work. `public/config.js` can hold the backend base URL, or the login screen can ask for it on first use.
