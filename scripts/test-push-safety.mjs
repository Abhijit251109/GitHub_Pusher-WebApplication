// Regression tests for the "push creates an empty repository" bug and related push/sync safety.
// Uses real git with local bare repositories standing in for GitHub; no network or Supabase.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { buildManifest, verifyRestoredWorkspace, performPush, commitAndPush, planPull, PushError } from '../lib/push-core.js';

const execFileAsync = promisify(execFile);
const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull, GIT_TERMINAL_PROMPT: '0' };

function gitIn(dir) {
  return (args, { input } = {}) => {
    const run = execFileAsync('git', args, { cwd: dir, env: GIT_ENV, maxBuffer: 50 * 1024 * 1024 });
    if (input != null) run.child.stdin.end(input);
    return run;
  };
}
async function tmp(prefix) { return fs.mkdtemp(path.join(os.tmpdir(), `gpp-test-${prefix}-`)); }
async function write(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), content);
  }
}
async function prepareGit(dir, url) {
  const git = gitIn(dir);
  await git(['init', '-q']);
  await git(['config', 'user.name', 'Test']);
  await git(['config', 'user.email', 'test@localhost']);
  if (!url) return;
  try { await git(['remote', 'add', 'origin', url]); } catch { await git(['remote', 'set-url', 'origin', url]); }
}
async function bareRepo() {
  const dir = await tmp('remote');
  await gitIn(dir)(['init', '-q', '--bare', '-b', 'main']);
  return dir;
}
// Commits files to the remote from a separate clone, as if someone edited on GitHub.
async function commitToRemote(remote, files, remove = []) {
  const clone = await tmp('clone');
  await execFileAsync('git', ['clone', '-q', remote, clone], { env: GIT_ENV });
  const git = gitIn(clone);
  await git(['config', 'user.name', 'Other']);
  await git(['config', 'user.email', 'other@localhost']);
  await git(['checkout', '-q', '-B', 'main']);
  await write(clone, files);
  for (const rel of remove) await git(['rm', '-q', rel]);
  await git(['add', '-A']);
  await git(['commit', '-q', '-m', 'remote edit']);
  await git(['push', '-q', 'origin', 'main']);
  return (await git(['rev-parse', 'HEAD'])).stdout.trim();
}
async function remoteFiles(remote, ref = 'main') {
  try {
    const { stdout } = await gitIn(remote)(['ls-tree', '-r', '--name-only', ref]);
    return stdout.split('\n').filter(Boolean).sort();
  } catch { return []; }
}
async function remoteFile(remote, rel) { return (await gitIn(remote)(['show', `main:${rel}`])).stdout; }

// A workspace that is a copy of `files`, the way withWorkspace hands one to the push flow.
function workspaceOf(files) {
  return async (_project, fn) => {
    const dir = await tmp('work');
    await write(dir, files);
    return fn(dir);
  };
}
function pushDeps({ remote, files, created = false, overrides = {} }) {
  const calls = { resolveRepo: 0, deleteRepo: 0 };
  const deps = {
    withWorkspace: workspaceOf(files),
    prepareGit,
    async resolveRepo() { calls.resolveRepo++; return { repo: { clone_url: remote, full_name: 'me/repo', html_url: 'https://github.test/me/repo', default_branch: 'main' }, created }; },
    async deleteRepo() { calls.deleteRepo++; },
    gitFor: (dir, fn) => fn(gitIn(dir)),
    ...overrides
  };
  return { deps, calls };
}
async function push(project, opts, extra = {}) {
  return performPush({ project, branch: 'main', message: 'sync', ...extra, deps: opts.deps });
}

test('a failed restore aborts before any GitHub repository is resolved or created', async () => {
  const { deps, calls } = pushDeps({ remote: await bareRepo(), files: {} , overrides: {
    withWorkspace: async () => { throw new PushError('RESTORE_FAILED', 'Storage download failed', { status: 502 }); }
  } });
  await assert.rejects(push({ id: 'p' }, { deps }), { code: 'RESTORE_FAILED' });
  assert.equal(calls.resolveRepo, 0);
});

test('an empty workspace is refused and no repository is created', async () => {
  const remote = await bareRepo();
  const { deps, calls } = pushDeps({ remote, files: {} });
  await assert.rejects(push({ id: 'p' }, { deps }), { code: 'WORKSPACE_EMPTY' });
  assert.equal(calls.resolveRepo, 0);
  assert.deepEqual(await remoteFiles(remote), []);
});

