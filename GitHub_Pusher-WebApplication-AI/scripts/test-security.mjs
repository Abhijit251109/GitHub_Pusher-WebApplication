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
import { createOriginPolicy, parseTrustProxy, parseBranch, parseRepoId, assertRepoName, createJobGate, jobSlot, runJob, errorResponse, AppError, envInt, tokenCanDeleteRepos } from '../lib/security.js';

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

test('a job slot is free by the time its response is written, even if the handler then keeps running', async () => {
  const gate = createJobGate({ maxConcurrent: 1, maxPerUser: 1 });
  const req = { auth: { user: { id: 'u' } } };
  const res = { on() {}, status() { return this; }, setHeader() {}, json() {}, end() { res.freeWhenSent = gate.running === 0; } };
  await new Promise(resolve => jobSlot(gate)(req, res, resolve));
  assert.equal(gate.running, 1);
  let finish;
  const handlerDone = runJob(async (_req, r) => { r.end(); await new Promise(f => { finish = f; }); })(req, res);
  assert.equal(res.freeWhenSent, true, 'released before the response went out');
  assert.equal(gate.tryAcquire('u').ok, true, 'the same user can start the next job at once');
  finish();
  await handlerDone;
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
let failEditorManifest = false;
let failEditorRow = null;
const projectRows = new Map(); // id -> row written by the server
// u7 uploads and deletes a real project; u8 probes unknown project ids. Neither has seeded data.
users.u7 = { token: 'token-u7', id: '1007', projectId: null };
users.u8 = { token: 'token-u8', id: '1008', projectId: null };
// u9 checks that uploads keep folder paths and never lose files silently.
users.u9 = { token: 'token-u9', id: '1009', projectId: null };
// u10 sends uploads back to back.
users.u10 = { token: 'token-u10', id: '1010', projectId: null };
for (const u of [users.u7, users.u8, users.u9, users.u10]) byHash.set(tokenHash(u.token), u);

async function storageRoute(req, res, rest, body, send) {
  const BUCKET = 'gpp-private/';
  if (req.method === 'POST' && rest.startsWith('list/')) {
    const { prefix = '', offset = 0, limit = 1000 } = JSON.parse(body.toString() || '{}');
    const dir = prefix.replace(/\/$/, '') + '/';
    const names = [...new Set([...store.keys()].filter(k => k.startsWith(dir)).map(k => k.slice(dir.length).split('/')[0]))].sort().slice(offset, offset + limit);
    return send(200, names.map(name => store.has(dir + name) ? { name, id: `id-${name}`, metadata: { size: store.get(dir + name).length } } : { name, id: null, metadata: null }));
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
  if (failEditorManifest && ['POST', 'PUT'].includes(req.method) && key.includes('/edits/') && key.endsWith('/manifest.json')) {
    failEditorManifest = false;
    return send(500, { statusCode: '500', error: 'internal', message: 'Simulated editor manifest upload failure' });
  }
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
      const rows = [].concat(JSON.parse(body.toString()));
      if (failEditorRow && rows.some(row => row.storage_path?.includes('/edits/'))) {
        if (failEditorRow === 'after-write') for (const row of rows) projectRows.set(row.id, row);
        failEditorRow = null;
        return send(500, { message: 'Simulated editor row acknowledgement failure' });
      }
      for (const row of rows) projectRows.set(row.id, row);
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
let aiMock;
const aiRequests = [];
let aiResponseMode = 'valid';
let server;
let base;
let serverLog = '';
const PORT = 40000 + Math.floor(Math.random() * 20000);

before(async () => {
  mock = mockSupabase();
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  aiMock = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks).toString());
    aiRequests.push({ path: req.url, body: request });
    res.setHeader('Content-Type', 'application/json');
    if (aiResponseMode === 'provider-error') {
      res.statusCode = 500;
      return res.end(JSON.stringify({ error: 'mock-private-provider-diagnostics' }));
    }
    if (aiResponseMode === 'malformed') return res.end('{not valid JSON');
    const context = JSON.parse(request.messages.find(message => message.role === 'user').content);
    const file = context.files[0];
    const proposal = {
      summary: 'Update the selected source file.',
      changes: [{
        path: aiResponseMode === 'unselected' ? 'outside-selection.js' : file.path,
        content: `${file.content}// AI reviewed change\n`, explanation: 'Add the requested comment.'
      }]
    };
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(proposal) } }] }));
  });
  await new Promise(r => aiMock.listen(0, '127.0.0.1', r));
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
      AI_ENABLED: 'true', AI_MODEL: 'mock-coder', AI_BASE_URL: `http://127.0.0.1:${aiMock.address().port}/v1`, AI_API_KEY: '',
      RATE_LIMIT_AI_PER_15_MIN: '20',
      RATE_LIMIT_AUTH_PER_15_MIN: '5', RATE_LIMIT_PUSH_PER_15_MIN: '10', RATE_LIMIT_UPLOAD_PER_15_MIN: '200', MAX_CONCURRENT_JOBS: '2', SYNC_INTERVAL_MS: '3600000'
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
after(() => { server?.kill(); mock?.close(); aiMock?.close(); });

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

