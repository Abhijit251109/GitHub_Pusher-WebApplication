# Security and deployment audit — remediated build

This report corresponds to the current 3.0.x build after the Supabase persistence/security remediation.

## Remediated
- GitHub Pages remains a static deployment through `.github/workflows/pages.yml`.
- OAuth state + PKCE is bound to the initiating browser with a short-lived HttpOnly cookie.
- OAuth state and SSE tickets are consumed once.
- Git repository configuration/hooks are sanitized before Git commands run; global/system Git config and terminal prompts are disabled.
- Archives enforce entry-count, expanded-size, decompression-ratio, and depth limits; link/device entries are rejected.
- Direct package versions are pinned in `package.json`; the security-sensitive `tar` dependency is pinned to 7.5.22.
- Docker's documented/default port matches the server default.
- Android builds use `scripts/build-android.mjs` and generate the canonical Capacitor project when absent.
- Backend Supabase secrets are not shipped in the GitHub Pages artifact or the distributable ZIP.

## Intentionally unchanged
This remediation pass does **not** add a general-purpose API/request rate limiter.

## Operational requirements
- Configure secrets in Render; do not commit `.env`.
- Run `supabase/schema.sql` in Supabase SQL Editor.
- Generate/commit `package-lock.json` from a networked npm environment before a release requiring strict dependency reproducibility.
- Rotate any Supabase secret that has previously been exposed.
