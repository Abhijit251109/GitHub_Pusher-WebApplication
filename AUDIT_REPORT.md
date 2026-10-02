# Security and deployment audit — 3.0.1 corrective build

This report corresponds to the 3.0.1 build after the upload, deployment-configuration, and request-handling review.

## Remediated in this release
- Cross-filesystem upload moves no longer fail with `EXDEV`; uploads fall back from rename to copy-and-delete when required.
- Authentication is checked before multipart upload parsing, preventing unauthenticated requests from first consuming upload disk space.
- External GitHub API/OAuth calls have a configurable 30-second timeout by default.
- GitHub Pages `public/config.js` points at the active Render deployment URL used by this project.
- Static JavaScript syntax verification is available through `npm run verify`.
- Generated Android/Gradle build output is ignored by Git while application release directories remain trackable.

## Existing protections retained
- GitHub OAuth state + PKCE bound to the initiating browser.
- Encrypted GitHub tokens stored only server-side.
- Supabase Postgres + private Storage for durable project data.
- Archive entry, size, decompression-ratio, depth, and link/device safeguards.
- Git repository sanitization, disabled hooks, and disabled terminal prompts.
- Per-project ownership checks and snapshot retention.

## Validation
- Node syntax checks pass for all JavaScript source files.
- `npm run verify` passes for the packaged source tree.
- A live runtime smoke test could not be executed in the packaging environment because npm dependency installation timed out and the runtime had no installed `node_modules`; the source and configuration checks above were still completed.

## Operational requirements
- Run `supabase/schema.sql` once in Supabase SQL Editor.
- Configure Render secrets from `.env.example`; never commit `.env`.
- Keep the GitHub OAuth callback URL set to the Render callback endpoint.
- Generate a `package-lock.json` in a networked npm environment before switching CI from `npm install` to `npm ci`.