test('a partially restored workspace fails the manifest check', async () => {
  const dir = await tmp('manifest');
  await write(dir, { 'a.txt': 'a', 'src/b.js': 'b', 'node_modules/x/index.js': 'skipped' });
  const manifest = await buildManifest(dir);
  assert.equal(manifest.fileCount, 2);
  await verifyRestoredWorkspace(dir, manifest);
  await fs.rm(path.join(dir, 'src/b.js'));
  await assert.rejects(verifyRestoredWorkspace(dir, manifest), { code: 'WORKSPACE_INCOMPLETE' });
  await assert.rejects(verifyRestoredWorkspace(await tmp('empty'), null), { code: 'WORKSPACE_EMPTY' });
});

test('first push to a new repository lands every file and is verified', async () => {
  const remote = await bareRepo();
  const { deps } = pushDeps({ remote, files: { 'index.html': '<h1>hi</h1>', 'src/app.js': 'x()' } });
  const result = await push({ id: 'p' }, { deps });
  assert.equal(result.outcome, 'pushed');
  assert.deepEqual(await remoteFiles(remote), ['index.html', 'src/app.js']);
  assert.equal((await gitIn(remote)(['rev-parse', 'main'])).stdout.trim(), result.commit);
});

test('pushing into a repository with a README keeps it and never rewrites history', async () => {
  const remote = await bareRepo();
  const readmeCommit = await commitToRemote(remote, { 'README.md': '# repo' });
  const { deps } = pushDeps({ remote, files: { 'app.py': 'print(1)' } });
  const result = await push({ id: 'p' }, { deps });
  assert.deepEqual(await remoteFiles(remote), ['README.md', 'app.py']);
  await gitIn(remote)(['merge-base', '--is-ancestor', readmeCommit, result.commit]);
});

test('differing files with no shared history are a conflict until the user chooses', async () => {
  const remote = await bareRepo();
  await commitToRemote(remote, { 'README.md': '# theirs' });
  const { deps } = pushDeps({ remote, files: { 'README.md': '# mine', 'a.txt': 'a' } });
  await assert.rejects(push({ id: 'p' }, { deps }), e => e.code === 'CONFLICT' && e.details.conflicts.includes('README.md'));
  assert.deepEqual(await remoteFiles(remote), ['README.md']);
  const result = await push({ id: 'p' }, { deps }, { keepLocalOnConflict: true });
  assert.deepEqual(result.overwritten, ['README.md']);
  assert.equal(await remoteFile(remote, 'README.md'), '# mine');
});

test('pushing unchanged files reports no-changes and creates no commit', async () => {
  const remote = await bareRepo();
  const files = { 'a.txt': 'a' };
  const first = await push({ id: 'p' }, pushDeps({ remote, files }));
  const project = { id: 'p', lastPushedCommit: first.commit, lastPushedAt: new Date().toISOString() };
  const second = await push(project, pushDeps({ remote, files }));
  assert.equal(second.outcome, 'no-changes');
  assert.equal((await gitIn(remote)(['rev-parse', 'main'])).stdout.trim(), first.commit);
});

test('remote edits the user did not touch are kept, not reverted', async () => {
  const remote = await bareRepo();
  const first = await push({ id: 'p' }, pushDeps({ remote, files: { 'a.txt': 'a1', 'b.txt': 'b1', 'gone.txt': 'g' } }));
  await commitToRemote(remote, { 'a.txt': 'a2-remote', 'new-remote.txt': 'n' });
  const project = { id: 'p', lastPushedCommit: first.commit, lastPushedAt: new Date().toISOString() };
  // Stored copy is stale for a.txt, edits b.txt, deletes gone.txt.
  await push(project, pushDeps({ remote, files: { 'a.txt': 'a1', 'b.txt': 'b2-local' } }));
  assert.equal(await remoteFile(remote, 'a.txt'), 'a2-remote');
  assert.equal(await remoteFile(remote, 'b.txt'), 'b2-local');
  assert.deepEqual(await remoteFiles(remote), ['a.txt', 'b.txt', 'new-remote.txt']);
});

