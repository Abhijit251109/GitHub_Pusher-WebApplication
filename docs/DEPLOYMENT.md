# Free deployment: GitHub Pages + Render + Supabase

This project intentionally does **not** use the Render filesystem for persistent application data. Render's free web services have ephemeral filesystems: anything written there is lost on restart, spin-down, or redeploy. Instead, the app keeps metadata in Supabase Postgres and project/snapshot archives in a private Supabase Storage bucket. Render runs only the Node/Express API. GitHub Pages serves the static `public/` frontend.

Render currently offers free Node web services, but their filesystem is ephemeral. Supabase's Free plan currently includes 500 MB of database capacity and 1 GB of file storage; free projects may pause after inactivity. Treat the service as a hobby/personal deployment and keep an export/backup of important projects. See the linked official docs in the root README for the current quotas and limitations.

## 1. Create Supabase storage

1. Create a Supabase project on the Free plan.
2. Open **SQL Editor**.
3. Paste and run `supabase/schema.sql`.
4. In **Project Settings → API**, copy the project URL and the server-only **service role** key.
5. Keep the service-role key secret. Never put it in `public/`, GitHub Pages, or a client bundle.
6. The SQL creates a private bucket named `gpp-private` with a 50 MB object limit. The app keeps individual project archives below its own 45 MB limit so it remains compatible with the Free plan's upload ceiling.

## 2. Create the Render service

1. Push this repository to GitHub.
2. In Render, choose **New → Web Service** and connect the repository.
3. Render can use `render.yaml`, or you can enter the equivalent settings manually.
4. Choose the **Free** plan.
5. Set the secrets/environment values from `.env.example` and `render.yaml`.
6. Set `PUBLIC_BASE_URL` to the final Render URL, such as `https://github-project-pusher.onrender.com`.
7. Set `GITHUB_CALLBACK_URL` to `https://github-project-pusher.onrender.com/auth/github/callback`.
8. Set `FRONTEND_URL` to your GitHub Pages URL, such as `https://USERNAME.github.io/REPOSITORY`.

### Required secrets

Generate these locally, then paste them into Render's environment settings:

```bash
node -e "const c=require('crypto'); console.log(c.randomBytes(32).toString('hex'))"
node -e "const c=require('crypto'); console.log(c.randomBytes(32).toString('base64url'))"
```

Use the first output for `TOKEN_ENCRYPTION_KEY` and the second for `SESSION_SECRET` (or use another 32+ character random secret). Never commit either value.

## 3. Configure GitHub OAuth

Create or edit your GitHub OAuth App and set:

- **Homepage URL:** your GitHub Pages URL
- **Authorization callback URL:** your Render callback URL

GitHub's current OAuth documentation recommends the `state` parameter and PKCE (`S256`) for the web application flow. The backend implements both, and it exchanges the OAuth code server-side so the GitHub client secret never reaches the GitHub Pages frontend.

## 4. Lock the app to your own GitHub account

For a personal deployment, leave these settings enabled:

```env
REQUIRE_GITHUB_ALLOWLIST=true
ALLOWED_GITHUB_USER_IDS=YOUR_NUMERIC_GITHUB_USER_ID
```

Use the numeric GitHub user ID, not the username. The server denies every other GitHub account before issuing an application session.

## 5. GitHub Pages deployment

The included `.github/workflows/pages.yml` publishes `public/` as a static Pages site. This does **not** run `server.js`, and it does not require Node on the Pages host.

In GitHub:

1. Open **Settings → Pages**.
2. Set **Source** to **GitHub Actions**.
3. Push to `master` or `main`.
4. The workflow publishes the frontend.

The frontend is built with relative asset URLs, so the app continues to work whether the Pages site is served at the repository root (`USERNAME.github.io`) or under a repository path (`USERNAME.github.io/REPOSITORY`).

The first time a GitHub Pages user opens the site, the login page asks for the Render API URL unless `public/config.js` has already been set to it. You can set:

```js
window.GPP_CONFIG = { API_BASE: 'https://YOUR-RENDER-SERVICE.onrender.com' };
```

The frontend never receives the GitHub OAuth client secret or the Supabase service-role key. The distributable ZIP also excludes `.env`; configure backend secrets in Render instead.

### Node version
Render currently defaults newer services to Node 24. The repository pins Node 20.20.2 with both `.node-version` and `NODE_VERSION` in `render.yaml`, so the deployment does not silently switch majors. Node 20 is now EOL upstream, so treat this pin as compatibility-only and plan a later runtime upgrade when the project is ready.

### Feedback and contributions
Feedback is written as `./feedback/*.txt`; contribution proposals are written as `./contribute/*.json`. Because Render Free storage is ephemeral, the same files are mirrored into the private Supabase Storage bucket when Supabase is configured.

## 6. What is persistent now?

- User records and encrypted GitHub tokens: Supabase Postgres.
- Sessions, OAuth state, one-time login codes, and SSE tickets: Supabase Postgres.
- Project metadata: Supabase Postgres.
- Uploaded project working trees, including `.git` history: private Supabase Storage archive per project.
- Before/after snapshots: private Supabase Storage archives plus snapshot metadata in Postgres.
- Server temporary files: `/tmp`; these are disposable and are recreated as needed.

A Render restart, spin-down, or redeploy therefore does not delete the project's cloud copy. The free Render service may still sleep when idle, and Supabase Free projects may pause after inactivity, but the stored data remains in the remote datastore rather than the Render filesystem.

## 7. Free-tier storage guardrails

The application defaults to:

- `MAX_TOTAL_UPLOAD_MB=40`
- `MAX_ARCHIVE_MB=45`
- `MAX_SNAPSHOTS_PER_PROJECT=10`

These conservative values keep ordinary archives under Supabase Free's per-file upload ceiling and help control storage usage. Supabase Free currently includes 1 GB of file storage and 500 MB of database size, so this is best suited to personal projects rather than a large multi-user platform.

## 8. Security model

- OAuth `state` and PKCE S256 protect the sign-in flow.
- GitHub tokens are encrypted with AES-256-GCM before they enter the database.
- The browser gets only an application session token; it never receives the GitHub token or service-role key.
- Session tokens are stored only as HMAC hashes in the database and expire automatically.
- Cross-origin GitHub Pages access uses a short-lived login code and a short-lived SSE ticket.
- CORS is restricted to the configured frontend and backend origins.
- Same-site browser requests still require the expected origin when cookie authentication is used.
- A personal GitHub allowlist can block all other GitHub accounts.
- Projects and snapshots are authorized by the authenticated numeric GitHub user ID.
- Storage is private; no project archive is made public.

For stronger recovery guarantees than the Free plans provide, periodically export important data. Supabase Free does not include automatic backups for the database.
