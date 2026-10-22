// Security regression tests: origin policy, rate limits/job bounds, client-safe errors and input
// validation. Unit tests cover lib/security.js; the end-to-end tests start the real server in
// production mode against an in-process mock of the Supabase REST/Storage API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { createOriginPolicy, parseTrustProxy, parseBranch, parseRepoId, assertRepoName, createJobGate, errorResponse, AppError, envInt, tokenCanDeleteRepos } from '../lib/security.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('origin policy: only configured origins, localhost only outside production', () => {
  const prod = createOriginPolicy({ isProd: true, frontendUrl: 'https://owner.github.io/app', publicBaseUrl: 'https://api.example.com' });
  assert.equal(prod.allowed('https://owner.github.io'), true);
  assert.equal(prod.allowed('https://api.example.com'), true);
  for (const bad of ['https://evil.github.io', 'https://owner.github.io.evil.com', 'http://owner.github.io', 'null', 'http://localhost:5173', 'garbage']) {
    assert.equal(prod.allowed(bad), false, bad);
  }
  const dev = createOriginPolicy({ isProd: false });
  assert.equal(dev.allowed('http://localhost:5173'), true);
  assert.equal(dev.allowed('https://evil.github.io'), false);
});

test('TRUST_PROXY parsing refuses the spoofable "true"', () => {
  assert.equal(parseTrustProxy(undefined), undefined);
  assert.equal(parseTrustProxy('1'), 1);
  assert.equal(parseTrustProxy('loopback'), 'loopback');
  assert.throws(() => parseTrustProxy('true'), /spoof/);
});

test('branch must be a plain branch-name string', () => {
  assert.equal(parseBranch(undefined), 'main');
  assert.equal(parseBranch('feature/x-1.2'), 'feature/x-1.2');
  for (const bad of [['a', 'b'], { a: 1 }, 5, 'refs/heads/x', '-x', 'HEAD', 'a b', 'a~1', 'x'.repeat(201)]) {
    assert.throws(() => parseBranch(bad), { code: 'INVALID_BRANCH' }, JSON.stringify(bad));
  }
});

test('repoId must be a positive integer and repo names cannot be dot segments', () => {
  assert.equal(parseRepoId(123), '123');
  assert.equal(parseRepoId('123'), '123');
  assert.equal(parseRepoId(null), null);
  for (const bad of ['123/../../user/repos', '0', '-1', '1.5', '12?x=1', [1], 1.5, '٣']) {
    assert.throws(() => parseRepoId(bad), { code: 'INVALID_REPO_ID' }, JSON.stringify(bad));
  }
  assert.equal(assertRepoName('my-repo.js'), 'my-repo.js');
  for (const bad of ['.', '..', '...', 'a/b', '']) assert.throws(() => assertRepoName(bad), { code: 'INVALID_REPO_NAME' });
});

test('job gate bounds per-user and server-wide work', () => {
  const gate = createJobGate({ maxConcurrent: 2, maxPerUser: 1 });
  const a = gate.tryAcquire('a');
  assert.equal(gate.tryAcquire('a').code, 'JOB_IN_PROGRESS');
  const b = gate.tryAcquire('b');
  assert.equal(gate.tryAcquire('c').code, 'SERVER_BUSY');
  a.release();
  a.release(); // idempotent
  assert.equal(gate.running, 1);
  assert.equal(gate.tryAcquire('c').ok, true);
  b.release();
});

test('unexpected errors are replaced by a generic message with a reference id', () => {
  const logs = [];
  const raw = Object.assign(new Error('Storage download failed: s3://internal/projects/42/working.tgz'), { stderr: 'fatal: https://x-access-token:ghs_secret@github.com/me/r.git' });
  const { status, body } = errorResponse(raw, { log: (...args) => logs.push(args.join(' ')) });
  assert.equal(status, 500);
  assert.equal(body.code, 'SERVER_ERROR');
  assert.doesNotMatch(JSON.stringify(body), /s3:|ghs_secret|working\.tgz/);
  assert.match(logs[0], new RegExp(body.ref));
  assert.match(logs[0], /ghs_secret/);
  const known = errorResponse(new AppError('CONFLICT', 'Pick a side.', { status: 409, internal: 'stderr text' }), { log: () => {} });
  assert.deepEqual(known, { status: 409, body: { error: 'Pick a side.', code: 'CONFLICT' } });
});

