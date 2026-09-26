# Production Deployment

## 1. GitHub OAuth

Create a GitHub OAuth App and set:

- Homepage URL: `https://YOUR-DOMAIN`
- Authorization callback URL: `https://YOUR-DOMAIN/auth/github/callback`

Configure the required repository permission scope for the repositories you want the service to manage.

## 2. Environment

Copy `.env.example` to `.env` and set:

```env
PORT=4173
PUBLIC_BASE_URL=https://YOUR-DOMAIN
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
GITHUB_CALLBACK_URL=https://YOUR-DOMAIN/auth/github/callback
SESSION_SECRET=replace-with-a-long-random-secret
TOKEN_ENCRYPTION_KEY=64-hex-characters
COOKIE_SECURE=true
```

Generate `TOKEN_ENCRYPTION_KEY` with:

```bash
openssl rand -hex 32
```

## 3. Persistent storage

Mount a persistent volume at `/app/data`. Losing this directory loses the server-side project library, snapshots, sessions, and stored encrypted credentials.

## 4. HTTPS

Put the Node.js service behind an HTTPS reverse proxy or a platform-managed TLS endpoint. Do not expose an OAuth callback or session cookie over plain HTTP in production.

## 5. Docker

```bash
docker compose up -d --build
```

## 6. Public installation

The hosted site is a PWA. On supported Android and desktop browsers, use the site's **Install App** button. This installs the web app without publishing through an app store.

## 7. Native builds

Native applications are shells around the hosted service. Build the desktop package on the target OS or in CI, and build the Android APK/AAB with Android Studio or Gradle.


### Native application downloads

The public server exposes installer packages placed in `application/windows/` and `application/android/` through the download API. Only `.msi`/`.exe` (Windows) and `.apk`/`.aab` (Android) are exposed.