test('the same file edited on both sides is a conflict', async () => {
  const remote = await bareRepo();
  const first = await push({ id: 'p' }, pushDeps({ remote, files: { 'a.txt': 'a1' } }));
  await commitToRemote(remote, { 'a.txt': 'a2-remote' });
  const project = { id: 'p', lastPushedCommit: first.commit, lastPushedAt: new Date().toISOString() };
  await assert.rejects(push(project, pushDeps({ remote, files: { 'a.txt': 'a2-local' } })), { code: 'CONFLICT' });
  assert.equal(await remoteFile(remote, 'a.txt'), 'a2-remote');
});

test('generated folders committed on GitHub are not deleted by a push', async () => {
  const remote = await bareRepo();
  await commitToRemote(remote, { 'dist/bundle.js': 'built', 'a.txt': 'a' });
  await push({ id: 'p' }, pushDeps({ remote, files: { 'a.txt': 'a', 'b.txt': 'b' } }));
  assert.deepEqual(await remoteFiles(remote), ['a.txt', 'b.txt', 'dist/bundle.js']);
});

test('a branch that moves during the push is never overwritten', async () => {
  const remote = await bareRepo();
  await commitToRemote(remote, { 'a.txt': 'a' });
  let raced = false;
  const { deps } = pushDeps({ remote, files: { 'a.txt': 'a', 'b.txt': 'b' }, overrides: {
    gitFor: (dir, fn) => {
      const git = gitIn(dir);
      return fn(async (args, opts) => {
        if (args[0] === 'push' && !raced) { raced = true; await commitToRemote(remote, { 'c.txt': 'someone else' }); }
        return git(args, opts);
      });
    }
  } });
  await assert.rejects(push({ id: 'p' }, { deps }), { code: 'REMOTE_CHANGED' });
  assert.deepEqual(await remoteFiles(remote), ['a.txt', 'c.txt']);
});

// Fails one git subcommand the way GitHub refusing it would.
function failingOn(subcommand) {
  return (dir, fn) => {
    const git = gitIn(dir);
    return fn(async (args, opts) => {
      if (args[0] === subcommand) throw new PushError('PUSH_FAILED', 'denied', { status: 502 });
      return git(args, opts);
    });
  };
}

test('a repository created for a push that fails is cleaned up', async () => {
  const remote = await bareRepo();
  const { deps, calls } = pushDeps({ remote, files: { 'a.txt': 'a' }, created: true, overrides: {
    gitFor: failingOn('push')
  } });
  await assert.rejects(push({ id: 'p' }, { deps }), e => e.code === 'PUSH_FAILED' && /deleted/.test(e.details.cleanup));
  assert.equal(calls.deleteRepo, 1);
});

test('when the cleanup itself fails the user is told the repository exists', async () => {
  const remote = await bareRepo();
  const { deps } = pushDeps({ remote, files: { 'a.txt': 'a' }, created: true, overrides: {
    gitFor: failingOn('push'),
    deleteRepo: async () => { throw new Error('Must have admin rights'); }
  } });
  await assert.rejects(push({ id: 'p' }, { deps }), e => /could not be deleted automatically/.test(e.details.cleanup));
});

test('without delete_repo a failed first push keeps the created repository, announced and linked', async () => {
  const remote = await bareRepo();
  const { deps, calls } = pushDeps({ remote, files: { 'a.txt': 'a' }, overrides: {
    gitFor: failingOn('push'),
    async resolveRepo() { calls.resolveRepo++; return { repo: { id: 7, clone_url: remote, full_name: 'me/repo', html_url: 'https://github.test/me/repo', default_branch: 'main' }, created: true, canCleanup: false }; }
  } });
  await assert.rejects(push({ id: 'p' }, { deps }), e => e.code === 'PUSH_FAILED'
    && /still empty/.test(e.details.cleanup) && /https:\/\/github\.test\/me\/repo/.test(e.details.cleanup)
    && e.details.createdRepo.full_name === 'me/repo' && e.details.createdRepo.id === 7);
  assert.equal(calls.deleteRepo, 0, 'no delete is attempted without the scope');
});

test('a remote tree count mismatch fails verification', async () => {
  const remote = await bareRepo();
  const { deps } = pushDeps({ remote, files: { 'a.txt': 'a' }, overrides: { remoteTreeCount: async () => ({ count: 0, truncated: false }) } });
  await assert.rejects(push({ id: 'p' }, { deps }), e => e.code === 'VERIFY_FAILED' && e.details.pushed === true);
});

