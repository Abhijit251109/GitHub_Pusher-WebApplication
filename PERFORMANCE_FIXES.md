# Responsiveness update (from `master` at d2d329531d6e58c8d8fe3631630bdeabed705a3e)

This is the complete application source from the verified `master` tree, plus conservative performance changes. No AI integration and no hosting-plan changes.

## Improvements

1. **Faster warm startup.** The browser requests authentication and the user's project list in parallel instead of waiting for authentication before requesting projects. Optional download cards no longer block displaying the application.
2. **Fewer database round trips for authenticated API requests.** A PostgREST relationship loads a session and its user in one query. A compatibility fallback handles providers/test mocks that do not return the embedded `users` relation. Authentication, ownership checks, and token expiry remain enforced.
3. **Quicker repeated folder/file opening.** Only verified read-only editor workspaces are retained for a short, bounded lifetime. After the initial archive download and verification, subsequent file/directory reads for the same project can use that workspace. Saves, pulls, pushes, and removals invalidate the cache; saves still use an isolated working directory and stale SHA protection.
4. **Less background sync work.** The worker loads all connected projects in one query rather than one query per user. For eligible projects with a known Git commit, a small GitHub ref request determines if the branch is unchanged before paying for Supabase downloads, tar extraction, and Git setup. Any unsuccessful/ambiguous preflight falls back to the original verified Git sync. Manual Fetch Changes always does the full check.

## Tunables (optional)

- `EDITOR_CACHE_TTL_MS` default 60000 (60 seconds).
- `EDITOR_CACHE_MAX_PROJECTS` default 3.
- `EDITOR_CACHE_MAX_MB` default 80 (per cached extracted project, based on its verified manifest).
- Existing `SYNC_INTERVAL_MS` remains unchanged.

The cache is **per running service instance** on temporary disk; it is never treated as durable storage. Project files still live in Supabase Storage. Render Free may sleep after inactivity. No code change can eliminate its cold-start delay; this release targets **warm** responsiveness.

## Verification & deployment

- Master source was checked against the current GitHub tree before modification: all 156 original file paths and their Git blob hashes matched the full-source ZIP, including the two root-level documentation/patch files.
- `npm run test:syntax`: passed.
- `node --test scripts/test-sync-preflight.mjs`: 2 tests passed.
- Full `npm test` was **not runnable** in the working environment: node dependencies were not installed, and the environment cannot download them. Run `npm ci && npm test` with network access before deploying.
- Live GitHub OAuth, Supabase storage, browser runtime and Render deployments were **not** exercised here.
- The source ZIP does not include `.git`, node_modules, native installers, or any secrets.

## Apply

Extract the archive, inspect the changes, and run:

```bash
npm ci
npm run test:syntax
npm test
```

To publish from your own checkout, replace its tracked source files with this archive while keeping your `.git` directory and local `.env` file, review `git diff`, then commit and push. On Render Free the deployment may incur an initial wake-up delay regardless of these changes.
