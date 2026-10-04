# GitHub Project Pusher 3.0.0

A public-hostable GitHub project library with a static GitHub Pages frontend, a free Render Node backend, and persistent Supabase Postgres + private Storage.

## Main features

- Auth0 authentication with Google + Username/Password via Universal Login
- GitHub OAuth/PKCE connection for repository access and push operations
- Optional numeric-GitHub-ID allowlist for personal deployments
- Encrypted GitHub tokens stored only on the server
- Persistent project metadata in Postgres
- Persistent project files and `.git` history in private object storage
- Before/after snapshots retained in private object storage
- Push to an existing repository or create a new repository
- Automatic Git initialization when `.git` is missing
- Background GitHub sync and fast-forward pulls
- Dirty-tree conflict protection
- Installable PWA
- GitHub Pages-compatible static frontend
- Electron desktop shell and Capacitor Android source

## Architecture

```text
GitHub Pages (public/)
        |
        | HTTPS API + Auth0 bearer tokens
        v
Render Free Web Service (Node/Express)
        |
        +---- Supabase Postgres (users, sessions, projects, snapshots)
        |
        +---- Supabase Storage (project archives + snapshots)
        |
        +---- Auth0 (identity)
        +---- GitHub OAuth + GitHub API (repository connection)
```

The Render filesystem is temporary. Important application data is never treated as durable local state.

## Run locally

```bash
npm install
npm start
```

Open `http://127.0.0.1:4173`.

Local development uses the same Supabase-backed persistence model. Create a Supabase project, run `supabase/schema.sql`, copy `.env.example` to `.env`, and provide the values before starting the server.

## Free deployment

See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for the complete GitHub Pages + Render Free + Supabase setup.

### Why not a Render disk?

Render's current Free web services have an ephemeral filesystem and do not support persistent disks. The app therefore stores data in Supabase instead. Render Free remains useful for running the API, while Supabase holds durable state.

### GitHub Pages

The static frontend keeps the Supabase **publishable** key in `public/config.js`. This key is intentionally browser-visible; it must never be replaced with `SUPABASE_SERVICE_ROLE_KEY`. The current frontend continues to send privileged data operations through the Render API.


The repository contains `.github/workflows/pages.yml`, which publishes the `public/` folder as a static GitHub Pages site. Server-side Node code is not sent to or executed by GitHub Pages. `public/` uses relative asset URLs so repository-path Pages sites continue to work.

## Database setup

Run `supabase/schema.sql` in the Supabase SQL Editor. It creates the server-owned tables, enables row-level security, and creates the private `gpp-private` Storage bucket.

## Security

See [`SECURITY.md`](SECURITY.md). In particular, never put `GITHUB_CLIENT_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `SESSION_SECRET`, or `TOKEN_ENCRYPTION_KEY` in `public/` or a GitHub Pages build.