async function pullInto(remote, files, knownCommit) {
  const dir = await tmp('sync');
  await write(dir, files);
  await prepareGit(dir, remote);
  const plan = await planPull({ git: gitIn(dir), dir, branch: 'main', knownCommit });
  return { dir, plan };
}

test('auto-pull applies remote changes only when the stored copy is unedited', async () => {
  const remote = await bareRepo();
  const first = await push({ id: 'p' }, pushDeps({ remote, files: { 'a.txt': 'a1', 'b.txt': 'b1' } }));
  const tip = await commitToRemote(remote, { 'a.txt': 'a2', 'c.txt': 'c' }, ['b.txt']);

  const clean = await pullInto(remote, { 'a.txt': 'a1', 'b.txt': 'b1' }, first.commit);
  assert.equal(clean.plan.action, 'pulled');
  assert.equal(clean.plan.remote, tip);
  assert.equal(await fs.readFile(path.join(clean.dir, 'a.txt'), 'utf8'), 'a2');
  assert.equal(await fs.readFile(path.join(clean.dir, 'c.txt'), 'utf8'), 'c');
  await assert.rejects(fs.access(path.join(clean.dir, 'b.txt')));

  const edited = await pullInto(remote, { 'a.txt': 'a1', 'b.txt': 'b1-local' }, first.commit);
  assert.equal(edited.plan.action, 'conflict');
  assert.equal(await fs.readFile(path.join(edited.dir, 'b.txt'), 'utf8'), 'b1-local');
  assert.equal(await fs.readFile(path.join(edited.dir, 'a.txt'), 'utf8'), 'a1');

  const upToDate = await pullInto(remote, { 'a.txt': 'a2', 'c.txt': 'c' }, tip);
  assert.equal(upToDate.plan.action, 'none');
});

test('direct commitAndPush refuses to commit an empty tree', async () => {
  const remote = await bareRepo();
  const dir = await tmp('direct');
  await prepareGit(dir, remote);
  await assert.rejects(commitAndPush({ git: gitIn(dir), dir, branch: 'main', message: 'x' }), { code: 'WORKSPACE_EMPTY' });
  assert.deepEqual(await remoteFiles(remote), []);
});

// ---------- symlinks / submodules on the remote (never written into the workspace) ----------

// Commits a symlink and a submodule entry to the remote, as someone could on GitHub.
async function commitSpecialToRemote(remote) {
  const clone = await tmp('special');
  await execFileAsync('git', ['clone', '-q', remote, clone], { env: GIT_ENV });
  const git = gitIn(clone);
  await git(['config', 'user.name', 'Other']);
  await git(['config', 'user.email', 'other@localhost']);
  await git(['checkout', '-q', '-B', 'main']);
  await fs.symlink('/etc/passwd', path.join(clone, 'escape-link'));
  await git(['add', 'escape-link']);
  await git(['update-index', '--add', '--cacheinfo', `160000,${'a'.repeat(40)},vendor/sub`]);
  await git(['commit', '-q', '-m', 'add symlink and submodule']);
  await git(['push', '-q', 'origin', 'main']);
  return (await git(['rev-parse', 'HEAD'])).stdout.trim();
}
async function symlinksIn(root) {
  const found = [];
  async function walk(dir) {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) found.push(path.relative(root, p));
      else if (e.isDirectory()) await walk(p);
    }
  }
  await walk(root);
  return found;
}
async function remoteEntry(remote, rel) {
  return (await gitIn(remote)(['ls-tree', 'main', '--', rel])).stdout.trim().split(/\s+/).slice(0, 3).join(' ');
}
// Same check createArchive performs before persisting: tar must not meet a symlink.
async function archiveLikeServer(dir) {
  const tar = await import('tar');
  const file = path.join(await tmp('tar'), 'w.tgz');
  await tar.c({ gzip: true, file, cwd: dir, portable: true, filter: (p, stat) => {
    if (stat.isSymbolicLink()) throw new Error(`symlink in archive: ${p}`);
    return !p.startsWith('./.git');
  } }, ['.']);
}

