# Architecture

GitHub Project Pusher is split into a static frontend and a lightweight Node backend. Important state never depends on the backend instance filesystem.

## Components

- `public/` — responsive web UI and PWA shell. This directory is independently deployable to GitHub Pages.
- `server.js` — Express API, GitHub OAuth/PKCE callback handling, encrypted GitHub token storage, project operations, snapshot management, and sync worker.
- Supabase Postgres — users, sessions, OAuth attempts, one-time login codes, SSE tickets, projects, and snapshot metadata.
- Supabase Storage — private compressed archives containing project working trees (including `.git`) and before/after snapshots.
- `electron/` — desktop shell.
- `native/android/` — checked-in Android scaffold/reference; Capacitor builds the canonical `android/` directory.

## Authentication flow

1. The browser starts GitHub OAuth at the backend.
2. The backend stores a short-lived state + PKCE verifier in Supabase and binds the attempt to a short-lived HttpOnly browser cookie.
3. GitHub redirects to the backend callback.
4. The backend exchanges the code using the verifier and stores GitHub access/refresh tokens encrypted with AES-256-GCM.
5. When the frontend is hosted on GitHub Pages, the backend redirects with a one-time short-lived login code. The frontend exchanges that code for an application session token.
6. Only a hash of the application session token is stored in Postgres.

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
