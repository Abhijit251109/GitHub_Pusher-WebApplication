// Request-safety helpers: origin policy, input validation, client-safe errors and job limits.
// Kept free of Express app state so scripts/test-security.mjs can exercise them directly.
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';

// An error whose message is written for end users. Anything in `internal` is for server logs only.
export class AppError extends Error {
  constructor(code, message, { status = 400, details, internal } = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
    this.internal = internal;
  }
}

// Response body for any error: AppError messages pass through; everything else is replaced by a
// generic message plus a reference id that also appears in the server log line.
export function errorResponse(e, { context = 'Request', fallback = 'Something went wrong on the server.', log = console.error } = {}) {
  if (e instanceof AppError) {
    if (e.internal) log(`${context} [${e.code}]: ${e.internal}`);
    return { status: e.status, body: { error: e.message, code: e.code, ...(e.details ? { details: e.details } : {}) } };
  }
  const ref = crypto.randomBytes(4).toString('hex');
  log(`${context} failed [ref ${ref}]:`, e?.stack || e, e?.stderr ? `\nstderr: ${e.stderr}` : '');
  return { status: 500, body: { error: `${fallback} (ref ${ref})`, code: 'SERVER_ERROR', ref } };
}

// Credentialed CORS and the state-changing-request check accept exactly these origins.
const DEV_ORIGINS = new Set(['http://localhost', 'http://localhost:3000', 'http://localhost:5173', 'http://localhost:5174', 'http://localhost:8080', 'http://localhost:4173', 'http://127.0.0.1:4173']);
export function createOriginPolicy({ isProd, frontendUrl, publicBaseUrl }) {
  const configured = new Set();
  for (const url of [frontendUrl, publicBaseUrl]) {
    if (!url) continue;
    try { configured.add(new URL(url).origin); } catch { throw new Error(`Invalid URL in configuration: ${url}`); }
  }
  return {
    origins: [...configured],
    allowed(origin) {
      let normalized;
      try { normalized = new URL(String(origin)).origin; } catch { return false; }
      if (normalized === 'null') return false;
      return configured.has(normalized) || (!isProd && DEV_ORIGINS.has(normalized));
    }
  };
}

// `trust proxy` must be explicit so rate limits key on the real client IP without letting clients
// spoof it. TRUST_PROXY=true would trust any X-Forwarded-For value, so it is rejected.
export function parseTrustProxy(value) {
  if (value == null || String(value).trim() === '') return undefined;
  const v = String(value).trim();
  if (/^\d+$/.test(v)) return Number(v);
  if (v === 'false') return false;
  if (v === 'true') throw new Error('TRUST_PROXY=true lets any client spoof its IP via X-Forwarded-For. Set it to the number of proxies in front of the app (1 on Render) or to the proxy addresses.');
  return v; // Express also accepts 'loopback', 'uniquelocal' and comma-separated IPs/CIDRs.
}

const BRANCH_SHAPE = /^[A-Za-z0-9._/-]{1,200}$/;
// Shape check only; callers also run `git check-ref-format --branch` on the result.
export function parseBranch(value) {
  if (value === undefined || value === null || value === '') return 'main';
  if (typeof value !== 'string') throw new AppError('INVALID_BRANCH', 'Branch must be a single branch name.');
  if (!BRANCH_SHAPE.test(value) || value.startsWith('refs/') || value.startsWith('-') || value === 'HEAD') {
    throw new AppError('INVALID_BRANCH', 'Branch names may use letters, numbers, ".", "_", "-" and "/", and must not start with "refs/" or "-".');
  }
  return value;
}

// GitHub repository ids are positive integers; anything else could alter the API path.
export function parseRepoId(value) {
  if (value === undefined || value === null || value === '') return null;
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^[1-9][0-9]{0,15}$/.test(text)) throw new AppError('INVALID_REPO_ID', 'Repository id must be a positive number.');
  return text;
}

// GitHub repository names: letters, digits, ".", "_", "-"; never "." or "..".
export function assertRepoName(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9._-]{1,100}$/.test(name) || /^\.+$/.test(name)) {
    throw new AppError('INVALID_REPO_NAME', 'Repository names may use letters, numbers, ".", "_" and "-", and cannot be only dots.');
  }
  return name;
}

export function parseOptionalString(value, field, { max = 200 } = {}) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > max) throw new AppError('INVALID_INPUT', `${field} must be text of at most ${max} characters.`);
  return value;
}

