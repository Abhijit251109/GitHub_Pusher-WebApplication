# Security notes

This application handles GitHub OAuth credentials and user project archives. The server is designed so sensitive credentials remain server-side.

## Sensitive values

Never commit:

- `GITHUB_CLIENT_SECRET`
- `SUPABASE_SECRET_KEY`
- `SESSION_SECRET`
- `TOKEN_ENCRYPTION_KEY`

These belong only in the backend environment.

## Authentication

GitHub OAuth uses a server-generated `state` value and PKCE S256, and the OAuth attempt is bound to the initiating browser with a short-lived HttpOnly cookie. The OAuth code is exchanged on the backend. For GitHub Pages, the callback returns a short-lived one-time login code to the static frontend, which exchanges it for an application session token. The session token is HMAC-hashed before being stored in Postgres.

## GitHub tokens

Access and refresh tokens are encrypted with AES-256-GCM before database storage. The encryption key is never exposed to the browser.

## Storage

Project working trees and snapshots are stored in a private Supabase Storage bucket. The server uses the Supabase secret key to access them. The browser receives no Storage secret.

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
