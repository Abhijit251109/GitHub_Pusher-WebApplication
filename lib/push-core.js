// Push/sync safety core. Kept free of Supabase/Express so it can be tested against real git
// with a local bare repository standing in for GitHub (see scripts/test-push-safety.mjs).
import fs from 'fs/promises';
import path from 'path';
import { AppError } from './security.js';

// Large generated directories that are never stored in project archives.
export const ARCHIVE_SKIP_NAMES = new Set(['node_modules', '.venv', '__pycache__', '.gradle', '.m2', 'target', 'build', 'dist', '.next', '.cache']);
export const MANIFEST_VERSION = 1;

// Messages are shown to users; raw git/Storage text goes in `internal` and only reaches logs.
export class PushError extends AppError {
  constructor(code, message, { status = 500, details, internal } = {}) {
    super(code, message, { status, details, internal });
    this.name = 'PushError';
  }
}

// Same rule as the archive filter: .git and the skip names are excluded only as top-level entries.
export function isArchiveExcluded(rel) {
  const first = String(rel).split('/')[0];
  return first === '.git' || ARCHIVE_SKIP_NAMES.has(first);
}

// Every regular file that would be stored in the project archive, as posix path -> size.
export async function listWorkingFiles(root) {
  const files = new Map();
  async function walk(dir, prefix) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (!prefix && isArchiveExcluded(rel)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) await walk(abs, rel);
      else if (e.isFile()) files.set(rel, (await fs.stat(abs)).size);
    }
  }
  await walk(root, '');
  return files;
}

export async function buildManifest(root) {
  const files = await listWorkingFiles(root);
  const sorted = [...files.entries()].sort(([a], [b]) => a.localeCompare(b));
  return {
    version: MANIFEST_VERSION,
    fileCount: sorted.length,
    totalBytes: sorted.reduce((sum, [, size]) => sum + size, 0),
    files: Object.fromEntries(sorted)
  };
}

// Throws unless the restored workspace contains every file recorded when the project was stored.
export async function verifyRestoredWorkspace(root, manifest) {
  const actual = await listWorkingFiles(root);
  if (!manifest) {
    // Legacy project stored before manifests existed: the best available check is "not empty".
    if (actual.size === 0) {
      throw new PushError('WORKSPACE_EMPTY', 'The stored copy of this project restored 0 files. Nothing was sent to GitHub. Remove the project and add it again.', { status: 422 });
    }
    return { fileCount: actual.size, legacy: true };
  }
  const missing = [];
  const changed = [];
  for (const [rel, size] of Object.entries(manifest.files || {})) {
    if (!actual.has(rel)) missing.push(rel);
    else if (actual.get(rel) !== size) changed.push(rel);
  }
  if (missing.length || changed.length) {
    const restored = manifest.fileCount - missing.length;
    throw new PushError('WORKSPACE_INCOMPLETE', `Only ${restored} of ${manifest.fileCount} stored files were restored intact (${missing.length} missing, ${changed.length} with the wrong size). Nothing was sent to GitHub.`, {
      status: 422,
      details: { expected: manifest.fileCount, missing: missing.slice(0, 20), changed: changed.slice(0, 20) }
    });
  }
  return { fileCount: actual.size, legacy: false };
}

// A git call stopped by its timeout or the job deadline. Code that reads a failed git call as an
// answer ("no such ref", "files differ") must rethrow these instead.
export const GIT_TIMEOUT = 'GIT_TIMEOUT';
function rethrowTimeout(e) { if (e?.code === GIT_TIMEOUT) throw e; }

