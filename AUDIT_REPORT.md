# Security and deployment audit — remediated build

This report corresponds to the current 3.0.x build after the Supabase persistence, upload, feedback, SSE, and runtime configuration remediation.

## Remediated
- GitHub Pages remains a static deployment through `.github/workflows/pages.yml`.
- OAuth state + PKCE is bound to the initiating browser with a short-lived HttpOnly cookie.
- SSE tickets are short-lived and reusable until expiry so EventSource reconnects continue to work.
- Cross-filesystem uploads use an EXDEV-safe `rename` → `copyFile` + remove fallback.
- Feedback and contribution directories are created at startup; submissions are written locally and mirrored to private Supabase Storage when configured.
- Supabase submission-storage failures are no longer silently ignored; the local submission is removed and the API reports the failure instead.
- Git repository configuration/hooks are sanitized before Git commands run; global/system Git config and terminal prompts are disabled.
- Archives enforce entry-count, expanded-size, decompression-ratio, and depth limits; link/device entries are rejected.
- Direct package versions are pinned in `package.json`; the security-sensitive `tar` dependency is pinned to 7.5.22.
- Node runtime is standardized on Node 22, which matches the Capacitor 8 requirement and the native build workflows.
- Native Electron/Capacitor clients default to the production Render HTTPS endpoint while retaining `GPP_APP_URL` overrides.
- Render Blueprint service naming matches the configured production service URL.
- Backend Supabase secrets are not shipped in the GitHub Pages artifact or the distributable ZIP.

## Dependency reproducibility
The supplied archive intentionally does not include the previous hand-written partial `package-lock.json`: it was not a complete lockfile and could not be safely regenerated in this offline environment. The project uses exact direct dependency versions and `npm install` in Render/CI. Generate a fresh lockfile with `npm install` from a networked development environment when strict `npm ci` reproducibility is required.

## Intentionally unchanged
This remediation pass does **not** add a general-purpose API/request rate limiter.

## Operational requirements
- Configure secrets in Render; do not commit `.env`.
- Run `supabase/schema.sql` in Supabase SQL Editor.
- Configure `PUBLIC_GITHUB_URL` and `PUBLIC_CONTACT_EMAIL` in Render when the contact links should be shown.
- Keep the Render `FRONTEND_URL`, `PUBLIC_BASE_URL`, and GitHub OAuth callback URL aligned with the actual deployment.