test('symlinks and submodules on GitHub are kept there but never written into the workspace (push)', async () => {
  const remote = await bareRepo();
  const first = await push({ id: 'p' }, pushDeps({ remote, files: { 'a.txt': 'a1' } }));
  await commitSpecialToRemote(remote);
  const linkBefore = await remoteEntry(remote, 'escape-link');
  const subBefore = await remoteEntry(remote, 'vendor/sub');
  let workDir;
  const project = { id: 'p', lastPushedCommit: first.commit, lastPushedAt: new Date().toISOString() };
  const { deps } = pushDeps({ remote, files: { 'a.txt': 'a2' }, overrides: {
    afterPush: async dir => { workDir = dir; assert.deepEqual(await symlinksIn(dir), []); await archiveLikeServer(dir); return []; }
  } });
  const result = await push(project, { deps });
  assert.equal(result.outcome, 'pushed');
  assert.deepEqual(result.special.sort(), ['escape-link', 'vendor/sub']);
  assert.ok(workDir);
  assert.equal(await remoteEntry(remote, 'escape-link'), linkBefore, 'symlink unchanged on GitHub');
  assert.equal(await remoteEntry(remote, 'vendor/sub'), subBefore, 'submodule unchanged on GitHub');
  assert.equal(await remoteFile(remote, 'a.txt'), 'a2');
});

test('auto-pull with a new remote symlink pulls the rest, writes no symlink, and does not wedge', async () => {
  const remote = await bareRepo();
  const first = await push({ id: 'p' }, pushDeps({ remote, files: { 'a.txt': 'a1' } }));
  await commitToRemote(remote, { 'b.txt': 'b-remote' });
  const tip = await commitSpecialToRemote(remote);

  const pulled = await pullInto(remote, { 'a.txt': 'a1' }, first.commit);
  assert.equal(pulled.plan.action, 'pulled');
  assert.equal(pulled.plan.remote, tip);
  assert.deepEqual(pulled.plan.special.sort(), ['escape-link', 'vendor/sub']);
  assert.equal(await fs.readFile(path.join(pulled.dir, 'b.txt'), 'utf8'), 'b-remote');
  assert.deepEqual(await symlinksIn(pulled.dir), []);
  await archiveLikeServer(pulled.dir); // persistWorkingTree's archive step succeeds

  // Next cycle, from the stored copy: up to date, not an error or a conflict.
  const next = await pullInto(remote, { 'a.txt': 'a1', 'b.txt': 'b-remote' }, tip);
  assert.equal(next.plan.action, 'none');
  // And a later push from that copy works and keeps the special entries.
  const project = { id: 'p', lastPulledCommit: tip, lastSyncAt: new Date().toISOString() };
  const again = await push(project, pushDeps({ remote, files: { 'a.txt': 'a1', 'b.txt': 'b2' } }));
  assert.equal(again.outcome, 'pushed');
  assert.deepEqual((await remoteFiles(remote)).sort(), ['a.txt', 'b.txt', 'escape-link', 'vendor/sub']);
});

// ---------- git stderr stays out of user-facing messages ----------

test('a rejected push reports a safe message; git stderr is kept for the log only', async () => {
  const remote = await bareRepo();
  const hook = path.join(remote, 'hooks', 'pre-receive');
  await fs.writeFile(hook, '#!/bin/sh\necho "remote: internal url https://x-access-token:ghs_SECRET@github.com/me/r.git" >&2\nexit 1\n');
  await fs.chmod(hook, 0o755);
  const error = await push({ id: 'p' }, pushDeps({ remote, files: { 'a.txt': 'a' } })).catch(e => e);
  assert.equal(error.code, 'PUSH_FAILED');
  assert.equal(error.message, 'GitHub rejected the push.');
  assert.doesNotMatch(JSON.stringify({ message: error.message, details: error.details }), /ghs_SECRET|x-access-token/);
  assert.match(error.internal, /ghs_SECRET/);
});

test('a protected-branch rejection gets a specific safe message', async () => {
  const remote = await bareRepo();
  const hook = path.join(remote, 'hooks', 'pre-receive');
  await fs.writeFile(hook, '#!/bin/sh\necho "remote: error: GH006: Protected branch update failed for refs/heads/main." >&2\nexit 1\n');
  await fs.chmod(hook, 0o755);
  const error = await push({ id: 'p' }, pushDeps({ remote, files: { 'a.txt': 'a' } })).catch(e => e);
  assert.equal(error.message, 'The branch is protected on GitHub, so it cannot be pushed to directly.');
});

// ---------- timeouts: a hung git call is killed and never mistaken for an ordinary answer ----------