function gitErrorText(e) { return String(e?.stderr || e?.message || e).trim(); }
// git never got a credential to send: a server-side setup fault, not the user's GitHub access.
const CREDENTIAL_SETUP = /could not read (username|password)|unable to read askpass|terminal prompts disabled/i;
export function authSetupError(text) {
  return new PushError('GIT_AUTH_SETUP', 'The server could not pass your GitHub login to git. This is a problem on the server, not with your account. Nothing was sent to GitHub.', { status: 500, internal: text });
}
function fetchError(e) {
  if (e?.code === GIT_TIMEOUT) return e;
  const text = gitErrorText(e);
  if (CREDENTIAL_SETUP.test(text)) return authSetupError(text);
  const message = /not found|does not exist/i.test(text) ? 'The GitHub repository was not found or your account cannot see it.'
    : /authentication failed|403|denied|permission/i.test(text) ? 'GitHub denied access to this repository. Reconnect GitHub or check that your account can access it.'
    : 'Could not read the GitHub repository. Try again in a moment.';
  return new PushError('FETCH_FAILED', message, { status: 502, internal: text });
}
function pushRejection(text) {
  if (/protected branch|GH006/i.test(text)) return 'The branch is protected on GitHub, so it cannot be pushed to directly.';
  if (/GH001|large files?|exceeds .*limit/i.test(text)) return 'GitHub rejected a file that is too large (the limit is 100 MB per file).';
  if (/authentication failed|403|denied|permission/i.test(text)) return 'Your GitHub account does not have write access to this repository.';
  return 'GitHub rejected the push.';
}

async function tryRev(git, ref) {
  try { return (await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).stdout.trim() || null; } catch (e) { rethrowTimeout(e); return null; }
}

// Regular files in a commit (path -> blob id) and its special entries: symlinks (mode 120000)
// and submodules (160000). Special entries are never written into the workspace: the stored
// copy holds only regular files, and a symlink there could redirect later writes.
async function treeBlobs(git, commit) {
  const files = new Map();
  const special = new Set();
  if (!commit) return { files, special };
  const { stdout } = await git(['ls-tree', '-r', '-z', commit]);
  for (const record of stdout.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    const [mode, type, id] = record.slice(0, tab).split(' ');
    const rel = record.slice(tab + 1);
    if (type === 'blob' && (mode === '100644' || mode === '100755')) files.set(rel, id);
    else special.add(rel);
  }
  return { files, special };
}

// Blob ids the working tree's files would get if committed (honours .gitattributes filters).
async function workingBlobs(git, dir, paths) {
  const out = new Map();
  const present = [];
  for (const rel of paths) {
    if (rel.includes('\n')) throw new PushError('UNSUPPORTED_PATH', `File names containing line breaks are not supported: ${JSON.stringify(rel)}`, { status: 422 });
    const stat = await fs.lstat(path.join(dir, rel)).catch(() => null);
    if (stat?.isFile()) present.push(rel);
  }
  if (!present.length) return out;
  const { stdout } = await git(['hash-object', '--stdin-paths'], { input: present.join('\n') + '\n' });
  const ids = stdout.trim().split('\n');
  present.forEach((rel, i) => out.set(rel, ids[i]));
  return out;
}

async function untrackedPaths(git) {
  const { stdout } = await git(['ls-files', '-z', '--others', '--exclude-standard']);
  return stdout.split('\0').filter(Boolean);
}

// Three-way comparison of the stored working tree against the last commit this app knows the
// project matched (`known`) and the current remote tip (`base`).
//   takeRemote: remote changed it, user did not -> bring the remote version in (or delete)
//   restore:    remote has it, local copy is missing and we cannot prove the user deleted it
//   conflicts:  both sides changed it differently
//   localChanges: paths where the stored copy differs from `known`
//   special:    symlinks/submodules on the remote, left exactly as they are
async function classify(git, dir, { base, known }) {
  const { files: baseTree, special } = await treeBlobs(git, base);
  const knownTree = known ? (await treeBlobs(git, known)).files : null;
  const candidates = new Set([...baseTree.keys(), ...(knownTree ? knownTree.keys() : []), ...(await untrackedPaths(git))]);
  for (const p of special) candidates.delete(p);
  const local = await workingBlobs(git, dir, [...candidates].filter(p => !isArchiveExcluded(p)));
  const takeRemote = [];
  const restore = [];
  const conflicts = [];
  const localChanges = [];
  for (const p of candidates) {
    const b = baseTree.get(p) ?? null;
    if (isArchiveExcluded(p)) {
      // Never stored locally (node_modules, dist, ...), so its absence is not a deletion.
      if (b) restore.push(p);
      continue;
    }
    const l = local.get(p) ?? null;
    if (knownTree) {
      const k = knownTree.get(p) ?? null;
      if (l !== k) localChanges.push(p);
      if (b === k || l === b) continue;
      if (l === k) takeRemote.push(p);
      else conflicts.push(p);
    } else if (b && l !== b) {
      if (l === null) restore.push(p);
      else conflicts.push(p);
    }
  }
  return { baseTree, takeRemote, restore, conflicts, localChanges, special: [...special] };
}