test('delete_repo is read from the scope header, and unknown is not treated as granted or refused', () => {
  assert.equal(tokenCanDeleteRepos('repo, delete_repo'), true);
  for (const scopes of ['repo', 'repo, offline_access', '', 'delete_repos']) assert.equal(tokenCanDeleteRepos(scopes), false);
  assert.equal(tokenCanDeleteRepos(null), null, 'GitHub App tokens send no scope header');
});

test('the default OAuth scope does not include delete_repo', async () => {
  const source = await fs.readFile(path.join(ROOT, 'server.js'), 'utf8');
  const fallback = source.match(/GITHUB_OAUTH_SCOPE \|\| '([^']*)'/)[1];
  assert.equal(fallback, 'repo offline_access');
  for (const file of ['render.yaml', '.env.example']) {
    assert.doesNotMatch(await fs.readFile(path.join(ROOT, file), 'utf8'), /^\s*(value: |GITHUB_OAUTH_SCOPE=).*delete_repo/m, file);
  }
});

test('integer settings: unset uses the default, anything not a whole number in range is refused', () => {
  assert.equal(envInt({}, 'X', 7), 7);
  assert.equal(envInt({ X: '' }, 'X', 7), 7);
  assert.equal(envInt({ X: ' 12 ' }, 'X', 7), 12);
  for (const bad of ['abc', '0', '-3', '1.5', '1e3', '0x10', '99999999999999999999']) {
    assert.throws(() => envInt({ X: bad }, 'X', 7), /X must be a whole number/, bad);
  }
  assert.throws(() => envInt({ X: '70000' }, 'X', 1, { max: 65535 }), /between 1 and 65535/);
});

// ---------- end to end: real server, mocked Supabase ----------