test('e2e: back-to-back uploads by one user are never refused as JOB_IN_PROGRESS', async () => {
  const statuses = [];
  for (let i = 0; i < 25; i++) {
    for (let j = 0; j < 2; j++) {
      const res = await upload(users.u10, uploadForm(`b2b-${i}-${j}`, { [`b2b/${i}-${j}.txt`]: 'x' }));
      statuses.push(res.status);
      await res.arrayBuffer();
    }
  }
  assert.deepEqual(statuses.filter(s => s !== 200), [], 'every upload succeeded');
});

test('e2e: a path uploaded both as a file and as a folder is refused', async () => {
  const before = store.size;
  const res = await upload(users.u9, uploadForm('conflict', { 'x/a': 'file', 'x/a/b': 'inside' }));
  const body = await res.json();
  assert.equal(res.status, 422, JSON.stringify(body));
  assert.equal(body.code, 'PATH_CONFLICT');
  assert.equal(store.size, before);
});

test('e2e: editor opens nested files, saves persistently, rejects stale tabs and enforces ownership', async () => {
  const up = await upload(users.u9, uploadForm('editor', { 'src/app.js': 'console.log("before");\r\n', 'README.md': 'readme', 'logo.bin': new Uint8Array([0, 1, 2]) }));
  const project = await up.json();
  assert.equal(up.status, 200, JSON.stringify(project));
  const endpoint = `/api/projects/${project.id}`;
  const root = await asUser(users.u9, 'GET', `${endpoint}/files`);
  assert.equal(root.headers.get('cache-control'), 'no-store');
  assert.deepEqual((await root.json()).entries.map(x => x.name), ['src', 'logo.bin', 'README.md']);
  const dir = await asUser(users.u9, 'GET', `${endpoint}/files?path=src`);
  assert.deepEqual((await dir.json()).entries.map(x => x.path), ['src/app.js']);
  const opened = await (await asUser(users.u9, 'GET', `${endpoint}/file?path=src%2Fapp.js`)).json();
  assert.equal(opened.content, 'console.log("before");\r\n');
  const edit = { ...opened, content: 'console.log("after");\r\n' };
  const deniedRead = await asUser(users.u8, 'GET', `${endpoint}/file?path=src%2Fapp.js`);
  const deniedSave = await asUser(users.u8, 'POST', `${endpoint}/file`, edit);
  assert.equal(deniedRead.status, 404);
  assert.equal(deniedSave.status, 404);
  const savedResponse = await asUser(users.u9, 'POST', `${endpoint}/file`, edit);
  const saved = await savedResponse.json();
  assert.equal(savedResponse.status, 200, JSON.stringify(saved));
  assert.equal(saved.changed, true);
  assert.notEqual(saved.sha, opened.sha);
  const reloaded = await (await asUser(users.u9, 'GET', `${endpoint}/file?path=src%2Fapp.js`)).json();
  assert.equal(reloaded.content, edit.content);
  assert.equal(reloaded.sha, saved.sha);
  const row = projectRows.get(project.id);
  assert.match(row.storage_path, /\/edits\//);
  assert.equal(row.sync_state, 'local');
  assert.equal(JSON.parse(store.get(row.storage_path.replace('working.tgz', 'manifest.json'))).fileCount, 3);
  const version = row.storage_path;
  const unchanged = await asUser(users.u9, 'POST', `${endpoint}/file`, reloaded);
  assert.equal((await unchanged.json()).changed, false);
  assert.equal(projectRows.get(project.id).storage_path, version, 'no-op save uploads no new version');
  const stale = await asUser(users.u9, 'POST', `${endpoint}/file`, edit);
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, 'FILE_CHANGED');
  assert.equal(projectRows.get(project.id).storage_path, version);

  for (const relative of ['../server.js', '.git/config', 'src/../../x']) {
    const r = await asUser(users.u9, 'GET', `${endpoint}/file?path=${encodeURIComponent(relative)}`);
    assert.equal(r.status, 400, relative);
    assert.equal((await r.json()).code, 'INVALID_FILE_PATH');
  }
  const unauthenticated = await fetch(`${base}${endpoint}/files`);
  assert.equal(unauthenticated.status, 401);
});