test('a hung git call is killed after the per-call timeout', async () => {
  const { createGitRunner } = await import('../lib/git.js');
  const runGit = createGitRunner({ timeoutMs: 300, jobTimeoutMs: 60_000 });
  const dir = await tmp('hang');
  const started = Date.now();
  // `hash-object --stdin` waits forever for input that never comes.
  const error = await runGit(dir, ['hash-object', '--stdin']).catch(e => e);
  assert.equal(error.code, 'GIT_TIMEOUT');
  assert.equal(error.status, 504);
  assert.match(error.internal, /GIT_TIMEOUT_MS/);
  assert.ok(Date.now() - started < 5000);
});

test('the job deadline stops git calls even when each call is within its own limit', async () => {
  const { createGitRunner } = await import('../lib/git.js');
  const runGit = createGitRunner({ timeoutMs: 60_000, jobTimeoutMs: 200 });
  const error = await runGit(await tmp('deadline'), ['hash-object', '--stdin'], {}, { signal: AbortSignal.timeout(200) }).catch(e => e);
  assert.equal(error.code, 'GIT_TIMEOUT');
  assert.match(error.internal, /JOB_TIMEOUT_MS/);
});

function timingOutOn(subcommand) {
  return (dir, fn) => {
    const git = gitIn(dir);
    return fn(async (args, opts) => {
      if (args[0] === subcommand) throw new PushError('GIT_TIMEOUT', 'A git operation took too long and was stopped.', { status: 504 });
      return git(args, opts);
    });
  };
}

test('a timeout while reading the remote branch is not treated as "branch does not exist"', async () => {
  const remote = await bareRepo();
  await commitToRemote(remote, { 'README.md': '# theirs' });
  const { deps } = pushDeps({ remote, files: { 'a.txt': 'a' }, overrides: { gitFor: timingOutOn('rev-parse') } });
  await assert.rejects(push({ id: 'p' }, { deps }), { code: 'GIT_TIMEOUT' });
  assert.deepEqual(await remoteFiles(remote), ['README.md'], 'nothing was pushed on a guessed base');
});

test('a repository created for a push that timed out is never auto-deleted', async () => {
  const remote = await bareRepo();
  const { deps, calls } = pushDeps({ remote, files: { 'a.txt': 'a' }, created: true, overrides: { gitFor: timingOutOn('push') } });
  await assert.rejects(push({ id: 'p' }, { deps }), e => e.code === 'GIT_TIMEOUT' && /interrupted/.test(e.details.cleanup));
  assert.equal(calls.deleteRepo, 0);
});

// --- GitHub credentials (the askpass helper that git could never run) ---

test('git receives the token through gitAuthEnv', async () => {
  const { createGitRunner, gitAuthEnv, checkGitCredentials } = await import('../lib/git.js');
  const runGit = createGitRunner({ timeoutMs: 10_000, jobTimeoutMs: 10_000 });
  const dir = await tmp('cred');
  const { stdout } = await runGit(dir, ['credential', 'fill'], gitAuthEnv('tok-123'), { input: 'protocol=https\nhost=github.com\n\n' });
  assert.match(stdout, /^username=x-access-token$/m);
  assert.match(stdout, /^password=tok-123$/m);
  await checkGitCredentials(runGit, dir, gitAuthEnv('tok-123'), 'tok-123');
});

test('a broken credential setup is reported as a server problem and stops before GitHub is touched', async () => {
  const { createGitRunner, checkGitCredentials } = await import('../lib/git.js');
  const runGit = createGitRunner({ timeoutMs: 10_000, jobTimeoutMs: 10_000 });
  // The askpass file this replaced: JavaScript with no shebang, which git runs with /bin/sh.
  const askpass = path.join(await tmp('askpass'), 'askpass.cjs');
  await fs.writeFile(askpass, "const p=process.argv.slice(2).join(' ');process.stdout.write(/username/i.test(p)?'x-access-token':(process.env.GH_TOKEN||''));\n", { mode: 0o700 });
  const broken = { GIT_ASKPASS: askpass, GH_TOKEN: 'tok', GIT_TERMINAL_PROMPT: '0' };
  const error = await checkGitCredentials(runGit, await tmp('cred'), broken, 'tok').catch(e => e);
  assert.equal(error.code, 'GIT_AUTH_SETUP');
  assert.doesNotMatch(error.message, /Reconnect GitHub/);

  const { deps, calls } = pushDeps({ remote: await bareRepo(), files: { 'a.txt': 'a' }, created: true, overrides: {
    checkGitAuth: dir => checkGitCredentials(runGit, dir, broken, 'tok')
  } });
  await assert.rejects(push({ id: 'p' }, { deps }), { code: 'GIT_AUTH_SETUP' });
  assert.equal(calls.resolveRepo, 0, 'no repository was looked up or created');
});

