# GitHub Project Pusher 2.1.1

A public-hostable GitHub project library with web, PWA, desktop, and Android targets.

## Main features

- GitHub OAuth authentication
- Persistent per-user project library
- Add/remove projects
- Push to an existing repo or create a new repo
- Automatic Git initialization when `.git` is missing
- Background GitHub sync and fast-forward pulls
- Dirty-tree conflict protection
- Before/after snapshots
- Installable PWA
- Electron desktop shell for Windows/macOS/Linux
- Capacitor Android shell source

## Repository layout

- `public/` web application
- `server.js` backend and sync service
- `docs/` architecture, deployment, and user documentation
- `electron/` desktop runtime
- `native/desktop/` desktop target documentation
- `native/android/` checked-in Android scaffold/reference; Capacitor generates the canonical root `android/` project

## Run

```bash
npm install
npm start
```

Open `http://localhost:4173` for local development.

## Public deployment

Use `.env.example`, `docker-compose.yml`, and `docs/DEPLOYMENT.md`. A persistent volume must be mounted at `/app/data`.

## Native applications

See `native/README.md` for Windows/macOS/Linux and Android build instructions.

## Application downloads

Place release builds under `application/windows/` and `application/android/`. The website automatically discovers supported files and shows download buttons. Windows supports `.msi` and `.exe`; Android supports `.apk` and `.aab`.

The configured Windows MSI artifact is named `github_pusher.msi`. Build it with `npm run build:windows-installer -- --x64` on a Windows build host. A GitHub Actions workflow is included at `.github/workflows/build-windows-msi.yml` so the MSI can be built reproducibly on GitHub.

The MSI build requires the Electron/electron-builder dependencies and a Windows-compatible build environment; the checked-in workflow is the reliable cross-platform way to produce the Windows installer from this source tree.

## Direct login
When the server is running, open `/login` to go straight to GitHub authorization. The included `public/login.html` is also suitable as a small login launcher.