test('e2e: a failed editor upload leaves the previous archive and file content intact', async () => {
  const up = await upload(users.u9, uploadForm('save-failure', { 'file.txt': 'original' }));
  const project = await up.json();
  const endpoint = `/api/projects/${project.id}/file`;
  const opened = await (await asUser(users.u9, 'GET', `${endpoint}?path=file.txt`)).json();
  const before = projectRows.get(project.id).storage_path;
  const archive = Buffer.from(store.get(before));
  failEditorManifest = true;
  const failed = await asUser(users.u9, 'POST', endpoint, { ...opened, content: 'unsaved new text' });
  assert.equal(failed.status, 500);
  assert.equal(projectRows.get(project.id).storage_path, before);
  assert.deepEqual(store.get(before), archive);
  assert.equal((await (await asUser(users.u9, 'GET', `${endpoint}?path=file.txt`)).json()).content, 'original');
  assert.equal([...store.keys()].filter(key => key.includes(`${project.id}/edits/`)).length, 0, 'failed version is cleaned up');
});

test('e2e: invalid commit messages are refused before storage or GitHub access', async () => {
  const before = counters.storageReads;
  for (const commitMessage of [42, ['bad'], 'x\0y', 'x'.repeat(5001)]) {
    const response = await push(users.u8, { projectId: crypto.randomUUID(), commitMessage });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'INVALID_COMMIT_MESSAGE');
  }
  assert.equal(counters.storageReads, before);
});

test('e2e: editor database failures never delete a referenced project archive', async () => {
  for (const failure of ['before-write', 'after-write']) {
    const up = await upload(users.u9, uploadForm('row-failure', { 'file.txt': 'original' }));
    const project = await up.json();
    const endpoint = `/api/projects/${project.id}/file`;
    const opened = await (await asUser(users.u9, 'GET', `${endpoint}?path=file.txt`)).json();
    failEditorRow = failure;
    const failed = await asUser(users.u9, 'POST', endpoint, { ...opened, content: 'new content' });
    assert.equal(failed.status, 500);
    const row = projectRows.get(project.id);
    assert.equal(store.has(row.storage_path), true, failure);
    const reloaded = await (await asUser(users.u9, 'GET', `${endpoint}?path=file.txt`)).json();
    assert.equal(reloaded.content, failure === 'before-write' ? 'original' : 'new content');
    if (failure === 'before-write') assert.equal([...store.keys()].filter(key => key.includes(`${project.id}/edits/`)).length, 0);
  }
});

