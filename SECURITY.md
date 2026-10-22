# Security notes

This application handles GitHub OAuth credentials and user project archives. The server is designed so sensitive credentials remain server-side.

## Sensitive values

Never commit:

- `GITHUB_CLIENT_SECRET`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SESSION_SECRET`
- `TOKEN_ENCRYPTION_KEY`

These belong only in the backend environment.

## Authentication

GitHub OAuth uses a server-generated `state` value and PKCE S256, and the OAuth attempt is bound to the initiating browser with a short-lived HttpOnly cookie. The OAuth code is exchanged on the backend. For GitHub Pages, the callback returns a short-lived one-time login code to the static frontend, which exchanges it for an application session token. The session token is HMAC-hashed before being stored in Postgres.

## GitHub scopes

By default the app requests `repo offline_access` (`GITHUB_OAUTH_SCOPE`).

- `repo` is required: it lets the app list the user's repositories, create a new repository for a first push, and push commits to repositories the user can write to. It also lets a stolen token rewrite those repositories' contents, which is why tokens are encrypted at rest (below).
- `offline_access` is kept for refresh tokens where GitHub issues them.
- `delete_repo` is **not** requested by default. It cannot be limited to one repository: a token holding it can permanently delete every repository the user administers. Anyone who obtained a stored token (database plus encryption key, a server compromise, a future injection bug) could then delete the user's repositories instead of only rewriting them.

Trade-off when a first push into a repository the app just created fails:

- Without `delete_repo` (default), the repository is left in place, but never silently. The push first proves git credentials work and stages the files locally, so problems on the server are found before anything is created. If the push still fails, the error names and links the empty repository, and it is linked to the project, so the next push fills it rather than creating another.
- With `delete_repo` (opt-in: set `GITHUB_OAUTH_SCOPE=repo delete_repo offline_access`), the app deletes that repository, and only after GitHub confirms it has no branches. It never deletes after a timeout or any repository it did not create in the same request. Enable it only for a personal deployment where you accept that risk.

Changing the scope only affects new sign-ins. A token that was already granted `delete_repo` keeps it until the user revokes the app under GitHub **Settings → Applications → Authorized OAuth Apps** and signs in again.

## GitHub tokens

Access and refresh tokens are encrypted with AES-256-GCM before database storage. The encryption key is never exposed to the browser.

## Storage

Project working trees and snapshots are stored in a private Supabase Storage bucket. The server uses the service-role key to access them. The browser receives no Storage secret.

## Authorization

Every project lookup is checked against the authenticated numeric GitHub user ID. The optional allowlist can prevent any account other than the configured GitHub IDs from signing in.

## Backups

Free-tier Supabase does not include automatic database backups. Keep independent exports of important projects and consider reducing snapshot retention for storage efficiency.

### Local Supabase secret

The backend may load a local `.env` file during development. That file is intentionally ignored by Git and must never be committed. The Supabase secret key belongs only in the backend environment; the GitHub Pages frontend must use only the publishable key.

### Git repository safety

Uploaded `.git` metadata is retained for history, but repository-local config and hooks are sanitized before Git commands run. Git global/system config is disabled for application Git operations, and hooks are disabled.

### Archive safety

Project archives enforce maximum entry count, expanded size, decompression ratio, and directory depth. Symbolic links, hardlinks, device nodes, sockets, and FIFOs are rejected.
