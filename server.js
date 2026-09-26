import express from 'express';
import multer from 'multer';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const app = express();
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = process.cwd();
const APPLICATIONS = path.join(ROOT, 'application');
const APPLICATION_PLATFORMS = { windows: ['.msi', '.exe'], macos: ['.dmg', '.pkg', '.zip'], android: ['.apk', '.aab'], linux: ['.AppImage', '.deb', '.rpm', '.zip'] };
const DATA = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA, 'store.json');
const PROJECTS = path.join(DATA, 'projects');
const HISTORY = path.join(DATA, 'history');
const MAX_FILES = Number(process.env.MAX_UPLOAD_FILES || 2000);
const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE_MB || 50) * 1024 * 1024;
const MAX_TOTAL_UPLOAD = Number(process.env.MAX_TOTAL_UPLOAD_MB || 250) * 1024 * 1024;
const MAX_SNAPSHOTS = Number(process.env.MAX_SNAPSHOTS_PER_PROJECT || 20);
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_DAYS || 30) * 24 * 60 * 60 * 1000;
const SYNC_MS = Number(process.env.SYNC_INTERVAL_MS || 20000);
const APP_NAME = process.env.APP_NAME || 'GitHub Project Pusher';
const COOKIE = 'gpp_session';
const isProd = process.env.NODE_ENV === 'production';

