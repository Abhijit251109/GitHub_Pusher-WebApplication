# Deployment checklist

This version is designed for **GitHub Pages + Render Free + Supabase Free**. GitHub Pages serves the static frontend, Render runs the Node/Express backend, and Supabase stores the durable database and private project/snapshot archives.

## 1. Supabase

Run `supabase/schema.sql` once in the Supabase SQL Editor. Copy the project URL and the server-only service-role key into the Render environment. Never put the service-role key in `public/` or a GitHub Pages build.

## 2. Render Free

Use the included `render.yaml`, or manually create a **Free Web Service** with:

```text
Build:  npm install --no-audit --no-fund
Start:  npm start
Health: /api/health
```

Set the variables in `.env.example`, including:

```env
PUBLIC_BASE_URL=https://YOUR-RENDER-SERVICE.onrender.com
FRONTEND_URL=https://USERNAME.github.io/REPOSITORY
SUPABASE_URL=https://YOUR-PROJECT.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...
```

Render Free's filesystem is ephemeral, so do not store application data under `/app/data`. The server only uses temporary local space for upload and Git operations; durable state is in Supabase.

## 3. Auth0

Create the Auth0 application as **Single Page Application** and enable the **Username-Password-Authentication** and **Google** connections shown in your Auth0 dashboard. Create an Auth0 API for the backend, then set:

```env
AUTH0_DOMAIN=dev-xxxxxxxx.us.auth0.com
AUTH0_CLIENT_ID=your-spa-client-id
AUTH0_AUDIENCE=https://github-project-pusher-api
```

In the Auth0 SPA settings, add the exact GitHub Pages URL (plus the local URL you use for development) to **Allowed Callback URLs**, **Allowed Logout URLs**, and **Allowed Web Origins**. The current frontend callback is the same `index.html`/`login.html` path from which Auth0 is started.

## 4. GitHub OAuth

In the GitHub OAuth App, use:

- Homepage URL: your GitHub Pages URL
- Authorization callback URL: `https://YOUR-RENDER-SERVICE.onrender.com/auth/github/callback`

The backend uses `state` and PKCE S256 for the OAuth web flow.

## 5. Personal-account allowlist

For a personal deployment, keep:

```env
REQUIRE_GITHUB_ALLOWLIST=true
ALLOWED_GITHUB_USER_IDS=YOUR_NUMERIC_GITHUB_ID
```

The numeric GitHub user ID is used instead of the mutable username.

## 6. GitHub Pages

The included `.github/workflows/pages.yml` publishes `public/` using GitHub Actions. In **Repository Settings → Pages**, select **GitHub Actions** as the source.

The static frontend uses relative asset URLs and therefore continues to work on repository-path Pages URLs. `public/config.js` can optionally contain the Render API URL; otherwise the login page asks for it once and stores it locally.

## 7. Durable data

The following remain intact across Render restart, free-tier spin-down, and redeploy:

- Postgres users and encrypted GitHub credentials
- application sessions and OAuth state
- project metadata
- project working trees, including `.git` history
- before/after snapshots

Supabase Free currently includes 500 MB of database capacity and 1 GB of file storage. Keep the archive/snapshot limits conservative and export important data independently because Free does not include automatic database backups.

## 8. Native apps

Electron and Capacitor clients should point at the HTTPS backend URL. Never ship the GitHub OAuth client secret in a desktop/mobile client.

## GitHub Pages

`public/config.js` contains the Supabase publishable key used by the browser-facing configuration. That key is intentionally public. Do not place the Supabase service-role key in `public/` or any GitHub Pages artifact.

Supabase project URL configured for this build:
`https://vsrooptemnxxqolzbeze.supabase.co`

The Supabase publishable key is safe for the browser bundle; the Supabase secret key remains backend-only in `.env`/Render environment variables.