export function parseCommitMessage(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > 5000 || /[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(value)) {
    throw new AppError('INVALID_COMMIT_MESSAGE', 'Commit message must be text of at most 5000 characters.');
  }
  return value.trim() ? value : null;
}

export function parseEnum(value, field, allowed, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (!allowed.includes(value)) throw new AppError('INVALID_INPUT', `${field} must be one of: ${allowed.join(', ')}.`);
  return value;
}

// Whether a token may delete repositories, from GitHub's X-OAuth-Scopes header: true/false, or
// null when unknown (GitHub App tokens send no such header). delete_repo is opt-in (see SECURITY.md).
export function tokenCanDeleteRepos(scopesHeader) {
  if (scopesHeader === null || scopesHeader === undefined) return null;
  return String(scopesHeader).split(',').map(s => s.trim()).includes('delete_repo');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function parseProjectId(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new AppError('INVALID_PROJECT', 'Select a project.');
  return value;
}

// Bounds git/tar/Storage work: a fixed number of jobs server-wide and per user. Requests over the
// bound are refused immediately rather than waiting behind the per-project lock. Jobs end on
// their own because every git, GitHub and Supabase call has a timeout and each job has a deadline
// (GIT_TIMEOUT_MS, JOB_TIMEOUT_MS in server.js), so a hung call cannot hold a slot indefinitely.
export function createJobGate({ maxConcurrent, maxPerUser }) {
  let running = 0;
  const perUser = new Map();
  return {
    tryAcquire(userId) {
      const key = String(userId);
      if ((perUser.get(key) || 0) >= maxPerUser) return { ok: false, code: 'JOB_IN_PROGRESS', message: 'Another push, fetch or upload of yours is still running. Wait for it to finish, then try again.' };
      if (running >= maxConcurrent) return { ok: false, code: 'SERVER_BUSY', message: 'The server is busy with other pushes. Try again in a minute.' };
      running++;
      perUser.set(key, (perUser.get(key) || 0) + 1);
      let released = false;
      return {
        ok: true,
        release() {
          if (released) return;
          released = true;
          running--;
          const left = perUser.get(key) - 1;
          if (left > 0) perUser.set(key, left); else perUser.delete(key);
        }
      };
    },
    get running() { return running; }
  };
}

// Middleware: takes a job slot for req.auth.user or answers 429. The slot is held until the job's
// handler settles (req.releaseJob), not until the client disconnects, so aborting and retrying
// cannot stack up work. If the request ends before the handler starts, the slot is freed then.
export function jobSlot(gate) {
  return (req, res, next) => {
    const slot = gate.tryAcquire(req.auth.user.id);
    if (!slot.ok) {
      res.setHeader('Retry-After', '30');
      return res.status(429).json({ error: slot.message, code: slot.code });
    }
    req.releaseJob = slot.release;
    res.on('close', () => { if (!req.jobStarted) slot.release(); });
    next();
  };
}
// Wraps a job handler. The slot is released just before the response is written (handlers finish
// their work, including temp-file cleanup, before answering), so a client that gets its answer and
// immediately starts the next job is never refused with JOB_IN_PROGRESS. Releasing after the
// handler resolved raced with that next request. If the handler ends without answering, the
// slot is released then.
export function runJob(handler) {
  return async (req, res, next) => {
    req.jobStarted = true;
    const end = res.end;
    res.end = function (...args) { req.releaseJob?.(); return end.apply(this, args); };
    try { return await handler(req, res, next); } finally { res.end = end; req.releaseJob?.(); }
  };
}

// Integer settings from the environment. A value that is set but not a whole number in range stops
// startup: a silent NaN would disable the limit it configures (e.g. a NaN rate limit never fires).
export function envInt(env, name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const text = String(raw).trim();
  const value = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be a whole number between ${min} and ${max}; got "${raw}".`);
  }
  return value;
}

export function limiter({ windowMs, limit, key = 'ip', text = false }) {
  const message = 'Too many requests. Wait a few minutes and try again.';
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    ...(key === 'user' ? { keyGenerator: req => `user:${req.auth.user.id}` } : {}),
    handler: (_req, res, _next, options) => {
      res.status(options.statusCode);
      if (text) res.type('text/plain').send(message);
      else res.json({ error: message, code: 'RATE_LIMITED' });
    }
  });
}
