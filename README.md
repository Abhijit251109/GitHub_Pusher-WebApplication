# GitHub Pusher Studio

An installable project workspace for browsing and editing files, fetching GitHub changes, and pushing projects with optional custom commit messages. Includes a responsive dashboard, dark/light/system themes, GitHub sign-in, private persistent storage, conflict checks and safety snapshots.

## Browse, edit, fetch and push

1. Add a project folder or files and select the project.
2. Choose **Open Selected** to browse folders and open an existing text file.
3. Edit the contents and choose **Save file** (Ctrl/⌘ + S).
4. Choose **Fetch Changes** to check GitHub updates. Saved edits are preserved; conflicting changes are reported.
5. Choose **Push Selected**, review the repository and branch, and optionally enter a commit message. Blank or whitespace-only input uses `Sync from GitHub Pusher Studio [timestamp]` (or the configured `APP_NAME`). Identical content creates no new commit.

The editor saves to the account's app workspace. It does not modify the original folder uploaded from your device. Saving does not commit or push to GitHub. The existing periodic GitHub sync remains; no AI integration or AI-triggered actions are included.

The editor supports existing UTF-8 text files up to 2 MiB. Binary files, symbolic links, Git internals and excluded generated folders cannot be edited. A stale file version is rejected rather than overwriting newer edits from another tab or device. Unsaved drafts are protected when changing projects or leaving the page.

## Run locally

Use the Node version in `.nvmrc` and Git on PATH. Copy `.env.example` to `.env` and configure your GitHub OAuth app, session/encryption secrets and Supabase connection. See [deployment setup](docs/DEPLOYMENT.md) and [security settings](SECURITY.md).

```sh
npm ci
npm start
```

Production requires persistent Supabase database and private Storage, using the existing [schema](supabase/schema.sql). This release requires no new database tables or migration. Never put the server's secret key in the public frontend.

## Validation

```sh
npm run test:syntax
npm test
node scripts/verify-project.mjs
git diff --check
```

Tests cover real Git push/pull behavior with local remotes, authenticated HTTP routes against mocked persistence, file editing and ownership, stale versions, binary/large files, upload failure recovery, and exact custom commit messages.

The [user guide](docs/USER_GUIDE.md) describes snapshots and conflict handling. Native desktop/Android packaging and the PWA use the GitHub Pusher Studio name; existing app IDs, OAuth callback schemes, repository URLs and installer filenames are preserved for compatibility.
