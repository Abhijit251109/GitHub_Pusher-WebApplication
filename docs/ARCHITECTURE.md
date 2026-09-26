# Architecture

GitHub Project Pusher is a local-first project library backed by a hosted Node.js service.

## Components

- `public/` — responsive web UI and PWA shell.
- `server.js` — Express API, OAuth callback handling, hashed session keys, encrypted GitHub token storage, project uploads, snapshots, and sync worker.
- `data/projects/` — created at runtime; persistent per-user projects and Git working trees.
- `electron/` — desktop shell.
- `native/android/` — checked-in Android scaffold/reference; Capacitor builds the canonical `android/` directory.

## GitHub flow

1. User signs in with GitHub OAuth.
2. Server stores the OAuth access token encrypted at rest.
3. User adds a project to their library.
4. Server initializes Git when `.git` is absent.
5. Push creates a commit and sends it to the selected or newly created repository.
6. The sync worker polls tracked repositories. Clean working trees can fast-forward automatically; dirty trees are never overwritten.
7. Snapshots are taken before and after push/pull operations.

## Persistence

Deployments must provide a persistent volume for `/app/data`. For multi-instance production deployments, replace the file-backed store and local project folders with shared storage plus a database and job queue.