const SESSION_SECRET = 'e2e-session-secret-'.padEnd(48, 'x');
const ENC_KEY_HEX = crypto.randomBytes(32).toString('hex');
const hashKey = crypto.createHash('sha256').update(SESSION_SECRET).digest();
const tokenHash = token => crypto.createHmac('sha256', hashKey).update(token).digest('hex');
function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(ENC_KEY_HEX, 'hex'), iv);
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${data.toString('base64url')}`;
}

// Users u1..u5, each with one project. u1-u3 have slow storage so their jobs stay running.
const users = {};
for (let i = 1; i <= 5; i++) {
  users[`u${i}`] = { token: `token-u${i}`, id: String(1000 + i), projectId: crypto.randomUUID(), slow: i <= 3 };
}
// u6 was stored before manifests existed: its manifest is missing, which must not block a restore.
users.u6 = { token: 'token-u6', id: '1006', projectId: crypto.randomUUID(), slow: false, legacy: true };
const byHash = new Map(Object.values(users).map(u => [tokenHash(u.token), u]));
const byProject = new Map(Object.values(users).map(u => [u.projectId, u]));
const counters = { oauthInserts: 0, storageReads: 0 };

// Seeded projects (u1-u6) have failing Storage; anything else lives in this in-memory store, so a
// real upload followed by a delete can be checked end to end.
const store = new Map(); // object path -> Buffer
const projectRows = new Map(); // id -> row written by the server
// u7 uploads and deletes a real project; u8 probes unknown project ids. Neither has seeded data.
users.u7 = { token: 'token-u7', id: '1007', projectId: null };
users.u8 = { token: 'token-u8', id: '1008', projectId: null };
// u9 checks that uploads keep folder paths and never lose files silently.
users.u9 = { token: 'token-u9', id: '1009', projectId: null };
for (const u of [users.u7, users.u8, users.u9]) byHash.set(tokenHash(u.token), u);

async function storageRoute(req, res, rest, body, send) {
  const BUCKET = 'gpp-private/';
  if (req.method === 'POST' && rest.startsWith('list/')) {
    const { prefix = '' } = JSON.parse(body.toString() || '{}');
    const dir = prefix.replace(/\/$/, '') + '/';
    const names = [...store.keys()].filter(k => k.startsWith(dir) && !k.slice(dir.length).includes('/')).map(k => k.slice(dir.length));
    return send(200, names.map(name => ({ name, id: `id-${name}`, metadata: { size: store.get(dir + name).length } })));
  }
  if (req.method === 'DELETE') {
    const { prefixes = [] } = JSON.parse(body.toString() || '{}');
    const removed = prefixes.filter(p => store.delete(p));
    return send(200, removed.map(name => ({ name })));
  }
  if (req.method === 'GET' && rest.startsWith('info/' + BUCKET)) {
    const key = decodeURIComponent(rest.slice(('info/' + BUCKET).length));
    return store.has(key) ? send(200, { name: key, size: store.get(key).length }) : send(400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
  }
  const key = decodeURIComponent(rest.slice(BUCKET.length));
  if (req.method === 'POST' || req.method === 'PUT') { store.set(key, body); return send(200, { Key: BUCKET + key }); }
  if (store.has(key)) { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); return res.end(store.get(key)); }
  return send(400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
}

function mockSupabase() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://mock');
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const eq = name => (url.searchParams.get(name) || '').replace(/^eq\./, '');
    if (url.pathname.startsWith('/storage/v1/object/')) {
      const owner = Object.values(users).find(u => u.projectId && url.pathname.includes(u.projectId));
      if (!owner) return storageRoute(req, res, url.pathname.slice('/storage/v1/object/'.length), body, send);
      counters.storageReads++;
      await new Promise(r => setTimeout(r, owner.slow ? 1500 : 10));
      if (owner.legacy && url.pathname.endsWith('/manifest.json')) return send(400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
      return send(500, { statusCode: '500', error: 'internal', message: `upstream s3://internal-bucket/${url.pathname} timed out at 10.0.3.7` });
    }
    const table = url.pathname.replace('/rest/v1/', '');
    if (table === 'projects' && req.method === 'POST') {
      for (const row of [].concat(JSON.parse(body.toString()))) projectRows.set(row.id, row);
      return send(201, []);
    }
    if (table === 'projects' && req.method === 'DELETE') { projectRows.delete(eq('id')); return send(204); }
    if (req.method !== 'GET') {
      if (table === 'oauth_attempts') counters.oauthInserts++;
      return send(201, []);
    }
    if (table === 'sessions') {
      const u = byHash.get(eq('id'));
      return send(200, u ? [{ id: eq('id'), user_id: u.id, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600e3).toISOString() }] : []);
    }
    if (table === 'users') {
      const u = Object.values(users).find(x => x.id === eq('id'));
      return send(200, u ? [{ id: u.id, login: `login-${u.id}`, name: 'Tester', avatar: '', github_token_enc: encrypt('gho_fake') }] : []);
    }
    if (table === 'projects') {
      const stored = projectRows.get(eq('id'));
      if (stored) return send(200, [stored]);
      const u = byProject.get(eq('id'));
      return send(200, u ? [{ id: u.projectId, user_id: u.id, name: 'proj', file_count: 3, storage_path: `projects/${u.id}/${u.projectId}/working.tgz`, sync_state: 'local' }] : []);
    }
    return send(200, []);
  });
}

let mock;
let server;
let base;
let serverLog = '';
const PORT = 40000 + Math.floor(Math.random() * 20000);