test('e2e: removing an edited project deletes active and orphaned versions from nested folders', async () => {
  const up = await upload(users.u9, uploadForm('remove-editor', { 'file.txt': 'original' }));
  const project = await up.json();
  const endpoint = `/api/projects/${project.id}`;
  const opened = await (await asUser(users.u9, 'GET', `${endpoint}/file?path=file.txt`)).json();
  const saved = await asUser(users.u9, 'POST', `${endpoint}/file`, { ...opened, content: 'saved edit' });
  assert.equal(saved.status, 200, JSON.stringify(await saved.json()));
  const orphan = `projects/${users.u9.id}/${project.id}/edits/orphan/working.tgz`;
  store.set(orphan, Buffer.from('orphaned version'));
  const deleted = await asUser(users.u9, 'DELETE', endpoint);
  assert.deepEqual(await deleted.json(), { ok: true });
  assert.equal([...store.keys()].filter(key => key.includes(project.id)).length, 0);
});

test('e2e AI: authentication, ownership and origin checks prevent inference', async () => {
  const up = await upload(users.u9, uploadForm('ai-access', { 'src/app.js': 'export const value = 1;\n' }));
  const project = await up.json();
  assert.equal(up.status, 200);
  const endpoint = `/api/projects/${project.id}/ai/propose`;
  const body = { instruction: 'Add a comment', paths: ['src/app.js'] };
  const before = aiRequests.length;
  const noSession = await fetch(`${base}${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(noSession.status, 401);
  assert.equal((await fetch(`${base}/api/ai/status`)).status, 401);
  const status = await asUser(users.u9, 'GET', '/api/ai/status');
  assert.equal(status.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await status.json(), { enabled: true, model: 'mock-coder', maxFiles: 6 });
  const otherOwner = await asUser(users.u8, 'POST', endpoint, body);
  assert.equal(otherOwner.status, 404);
  assert.equal((await otherOwner.json()).code, 'PROJECT_NOT_FOUND');
  const csrf = await fetch(`${base}${endpoint}`, {
    method: 'POST', headers: { Origin: 'https://evil.example', Cookie: `gpp_session=${users.u9.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  assert.equal(csrf.status, 403);
  assert.equal((await csrf.json()).code, 'ORIGIN_NOT_ALLOWED');
  assert.equal(aiRequests.length, before);
});

test('e2e AI: traversal, credential paths and unsupported request fields never reach the model', async () => {
  const before = aiRequests.length;
  const endpoint = `/api/projects/${crypto.randomUUID()}/ai/propose`;
  const cases = [
    [{ instruction: 'Update', paths: ['../server.js'] }, 'INVALID_FILE_PATH'],
    [{ instruction: 'Update', paths: ['.env'] }, 'AI_SENSITIVE_FILE'],
    [{ instruction: 'Update', paths: ['config/private.pem'] }, 'AI_SENSITIVE_FILE'],
    [{ instruction: 'Update', paths: ['src/app.js', 'src/app.js'] }, 'AI_INVALID_REQUEST'],
    [{ instruction: 'Update', paths: ['src/app.js'], baseURL: 'https://attacker.example' }, 'AI_INVALID_REQUEST']
  ];
  for (const [body, code] of cases) {
    const response = await asUser(users.u9, 'POST', endpoint, body);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, code);
  }
  assert.equal(aiRequests.length, before);
});

test('e2e AI: proposals are read-only and explicit apply preserves stale-version protection', async () => {
  const original = 'export const value = 1;\n';
  const up = await upload(users.u9, uploadForm('ai-edit', { 'src/app.js': original, 'unselected.txt': 'Do not send this content to inference.' }));
  const project = await up.json();
  assert.equal(up.status, 200);
  const endpoint = `/api/projects/${project.id}`;
  const rowBefore = { ...projectRows.get(project.id) };
  const storeBefore = new Map([...store].map(([key, value]) => [key, Buffer.from(value)]));
  const response = await asUser(users.u9, 'POST', `${endpoint}/ai/propose`, { instruction: 'Add a comment', paths: ['src/app.js'] });
  const proposal = await response.json();
  assert.equal(response.status, 200, JSON.stringify(proposal));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(proposal.model, 'mock-coder');
  assert.equal(proposal.changes.length, 1);
  const change = proposal.changes[0];
  assert.equal(change.originalContent, original);
  assert.equal(change.sha, crypto.createHash('sha256').update(original).digest('hex'));
  assert.equal(change.content, `${original}// AI reviewed change\n`);
  assert.deepEqual(projectRows.get(project.id), rowBefore, 'proposing must not change project metadata');
  assert.deepEqual(store, storeBefore, 'proposing must not write any archive or snapshot');
  const request = aiRequests.at(-1);
  assert.equal(request.path, '/v1/chat/completions');
  assert.equal(request.body.model, 'mock-coder');
  const context = JSON.parse(request.body.messages.find(message => message.role === 'user').content);
  assert.deepEqual(context.files, [{ path: 'src/app.js', content: original }]);
  assert.doesNotMatch(JSON.stringify(request.body), /Do not send this content|token-u9|github_token_enc/);
  const saved = await asUser(users.u9, 'POST', `${endpoint}/file`, { path: change.path, content: change.content, sha: change.sha });
  assert.equal(saved.status, 200, JSON.stringify(await saved.json()));
  const reloaded = await (await asUser(users.u9, 'GET', `${endpoint}/file?path=src%2Fapp.js`)).json();
  assert.equal(reloaded.content, change.content);
  const version = projectRows.get(project.id).storage_path;
  const stale = await asUser(users.u9, 'POST', `${endpoint}/file`, { path: change.path, content: 'overwrite', sha: change.sha });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, 'FILE_CHANGED');
  assert.equal(projectRows.get(project.id).storage_path, version);
});

