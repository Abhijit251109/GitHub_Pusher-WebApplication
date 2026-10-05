import express from 'express';
import multer from 'multer';
import fs from 'fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createClient } from '@supabase/supabase-js';
import * as tar from 'tar';
import helmet from 'helmet';

const execFileAsync = promisify(execFile);
const app = express();
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = process.cwd();
const APPLICATIONS = path.join(ROOT, 'application');
const APPLICATION_PLATFORMS = {
  windows: ['.msi', '.exe'],
  macos: ['.dmg', '.pkg', '.zip'],
  android: ['.apk', '.aab'],
  linux: ['.AppImage', '.deb', '.rpm', '.zip']
};
const LOCAL_DATA = path.join(ROOT, 'data');
const UPLOAD_TEMP = path.join(LOCAL_DATA, 'uploads');
const FEEDBACK_DIR = path.join(ROOT, 'feedback');
const CONTRIBUTE_DIR = path.join(ROOT, 'contribute');
const MAX_FILES = Number(process.env.MAX_UPLOAD_FILES || 2000);
const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE_MB || 50) * 1024 * 1024;
const MAX_TOTAL_UPLOAD = Number(process.env.MAX_TOTAL_UPLOAD_MB || 40) * 1024 * 1024;
const MAX_ARCHIVE_SIZE = Number(process.env.MAX_ARCHIVE_MB || 45) * 1024 * 1024;
const MAX_EXTRACTED_BYTES = Number(process.env.MAX_EXTRACTED_MB || 150) * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = Number(process.env.MAX_ARCHIVE_ENTRIES || 10000);
const MAX_DECOMPRESSION_RATIO = Number(process.env.MAX_DECOMPRESSION_RATIO || 20);
const MAX_SNAPSHOTS = Number(process.env.MAX_SNAPSHOTS_PER_PROJECT || 10);
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_DAYS || 7) * 24 * 60 * 60 * 1000;
const LOGIN_CODE_TTL_MS = 2 * 60 * 1000;
const OAUTH_ATTEMPT_TTL_MS = 10 * 60 * 1000;
const SSE_TICKET_TTL_MS = 5 * 60 * 1000;
const SYNC_MS = Number(process.env.SYNC_INTERVAL_MS || 30000);
const APP_NAME = process.env.APP_NAME || 'GitHub Project Pusher';
const SESSION_COOKIE = 'gpp_session';
const OAUTH_BINDING_COOKIE = 'gpp_oauth_pre';
const isProd = process.env.NODE_ENV === 'production';
const GIT_CONFIG_GLOBAL = process.platform === 'win32' ? path.join(os.tmpdir(), `gpp-empty-global-${process.pid}.gitconfig`) : os.devNull;
const STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'gpp-private';
const FRONTEND_URL = String(process.env.FRONTEND_URL || '').trim().replace(/\/$/, '');
const FRONTEND_ORIGIN = (() => { try { return FRONTEND_URL ? new URL(FRONTEND_URL).origin : ''; } catch { return ''; } })();
const ALLOWED_GITHUB_USER_IDS = new Set(String(process.env.ALLOWED_GITHUB_USER_IDS || '').split(',').map(v => v.trim()).filter(Boolean));
const REQUIRE_GITHUB_ALLOWLIST = String(process.env.REQUIRE_GITHUB_ALLOWLIST || '').toLowerCase() === 'true';
const GITHUB_SCOPE = process.env.GITHUB_OAUTH_SCOPE || 'repo write:public_key offline_access';

if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY));

const SUPABASE_SERVER_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const hasSupabase = Boolean(process.env.SUPABASE_URL && SUPABASE_SERVER_KEY);
if (isProd && !hasSupabase) {
  throw new Error('Persistent storage is required in production. Set SUPABASE_URL and SUPABASE_SECRET_KEY.');
}

const supabase = hasSupabase
  ? createClient(process.env.SUPABASE_URL, SUPABASE_SERVER_KEY, { auth: { autoRefreshToken: false, persistSession: false } })
  : null;

await fs.mkdir(UPLOAD_TEMP, { recursive: true });
if (process.platform === 'win32') await fs.writeFile(GIT_CONFIG_GLOBAL, '');
await fs.mkdir(FEEDBACK_DIR, { recursive: true });
await fs.mkdir(CONTRIBUTE_DIR, { recursive: true });
await fs.mkdir(APPLICATIONS, { recursive: true });
await Promise.all(Object.keys(APPLICATION_PLATFORMS).map(platform => fs.mkdir(path.join(APPLICATIONS, platform), { recursive: true })));

const uploadStorage = {
  _handleFile(req, file, cb) {
    const filename = `${crypto.randomUUID()}-${normalizeName(path.basename(file.originalname || 'file'))}`;
    const fullPath = path.join(UPLOAD_TEMP, filename);
    const totalSizeLimit = new Transform({
      transform(chunk, _encoding, callback) {
        const total = (req.gppUploadBytes || 0) + chunk.length;
        if (total > MAX_TOTAL_UPLOAD) {
          const error = new Error(`Upload exceeds ${Math.round(MAX_TOTAL_UPLOAD / 1024 / 1024)} MB.`);
          error.code = 'LIMIT_TOTAL_UPLOAD';
          callback(error);
          return;
        }
        req.gppUploadBytes = total;
        callback(null, chunk);
      }
    });
    pipeline(file.stream, totalSizeLimit, createWriteStream(fullPath, { flags: 'wx' }))
      .then(async () => {
        const stat = await fs.stat(fullPath);
        cb(null, { destination: UPLOAD_TEMP, filename, path: fullPath, size: stat.size });
      })
      .catch(error => fs.rm(fullPath, { force: true }).catch(() => {}).then(() => cb(error)));
  },
  _removeFile(_req, file, cb) {
    fs.rm(file.path, { force: true }).then(() => cb(null), cb);
  }
};
const upload = multer({
  storage: uploadStorage,
  limits: { files: MAX_FILES, fileSize: MAX_FILE_SIZE }
});

app.use((req, res, next) => {
  const origin = req.get('Origin');
  if (origin && allowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'", ...(FRONTEND_ORIGIN ? [FRONTEND_ORIGIN] : [])],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'", 'https://github.com'],
      frameAncestors: ["'none'"],
      workerSrc: ["'self'"]
    }
  },
  referrerPolicy: { policy: 'no-referrer' },
  hsts: isProd ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false
}));

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(ROOT, 'public')));

function supabaseRequired() {
  if (!supabase) throw new Error('Supabase persistence is not configured.');
}