if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY));
const uploadTemp = path.join(DATA, 'uploads');
await fs.mkdir(uploadTemp, { recursive: true });
const upload = multer({ storage: multer.diskStorage({ destination: (_req, _file, cb) => cb(null, uploadTemp), filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}-${normalizeName(path.basename(file.originalname || 'file'))}`) }), limits: { files: MAX_FILES, fileSize: MAX_FILE_SIZE } });
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(ROOT, 'public')));
await fs.mkdir(DATA, { recursive: true });
await fs.mkdir(APPLICATIONS, { recursive: true });
await Promise.all(Object.keys(APPLICATION_PLATFORMS).map(platform => fs.mkdir(path.join(APPLICATIONS, platform), { recursive: true })));
await fs.mkdir(PROJECTS, { recursive: true });
await fs.mkdir(HISTORY, { recursive: true });

function secretKey() {
  const secret = process.env.TOKEN_ENCRYPTION_KEY;
  if (!secret || !/^[0-9a-fA-F]{64}$/.test(secret)) {
    console.warn('TOKEN_ENCRYPTION_KEY is missing or invalid. Generate 64 hex characters for production.');
    return crypto.createHash('sha256').update(process.env.SESSION_SECRET || 'development-only-insecure-secret').digest();
  }
  return Buffer.from(secret, 'hex');
}
function sessionSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) console.warn('SESSION_SECRET is missing or shorter than 32 characters. Set a strong secret in production.');
  return secret || 'development-only-insecure-secret';
}
const KEY = secretKey();
const SESSION_HASH_KEY = crypto.createHash('sha256').update(sessionSecret()).digest();
function sessionHash(value) { return crypto.createHmac('sha256', SESSION_HASH_KEY).update(value).digest('hex'); }

function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
}
function decrypt(value) {
  const [ivS, tagS, dataS] = String(value).split('.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivS, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagS, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(dataS, 'base64url')), decipher.final()]).toString('utf8');
}

async function readDB() {
  try { return JSON.parse(await fs.readFile(DB_FILE, 'utf8')); }
  catch { return { users: {}, sessions: {}, projects: {} }; }
}
async function writeDB(db) {
  const temp = `${DB_FILE}.tmp-${crypto.randomUUID()}`;
  await fs.writeFile(temp, JSON.stringify(db, null, 2));
  await fs.rename(temp, DB_FILE);
}

function cookieOptions() {
  const parts = [`Path=/`, `HttpOnly`, `SameSite=Lax`];
  if (isProd || process.env.COOKIE_SECURE === 'true') parts.push('Secure');
  return parts.join('; ');
}
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  for (const pair of raw.split(';')) {
    const i = pair.indexOf('='); if (i < 0) continue;
    out[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim());
  }
  return out;
}
async function getSession(req, res) {
  const db = await readDB();
  let sid = parseCookies(req)[COOKIE];
  const key = sid && sessionHash(sid);
  if (!sid || !db.sessions[key] || (db.sessions[key].createdAt + SESSION_TTL_MS) < Date.now()) {
    sid = crypto.randomBytes(32).toString('hex');
    const hashed = sessionHash(sid);
    await mutateDB(current => { current.sessions[hashed] = { createdAt: Date.now() }; });
    res.setHeader('Set-Cookie', `${COOKIE}=${sid}; ${cookieOptions()}`);
  }
  const fresh = await readDB();
  return { db: fresh, sid, session: fresh.sessions[sessionHash(sid)] };
}
async function authUser(req, res, required = true) {
  const ctx = await getSession(req, res);
  if (!ctx.session.userId) {
    if (required) res.status(401).json({ error: 'Please sign in with GitHub.' });
    return null;
  }
  const user = ctx.db.users[ctx.session.userId];
  if (!user) {
    if (required) res.status(401).json({ error: 'Session expired. Please sign in again.' });
    return null;
  }
  return { ...ctx, user };
}
function normalizeName(s) {
  return String(s || '').replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || 'project';
}
function safeRelative(rel) {
  const n = path.posix.normalize(String(rel || '').replaceAll('\\', '/'));
  if (!n || n === '.' || n.startsWith('../') || n.includes('/../') || path.posix.isAbsolute(n)) return null;
  return n;
}
function publicBaseUrl(req) {
  return process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
}
function sameOrigin(req) {
  const origin = req.get('Origin');
  if (!origin) return true;
  try { return new URL(origin).origin === new URL(publicBaseUrl(req)).origin; } catch { return false; }
}
function requireSameOrigin(req, res, next) {
  if (!sameOrigin(req)) return res.status(403).json({ error: 'Cross-origin request blocked.' });
  next();
}
function githubHeaders(token) {
  return { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': APP_NAME };
}
async function githubFetch(url, options = {}) {
  const r = await fetch(url, options);
  const text = await r.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) throw new Error((data && data.message) || `GitHub API error ${r.status}`);
  return data;
}
async function userToken(user) {
  if (!user.githubTokenEnc) return null;
  if (user.githubExpiresAt && user.githubExpiresAt - Date.now() < 60_000 && user.githubRefreshTokenEnc) {
    const refresh = decrypt(user.githubRefreshTokenEnc);
    const response = await fetch('https://github.com/login/oauth/access_token', { method:'POST', headers:{Accept:'application/json','Content-Type':'application/json'}, body:JSON.stringify({client_id:process.env.GITHUB_CLIENT_ID,client_secret:process.env.GITHUB_CLIENT_SECRET,grant_type:'refresh_token',refresh_token:refresh}) });
    const data = await response.json();
    if (!response.ok || data.error || !data.access_token) throw new Error(data.error_description || 'GitHub token refresh failed. Please reconnect GitHub.');
    await mutateDB(db => { const u=db.users[user.id]; if (!u) return; u.githubTokenEnc=encrypt(data.access_token); u.githubRefreshTokenEnc=data.refresh_token ? encrypt(data.refresh_token) : u.githubRefreshTokenEnc; u.githubExpiresAt=data.expires_in ? Date.now()+Number(data.expires_in)*1000 : null; u.githubRefreshExpiresAt=data.refresh_token_expires_in ? Date.now()+Number(data.refresh_token_expires_in)*1000 : u.githubRefreshExpiresAt; u.updatedAt=new Date().toISOString(); });
    user.githubTokenEnc = encrypt(data.access_token);
    user.githubRefreshTokenEnc = data.refresh_token ? encrypt(data.refresh_token) : user.githubRefreshTokenEnc;
    user.githubExpiresAt = data.expires_in ? Date.now()+Number(data.expires_in)*1000 : null;
    user.githubRefreshExpiresAt = data.refresh_token_expires_in ? Date.now()+Number(data.refresh_token_expires_in)*1000 : user.githubRefreshExpiresAt;
    return data.access_token;
  }
  return decrypt(user.githubTokenEnc);
}
function projectDir(userId, projectId) { return path.join(PROJECTS, normalizeName(userId), projectId); }
function historyDir(userId, projectId) { return path.join(HISTORY, normalizeName(userId), projectId); }
async function saveDB(db) { await writeDB(db); }
let dbMutationQueue = Promise.resolve();
function mutateDB(mutator) {
  const task = dbMutationQueue.then(async () => {
    const db = await readDB();
    const result = await mutator(db);
    await saveDB(db);
    return result;
  });
  dbMutationQueue = task.catch(() => {});
  return task;
}
async function projectListFor(userId) {
  const db = await readDB();
  return Object.values(db.projects).filter(p => p.userId === userId).sort((a,b) => a.name.localeCompare(b.name));
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
  await walk(root); return count;
}
function broadcastClient(res, payload) { try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch {} }
const clients = new Map();
function broadcast(userId, payload) { for (const [res, uid] of clients.entries()) if (uid === userId) broadcastClient(res, payload); }

async function ensureGit(dir, cloneUrl) {
  await fs.mkdir(dir, { recursive: true });
  let initialized = false;
  try { await fs.access(path.join(dir, '.git')); }
  catch { await runGit(dir, ['init']); initialized = true; }
  await runGit(dir, ['config', 'user.name', APP_NAME]);
  await runGit(dir, ['config', 'user.email', 'github-project-pusher@localhost']);
  try { await runGit(dir, ['remote', 'get-url', 'origin']); await runGit(dir, ['remote', 'set-url', 'origin', cloneUrl]); }
  catch { await runGit(dir, ['remote', 'add', 'origin', cloneUrl]); }
  return initialized;
}
function askpassScript() {
  return path.join(os.tmpdir(), `gpp-askpass-${crypto.randomUUID()}.cjs`);
}
async function withGitAuth(token, fn) {
  const file = askpassScript();
  await fs.writeFile(file, `const p=process.argv.slice(2).join(' ');process.stdout.write(/username/i.test(p)?'x-access-token':(process.env.GH_TOKEN||''));\n`);
  try { await fs.chmod(file, 0o700); return await fn({ GIT_ASKPASS: file, GH_TOKEN: token, GIT_TERMINAL_PROMPT: '0' }); }
  finally { await fs.rm(file, { force: true }); }
}
async function runGit(cwd, args, env = {}) { return execFileAsync('git', args, { cwd, env: { ...process.env, ...env }, maxBuffer: 12 * 1024 * 1024 }); }
async function statusPorcelain(dir) { return (await runGit(dir, ['status', '--porcelain'])).stdout.trim(); }
async function rev(dir, name) { try { return (await runGit(dir, ['rev-parse', name])).stdout.trim(); } catch { return null; } }
async function snapshot(userId, projectId, label) {
  const source = projectDir(userId, projectId);
  const stamp = new Date().toISOString().replaceAll(':', '-');
  const dest = path.join(historyDir(userId, projectId), `${stamp}-${label}`);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.cp(source, dest, { recursive: true, filter: p => !p.split(path.sep).includes('.git') });
  const root = historyDir(userId, projectId);
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const dirs = entries.filter(e => e.isDirectory()).map(e => e.name).sort().reverse();
  for (const stale of dirs.slice(MAX_SNAPSHOTS)) await fs.rm(path.join(root, stale), { recursive: true, force: true });
  return dest;
}
async function updateProject(projectId, patch) {
  const db = await readDB();
  db.projects[projectId] = { ...db.projects[projectId], ...patch, updatedAt: new Date().toISOString() };
  await saveDB(db);
  return db.projects[projectId];
}

function applicationFileInfo(platform, name, stat) {
  const encodedName = encodeURIComponent(name);
  return { platform, name, size: stat.size, modifiedAt: stat.mtime.toISOString(), url: `/api/applications/download/${platform}/${encodedName}` };
}
async function listApplications() {
  const out = [];
  for (const [platform, extensions] of Object.entries(APPLICATION_PLATFORMS)) {
    const dir = path.join(APPLICATIONS, platform);
    let entries = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.startsWith('.')) continue;
      const lower = entry.name.toLowerCase();
      const ext = extensions.find(x => lower.endsWith(x.toLowerCase()));
      if (!ext) continue;
      try { const stat = await fs.stat(path.join(dir, entry.name)); out.push(applicationFileInfo(platform, entry.name, stat)); } catch {}
    }
  }
  return out.sort((a,b) => b.modifiedAt.localeCompare(a.modifiedAt));
}
function validApplication(platform, name) {
  const extensions = APPLICATION_PLATFORMS[platform];
  if (!extensions || !name || path.basename(name) !== name) return false;
  const lower = name.toLowerCase();
  return extensions.some(ext => lower.endsWith(ext.toLowerCase()));
}

app.get('/api/auth/me', async (req,res) => {
  const a = await authUser(req,res,false);
  if (!a) return res.json({ authenticated:false });
  res.json({ authenticated:true, user:{ login:a.user.login, name:a.user.name, avatar:a.user.avatar } });
});
app.get('/login', (_req,res) => res.redirect('/api/auth/login'));
app.get('/api/auth/login', async (req,res) => {
  if (!process.env.GITHUB_CLIENT_ID || !process.env.GITHUB_CLIENT_SECRET) return res.status(503).send('GitHub OAuth is not configured on this server.');
  const ctx = await getSession(req,res);
  const state = crypto.randomBytes(24).toString('hex');
  await mutateDB(db => { const session = db.sessions[sessionHash(ctx.sid)]; if (session) session.oauthState = state; });
  const redirect = process.env.GITHUB_CALLBACK_URL || `${publicBaseUrl(req)}/auth/github/callback`;
  const scope = process.env.GITHUB_OAUTH_SCOPE || 'repo offline_access';
  const u = new URL('https://github.com/login/oauth/authorize');
  u.searchParams.set('client_id', process.env.GITHUB_CLIENT_ID);
  u.searchParams.set('redirect_uri', redirect);
  u.searchParams.set('scope', scope);
  u.searchParams.set('state', state);
  res.redirect(u.toString());
});
app.get('/auth/github/callback', async (req,res) => {
  try {
    const ctx = await getSession(req,res);
    if (!req.query.code || !req.query.state || req.query.state !== ctx.session.oauthState) return res.status(400).send('Invalid OAuth state.');
    const tokenData = await fetch('https://github.com/login/oauth/access_token', { method:'POST', headers:{Accept:'application/json','Content-Type':'application/json'}, body:JSON.stringify({client_id:process.env.GITHUB_CLIENT_ID,client_secret:process.env.GITHUB_CLIENT_SECRET,code:req.query.code,state:req.query.state,redirect_uri:process.env.GITHUB_CALLBACK_URL || `${publicBaseUrl(req)}/auth/github/callback`}) }).then(async r => { const d=await r.json(); if(!r.ok || d.error) throw new Error(d.error_description || 'OAuth exchange failed.'); return d; });
    const ghUser = await githubFetch('https://api.github.com/user', { headers: githubHeaders(tokenData.access_token) });
    await mutateDB(db => { db.users[ghUser.id] = { id:String(ghUser.id), login:ghUser.login, name:ghUser.name || ghUser.login, avatar:ghUser.avatar_url, githubTokenEnc:encrypt(tokenData.access_token), githubRefreshTokenEnc:tokenData.refresh_token ? encrypt(tokenData.refresh_token) : undefined, githubExpiresAt: tokenData.expires_in ? Date.now() + Number(tokenData.expires_in) * 1000 : null, githubRefreshExpiresAt: tokenData.refresh_token_expires_in ? Date.now() + Number(tokenData.refresh_token_expires_in) * 1000 : null, updatedAt:new Date().toISOString() }; db.sessions[sessionHash(ctx.sid)] = { ...db.sessions[sessionHash(ctx.sid)], userId:String(ghUser.id), oauthState:null }; });
    res.redirect('/');
  } catch (e) { res.status(400).send(`GitHub sign-in failed: ${e.message}`); }
});
app.post('/api/auth/logout', requireSameOrigin, async (req,res) => { const ctx=await getSession(req,res); await mutateDB(db => { delete db.sessions[sessionHash(ctx.sid)]; }); res.setHeader('Set-Cookie', `${COOKIE}=; ${cookieOptions()}; Max-Age=0`); res.json({ok:true}); });

app.get('/api/applications', async (_req,res) => { try { res.setHeader('Cache-Control','no-store'); res.json(await listApplications()); } catch (e) { res.status(500).json({error:e.message}); } });
app.get('/api/applications/download/:platform/:name', async (req,res) => {
  const { platform, name } = req.params;
  if (!validApplication(platform, name)) return res.status(404).json({error:'Application build not found.'});
  const file = path.join(APPLICATIONS, platform, name);
  try { await fs.access(file); res.download(file, name); } catch { res.status(404).json({error:'Application build not found.'}); }
});

app.get('/api/projects', async (req,res) => { const a=await authUser(req,res); if(!a)return; const db=await readDB(); const list=Object.values(db.projects).filter(p=>p.userId===a.user.id); for(const p of list){p.files=await countFiles(projectDir(a.user.id,p.id));} res.json(list.sort((x,y)=>x.name.localeCompare(y.name))); });
app.get('/api/events', async (req,res) => { const a=await authUser(req,res); if(!a)return; res.setHeader('Content-Type','text/event-stream'); res.setHeader('Cache-Control','no-cache, no-transform'); res.setHeader('Connection','keep-alive'); res.setHeader('X-Accel-Buffering','no'); res.flushHeaders?.(); clients.set(res,a.user.id); broadcastClient(res,{type:'connected'}); const heartbeat=setInterval(()=>{ try{res.write(': keep-alive\n\n');}catch{} },25000); req.on('close',()=>{clearInterval(heartbeat);clients.delete(res);}); });

app.post('/api/projects', requireSameOrigin, (req,res,next) => { const len = Number(req.headers['content-length'] || 0); if (len && len > MAX_TOTAL_UPLOAD + 1024 * 1024) return res.status(413).json({error:`Upload exceeds the ${Math.round(MAX_TOTAL_UPLOAD / 1024 / 1024)} MB total limit.`}); next(); }, upload.array('files', MAX_FILES), async (req,res) => {
  const a=await authUser(req,res); if(!a)return;
  try {
    const id=crypto.randomUUID(); const first=req.files?.[0]?.originalname || 'project'; const name=normalizeName(req.body.projectName || first.split(/[\\/]/)[0]); const dir=projectDir(a.user.id,id); await fs.mkdir(dir,{recursive:true});
    let totalBytes = 0;
    for(const file of req.files || []) {
      totalBytes += Number(file.size || 0);
      if(totalBytes > MAX_TOTAL_UPLOAD) throw new Error(`Upload exceeds the ${Math.round(MAX_TOTAL_UPLOAD / 1024 / 1024)} MB total limit.`);
      const rel=safeRelative(file.originalname);
      if(!rel) continue;
      const target=path.join(dir,rel);
      if(!target.startsWith(dir+path.sep)) continue;
      await fs.mkdir(path.dirname(target),{recursive:true});
      await fs.rename(file.path,target);
    }
    for(const file of req.files || []) { if(file.path) await fs.rm(file.path,{force:true}); }
    const now=new Date().toISOString(); const saved=await mutateDB(db=>{db.projects[id]={id,userId:a.user.id,name,createdAt:now,updatedAt:now,syncState:'local'}; return db.projects[id];}); broadcast(a.user.id,{type:'projects-changed',projectId:id}); res.json(saved);
  } catch(e) { await fs.rm(typeof dir !== 'undefined' ? dir : '',{recursive:true,force:true}).catch(()=>{}); for(const file of req.files || []) { if(file.path) await fs.rm(file.path,{force:true}).catch(()=>{}); } res.status(500).json({error:e.message}); }
});
app.delete('/api/projects/:id', requireSameOrigin, async (req,res) => { const a=await authUser(req,res); if(!a)return; const id=req.params.id; try { const db=await readDB(); const p=db.projects[id]; if(!p || p.userId!==a.user.id) return res.status(404).json({error:'Project not found.'}); await fs.rm(projectDir(a.user.id,id),{recursive:true,force:true}); await mutateDB(current=>{ delete current.projects[id]; }); broadcast(a.user.id,{type:'projects-changed'}); res.json({ok:true}); } catch(e){res.status(500).json({error:e.message});} });
app.get('/api/projects/:id/history', async(req,res)=>{const a=await authUser(req,res);if(!a)return;const db=await readDB();const p=db.projects[req.params.id];if(!p||p.userId!==a.user.id)return res.status(404).json({error:'Project not found.'});let out=[];try{out=(await fs.readdir(historyDir(a.user.id,p.id),{withFileTypes:true})).filter(x=>x.isDirectory()).map(x=>x.name).sort().reverse();}catch{}res.json(out);});

app.get('/api/github/repos', async(req,res)=>{const a=await authUser(req,res);if(!a)return;try{const token=await userToken(a.user);const repos=[];for(let page=1;page<=10;page++){const data=await githubFetch(`https://api.github.com/user/repos?per_page=100&sort=updated&page=${page}`,{headers:githubHeaders(token)});repos.push(...data);if(data.length<100)break;}res.json(repos.map(r=>({id:r.id,name:r.name,full_name:r.full_name,private:r.private,clone_url:r.clone_url,default_branch:r.default_branch,html_url:r.html_url})));}catch(e){res.status(502).json({error:e.message});}});
app.post('/api/github/push', requireSameOrigin, async(req,res)=>{
  const a=await authUser(req,res);if(!a)return;
  const {projectId,repoId,repoName,visibility='private',branch='main'}=req.body||{}; if(!projectId)return res.status(400).json({error:'Select a project.'});
  const db=await readDB(); const p=db.projects[projectId]; if(!p||p.userId!==a.user.id)return res.status(404).json({error:'Project not found.'});
  const dir=projectDir(a.user.id,p.id); const token=await userToken(a.user); try {
    let repo;
    if(repoId) repo=await githubFetch(`https://api.github.com/repositories/${repoId}`,{headers:githubHeaders(token)});
    else repo=await githubFetch('https://api.github.com/user/repos',{method:'POST',headers:{...githubHeaders(token),'Content-Type':'application/json'},body:JSON.stringify({name:normalizeName(repoName||p.name),private:visibility!=='public',auto_init:false})});
    await snapshot(a.user.id,p.id,'before-push');
    await ensureGit(dir,repo.clone_url);
    const dirty=await statusPorcelain(dir);
    await withGitAuth(token, async env=>{
      await runGit(dir,['fetch','origin'],env).catch(()=>{});
      const remoteBranch=repo.default_branch || branch;
      if(!dirty){
        const remoteRef=await rev(dir,`origin/${remoteBranch}`);
        const head=await rev(dir,'HEAD');
        if(remoteRef && !head) throw new Error('Selected repository already has history. Add it to a fresh repository or pull/merge it first.');
      }
      await runGit(dir,['add','-A'],env);
      let changes=true; try{await runGit(dir,['diff','--cached','--quiet'],env);changes=false;}catch{}
      if(changes) await runGit(dir,['commit','-m',`Sync from ${APP_NAME} ${new Date().toISOString()}`],env);
      await runGit(dir,['branch','-M',branch],env);
      await runGit(dir,['push','-u','origin',branch],env);
    });
    await snapshot(a.user.id,p.id,'after-push');
    const commit=await rev(dir,'HEAD'); const updated=await updateProject(p.id,{repoId:repo.id,repoFullName:repo.full_name,repoUrl:repo.html_url,remoteUrl:repo.clone_url,branch,lastPushedAt:new Date().toISOString(),lastPushedCommit:commit,syncState:'synced',syncMessage:'Push completed.'}); broadcast(a.user.id,{type:'project-updated',projectId:p.id,reason:'push'}); res.json({ok:true,repo:{full_name:repo.full_name,html_url:repo.html_url},project:updated});
  } catch(e){ await updateProject(p.id,{syncState:'error',syncMessage:e.stderr||e.message}); res.status(500).json({error:e.stderr||e.message||'Push failed.'}); }
});

async function syncProjectForUser(db,user,p){
  if(!p.repoFullName||!p.branch)return;
  const token=await userToken(user); if(!token)return; const dir=projectDir(user.id,p.id);
  try {
    await ensureGit(dir,p.remoteUrl);
    const dirty=await statusPorcelain(dir); const before=await rev(dir,'HEAD');
    await withGitAuth(token,env=>runGit(dir,['fetch','origin',p.branch],env));
    const remote=await rev(dir,`origin/${p.branch}`); if(!remote || remote===before) return;
    if(dirty){ await updateProject(p.id,{syncState:'conflict',syncMessage:'Remote changes detected but local edits were left untouched.',lastCheckedAt:new Date().toISOString()}); broadcast(user.id,{type:'sync-conflict',projectId:p.id}); return; }
    await snapshot(user.id,p.id,'before-pull');
    await withGitAuth(token,env=>runGit(dir,['pull','--ff-only','origin',p.branch],env));
    const after=await rev(dir,'HEAD'); await snapshot(user.id,p.id,'after-pull');
    await updateProject(p.id,{syncState:'synced',syncMessage:'Remote changes pulled automatically.',lastSyncAt:new Date().toISOString(),lastPulledCommit:after}); broadcast(user.id,{type:'project-updated',projectId:p.id,reason:'github-pull'});
  } catch(e){ await updateProject(p.id,{syncState:'error',syncMessage:e.stderr||e.message,lastCheckedAt:new Date().toISOString()}); broadcast(user.id,{type:'sync-error',projectId:p.id}); }
}
let syncRunning = false;
async function syncAll(){
  if (syncRunning) return;
  syncRunning = true;
  try {
    const db=await readDB();
    for(const user of Object.values(db.users)){
      if(!user.githubTokenEnc) continue;
      for(const p of Object.values(db.projects).filter(x=>x.userId===user.id&&x.repoFullName)){
        await syncProjectForUser(db,user,p);
      }
    }
  } finally {
    syncRunning = false;
  }
}
setInterval(()=>syncAll().catch(()=>{}),SYNC_MS);

app.use((err, _req, res, next) => {
  if (err instanceof multer.MulterError) return res.status(413).json({ error: `Upload rejected: ${err.message}` });
  if (err) return res.status(500).json({ error: 'Unexpected server error.' });
  next();
});
async function cleanupUploads(){ const now=Date.now(); for(const name of await fs.readdir(uploadTemp).catch(()=>[])){ const p=path.join(uploadTemp,name); const stat=await fs.stat(p).catch(()=>null); if(stat && now-stat.mtimeMs>60*60*1000) await fs.rm(p,{force:true}).catch(()=>{}); } }
await cleanupUploads();
app.get('/api/health',(_req,res)=>res.json({ok:true,app:APP_NAME,syncIntervalMs:SYNC_MS,persistence:'file-backed',maxUploadMb:Math.round(MAX_TOTAL_UPLOAD/1024/1024),maxSnapshots:MAX_SNAPSHOTS}));
app.get('/{*splat}',(_req,res)=>res.sendFile(path.join(ROOT,'public','index.html')));
app.listen(PORT,HOST,()=>console.log(`${APP_NAME} running on http://${HOST}:${PORT}`));