before(async () => {
  mock = mockSupabase();
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${PORT}`;
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'production', PORT: String(PORT), HOST: '127.0.0.1',
      SUPABASE_URL: `http://127.0.0.1:${mock.address().port}`, SUPABASE_SECRET_KEY: 'mock-key',
      SESSION_SECRET, TOKEN_ENCRYPTION_KEY: ENC_KEY_HEX,
      FRONTEND_URL: 'https://owner.github.io/app', PUBLIC_BASE_URL: base, TRUST_PROXY: '1',
      GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'secret',
      RATE_LIMIT_AUTH_PER_15_MIN: '5', RATE_LIMIT_PUSH_PER_15_MIN: '10', MAX_CONCURRENT_JOBS: '2', SYNC_INTERVAL_MS: '3600000'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', d => { serverLog += d; });
  server.stderr.on('data', d => { serverLog += d; });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`server did not start:\n${serverLog}`);
});
after(() => { server?.kill(); mock?.close(); });

const push = (user, body, headers = {}) => fetch(`${base}/api/github/push`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user.token}`, ...headers },
  body: JSON.stringify({ projectId: user.projectId, ...body })
});

test('e2e 1: an arbitrary *.github.io origin gets no credentialed CORS and fails the origin check', async () => {
  const evil = await fetch(`${base}/api/projects`, { method: 'OPTIONS', headers: { Origin: 'https://evil.github.io' } });
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
  assert.equal(evil.headers.get('access-control-allow-credentials'), null);
  const good = await fetch(`${base}/api/projects`, { method: 'OPTIONS', headers: { Origin: 'https://owner.github.io' } });
  assert.equal(good.headers.get('access-control-allow-origin'), 'https://owner.github.io');
  const csrf = await fetch(`${base}/api/github/push`, { method: 'POST', headers: { Origin: 'https://evil.github.io', Cookie: `gpp_session=${users.u5.token}`, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(csrf.status, 403);
  assert.equal((await csrf.json()).code, 'ORIGIN_NOT_ALLOWED');
  const csp = good.headers.get('content-security-policy') || (await fetch(`${base}/`)).headers.get('content-security-policy');
  assert.doesNotMatch(csp, /\*\.github\.io/);
});

test('e2e 4 and 6: malformed repoId, repoName and branch are rejected with 400 before any work', async () => {
  // Rejected requests still count toward u5's push limit, which is intended.
  const before = counters.storageReads;
  const cases = [
    [{ repoId: '123/../../user/repos' }, 'INVALID_REPO_ID'],
    [{ repoName: '..' }, 'INVALID_REPO_NAME'],
    [{ branch: ['a', 'b'] }, 'INVALID_BRANCH'],
    [{ branch: 'refs/heads/x' }, 'INVALID_BRANCH'],
    [{ branch: 'a..b' }, 'INVALID_BRANCH'],
    [{ visibility: 'internal' }, 'INVALID_INPUT'],
    [{ projectId: ['x'] }, 'INVALID_PROJECT']
  ];
  for (const [body, code] of cases) {
    const r = await push(users.u5, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal((await r.json()).code, code, JSON.stringify(body));
  }
  assert.equal(counters.storageReads, before, 'validation failures must not touch storage');
});

test('e2e 3: a storage failure returns a safe message; internals only reach the log', async () => {
  const r = await push(users.u4, {});
  const body = await r.json();
  assert.equal(r.status, 502);
  assert.equal(body.code, 'RESTORE_FAILED');
  assert.doesNotMatch(JSON.stringify(body), /s3:|10\.0\.3\.7|working\.tgz|internal-bucket/);
  await new Promise(r => setTimeout(r, 50));
  assert.match(serverLog, /RESTORE_FAILED.*internal-bucket/s);
});

test('e2e 2: concurrent heavy jobs are bounded per user and server-wide with immediate 429s', async () => {
  const [first, sameUser, second, third] = await Promise.all([
    push(users.u1, {}),
    new Promise(r => setTimeout(r, 200)).then(() => push(users.u1, {})),
    new Promise(r => setTimeout(r, 200)).then(() => push(users.u2, {})),
    new Promise(r => setTimeout(r, 400)).then(() => push(users.u3, {}))
  ]);
  assert.equal(sameUser.status, 429);
  assert.equal((await sameUser.json()).code, 'JOB_IN_PROGRESS');
  assert.equal(third.status, 429);
  assert.equal((await third.json()).code, 'SERVER_BUSY');
  assert.equal(first.status, 502);
  assert.equal(second.status, 502);
});

test('e2e 2: per-user push limit returns 429 without doing the work', async () => {
  // u4 already made 1 counted push above (RESTORE_FAILED); the limit is 10 per window.
  const reads = counters.storageReads;
  const statuses = [];
  for (let i = 0; i < 10; i++) statuses.push((await push(users.u4, {})).status);
  assert.deepEqual(statuses, [...Array(9).fill(502), 429]);
  // Each allowed push stops at the failing manifest read: exactly one storage read, none for the 429.
  assert.equal(counters.storageReads - reads, 9, 'the limited request must not touch storage');
});

test('e2e 2: auth endpoints are limited per client IP, keyed on X-Forwarded-For via TRUST_PROXY', async () => {
  const login = ip => fetch(`${base}/api/auth/login`, { redirect: 'manual', headers: { 'X-Forwarded-For': ip } });
  const inserts = counters.oauthInserts;
  const statuses = [];
  for (let i = 0; i < 7; i++) statuses.push((await login('203.0.113.9')).status);
  assert.deepEqual(statuses, [302, 302, 302, 302, 302, 429, 429]);
  assert.equal(counters.oauthInserts - inserts, 5, 'limited requests must not insert oauth_attempts rows');
  assert.equal((await login('198.51.100.20')).status, 302, 'a different client IP has its own budget');
});

test('e2e 2: uploads are refused before the body is read when not signed in', async () => {
  const r = await fetch(`${base}/api/projects`, { method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=x' }, body: '--x--' });
  assert.equal(r.status, 401);
});

test('e2e: a project stored before manifests existed still restores (missing manifest is not an error)', async () => {
  const reads = counters.storageReads;
  const r = await push(users.u6, {});
  assert.equal((await r.json()).code, 'RESTORE_FAILED'); // the mock archive itself fails
  assert.equal(counters.storageReads - reads, 2, 'missing manifest falls through to the archive download');
  assert.match(serverLog, /working\.tgz: HTTP 500/);
});

const asUser = (user, method, path, body) => fetch(`${base}${path}`, {
  method,
  headers: { Authorization: `Bearer ${user.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
  body: body ? JSON.stringify(body) : undefined
});