// Keeps special entries in the index without a working-tree copy, so `git add -A` leaves them
// unchanged on the remote instead of staging their deletion.
async function keepSpecialEntries(git, paths) {
  if (!paths.length) return;
  await git(['update-index', '--skip-worktree', '-z', '--stdin'], { input: paths.join('\0') + '\0' });
}

async function checkoutPaths(git, commit, paths) {
  if (!paths.length) return;
  await git(['--literal-pathspecs', 'checkout', commit, '--pathspec-from-file=-', '--pathspec-file-nul'], { input: paths.join('\0') });
}

async function applyRemote(git, dir, base, baseTree, paths) {
  const fromRemote = paths.filter(p => baseTree.has(p));
  for (const p of paths) if (!baseTree.has(p)) await fs.rm(path.join(dir, p), { force: true });
  await checkoutPaths(git, base, fromRemote);
}

// Most recent commit this app pushed or pulled for the project.
export function lastKnownCommit(project) {
  const pushed = project.lastPushedCommit ? Date.parse(project.lastPushedAt || 0) || 0 : -1;
  const pulled = project.lastPulledCommit ? Date.parse(project.lastSyncAt || 0) || 0 : -1;
  if (pushed < 0 && pulled < 0) return null;
  return pulled > pushed ? project.lastPulledCommit : project.lastPushedCommit;
}

async function knownCommitIn(git, commit) {
  if (!commit) return null;
  try { await git(['cat-file', '-e', `${commit}^{commit}`]); return commit; } catch (e) { rethrowTimeout(e); return null; }
}

