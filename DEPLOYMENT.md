# Public deployment checklist

## 1. GitHub OAuth App

Register an OAuth App in GitHub Developer Settings.

Set:

- Homepage URL: `https://YOUR-DOMAIN/`
- Authorization callback URL: `https://YOUR-DOMAIN/auth/github/callback`
- A scope that permits the repository operations you need (`repo` for private repositories in this OAuth implementation).

GitHub's current documentation recommends considering a GitHub App for integrations that benefit from fine-grained permissions and short-lived tokens. This project uses an OAuth App because it provides the direct user-authorization flow required by this personal project manager.

## 2. Environment variables

Copy `.env.example` to `.env` and set:

```env
NODE_ENV=production
PUBLIC_BASE_URL=https://YOUR-DOMAIN
GITHUB_CALLBACK_URL=https://YOUR-DOMAIN/auth/github/callback
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
SESSION_SECRET=at-least-32-random-characters
TOKEN_ENCRYPTION_KEY=64-hex-characters
COOKIE_SECURE=true
TRUST_PROXY=1
```

## 3. Persistent storage

Mount `/app/data` to durable storage. Do not mount the application source directory as writable shared storage. Projects, snapshots, user records, sessions, and encrypted GitHub tokens live there.

Do not run multiple server replicas against the same file-backed data directory. For a multi-replica service, move the registry/session store to a shared database and project data to shared object/block storage.

## 4. HTTPS

Place the Node server behind an HTTPS reverse proxy or managed platform TLS. The production session cookie is marked `Secure`.

## 5. Docker

```bash
docker compose up -d --build
```

## 6. Automatic sync

The server checks linked repositories every `SYNC_INTERVAL_MS` milliseconds (20 seconds by default). When a remote commit is found and the local project is clean, it performs a fast-forward-only pull and creates before/after snapshots.

If local uncommitted changes exist, the server does not overwrite them; the project is marked `conflict` instead.

## 7. Native apps

The public website is the canonical backend. Desktop Electron and Android Capacitor wrappers should point to that HTTPS URL. Do not put the GitHub client secret in the native client.


### Native application downloads

The public server exposes installer packages placed in `application/windows/` and `application/android/` through the download API. Only `.msi`/`.exe` (Windows) and `.apk`/`.aab` (Android) are exposed.