test('e2e: an unknown project id is a 404 PROJECT_NOT_FOUND on every route', async () => {
  const id = crypto.randomUUID();
  const responses = [
    await asUser(users.u8, 'GET', `/api/projects/${id}/history`),
    await asUser(users.u8, 'DELETE', `/api/projects/${id}`),
    await asUser(users.u8, 'POST', '/api/github/fetch', { projectId: id }),
    await asUser(users.u8, 'POST', '/api/github/push', { projectId: id })
  ];
  for (const r of responses) {
    assert.equal(r.status, 404, r.url);
    assert.deepEqual(await r.json(), { error: 'Project not found.', code: 'PROJECT_NOT_FOUND' });
  }
  assert.doesNotMatch(serverLog, /Cannot read properties of null/);
});

test('e2e: unknown API paths are JSON 404s, not the HTML app shell', async () => {
  for (const [method, path] of [['GET', '/api/does-not-exist'], ['POST', '/api/projects/x/y/z'], ['DELETE', '/api/nope']]) {
    const r = await fetch(`${base}${path}`, { method });
    assert.equal(r.status, 404, `${method} ${path}`);
    assert.match(r.headers.get('content-type'), /json/);
    assert.deepEqual(await r.json(), { error: 'Not found.', code: 'NOT_FOUND' });
  }
  assert.match(await (await fetch(`${base}/some/page`)).text(), /<html/i, 'non-API paths still serve the app');
});