test('files that cannot be committed are found before a repository is created', async () => {
  const { deps, calls } = pushDeps({ remote: await bareRepo(), files: { 'a.txt': 'a' }, created: true, overrides: {
    gitFor: (dir, fn) => {
      const git = gitIn(dir);
      return fn(async (args, opts) => {
        if (args[0] === 'write-tree') throw new PushError('PUSH_FAILED', 'index broken', { status: 500 });
        return git(args, opts);
      });
    }
  } });
  await assert.rejects(push({ id: 'p' }, { deps }), { code: 'PUSH_FAILED' });
  assert.equal(calls.resolveRepo, 0);
});

// A smart-HTTP git server that, like GitHub, answers 401 until it gets Basic auth with the token.
async function authenticatedGitServer(token) {
  const http = await import('http');
  const { spawn } = await import('child_process');
  const root = await tmp('http-root');
  await gitIn(root)(['init', '-q', '--bare', '-b', 'main', 'repo.git']);
  const expected = 'Basic ' + Buffer.from(`x-access-token:${token}`).toString('base64');
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== expected) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="test"' });
      return res.end();
    }
    const url = new URL(req.url, 'http://localhost');
    const cgi = spawn('git', ['http-backend'], { env: {
      ...GIT_ENV, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1', REMOTE_USER: 'x-access-token',
      PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), REQUEST_METHOD: req.method,
      CONTENT_TYPE: req.headers['content-type'] || '', HTTP_CONTENT_ENCODING: req.headers['content-encoding'] || '',
      GIT_PROTOCOL: req.headers['git-protocol'] || ''
    } });
    req.pipe(cgi.stdin);
    let head = Buffer.alloc(0);
    let headersDone = false;
    cgi.stdout.on('data', chunk => {
      if (headersDone) return res.write(chunk);
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) return;
      headersDone = true;
      let status = 200;
      for (const line of head.slice(0, end).toString().split('\r\n')) {
        const [name, ...rest] = line.split(':');
        if (name.toLowerCase() === 'status') status = parseInt(rest.join(':'), 10);
        else res.setHeader(name, rest.join(':').trim());
      }
      res.writeHead(status);
      res.write(head.slice(end + 4));
    });
    cgi.stdout.on('end', () => res.end());
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/repo.git`, bare: path.join(root, 'repo.git'), close: () => server.close() };
}

test('a push authenticates to an HTTP remote with the token and lands every file', async () => {
  const { createGitRunner, withGitAuth, checkGitCredentials } = await import('../lib/git.js');
  const runGit = createGitRunner({ timeoutMs: 30_000, jobTimeoutMs: 60_000 });
  const remote = await authenticatedGitServer('good-token');
  try {
    const authed = token => ({
      gitFor: (dir, fn) => withGitAuth(token, env => fn((args, opts) => runGit(dir, args, env, opts))),
      checkGitAuth: dir => withGitAuth(token, env => checkGitCredentials(runGit, dir, env, token))
    });
    const rejected = pushDeps({ remote: remote.url, files: { 'a.txt': 'a' }, created: true, overrides: authed('wrong-token') });
    await assert.rejects(push({ id: 'p' }, rejected), e => e.code === 'FETCH_FAILED' && /denied access/.test(e.message) && /deleted/.test(e.details.cleanup));
    assert.equal(rejected.calls.deleteRepo, 1, 'the empty repository created for the failed push is removed');

    const files = { 'README.md': 'root', 'a/README.md': 'a', 'a/b/c.txt': 'c' };
    const result = await push({ id: 'p' }, pushDeps({ remote: remote.url, files, created: true, overrides: authed('good-token') }));
    assert.equal(result.outcome, 'pushed');
    assert.deepEqual(await remoteFiles(remote.bare), ['README.md', 'a/README.md', 'a/b/c.txt']);
  } finally { remote.close(); }
});