test('e2e AI: unsafe or broken provider responses never write files or leak provider diagnostics', async () => {
  const up = await upload(users.u9, uploadForm('ai-failure', { 'file.txt': 'original' }));
  const project = await up.json();
  assert.equal(up.status, 200);
  const pointer = projectRows.get(project.id).storage_path;
  const originalArchive = Buffer.from(store.get(pointer));
  try {
    for (const mode of ['unselected', 'malformed', 'provider-error']) {
      aiResponseMode = mode;
      const response = await asUser(users.u9, 'POST', `/api/projects/${project.id}/ai/propose`, { instruction: 'Update this file', paths: ['file.txt'] });
      const body = await response.json();
      assert.equal(response.status, 502, mode);
      assert.match(body.code, /^AI_(INVALID_RESPONSE|PROVIDER_ERROR)$/);
      assert.doesNotMatch(JSON.stringify(body), /mock-private-provider-diagnostics|outside-selection|original/);
      assert.equal(projectRows.get(project.id).storage_path, pointer);
      assert.deepEqual(store.get(pointer), originalArchive);
    }
  } finally { aiResponseMode = 'valid'; }
});

test('e2e AI: per-user rate limits stop excess requests before inference', async () => {
  const before = aiRequests.length;
  const endpoint = `/api/projects/${crypto.randomUUID()}/ai/propose`;
  // u7 has not used AI in other tests. Invalid requests count toward its cost/abuse limit too.
  for (let i = 0; i < 20; i++) {
    const response = await asUser(users.u7, 'POST', endpoint, { instruction: '', paths: [] });
    assert.equal(response.status, 400);
    await response.arrayBuffer();
  }
  const limited = await asUser(users.u7, 'POST', endpoint, { instruction: '', paths: [] });
  assert.equal(limited.status, 429);
  assert.ok(limited.headers.get('retry-after'));
  assert.equal(aiRequests.length, before);
});