function nowIso() { return new Date().toISOString(); }
function normalizeName(s) {
  return String(s || '').replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || 'project';
}
async function moveFile(source, target) {
  try {
    await fs.rename(source, target);
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error;
    // Render can place the temporary upload directory and workspace on different
    // filesystems. rename(2) cannot cross that boundary, so copy then remove.
    await fs.copyFile(source, target);
    await fs.rm(source, { force: true });
  }
}
function safeRelative(rel) {
  const n = path.posix.normalize(String(rel || '').replaceAll('\\', '/'));
  if (!n || n === '.' || n.startsWith('../') || n.includes('/../') || path.posix.isAbsolute(n)) return null;
  return n;
}
function secretKey() {
  const secret = process.env.TOKEN_ENCRYPTION_KEY;
  if (!secret) return crypto.createHash('sha256').update(process.env.SESSION_SECRET || 'development-only-insecure-secret').digest();
  if (/^[0-9a-fA-F]{64}$/.test(secret)) return Buffer.from(secret, 'hex');
  const decoded = Buffer.from(secret, 'base64');
  if (decoded.length === 32) return decoded;
  throw new Error('TOKEN_ENCRYPTION_KEY must be 64 hex characters or a base64-encoded 32-byte key.');
}
function sessionSecret() {
  const secret = process.env.SESSION_SECRET;
  if (isProd && (!secret || secret.length < 32)) throw new Error('SESSION_SECRET must be at least 32 characters in production.');
  return secret || 'development-only-insecure-secret';
}
const ENCRYPTION_KEY = secretKey();
const SESSION_HASH_KEY = crypto.createHash('sha256').update(sessionSecret()).digest();
function hashSecret(value) { return crypto.createHmac('sha256', SESSION_HASH_KEY).update(String(value)).digest('hex'); }
function randomToken(bytes = 32) { return crypto.randomBytes(bytes).toString('base64url'); }
function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
}
function decrypt(value) {
  const [ivS, tagS, dataS] = String(value).split('.');
  if (!ivS || !tagS || !dataS) throw new Error('Encrypted value is malformed.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, Buffer.from(ivS, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagS, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(dataS, 'base64url')), decipher.final()]).toString('utf8');
}
function publicBaseUrl(req) {
  return String(process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}
function allowedOrigin(origin) {
  try {
    const normalized = new URL(origin).origin;
    if (FRONTEND_ORIGIN && normalized === FRONTEND_ORIGIN) return true;
    if (process.env.PUBLIC_BASE_URL && normalized === new URL(process.env.PUBLIC_BASE_URL).origin) return true;
  } catch {}
  return false;
}
function allowedReturnTo(value, req) {
  if (!value) return null;
  try {
    const parsed = new URL(String(value));
    const own = new URL(publicBaseUrl(req));
    const allowed = new Set([own.origin, FRONTEND_ORIGIN].filter(Boolean));
    if (!allowed.has(parsed.origin)) return null;
    if (!isProd && parsed.hostname === '127.0.0.1') return `${parsed.origin}${parsed.pathname}${parsed.search}`;
    return `${parsed.origin}${parsed.pathname}${parsed.search}`;
  } catch { return null; }
}
function parseCookies(req) {
  const out = {};
  for (const pair of String(req.headers.cookie || '').split(';')) {
    const i = pair.indexOf('=');
    if (i < 0) continue;
    out[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim());
  }
  return out;
}
function cookieOptions() {
  const sameSite = process.env.COOKIE_SAMESITE || 'Lax';
  const secure = isProd || process.env.COOKIE_SECURE === 'true';
  return `Path=/; HttpOnly; SameSite=${sameSite}${secure ? '; Secure' : ''}`;
}
function oauthBindingCookieOptions(maxAgeSeconds = Math.ceil(OAUTH_ATTEMPT_TTL_MS / 1000)) {
  const secure = isProd || process.env.COOKIE_SECURE === 'true';
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
}
function clearOAuthBindingCookie() {
  return `${OAUTH_BINDING_COOKIE}=; ${oauthBindingCookieOptions(0)}`;
}
function getBearerToken(req) {
  const header = req.get('Authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : null;
}
function requestHasBearer(req) { return Boolean(getBearerToken(req)); }
async function queryOne(table, builder) {
  supabaseRequired();
  const { data, error } = await builder;
  if (error) throw new Error(`${table}: ${error.message}`);
  return data;
}

function userFromRow(row) {
  if (!row) return null;
  return {
    id: String(row.id), login: row.login, name: row.name, avatar: row.avatar,
    githubTokenEnc: row.github_token_enc, githubRefreshTokenEnc: row.github_refresh_token_enc,
    githubExpiresAt: row.github_expires_at ? new Date(row.github_expires_at).getTime() : null,
    githubRefreshExpiresAt: row.github_refresh_expires_at ? new Date(row.github_refresh_expires_at).getTime() : null
  };
}
function projectFromRow(row) {
  if (!row) return null;
  return {
    id: row.id, userId: row.user_id, name: row.name, createdAt: row.created_at, updatedAt: row.updated_at,
    syncState: row.sync_state, syncMessage: row.sync_message, repoId: row.repo_id, repoFullName: row.repo_full_name,
    repoUrl: row.repo_url, remoteUrl: row.remote_url, branch: row.branch, lastPushedAt: row.last_pushed_at,
    lastPushedCommit: row.last_pushed_commit, lastSyncAt: row.last_sync_at, lastPulledCommit: row.last_pulled_commit,
    lastCheckedAt: row.last_checked_at, fileCount: row.file_count || 0, storagePath: row.storage_path
  };
}
function projectToRow(p) {
  return {
    id: p.id, user_id: p.userId, name: p.name, created_at: p.createdAt, updated_at: p.updatedAt,
    sync_state: p.syncState || 'local', sync_message: p.syncMessage || null, repo_id: p.repoId == null ? null : String(p.repoId),
    repo_full_name: p.repoFullName || null, repo_url: p.repoUrl || null, remote_url: p.remoteUrl || null,
    branch: p.branch || null, last_pushed_at: p.lastPushedAt || null, last_pushed_commit: p.lastPushedCommit || null,
    last_sync_at: p.lastSyncAt || null, last_pulled_commit: p.lastPulledCommit || null,
    last_checked_at: p.lastCheckedAt || null, file_count: Number(p.fileCount || 0), storage_path: p.storagePath || null
  };
}

async function dbUserUpsert(user) {
  const row = {
    id: String(user.id), login: user.login, name: user.name, avatar: user.avatar,
    github_token_enc: user.githubTokenEnc, github_refresh_token_enc: user.githubRefreshTokenEnc || null,
    github_expires_at: user.githubExpiresAt ? new Date(user.githubExpiresAt).toISOString() : null,
    github_refresh_expires_at: user.githubRefreshExpiresAt ? new Date(user.githubRefreshExpiresAt).toISOString() : null,
    updated_at: nowIso()
  };
  await queryOne('users', supabase.from('users').upsert(row, { onConflict: 'id' }));
  return user;
}
async function dbGetUser(userId) {
  const data = await queryOne('users', supabase.from('users').select('*').eq('id', String(userId)).maybeSingle());
  return userFromRow(data);
}
async function dbGetProject(projectId) {
  const data = await queryOne('projects', supabase.from('projects').select('*').eq('id', projectId).maybeSingle());
  return projectFromRow(data);
}
async function dbListProjects(userId) {
  const data = await queryOne('projects', supabase.from('projects').select('*').eq('user_id', String(userId)).order('name', { ascending: true }));
  return (data || []).map(projectFromRow);
}
async function dbUpsertProject(project) {
  await queryOne('projects', supabase.from('projects').upsert(projectToRow(project), { onConflict: 'id' }));
  return project;
}
async function dbDeleteProject(projectId, userId) {
  await queryOne('projects', supabase.from('projects').delete().eq('id', projectId).eq('user_id', String(userId)));
}
async function dbListUsers() {
  const data = await queryOne('users', supabase.from('users').select('*'));
  return (data || []).map(userFromRow);
}

async function createSession(userId) {
  const token = randomToken(32);
  await queryOne('sessions', supabase.from('sessions').insert({ id: hashSecret(token), user_id: String(userId), created_at: nowIso(), expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString() }));
  return token;
}
async function sessionFromToken(token) {
  if (!token) return null;
  const data = await queryOne('sessions', supabase.from('sessions').select('*').eq('id', hashSecret(token)).maybeSingle());
  if (!data) return null;
  if (new Date(data.expires_at).getTime() < Date.now()) {
    await queryOne('sessions', supabase.from('sessions').delete().eq('id', data.id));
    return null;
  }
  const user = await dbGetUser(data.user_id);
  if (!user) return null;
  return { sid: data.id, token, user };
}
async function deleteSession(token) {
  if (!token) return;
  await queryOne('sessions', supabase.from('sessions').delete().eq('id', hashSecret(token)));
}
async function getSession(req, res, { createAnonymous = false } = {}) {
  const bearer = getBearerToken(req);
  if (bearer) return sessionFromToken(bearer);
  const cookie = parseCookies(req)[SESSION_COOKIE];
  if (cookie) {
    const session = await sessionFromToken(cookie);
    if (session) return session;
  }
  if (!createAnonymous) return null;
  const token = randomToken(32);
  await queryOne('sessions', supabase.from('sessions').insert({ id: hashSecret(token), user_id: null, created_at: nowIso(), expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString() }));
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; ${cookieOptions()}`);
  return { sid: hashSecret(token), token, user: null };
}
async function authUser(req, res, required = true) {
  const session = await getSession(req, res);
  if (!session?.user) {
    if (required) res.status(401).json({ error: 'Please sign in with GitHub.' });
    return null;
  }
  return { ...session, user: session.user };
}

async function createOAuthAttempt(state, codeVerifier, returnTo, browserBinding) {
  await queryOne('oauth_attempts', supabase.from('oauth_attempts').insert({
    state_hash: hashSecret(state), code_verifier: codeVerifier, return_to: returnTo,
    client_cookie_hash: hashSecret(browserBinding),
    created_at: nowIso(), expires_at: new Date(Date.now() + OAUTH_ATTEMPT_TTL_MS).toISOString()
  }));
}
async function consumeOAuthAttempt(state, browserBinding) {
  const row = await queryOne('oauth_attempts', supabase.from('oauth_attempts').select('*').eq('state_hash', hashSecret(state)).maybeSingle());
  if (!row) return null;
  await queryOne('oauth_attempts', supabase.from('oauth_attempts').delete().eq('state_hash', hashSecret(state)));
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  if (!browserBinding || !row.client_cookie_hash || hashSecret(browserBinding) !== row.client_cookie_hash) return null;
  return row;
}
async function createLoginCode(userId) {
  const code = randomToken(32);
  await queryOne('login_codes', supabase.from('login_codes').insert({ code_hash: hashSecret(code), user_id: String(userId), created_at: nowIso(), expires_at: new Date(Date.now() + LOGIN_CODE_TTL_MS).toISOString() }));
  return code;
}
async function consumeLoginCode(code) {
  const row = await queryOne('login_codes', supabase.from('login_codes').select('*').eq('code_hash', hashSecret(code)).maybeSingle());
  if (!row) return null;
  await queryOne('login_codes', supabase.from('login_codes').delete().eq('code_hash', hashSecret(code)));
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return row;
}
async function createSseTicket(userId) {
  const ticket = randomToken(24);
  await queryOne('sse_tickets', supabase.from('sse_tickets').insert({ ticket_hash: hashSecret(ticket), user_id: String(userId), created_at: nowIso(), expires_at: new Date(Date.now() + SSE_TICKET_TTL_MS).toISOString() }));
  return ticket;
}
async function consumeSseTicket(ticket) {
  if (!ticket) return null;
  const row = await queryOne('sse_tickets', supabase.from('sse_tickets').select('*').eq('ticket_hash', hashSecret(ticket)).maybeSingle());
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await queryOne('sse_tickets', supabase.from('sse_tickets').delete().eq('ticket_hash', row.ticket_hash));
    return null;
  }
  // EventSource automatically reconnects using the same URL. Keep the short-lived
  // ticket reusable until expiry so reconnects do not become permanently 401.
  const user = await dbGetUser(row.user_id);
  return user ? { user } : null;
}
async function cleanupAuthRecords() {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  await Promise.all([
    queryOne('oauth_attempts', supabase.from('oauth_attempts').delete().lt('expires_at', new Date().toISOString())),
    queryOne('login_codes', supabase.from('login_codes').delete().lt('expires_at', new Date().toISOString())),
    queryOne('sse_tickets', supabase.from('sse_tickets').delete().lt('expires_at', new Date().toISOString())),
    queryOne('sessions', supabase.from('sessions').delete().lt('expires_at', new Date().toISOString()))
  ]).catch(() => {});
}

async function storageUpload(objectPath, data, contentType = 'application/octet-stream') {
  supabaseRequired();
  if (Buffer.byteLength(data) > MAX_ARCHIVE_SIZE) throw new Error(`Stored archive exceeds the ${Math.round(MAX_ARCHIVE_SIZE / 1024 / 1024)} MB free-tier archive limit.`);
  const { error } = await supabase.storage.from(STORAGE_BUCKET).upload(objectPath, data, { contentType, upsert: true });
  if (error) throw new Error(`Storage upload failed: ${error.message}`);
}
async function storageDownload(objectPath) {
  supabaseRequired();
  const { data, error } = await supabase.storage.from(STORAGE_BUCKET).download(objectPath);
  if (error || !data) throw new Error(`Storage download failed: ${error?.message || 'not found'}`);
  return Buffer.from(await data.arrayBuffer());
}
async function storageDownloadOptional(objectPath) {
  supabaseRequired();
  const { data, error } = await supabase.storage.from(STORAGE_BUCKET).download(objectPath);
  if (error) {
    if (Number(error.statusCode) === 404 || error.error === 'not_found') return null;
    throw new Error(`Storage download failed: ${error.message}`);
  }
  return data ? Buffer.from(await data.arrayBuffer()) : null;
}
async function storageRemove(paths) {
  if (!paths.length) return;
  const { error } = await supabase.storage.from(STORAGE_BUCKET).remove(paths);
  if (error) throw new Error(`Storage delete failed: ${error.message}`);
}

async function createArchive(sourceDir, destination, includeGit = true) {
  const entries = includeGit ? ['.'] : (await fs.readdir(sourceDir, { withFileTypes: true })).filter(e => e.name !== '.git').map(e => e.name);
  let entryCount = 0;
  let uncompressedBytes = 0;
  await tar.c({
    gzip: true, file: destination, cwd: sourceDir, portable: true,
    filter: (_entryPath, stat) => {
      entryCount += 1;
      if (entryCount > MAX_ARCHIVE_ENTRIES) throw new Error(`Project contains more than ${MAX_ARCHIVE_ENTRIES} archive entries.`);
      if (stat.isSymbolicLink() || stat.isSocket() || stat.isBlockDevice() || stat.isCharacterDevice() || stat.isFIFO()) {
        throw new Error('Project archives cannot contain symbolic links, device files, sockets, or FIFOs.');
      }
      if (stat.isFile()) {
        uncompressedBytes += Number(stat.size || 0);
        if (uncompressedBytes > MAX_EXTRACTED_BYTES) throw new Error(`Project contents exceed the ${Math.round(MAX_EXTRACTED_BYTES / 1024 / 1024)} MB expanded archive limit.`);
      }
      return true;
    }
  }, entries.length ? entries : ['.']);
  const stat = await fs.stat(destination);
  if (stat.size > MAX_ARCHIVE_SIZE) throw new Error(`Project archive exceeds ${Math.round(MAX_ARCHIVE_SIZE / 1024 / 1024)} MB. Reduce the project size or increase the configured storage limit on a paid storage plan.`);
  return stat.size;
}
async function extractArchive(buffer, destination) {
  const archive = path.join(os.tmpdir(), `gpp-archive-${crypto.randomUUID()}.tgz`);
  await fs.writeFile(archive, buffer);
  try {
    let entryCount = 0;
    let uncompressedBytes = 0;
    await tar.x({
      file: archive, cwd: destination, strict: true, preservePaths: false,
      maxDecompressionRatio: MAX_DECOMPRESSION_RATIO,
      maxDepth: 64,
      filter: (_entryPath, entry) => {
        entryCount += 1;
        if (entryCount > MAX_ARCHIVE_ENTRIES) throw new Error(`Archive contains more than ${MAX_ARCHIVE_ENTRIES} entries.`);
        if (['SymbolicLink', 'Link', 'CharacterDevice', 'BlockDevice', 'FIFO'].includes(entry.type)) throw new Error('Archive contains unsupported link/device entries.');
        uncompressedBytes += Number(entry.size || 0);
        if (uncompressedBytes > MAX_EXTRACTED_BYTES) throw new Error(`Expanded archive exceeds the ${Math.round(MAX_EXTRACTED_BYTES / 1024 / 1024)} MB limit.`);
        return true;
      }
    });
  } finally {
    await fs.rm(archive, { force: true });
  }
}
async function withWorkspace(project, fn) {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'gpp-project-'));
  try {
    if (project?.storagePath) {
      const archive = await storageDownload(project.storagePath);
      await extractArchive(archive, work);
    }
    return await fn(work);
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
async function persistWorkingTree(project, work) {
  const archive = path.join(os.tmpdir(), `gpp-working-${crypto.randomUUID()}.tgz`);
  try {
    await createArchive(work, archive, true);
    const buf = await fs.readFile(archive);
    const objectPath = project.storagePath || `projects/${project.userId}/${project.id}/working.tgz`;
    await storageUpload(objectPath, buf, 'application/gzip');
    const stat = await fs.stat(archive);
    return { storagePath: objectPath, archiveBytes: stat.size };
  } finally {
    await fs.rm(archive, { force: true }).catch(() => {});
  }
}
async function countFiles(root) {
  let count = 0;
  async function walk(dir) {
    let entries = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === '.git') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p); else count++;
    }
  }
  await walk(root);
  return count;
}
async function sha256File(file) {
  return crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
}
async function snapshotProject(project, work, label) {
  const archive = path.join(os.tmpdir(), `gpp-snapshot-${crypto.randomUUID()}.tgz`);
  try {
    await createArchive(work, archive, false);
    const hash = await sha256File(archive);
    const existing = await queryOne('snapshots', supabase.from('snapshots').select('*').eq('project_id', project.id).eq('content_hash', hash).order('created_at', { ascending: false }).limit(1).maybeSingle());
    if (existing) return existing;
    const stamp = new Date().toISOString().replaceAll(':', '-');
    const objectPath = `snapshots/${project.userId}/${project.id}/${stamp}-${normalizeName(label)}.tgz`;
    await storageUpload(objectPath, await fs.readFile(archive), 'application/gzip');
    const row = { id: crypto.randomUUID(), project_id: project.id, user_id: project.userId, label, created_at: nowIso(), storage_path: objectPath, content_hash: hash };
    await queryOne('snapshots', supabase.from('snapshots').insert(row));
    const older = await queryOne('snapshots', supabase.from('snapshots').select('*').eq('project_id', project.id).order('created_at', { ascending: false }));
    const stale = (older || []).slice(MAX_SNAPSHOTS);
    if (stale.length) {
      await storageRemove(stale.map(s => s.storage_path));
      await queryOne('snapshots', supabase.from('snapshots').delete().in('id', stale.map(s => s.id)));
    }
    return row;
  } finally {
    await fs.rm(archive, { force: true }).catch(() => {});
  }
}
async function listSnapshots(projectId, userId) {
  const data = await queryOne('snapshots', supabase.from('snapshots').select('id,label,created_at,content_hash').eq('project_id', projectId).eq('user_id', String(userId)).order('created_at', { ascending: false }));
  return (data || []).map(row => ({ id: row.id, label: row.label, createdAt: row.created_at, hash: row.content_hash }));
}
async function updateProject(projectId, userId, patch) {
  const current = await dbGetProject(projectId);
  if (!current || current.userId !== String(userId)) throw new Error('Project not found.');
  const updated = { ...current, ...patch, updatedAt: nowIso() };
  await dbUpsertProject(updated);
  return updated;
}

function githubHeaders(token) {
  return { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': APP_NAME };
}
async function githubFetch(url, options = {}) {
  const r = await fetch(url, options);
  const text = await r.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) {
    const error = new Error((data && data.message) || `GitHub API error ${r.status}`);
    error.status = r.status;
    throw error;
  }
  return data;
}
async function userToken(user) {
  if (!user.githubTokenEnc) return null;
  if (user.githubExpiresAt && user.githubExpiresAt - Date.now() < 60_000 && user.githubRefreshTokenEnc) {
    const refresh = decrypt(user.githubRefreshTokenEnc);
    const response = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: process.env.GITHUB_CLIENT_ID, client_secret: process.env.GITHUB_CLIENT_SECRET, grant_type: 'refresh_token', refresh_token: refresh })
    });
    const data = await response.json();
    if (!response.ok || data.error || !data.access_token) throw new Error(data.error_description || 'GitHub token refresh failed. Please reconnect GitHub.');
    user.githubTokenEnc = encrypt(data.access_token);
    user.githubRefreshTokenEnc = data.refresh_token ? encrypt(data.refresh_token) : user.githubRefreshTokenEnc;
    user.githubExpiresAt = data.expires_in ? Date.now() + Number(data.expires_in) * 1000 : null;
    user.githubRefreshExpiresAt = data.refresh_token_expires_in ? Date.now() + Number(data.refresh_token_expires_in) * 1000 : user.githubRefreshExpiresAt;
    await dbUserUpsert(user);
    return data.access_token;
  }
  return decrypt(user.githubTokenEnc);
}
function githubRepoPath(fullName) {
  const parts = String(fullName || '').split('/');
  if (parts.length !== 2 || !parts.every(part => part !== '.' && part !== '..' && /^[A-Za-z0-9_.-]+$/.test(part))) throw new Error('GitHub returned an invalid repository name.');
  return parts.map(encodeURIComponent).join('/');
}
function githubSSHUrl(fullName) { return `ssh://git@ssh.github.com:443/${githubRepoPath(fullName)}.git`; }
function deployKeyObjectPath(project) { return `projects/${project.userId}/${project.id}/github-deploy-key.enc`; }
const githubDeployKeyCache = new Map();
async function isGitHubDeployKeyActive(token, key) {
  const cacheKey = `${key.repoId}:${key.deployKeyId}`;
  const checkedAt = githubDeployKeyCache.get(cacheKey);
  if (checkedAt && Date.now() - checkedAt < 5 * 60 * 1000) return true;
  const endpoint = `https://api.github.com/repos/${githubRepoPath(key.repoFullName)}/keys/${encodeURIComponent(key.deployKeyId)}`;
  const response = await fetch(endpoint, { headers: githubHeaders(token) });
  if (response.status === 404) { githubDeployKeyCache.delete(cacheKey); return false; }
  if (!response.ok) {
    const text = await response.text();
    let message; try { message = JSON.parse(text)?.message; } catch {}
    throw new Error(message || `Could not verify the saved GitHub deploy key (${response.status}).`);
  }
  const activeKey = await response.json();
  const active = activeKey.key === key.publicKey && activeKey.enabled !== false;
  if (active) githubDeployKeyCache.set(cacheKey, Date.now());
  else githubDeployKeyCache.delete(cacheKey);
  return active;
}
async function readGitHubDeployKey(project) {
  const encrypted = await storageDownloadOptional(deployKeyObjectPath(project));
  if (!encrypted) return null;
  try { return JSON.parse(decrypt(encrypted.toString('utf8'))); }
  catch { throw new Error('The saved GitHub deploy key could not be decrypted. Check TOKEN_ENCRYPTION_KEY and try again.'); }
}
async function deleteGitHubDeployKey(token, key) {
  if (!key?.deployKeyId || !key?.repoFullName) return;
  githubDeployKeyCache.delete(`${key.repoId}:${key.deployKeyId}`);
  const endpoint = `https://api.github.com/repos/${githubRepoPath(key.repoFullName)}/keys/${encodeURIComponent(key.deployKeyId)}`;
  const response = await fetch(endpoint, { method: 'DELETE', headers: githubHeaders(token) });
  if (!response.ok && response.status !== 404) {
    const text = await response.text();
    let message; try { message = JSON.parse(text)?.message; } catch {}
    throw new Error(message || `Could not remove the old GitHub deploy key (${response.status}).`);
  }
}
async function ensureGitHubDeployKey(token, project, repo) {
  const repoId = String(repo.id);
  const repoFullName = String(repo.full_name || '');
  const repoPath = githubRepoPath(repoFullName);
  const objectPath = deployKeyObjectPath(project);
  const existing = await readGitHubDeployKey(project);
  if (existing?.repoId === repoId && existing.privateKey && existing.deployKeyId && await isGitHubDeployKeyActive(token, existing)) return existing;
  if (existing) await deleteGitHubDeployKey(token, existing);

  const pair = createDeployKeyPair(`${APP_NAME} ${project.id}`);
  let created;
  try {
    created = await githubFetch(`https://api.github.com/repos/${repoPath}/keys`, {
      method: 'POST', headers: { ...githubHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: `${APP_NAME} ${project.id}`, key: pair.publicKey, read_only: false })
    });
  } catch (error) {
    if ([403, 404, 422].includes(Number(error.status))) {
      throw new Error('GitHub refused to add a write deploy key. Sign out and sign in again to grant the OAuth app the repo and write:public_key permissions; your account must also have admin access to this repository.');
    }
    throw error;
  }
  const record = { repoId, repoFullName, deployKeyId: String(created.id), publicKey: pair.publicKey, privateKey: pair.privateKey };
  try {
    await storageUpload(objectPath, Buffer.from(encrypt(JSON.stringify(record)), 'utf8'), 'application/octet-stream');
  } catch (error) {
    await deleteGitHubDeployKey(token, record).catch(() => {});
    throw error;
  }
  githubDeployKeyCache.set(`${repoId}:${record.deployKeyId}`, Date.now());
  return record;
}

function ensureRequestProtection(req, res, next) {
  if (requestHasBearer(req)) return next();
  const origin = req.get('Origin');
  if (!origin || allowedOrigin(origin)) return next();
  return res.status(403).json({ error: 'Cross-origin request blocked.' });
}

async function sanitizeGitRepository(dir) {
  const gitPath = path.join(dir, '.git');
  let stat;
  try { stat = await fs.lstat(gitPath); } catch { return false; }
  if (!stat.isDirectory()) throw new Error('Unsupported .git layout: linked/worktree repositories are not accepted.');
  await fs.rm(path.join(gitPath, 'config'), { force: true });
  await fs.rm(path.join(gitPath, 'hooks'), { recursive: true, force: true });
  await runGit(dir, ['init']);
  await runGit(dir, ['config', 'core.hooksPath', os.devNull]);
  await runGit(dir, ['config', 'commit.gpgSign', 'false']);
  await runGit(dir, ['config', 'tag.gpgSign', 'false']);
  return true;
}
async function ensureGit(dir, cloneUrl) {
  await fs.mkdir(dir, { recursive: true });
  const initialized = !(await sanitizeGitRepository(dir));
  if (initialized) await runGit(dir, ['init']);
  await runGit(dir, ['config', 'core.hooksPath', os.devNull]);
  await runGit(dir, ['config', 'user.name', APP_NAME]);
  await runGit(dir, ['config', 'user.email', 'github-project-pusher@localhost']);
  if (cloneUrl) {
    try { await runGit(dir, ['remote', 'get-url', 'origin']); await runGit(dir, ['remote', 'set-url', 'origin', cloneUrl]); }
    catch { await runGit(dir, ['remote', 'add', 'origin', cloneUrl]); }
  }
  return initialized;
}
function sshField(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}
function sshUInt32(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
}
function createDeployKeyPair(comment) {
  const pair = crypto.generateKeyPairSync('ed25519');
  const publicBytes = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const privateSeed = pair.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const algorithm = Buffer.from('ssh-ed25519');
  const publicBlob = Buffer.concat([sshField(algorithm), sshField(publicBytes)]);
  const check = crypto.randomBytes(4).readUInt32BE(0);
  const privateBytes = Buffer.concat([
    sshUInt32(check), sshUInt32(check), sshField(algorithm), sshField(publicBytes),
    sshField(Buffer.concat([privateSeed, publicBytes])), sshField(comment)
  ]);
  const paddingLength = 8 - (privateBytes.length % 8);
  const padding = Buffer.from(Array.from({ length: paddingLength }, (_unused, index) => index + 1));
  const openSshKey = Buffer.concat([
    Buffer.from('openssh-key-v1\0'), sshField('none'), sshField('none'), sshField(''),
    sshUInt32(1), sshField(publicBlob), sshField(Buffer.concat([privateBytes, padding]))
  ]).toString('base64');
  return {
    publicKey: `ssh-ed25519 ${publicBlob.toString('base64')} ${comment}`,
    privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n${openSshKey.match(/.{1,70}/g).join('\n')}\n-----END OPENSSH PRIVATE KEY-----\n`
  };
}
let githubSSHHostKeysPromise;
async function githubSSHHostKeys() {
  if (!githubSSHHostKeysPromise) {
    githubSSHHostKeysPromise = (async () => {
      const response = await fetch('https://api.github.com/meta', { headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': APP_NAME } });
      if (!response.ok) throw new Error(`Could not retrieve GitHub SSH host keys (${response.status}).`);
      const data = await response.json();
      const keys = Array.isArray(data.ssh_keys) ? data.ssh_keys.filter(key => /^(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-[^ ]+) [A-Za-z0-9+/=]+$/.test(key)) : [];
      if (!keys.length) throw new Error('GitHub did not return valid SSH host keys.');
      return `${keys.map(key => `[ssh.github.com]:443 ${key}`).join('\n')}\n`;
    })().catch(error => { githubSSHHostKeysPromise = null; throw error; });
  }
  return githubSSHHostKeysPromise;
}
function shellQuote(value) { return `'${String(value).replaceAll('\\', '/').replaceAll("'", "'\\''")}'`; }
async function withGitSSH(privateKey, fn) {
  const keyFile = path.join(os.tmpdir(), `gpp-deploy-key-${crypto.randomUUID()}`);
  const hostFile = path.join(os.tmpdir(), `gpp-known-hosts-${crypto.randomUUID()}`);
  try {
    await fs.writeFile(keyFile, privateKey, { mode: 0o600 });
    if (process.platform === 'win32') {
      const account = (await execFileAsync('whoami')).stdout.trim();
      await execFileAsync('icacls', [keyFile, '/inheritance:r', '/grant:r', `${account}:F`]);
    } else {
      await fs.chmod(keyFile, 0o600);
    }
    await fs.writeFile(hostFile, await githubSSHHostKeys(), { mode: 0o600 });
    const command = `ssh -i ${shellQuote(keyFile)} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${shellQuote(hostFile)}`;
    return await fn({ GIT_SSH_COMMAND: command, GIT_TERMINAL_PROMPT: '0' });
  } finally {
    await fs.rm(keyFile, { force: true });
    await fs.rm(hostFile, { force: true });
  }
}
async function runGit(cwd, args, env = {}) {
  return execFileAsync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL,
      GIT_TERMINAL_PROMPT: '0',
      ...env
    },
    maxBuffer: 12 * 1024 * 1024
  });
}
async function statusPorcelain(dir) { return (await runGit(dir, ['status', '--porcelain'])).stdout.trim(); }
async function rev(dir, name) { try { return (await runGit(dir, ['rev-parse', name])).stdout.trim(); } catch { return null; } }
async function isAncestor(dir, ancestor, descendant, env = {}) {
  try { await runGit(dir, ['merge-base', '--is-ancestor', ancestor, descendant], env); return true; }
  catch (error) { if (Number(error.code) === 1) return false; throw error; }
}

function applicationFileInfo(platform, name, stat) {
  const encodedName = encodeURIComponent(name);
  return { platform, name, size: stat.size, modifiedAt: stat.mtime.toISOString(), url: `/api/applications/download/${platform}/${encodedName}` };
}
async function listApplications() {
  const out = [];
  for (const [platform, extensions] of Object.entries(APPLICATION_PLATFORMS)) {
    const dir = path.join(APPLICATIONS, platform);
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.startsWith('.')) continue;
      if (!extensions.some(ext => entry.name.toLowerCase().endsWith(ext.toLowerCase()))) continue;
      try { out.push(applicationFileInfo(platform, entry.name, await fs.stat(path.join(dir, entry.name)))); } catch {}
    }
  }
  return out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}
function validApplication(platform, name) {
  const extensions = APPLICATION_PLATFORMS[platform];
  return Boolean(extensions && name && path.basename(name) === name && extensions.some(ext => name.toLowerCase().endsWith(ext.toLowerCase())));
}

const clients = new Map();
function broadcastClient(res, payload) { try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch {} }
function broadcast(userId, payload) { for (const [res, uid] of clients.entries()) if (uid === String(userId)) broadcastClient(res, payload); }

const projectLocks = new Map();
async function withProjectLock(projectId, fn) {
  const previous = projectLocks.get(projectId) || Promise.resolve();
  let current;
  current = previous.then(fn).finally(() => {
    if (projectLocks.get(projectId) === current) projectLocks.delete(projectId);
  });
  projectLocks.set(projectId, current);
  return current;
}

app.get('/api/auth/me', async (req, res) => {
  try {
    const a = await authUser(req, res, false);
    if (!a) return res.json({ authenticated: false });
    return res.json({ authenticated: true, user: { login: a.user.login, name: a.user.name, avatar: a.user.avatar } });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});
app.get('/login', (req, res) => res.sendFile(path.join(ROOT, 'public', 'login.html')));
app.get('/api/auth/login', async (req, res) => {
  try {
    if (!process.env.GITHUB_CLIENT_ID || !process.env.GITHUB_CLIENT_SECRET) return res.status(503).send('GitHub OAuth is not configured on this server.');
    supabaseRequired();
    const returnTo = allowedReturnTo(req.query.return_to, req);
    if (req.query.return_to && !returnTo) return res.status(400).send('Invalid return URL.');
    const state = randomToken(24);
    const codeVerifier = randomToken(32);
    const browserBinding = randomToken(24);
    const challenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    await createOAuthAttempt(state, codeVerifier, returnTo, browserBinding);
    res.setHeader('Set-Cookie', `${OAUTH_BINDING_COOKIE}=${browserBinding}; ${oauthBindingCookieOptions()}`);
    const redirectUri = process.env.GITHUB_CALLBACK_URL || `${publicBaseUrl(req)}/auth/github/callback`;
    const u = new URL('https://github.com/login/oauth/authorize');
    u.searchParams.set('client_id', process.env.GITHUB_CLIENT_ID);
    u.searchParams.set('redirect_uri', redirectUri);
    u.searchParams.set('scope', GITHUB_SCOPE);
    u.searchParams.set('state', state);
    u.searchParams.set('code_challenge', challenge);
    u.searchParams.set('code_challenge_method', 'S256');
    u.searchParams.set('allow_signup', process.env.GITHUB_ALLOW_SIGNUP === 'false' ? 'false' : 'true');
    res.redirect(u.toString());
  } catch (e) { res.status(500).send(`GitHub sign-in setup failed: ${e.message}`); }
});
app.get('/auth/github/callback', async (req, res) => {
  try {
    supabaseRequired();
    if (!req.query.code || !req.query.state) return res.status(400).send('Missing OAuth code/state.');
    const browserBinding = parseCookies(req)[OAUTH_BINDING_COOKIE];
    const attempt = await consumeOAuthAttempt(String(req.query.state), browserBinding);
    if (!attempt) {
      res.setHeader('Set-Cookie', clearOAuthBindingCookie());
      return res.status(400).send('Invalid, expired, or browser-mismatched OAuth state.');
    }
    const redirectUri = process.env.GITHUB_CALLBACK_URL || `${publicBaseUrl(req)}/auth/github/callback`;
    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: process.env.GITHUB_CLIENT_ID, client_secret: process.env.GITHUB_CLIENT_SECRET, code: req.query.code, state: req.query.state, redirect_uri: redirectUri, code_verifier: attempt.code_verifier })
    });
    const tokenData = await tokenResponse.json();
    if (!tokenResponse.ok || tokenData.error || !tokenData.access_token) throw new Error(tokenData.error_description || 'OAuth exchange failed.');
    const ghUser = await githubFetch('https://api.github.com/user', { headers: githubHeaders(tokenData.access_token) });
    const userId = String(ghUser.id);
    if (REQUIRE_GITHUB_ALLOWLIST && !ALLOWED_GITHUB_USER_IDS.has(userId)) return res.status(403).send('This GitHub account is not authorized to use this application.');
    const user = {
      id: userId, login: ghUser.login, name: ghUser.name || ghUser.login, avatar: ghUser.avatar_url,
      githubTokenEnc: encrypt(tokenData.access_token),
      githubRefreshTokenEnc: tokenData.refresh_token ? encrypt(tokenData.refresh_token) : null,
      githubExpiresAt: tokenData.expires_in ? Date.now() + Number(tokenData.expires_in) * 1000 : null,
      githubRefreshExpiresAt: tokenData.refresh_token_expires_in ? Date.now() + Number(tokenData.refresh_token_expires_in) * 1000 : null
    };
    await dbUserUpsert(user);
    if (attempt.return_to) {
      const code = await createLoginCode(user.id);
      const target = new URL(attempt.return_to);
      target.searchParams.set('code', code);
      res.setHeader('Set-Cookie', clearOAuthBindingCookie());
      return res.redirect(target.toString());
    }
    const token = await createSession(user.id);
    res.setHeader('Set-Cookie', [clearOAuthBindingCookie(), `${SESSION_COOKIE}=${token}; ${cookieOptions()}`]);
    return res.redirect('/');
  } catch (e) { res.status(400).send(`GitHub sign-in failed: ${e.message}`); }
});
app.post('/api/auth/exchange', ensureRequestProtection, async (req, res) => {
  try {
    const code = String(req.body?.code || '');
    if (!code) return res.status(400).json({ error: 'Missing login code.' });
    const row = await consumeLoginCode(code);
    if (!row) return res.status(401).json({ error: 'Login code is invalid or expired.' });
    const token = await createSession(row.user_id);
    const user = await dbGetUser(row.user_id);
    return res.json({ token, user: { login: user.login, name: user.name, avatar: user.avatar } });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});
app.post('/api/auth/logout', ensureRequestProtection, async (req, res) => {
  try {
    const bearer = getBearerToken(req);
    const cookie = parseCookies(req)[SESSION_COOKIE];
    await deleteSession(bearer || cookie);
    if (cookie) res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; ${cookieOptions()}; Max-Age=0`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function cleanSubmissionText(value, max = 4000) {
  return String(value ?? '').replace(/\u0000/g, '').replace(/\r/g, '').trim().slice(0, max);
}
function submissionFileStem() {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}`;
}
async function saveSubmission(kind, extension, content, contentType) {
  const dir = kind === 'feedback' ? FEEDBACK_DIR : CONTRIBUTE_DIR;
  const filename = `${submissionFileStem()}${extension}`;
  const fullPath = path.join(dir, filename);
  await fs.writeFile(fullPath, content, 'utf8');
  if (supabase) {
    try {
      await storageUpload(`${kind}/${filename}`, Buffer.from(content, 'utf8'), contentType);
    } catch (error) {
      await fs.rm(fullPath, { force: true }).catch(() => {});
      throw error;
    }
  }
  return { filename, path: path.relative(ROOT, fullPath).replaceAll(path.sep, '/') };
}
async function optionalAuthenticatedUser(req) {
  try { return (await getSession(req, { setHeader() {} }, {}))?.user || null; } catch { return null; }
}
app.get('/api/public/contact', (_req, res) => {
  res.json({
    githubUrl: String(process.env.PUBLIC_GITHUB_URL || '').trim(),
    email: String(process.env.PUBLIC_CONTACT_EMAIL || '').trim()
  });
});
app.post('/api/feedback', ensureRequestProtection, async (req, res) => {
  try {
    const body = req.body || {};
    if (cleanSubmissionText(body.website, 200)) return res.json({ ok: true });
    const user = await optionalAuthenticatedUser(req);
    const message = cleanSubmissionText(body.message, 8000);
    if (!message) return res.status(400).json({ error: 'Please enter your feedback.' });
    const name = cleanSubmissionText(body.name, 120) || user?.name || user?.login || 'Anonymous';
    const email = cleanSubmissionText(body.email, 254) || user?.email || '';
    const github = cleanSubmissionText(body.github, 120) || user?.login || '';
    const text = [
      'GitHub Project Pusher — Feedback',
      `Submitted: ${nowIso()}`,
      `Name: ${name}`,
      `Email: ${email || '(not provided)'}`,
      `GitHub: ${github || '(not provided)'}`,
      '',
      message,
      ''
    ].join('\\n');
    const saved = await saveSubmission('feedback', '.txt', text, 'text/plain');
    res.json({ ok: true, filename: saved.filename });
  } catch (e) { res.status(500).json({ error: e.message || 'Could not save feedback.' }); }
});
app.post('/api/contribute', ensureRequestProtection, async (req, res) => {
  try {
    const body = req.body || {};
    if (cleanSubmissionText(body.website, 200)) return res.json({ ok: true });
    const user = await optionalAuthenticatedUser(req);
    const contribution = {
      submittedAt: nowIso(),
      name: cleanSubmissionText(body.name, 120) || user?.name || user?.login || 'Anonymous',
      email: cleanSubmissionText(body.email, 254) || user?.email || '',
      github: cleanSubmissionText(body.github, 120) || user?.login || '',
      type: cleanSubmissionText(body.type, 60) || 'code',
      title: cleanSubmissionText(body.title, 200),
      link: cleanSubmissionText(body.link, 1000),
      description: cleanSubmissionText(body.description, 8000)
    };
    if (!contribution.title || !contribution.description) return res.status(400).json({ error: 'Please provide a contribution title and description.' });
    const saved = await saveSubmission('contribute', '.json', JSON.stringify(contribution, null, 2) + '\n', 'application/json');
    res.json({ ok: true, filename: saved.filename });
  } catch (e) { res.status(500).json({ error: e.message || 'Could not save contribution.' }); }
});

app.get('/api/applications', async (_req, res) => { try { res.setHeader('Cache-Control', 'no-store'); res.json(await listApplications()); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/api/applications/download/:platform/:name', async (req, res) => {
  const { platform, name } = req.params;
  if (!validApplication(platform, name)) return res.status(404).json({ error: 'Application build not found.' });
  const file = path.join(APPLICATIONS, platform, name);
  try { await fs.access(file); res.download(file, name); } catch { res.status(404).json({ error: 'Application build not found.' }); }
});

app.get('/api/events/ticket', async (req, res) => {
  const a = await authUser(req, res); if (!a) return;
  try { res.json({ ticket: await createSseTicket(a.user.id) }); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/events', async (req, res) => {
  try {
    let auth = null;
    if (req.query.ticket) auth = await consumeSseTicket(String(req.query.ticket));
    else auth = await authUser(req, res, false);
    if (!auth?.user) return res.status(401).json({ error: 'Not authenticated.' });
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    clients.set(res, auth.user.id);
    broadcastClient(res, { type: 'connected' });
    const heartbeat = setInterval(() => { try { res.write(': keep-alive\n\n'); } catch {} }, 25000);
    req.on('close', () => { clearInterval(heartbeat); clients.delete(res); });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/projects', async (req, res) => {
  const a = await authUser(req, res); if (!a) return;
  try {
    const list = await dbListProjects(a.user.id);
    res.json(list.map(p => ({ ...p, files: p.fileCount })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/projects', ensureRequestProtection, async (req, res, next) => {
  const auth = await authUser(req, res);
  if (!auth) return;
  req.gppAuth = auth;
  next();
}, (req, res, next) => {
  const len = Number(req.headers['content-length'] || 0);
  if (len && len > MAX_TOTAL_UPLOAD + 1024 * 1024) return res.status(413).json({ error: `Upload exceeds the ${Math.round(MAX_TOTAL_UPLOAD / 1024 / 1024)} MB total limit.` });
  next();
}, upload.array('files', MAX_FILES), async (req, res) => {
  const a = req.gppAuth;
  let workspace = null;
  try {
    const files = req.files || [];
    if (!files.length) throw new Error('Choose at least one file.');
    let total = 0;
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'gpp-upload-'));
    for (const file of files) {
      total += Number(file.size || 0);
      if (total > MAX_TOTAL_UPLOAD) throw new Error(`Upload exceeds ${Math.round(MAX_TOTAL_UPLOAD / 1024 / 1024)} MB.`);
      const rel = safeRelative(file.originalname);
      if (!rel) continue;
      const target = path.join(workspace, rel);
      if (!target.startsWith(workspace + path.sep)) continue;
      await fs.mkdir(path.dirname(target), { recursive: true });
      await moveFile(file.path, target);
    }
    const id = crypto.randomUUID();
    const first = files[0]?.originalname || 'project';
    const name = normalizeName(req.body.projectName || first.split(/[\\/]/)[0]);
    const project = { id, userId: a.user.id, name, createdAt: nowIso(), updatedAt: nowIso(), syncState: 'local', syncMessage: 'Stored in persistent cloud storage.', fileCount: await countFiles(workspace), storagePath: `projects/${a.user.id}/${id}/working.tgz` };
    await withProjectLock(id, async () => { await persistWorkingTree(project, workspace); await dbUpsertProject(project); });
    broadcast(a.user.id, { type: 'projects-changed', projectId: id });
    res.json({ ...project, files: project.fileCount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    for (const file of req.files || []) await fs.rm(file.path, { force: true }).catch(() => {});
    if (workspace) await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
});
app.delete('/api/projects/:id', ensureRequestProtection, async (req, res) => {
  const a = await authUser(req, res); if (!a) return;
  try {
    const project = await dbGetProject(req.params.id);
    if (!project || project.userId !== a.user.id) return res.status(404).json({ error: 'Project not found.' });
    await withProjectLock(project.id, async () => {
      const snapshots = await queryOne('snapshots', supabase.from('snapshots').select('storage_path').eq('project_id', project.id));
      const deployKey = await readGitHubDeployKey(project).catch(() => null);
      if (deployKey) {
        try { await deleteGitHubDeployKey(await userToken(a.user), deployKey); } catch {}
      }
      if (deployKey?.repoId && deployKey?.deployKeyId) githubDeployKeyCache.delete(`${deployKey.repoId}:${deployKey.deployKeyId}`);
      const objects = [project.storagePath, deployKeyObjectPath(project), ...(snapshots || []).map(x => x.storage_path)].filter(Boolean);
      await storageRemove(objects);
      if (snapshots?.length) await queryOne('snapshots', supabase.from('snapshots').delete().eq('project_id', project.id));
      await dbDeleteProject(project.id, a.user.id);
    });
    broadcast(a.user.id, { type: 'projects-changed' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/projects/:id/history', async (req, res) => {
  const a = await authUser(req, res); if (!a) return;
  try {
    const project = await dbGetProject(req.params.id);
    if (!project || project.userId !== a.user.id) return res.status(404).json({ error: 'Project not found.' });
    res.json(await listSnapshots(project.id, a.user.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/github/repos', async (req, res) => {
  const a = await authUser(req, res); if (!a) return;
  try {
    const token = await userToken(a.user);
    const repos = [];
    for (let page = 1; page <= 10; page++) {
      const data = await githubFetch(`https://api.github.com/user/repos?per_page=100&sort=updated&page=${page}`, { headers: githubHeaders(token) });
      repos.push(...data);
      if (data.length < 100) break;
    }
    res.json(repos.map(r => ({ id: r.id, name: r.name, full_name: r.full_name, private: r.private, clone_url: r.clone_url, default_branch: r.default_branch, html_url: r.html_url })));
  } catch (e) { res.status(502).json({ error: e.message }); }
});
app.post('/api/github/push', ensureRequestProtection, async (req, res) => {
  const a = await authUser(req, res); if (!a) return;
  const { projectId, repoId, repoName, visibility = 'private', branch = 'main' } = req.body || {};
  if (!projectId) return res.status(400).json({ error: 'Select a project.' });
  const pushBranch = String(branch || 'main').trim();
  try { await runGit(ROOT, ['check-ref-format', '--branch', pushBranch]); }
  catch { return res.status(400).json({ error: 'Enter a valid Git branch name.' }); }
  if (repoId && !/^\d+$/.test(String(repoId))) return res.status(400).json({ error: 'Select a valid GitHub repository.' });
  let stage = 'load project';
  try {
    const project = await dbGetProject(projectId);
    if (!project || project.userId !== a.user.id) return res.status(404).json({ error: 'Project not found.' });
    const token = await userToken(a.user);
    await withProjectLock(project.id, async () => {
      let repo;
      stage = repoId ? 'load selected GitHub repository' : 'create GitHub repository';
      if (repoId) repo = await githubFetch(`https://api.github.com/repositories/${repoId}`, { headers: githubHeaders(token) });
      else repo = await githubFetch('https://api.github.com/user/repos', { method: 'POST', headers: { ...githubHeaders(token), 'Content-Type': 'application/json' }, body: JSON.stringify({ name: normalizeName(repoName || project.name), private: visibility !== 'public', auto_init: false }) });
      const remoteUrl = githubSSHUrl(repo.full_name);
      let updatedProject = await updateProject(project.id, a.user.id, { repoId: repo.id, repoFullName: repo.full_name, repoUrl: repo.html_url, remoteUrl, branch: pushBranch, syncState: 'syncing', syncMessage: 'Push in progress.' });
      await withWorkspace(project, async dir => {
        stage = 'create safety snapshot';
        await snapshotProject(updatedProject, dir, 'before-push');
        stage = 'register GitHub SSH deploy key';
        const deployKey = await ensureGitHubDeployKey(token, project, repo);
        await ensureGit(dir, remoteUrl);
        stage = 'connect to GitHub over SSH';
        await withGitSSH(deployKey.privateKey, async env => {
          stage = 'fetch remote GitHub history';
          await runGit(dir, ['fetch', 'origin'], env);
          const selectedRemoteRef = await rev(dir, `origin/${pushBranch}`);
          const remoteBranch = selectedRemoteRef ? pushBranch : (repo.default_branch || pushBranch);
          const remoteRef = await rev(dir, `origin/${remoteBranch}`);
          stage = 'commit project changes';
          await runGit(dir, ['add', '-A'], env);
          let changes = false;
          try { await runGit(dir, ['diff', '--cached', '--quiet'], env); }
          catch (error) { if (Number(error.code) !== 1) throw error; changes = true; }
          if (changes) await runGit(dir, ['commit', '-m', `Sync from ${APP_NAME} ${nowIso()}`], env);
          const localHead = await rev(dir, 'HEAD');
          if (!localHead) throw new Error('This project has no committable files. Add files and try again.');
          if (remoteRef && !(await isAncestor(dir, remoteRef, localHead, env))) {
            stage = 'merge existing GitHub history';
            try { await runGit(dir, ['merge', '--no-edit', '--allow-unrelated-histories', `origin/${remoteBranch}`], env); }
            catch (error) {
              await runGit(dir, ['merge', '--abort'], env).catch(() => {});
              throw new Error(`Could not merge the selected repository history. Resolve conflicting files and retry. ${error.stderr || error.message}`);
            }
          }
          stage = 'push commits to GitHub';
          await runGit(dir, ['branch', '-M', pushBranch], env);
          await runGit(dir, ['push', '-u', 'origin', `HEAD:refs/heads/${pushBranch}`], env);
        });
        const commit = await rev(dir, 'HEAD');
        await snapshotProject(updatedProject, dir, 'after-push');
        const persisted = await persistWorkingTree(updatedProject, dir);
        updatedProject = { ...updatedProject, storagePath: persisted.storagePath, fileCount: await countFiles(dir), lastPushedAt: nowIso(), lastPushedCommit: commit, syncState: 'synced', syncMessage: 'Push completed.' };
      });
      await dbUpsertProject(updatedProject);
      project.lastPushedAt = updatedProject.lastPushedAt;
      Object.assign(project, updatedProject);
    });
    broadcast(a.user.id, { type: 'project-updated', projectId: project.id, reason: 'push' });
    res.json({ ok: true, repo: { full_name: project.repoFullName, html_url: project.repoUrl }, project: { ...project, files: project.fileCount } });
  } catch (e) {
    const detail = e.stderr || e.message || 'Unknown error.';
    await updateProject(projectId, a.user.id, { syncState: 'error', syncMessage: `${stage}: ${detail}` }).catch(() => {});
    res.status(500).json({ error: `${stage}: ${detail}` });
  }
});

async function syncProjectForUser(user, project) {
  if (!project.repoFullName || !project.branch) return;
  await withProjectLock(project.id, async () => {
    await withWorkspace(project, async dir => {
      try {
        const token = await userToken(user);
        if (!token) return;
        let repo = { id: project.repoId, full_name: project.repoFullName };
        if (!repo.id) repo = await githubFetch(`https://api.github.com/repos/${githubRepoPath(project.repoFullName)}`, { headers: githubHeaders(token) });
        const deployKey = await ensureGitHubDeployKey(token, project, repo);
        await ensureGit(dir, githubSSHUrl(repo.full_name));
        const dirty = await statusPorcelain(dir);
        const before = await rev(dir, 'HEAD');
        await withGitSSH(deployKey.privateKey, env => runGit(dir, ['fetch', 'origin', project.branch], env));
        const remote = await rev(dir, `origin/${project.branch}`);
        if (!remote || remote === before) return;
        if (dirty) {
          await updateProject(project.id, user.id, { syncState: 'conflict', syncMessage: 'Remote changes detected but local edits were left untouched.', lastCheckedAt: nowIso() });
          broadcast(user.id, { type: 'sync-conflict', projectId: project.id });
          return;
        }
        await snapshotProject(project, dir, 'before-pull');
        await withGitSSH(deployKey.privateKey, env => runGit(dir, ['pull', '--ff-only', 'origin', project.branch], env));
        const after = await rev(dir, 'HEAD');
        await snapshotProject(project, dir, 'after-pull');
        const persisted = await persistWorkingTree(project, dir);
        await updateProject(project.id, user.id, { storagePath: persisted.storagePath, fileCount: await countFiles(dir), syncState: 'synced', syncMessage: 'Remote changes pulled automatically.', lastSyncAt: nowIso(), lastPulledCommit: after, lastCheckedAt: nowIso() });
        broadcast(user.id, { type: 'project-updated', projectId: project.id, reason: 'github-pull' });
      } catch (e) {
        await updateProject(project.id, user.id, { syncState: 'error', syncMessage: e.stderr || e.message, lastCheckedAt: nowIso() }).catch(() => {});
        broadcast(user.id, { type: 'sync-error', projectId: project.id });
      }
    });
  });
}
let syncRunning = false;
async function syncAll() {
  if (syncRunning || !supabase) return;
  syncRunning = true;
  try {
    const users = await dbListUsers();
    for (const user of users) {
      if (!user.githubTokenEnc) continue;
      const projects = await dbListProjects(user.id);
      for (const project of projects) if (project.repoFullName) await syncProjectForUser(user, project);
    }
  } catch {}
  finally { syncRunning = false; }
}

app.get('/api/health', async (_req, res) => {
  let persistence = hasSupabase ? 'supabase-postgres-and-storage' : 'local-ephemeral';
  let datastore = 'not-configured';
  if (supabase) {
    const { error } = await supabase.from('users').select('id').limit(1);
    datastore = error ? 'error' : 'ready';
    if (error && isProd) return res.status(503).json({ ok: false, app: APP_NAME, persistence, datastore, error: 'Persistent datastore is unavailable.' });
  }
  res.json({ ok: true, app: APP_NAME, persistence, datastore, storageBucket: hasSupabase ? STORAGE_BUCKET : null, syncIntervalMs: SYNC_MS, maxArchiveMb: Math.round(MAX_ARCHIVE_SIZE / 1024 / 1024), maxSnapshots: MAX_SNAPSHOTS });
});

app.use((err, _req, res, next) => {
  if (err?.code === 'LIMIT_TOTAL_UPLOAD') return res.status(413).json({ error: err.message });
  if (err instanceof multer.MulterError) return res.status(413).json({ error: `Upload rejected: ${err.message}` });
  if (err) return res.status(500).json({ error: 'Unexpected server error.' });
  next();
});

async function cleanupUploads() {
  const now = Date.now();
  for (const name of await fs.readdir(UPLOAD_TEMP).catch(() => [])) {
    const p = path.join(UPLOAD_TEMP, name);
    const stat = await fs.stat(p).catch(() => null);
    if (stat && now - stat.mtimeMs > 60 * 60 * 1000) await fs.rm(p, { force: true }).catch(() => {});
  }
}
await cleanupUploads();
if (supabase) {
  setInterval(() => { cleanupAuthRecords(); }, 15 * 60 * 1000).unref();
  setInterval(() => { syncAll(); }, SYNC_MS).unref();
}

// Backend-hosted UI remains available. GitHub Pages publishes public/ separately.
app.get('/{*splat}', (_req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));
app.listen(PORT, HOST, () => console.log(`${APP_NAME} running on http://${HOST}:${PORT}`));