// Commits the restored project on top of the remote branch and pushes without force.
// `git` runs git in `dir` with credentials: git(args, { input }) -> { stdout, stderr }.
export async function commitAndPush({ git, dir, branch, defaultBranch, knownCommit, keepLocalOnConflict = false, message, remoteTreeCount }) {
  await git(['fetch', '--prune', 'origin']).catch(e => { throw fetchError(e); });
  const branchTip = await tryRev(git, `refs/remotes/origin/${branch}`);
  // A new branch starts from the default branch so it shares history with the rest of the repo.
  const base = branchTip
    || (defaultBranch && defaultBranch !== branch ? await tryRev(git, `refs/remotes/origin/${defaultBranch}`) : null);
  const known = base ? await knownCommitIn(git, knownCommit) : null;

  // Build the new commit on top of the remote tip without touching the working tree.
  await git(['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
  if (base) {
    await git(['update-ref', `refs/heads/${branch}`, base]);
    await git(['read-tree', base]);
  } else {
    await git(['read-tree', '--empty']);
  }

  let overwritten = [];
  let restored = [];
  let special = [];
  if (base) {
    const plan = await classify(git, dir, { base, known });
    if (plan.conflicts.length && !keepLocalOnConflict) {
      throw new PushError('CONFLICT', `${plan.conflicts.length} file(s) were changed both in this project and on GitHub. Nothing was pushed.`, {
        status: 409, details: { conflicts: plan.conflicts.slice(0, 50), total: plan.conflicts.length, knownBase: Boolean(known) }
      });
    }
    overwritten = plan.conflicts;
    restored = [...plan.takeRemote, ...plan.restore];
    special = plan.special;
    await applyRemote(git, dir, base, plan.baseTree, [...plan.takeRemote, ...plan.restore]);
    await keepSpecialEntries(git, special);
  }

  await git(['add', '-A']);
  const tracked = (await git(['ls-files', '-z'])).stdout.split('\0').filter(Boolean).length;
  if (tracked === 0) throw new PushError('WORKSPACE_EMPTY', 'This project has no files to push. Nothing was sent to GitHub.', { status: 422 });
  let same = false;
  if (base) {
    try { await git(['diff', '--cached', '--quiet', base]); same = true; } catch (e) { rethrowTimeout(e); }
  }
  if (same && branchTip) return { outcome: 'no-changes', commit: base, fileCount: tracked, restored, overwritten, special };
  // Same content as the default branch: the new branch is pushed pointing at its tip.
  if (!same) await git(['commit', '-m', message]);
  const commit = (await git(['rev-parse', 'HEAD'])).stdout.trim();

  try {
    await git(['push', '-u', 'origin', `refs/heads/${branch}:refs/heads/${branch}`]);
  } catch (e) {
    rethrowTimeout(e);
    const text = gitErrorText(e);
    if (CREDENTIAL_SETUP.test(text)) throw authSetupError(text);
    // Only git's own fast-forward rejection ("! [rejected] ... (fetch first|non-fast-forward)") means the
    // branch moved; "[remote rejected]" is a server-side refusal such as a protected branch.
    if (/\[rejected\]|non-fast-forward|fetch first/i.test(text)) {
      throw new PushError('REMOTE_CHANGED', 'The GitHub branch changed while this push was running. Nothing was overwritten. Push again to include the new changes.', { status: 409 });
    }
    throw new PushError('PUSH_FAILED', pushRejection(text), { status: 502, internal: text });
  }

  // Report success only once GitHub demonstrably holds the commit and its files.
  const remoteLine = (await git(['ls-remote', 'origin', `refs/heads/${branch}`])).stdout.trim();
  const remoteSha = remoteLine.split(/\s+/)[0] || null;
  if (remoteSha !== commit) {
    throw new PushError('VERIFY_FAILED', `Push finished but GitHub reports ${remoteSha || 'no commit'} on ${branch} instead of ${commit}.`, { status: 502, details: { pushed: true, commit } });
  }
  const committed = (await git(['ls-tree', '-r', '-z', '--name-only', commit])).stdout.split('\0').filter(Boolean).length;
  if (remoteTreeCount) {
    const remote = await remoteTreeCount(commit);
    if (remote && !remote.truncated && remote.count !== committed) {
      throw new PushError('VERIFY_FAILED', `GitHub shows ${remote.count} files in the pushed commit, expected ${committed}.`, { status: 502, details: { pushed: true, commit } });
    }
  }
  return { outcome: 'pushed', commit, fileCount: committed, restored, overwritten, special };
}

// Everything about the commit that can fail without the network, run before a repository can be
// created: the files must stage into a non-empty tree and the tree must be writable.
export async function stageLocally({ git }) {
  await git(['read-tree', '--empty']);
  await git(['add', '-A']);
  const tracked = (await git(['ls-files', '-z'])).stdout.split('\0').filter(Boolean).length;
  if (tracked === 0) throw new PushError('WORKSPACE_EMPTY', 'This project has no files to push. Nothing was sent to GitHub.', { status: 422 });
  await git(['write-tree']);
  return { tracked };
}

// Full push flow. Order matters: the workspace is restored and checked, git's credentials are
// proven and the files are staged before GitHub is touched, so nothing that can be found out
// locally can fail after a new repository exists.
export async function performPush({ project, branch, keepLocalOnConflict, message, deps }) {
  const { withWorkspace, prepareGit, resolveRepo, deleteRepo, gitFor, checkGitAuth, remoteTreeCount, beforePush, afterPush, log = () => {} } = deps;
  let repo = null;
  let created = false;
  let canCleanup = true;
  let pushed = false;
  try {
    return await withWorkspace(project, async dir => {
      const files = await listWorkingFiles(dir);
      if (files.size === 0) throw new PushError('WORKSPACE_EMPTY', 'This project has no files to push. Nothing was sent to GitHub.', { status: 422 });
      const earlyWarnings = beforePush ? await beforePush(dir) : [];
      await prepareGit(dir, null);
      if (checkGitAuth) await checkGitAuth(dir);
      await gitFor(dir, git => stageLocally({ git }));
      ({ repo, created, canCleanup = true } = await resolveRepo());
      await prepareGit(dir, repo.clone_url);
      const result = await gitFor(dir, git => commitAndPush({
        git, dir, branch, defaultBranch: repo.default_branch, knownCommit: lastKnownCommit(project),
        keepLocalOnConflict, message,
        remoteTreeCount: remoteTreeCount ? sha => remoteTreeCount(repo, sha) : null
      }).catch(e => { if (e.details?.pushed) pushed = true; throw e; }));
      pushed = result.outcome === 'pushed';
      const warnings = [...earlyWarnings, ...(afterPush ? await afterPush(dir, repo, result, earlyWarnings) : [])];
      return { ...result, repo, created, warnings };
    });
  } catch (e) {
    if (created && !pushed && repo) {
      const kept = { id: repo.id, full_name: repo.full_name, html_url: repo.html_url, clone_url: repo.clone_url };
      if (e.code === GIT_TIMEOUT) {
        // A git call killed by a timeout may have pushed before it stopped, so never delete here.
        e.details = { ...e.details, createdRepo: kept, cleanup: `The repository ${repo.full_name} was created for this push, which was interrupted. Check ${repo.html_url} before pushing again.` };
      } else if (!canCleanup) {
        // The token may not delete repositories (delete_repo is opt-in), so the repository stays,
        // announced and linked to the project rather than silently left behind.
        e.details = { ...e.details, createdRepo: kept, cleanup: `The repository ${repo.full_name} was created for this push and is still empty. It is now linked to this project, so pushing again fills it; to remove it instead, delete it on GitHub: ${repo.html_url}` };
      } else {
        // A repository this request created must not be left behind empty.
        try {
          await deleteRepo(repo);
          log(`Deleted empty repository ${repo.full_name} after failed first push.`);
          e.details = { ...e.details, cleanup: `The empty repository ${repo.full_name} created for this push was deleted.` };
        } catch (cleanupError) {
          log(`Did not delete repository ${repo.full_name}: ${cleanupError.message}`);
          e.details = { ...e.details, createdRepo: kept, cleanup: `The repository ${repo.full_name} created for this push could not be deleted automatically. It is now linked to this project, so pushing again fills it; to remove it instead, delete it on GitHub: ${repo.html_url}` };
        }
      }
    }
    throw e;
  }
}

// Auto-pull check for the background sync worker. Pulls only when the stored copy has no edits
// since the last known commit; otherwise reports a conflict and changes nothing.
export async function planPull({ git, dir, branch, knownCommit }) {
  try { await git(['fetch', '--prune', 'origin', branch]); } catch (e) { throw fetchError(e); }
  const remote = await tryRev(git, `refs/remotes/origin/${branch}`);
  if (!remote) return { action: 'none', reason: 'remote-branch-missing' };
  if (remote === knownCommit) return { action: 'none', reason: 'up-to-date', remote };
  const known = await knownCommitIn(git, knownCommit);
  if (!known) return { action: 'conflict', remote, reason: 'The GitHub branch has changes this project was never synced with. Push to reconcile.' };
  await git(['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
  await git(['update-ref', `refs/heads/${branch}`, known]);
  await git(['read-tree', known]);
  const plan = await classify(git, dir, { base: remote, known });
  if (plan.localChanges.length) {
    return { action: 'conflict', remote, reason: 'Remote changes detected but local edits were left untouched.', localChanges: plan.localChanges.slice(0, 50) };
  }
  await applyRemote(git, dir, remote, plan.baseTree, [...plan.takeRemote, ...plan.restore]);
  await git(['update-ref', `refs/heads/${branch}`, remote]);
  await git(['read-tree', remote]);
  return { action: 'pulled', remote, special: plan.special };
}