test('e2e: deleting a freshly uploaded project leaves no Storage objects behind', async () => {
  const form = new FormData();
  form.append('projectName', 'delete-me');
  form.append('files', new Blob(['hello']), 'delete-me/a.txt');
  form.append('files', new Blob(['world']), 'delete-me/src/b.txt');
  const up = await fetch(`${base}/api/projects`, { method: 'POST', headers: { Authorization: `Bearer ${users.u7.token}` }, body: form });
  const project = await up.json();
  assert.equal(up.status, 200, JSON.stringify(project));
  const folder = `projects/${users.u7.id}/${project.id}/`;
  const before = [...store.keys()].filter(k => k.startsWith(folder)).sort();
  assert.deepEqual(before, [`${folder}manifest.json`, `${folder}working.tgz`]);
  store.set(`snapshots/${users.u7.id}/${project.id}/stray.tgz`, Buffer.from('x')); // e.g. a snapshot whose row was never written

  const del = await asUser(users.u7, 'DELETE', `/api/projects/${project.id}`);
  assert.deepEqual(await del.json(), { ok: true });
  const left = [...store.keys()].filter(k => k.includes(project.id));
  assert.deepEqual(left, []);
  assert.equal(projectRows.has(project.id), false);
});

test('e2e: the server refuses to start with a non-numeric limit', async () => {
  for (const [name, value] of [['MAX_CONCURRENT_JOBS', 'abc'], ['RATE_LIMIT_PUSH_PER_15_MIN', 'abc'], ['MAX_ARCHIVE_MB', '0'], ['GIT_TIMEOUT_MS', '1e9']]) {
    const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, NODE_ENV: 'development', [name]: value }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', d => { output += d; });
    child.stderr.on('data', d => { output += d; });
    const code = await new Promise(resolve => child.on('exit', resolve));
    assert.notEqual(code, 0, `${name}=${value} should stop startup`);
    assert.match(output, new RegExp(`${name} must be a whole number`));
  }
});

function uploadForm(name, files, manifest) {
  const form = new FormData();
  form.append('projectName', name);
  if (manifest) form.append('manifest', JSON.stringify(manifest));
  for (const [rel, content] of Object.entries(files)) form.append('files', new Blob([content]), rel);
  return form;
}
const upload = (user, form) => fetch(`${base}/api/projects`, { method: 'POST', headers: { Authorization: `Bearer ${user.token}` }, body: form });
const storedPaths = (user, id) => Object.keys(JSON.parse(store.get(`projects/${user.id}/${id}/manifest.json`)).files).sort();

test('e2e: an upload keeps every folder path, so same-named files in different folders all survive', async () => {
  const files = { 'site/README.md': 'root', 'site/a/README.md': 'a', 'site/b/README.md': 'b', 'site/a/b/c.txt': 'c' };
  const manifest = Object.entries(files).map(([path, content]) => ({ path, size: content.length }));
  const res = await upload(users.u9, uploadForm('nested', files, manifest));
  const project = await res.json();
  assert.equal(res.status, 200, JSON.stringify(project));
  assert.equal(project.files, 4);
  assert.deepEqual(storedPaths(users.u9, project.id), ['site/README.md', 'site/a/README.md', 'site/a/b/c.txt', 'site/b/README.md']);
});

test('e2e: an upload missing a selected file, or with a duplicate path, stores nothing', async () => {
  const before = store.size;
  const rowsBefore = projectRows.size;
  const files = { 'p/a.txt': 'a', 'p/b.txt': 'b' };
  const manifest = [{ path: 'p/a.txt', size: 1 }, { path: 'p/b.txt', size: 1 }, { path: 'p/lost.txt', size: 4 }];
  const incomplete = await upload(users.u9, uploadForm('incomplete', files, manifest));
  const body = await incomplete.json();
  assert.equal(incomplete.status, 422);
  assert.equal(body.code, 'UPLOAD_INCOMPLETE');
  assert.deepEqual(body.details.missing, ['p/lost.txt']);

  const form = uploadForm('dupes', files);
  form.append('files', new Blob(['again']), 'p/a.txt');
  const dup = await upload(users.u9, form);
  assert.equal(dup.status, 422);
  assert.equal((await dup.json()).code, 'DUPLICATE_PATH');

  assert.equal(store.size, before, 'no Storage objects were written');
  assert.equal(projectRows.size, rowsBefore, 'no project was created');
});
