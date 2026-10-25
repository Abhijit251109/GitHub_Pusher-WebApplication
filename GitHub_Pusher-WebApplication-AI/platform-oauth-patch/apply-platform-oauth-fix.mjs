import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const patchDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = process.cwd();
const templates = path.join(patchDir, 'templates');

function read(relativePath) {
  const fullPath = path.join(projectRoot, relativePath);
  if (!fs.existsSync(fullPath)) throw new Error(`Required project file not found: ${relativePath}. Run this script from the project root.`);
  return { fullPath, text: fs.readFileSync(fullPath, 'utf8') };
}
function write(relativePath, value) {
  const fullPath = path.join(projectRoot, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, value);
}
function replaceOnce(text, pattern, replacement, label) {
  const match = text.match(pattern);
  if (!match) throw new Error(`Could not locate ${label}; no changes have been committed. Check that this is the current project version.`);
  return text.replace(pattern, replacement);
}
function copyTemplate(relativePath) {
  const src = path.join(templates, relativePath);
  if (!fs.existsSync(src)) throw new Error(`Patch template missing: ${relativePath}`);
  const dest = path.join(projectRoot, relativePath);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

// 1) Patch only the two OAuth-sensitive backend/frontend files in place so
//    unrelated routes, dashboard UI, and recent public/app.js changes survive.
{
  const { fullPath, text: original } = read('server.js');
  let source = original;
  if (!source.includes("const NATIVE_OAUTH_REDIRECT_URI = 'com.githubprojectpusher.app://auth/callback';")) {
    source = replaceOnce(source,
      /const OAUTH_BINDING_COOKIE = 'gpp_oauth_pre';\s*/,
      "const OAUTH_BINDING_COOKIE = 'gpp_oauth_pre';\n// Shared custom URI scheme for Android and Electron desktop OAuth handoff.\nconst NATIVE_OAUTH_REDIRECT_URI = 'com.githubprojectpusher.app://auth/callback';\nconst NATIVE_OAUTH_NONCE_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;\n",
      'the OAuth binding cookie constant');
  }
  if (!source.includes('function isNativeOAuthReturnTo(value)')) {
    source = replaceOnce(source, /function clearOAuthBindingCookie\(\) \{/,
`function isNativeOAuthReturnTo(value) {
  try {
    const target = new URL(String(value || ''));
    return target.protocol === 'com.githubprojectpusher.app:'
      && target.hostname === 'auth'
      && target.pathname === '/callback'
      && NATIVE_OAUTH_NONCE_PATTERN.test(target.searchParams.get('nonce') || '');
  } catch { return false; }
}
function clearOAuthBindingCookie() {`, 'the OAuth cookie helper');
  }
  const consumeStart = source.indexOf('async function consumeOAuthAttempt(state, browserBinding) {');
  if (consumeStart < 0) throw new Error('Could not locate consumeOAuthAttempt in server.js.');
  const consumeEnd = source.indexOf('\n}', consumeStart);
  if (consumeEnd < 0) throw new Error('Could not locate the end of consumeOAuthAttempt in server.js.');
  const currentConsume = source.slice(consumeStart, consumeEnd + 2);
  if (!currentConsume.includes('isNativeOAuthReturnTo(row.return_to)')) {
    source = source.slice(0, consumeStart) + `async function consumeOAuthAttempt(state, browserBinding) {
  const row = await queryOne('oauth_attempts', supabase.from('oauth_attempts').select('*').eq('state_hash', hashSecret(state)).maybeSingle());
  if (!row) return null;
  await queryOne('oauth_attempts', supabase.from('oauth_attempts').delete().eq('state_hash', hashSecret(state)));
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  // Native clients return through a registered URI rather than the system browser's cookie jar.
  // State + PKCE remain mandatory; the browser-binding cookie remains required for web attempts.
  const isNativeAttempt = isNativeOAuthReturnTo(row.return_to);
  if (!isNativeAttempt && (!browserBinding || !row.client_cookie_hash || hashSecret(browserBinding) !== row.client_cookie_hash)) return null;
  return row;
}` + source.slice(consumeEnd + 2);
  }
  const loginStart = source.indexOf("app.get('/api/auth/login', async (req, res) => {");
  const callbackStart = source.indexOf("app.get('/auth/github/callback'", loginStart);
  if (loginStart < 0 || callbackStart < 0) throw new Error('Could not locate the OAuth login/callback route boundary in server.js.');
  const loginBlock = `app.get('/api/auth/login', async (req, res) => {
  try {
    if (!process.env.GITHUB_CLIENT_ID || !process.env.GITHUB_CLIENT_SECRET) return res.status(503).send('GitHub OAuth is not configured on this server.');
    supabaseRequired();
    const nativeClient = String(req.query.client || '').toLowerCase();
    const isNativeClient = nativeClient === 'android' || nativeClient === 'desktop';
    let returnTo;
    if (isNativeClient) {
      const mobileNonce = String(req.query.mobile_nonce || '');
      if (!NATIVE_OAUTH_NONCE_PATTERN.test(mobileNonce)) {
        return res.status(400).send('Missing or invalid native login nonce. Please retry sign-in from the installed app.');
      }
      const nativeTarget = new URL(NATIVE_OAUTH_REDIRECT_URI);
      nativeTarget.searchParams.set('nonce', mobileNonce);
      returnTo = nativeTarget.toString();
    } else {
      returnTo = allowedReturnTo(req.query.return_to, req);
      if (req.query.return_to && !returnTo) return res.status(400).send('Invalid return URL.');
    }
    const state = randomToken(24);
    const codeVerifier = randomToken(32);
    const browserBinding = randomToken(24);
    const challenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    await createOAuthAttempt(state, codeVerifier, returnTo, browserBinding);
    res.setHeader('Set-Cookie', \`\${OAUTH_BINDING_COOKIE}=\${browserBinding}; \${oauthBindingCookieOptions()}\`);
    const redirectUri = process.env.GITHUB_CALLBACK_URL || \`\${publicBaseUrl(req)}/auth/github/callback\`;
    const u = new URL('https://github.com/login/oauth/authorize');
    u.searchParams.set('client_id', process.env.GITHUB_CLIENT_ID);
    u.searchParams.set('redirect_uri', redirectUri);
    u.searchParams.set('scope', GITHUB_SCOPE);
    u.searchParams.set('state', state);
    u.searchParams.set('code_challenge', challenge);
    u.searchParams.set('code_challenge_method', 'S256');
    u.searchParams.set('allow_signup', process.env.GITHUB_ALLOW_SIGNUP === 'false' ? 'false' : 'true');
    res.redirect(u.toString());
  } catch (e) { res.status(500).send(\`GitHub sign-in setup failed: \${e.message}\`); }
});
\n`;
  const oldLogin = source.slice(loginStart, callbackStart);
  if (!oldLogin.includes('NATIVE_OAUTH_REDIRECT_URI')) {
    source = source.slice(0, loginStart) + loginBlock + source.slice(callbackStart);
  }
  if (!source.includes('if (attempt.return_to)')) throw new Error('The OAuth callback does not support return_to login-code handoff; refusing to patch.');
  if (source !== original) write('server.js', source);
}

{
  const { text: original } = read('public/login.js');
  let source = original;
  if (!source.includes('function nativeClient()')) {
    source = replaceOnce(source, /  async function exchange\(base\) \{/,
`  function randomMobileNonce() {
    const bytes = new Uint8Array(32);
    window.crypto.getRandomValues(bytes);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/g, '');
  }
  function nativeClient() {
    if (/GitHubProjectPusherAndroid/i.test(navigator.userAgent)) return 'android';
    if (/Electron\\//i.test(navigator.userAgent)) return 'desktop';
    if (window.Capacitor && typeof window.Capacitor.getPlatform === 'function' && window.Capacitor.getPlatform() === 'android') return 'android';
    return '';
  }
  async function exchange(base) {`, 'the login exchange function');
  }
  if (!source.includes("sessionStorage.removeItem('gpp_mobile_oauth_nonce')")) {
    source = replaceOnce(source,
      /    sessionStorage\.setItem\('gpp_access_token', data\.token\);\s*location\.replace\('\.\/index\.html'\);/,
      `    sessionStorage.setItem('gpp_access_token', data.token);
    if (nativeClient()) {
      sessionStorage.removeItem('gpp_mobile_oauth_nonce');
      localStorage.removeItem('gpp_mobile_oauth_nonce');
    }
    location.replace('./index.html');`, 'the token exchange success path');
  }
  const beginStart = source.indexOf('  function begin(base) {');
  const codeStart = source.indexOf('  if (code) {', beginStart);
  if (beginStart < 0 || codeStart < 0) throw new Error('Could not locate begin()/callback logic in public/login.js.');
  const currentBegin = source.slice(beginStart, codeStart);
  if (!currentBegin.includes('mobile_nonce')) {
    source = source.slice(0, beginStart) + `  function begin(base) {
    base = trimBase(base);
    if (!validBase(base)) { error.textContent='Please enter a full URL starting with http:// or https://'; error.style.display='block'; return; }
    sessionStorage.setItem('gpp_app_url', base);
    localStorage.setItem('gpp_app_url', base);
    const client = nativeClient();
    if (client) {
      let mobileNonce;
      try { mobileNonce = randomMobileNonce(); }
      catch {
        status.textContent = 'Secure GitHub sign-in is unavailable.';
        error.textContent = 'This app could not generate a secure login nonce. Update the app/WebView and try again.';
        error.style.display = 'block';
        return;
      }
      sessionStorage.setItem('gpp_mobile_oauth_nonce', mobileNonce);
      localStorage.setItem('gpp_mobile_oauth_nonce', mobileNonce);
      location.href = \`\${base}/api/auth/login?client=\${client}&mobile_nonce=\${encodeURIComponent(mobileNonce)}\`;
      return;
    }
    const returnTo = location.href.split('#')[0];
    location.href = \`\${base}/api/auth/login?return_to=\${encodeURIComponent(returnTo)}\`;
  }

` + source.slice(codeStart);
  }
  const codeBlockStart = source.indexOf('  if (code) {');
  const sameOriginStart = source.indexOf('  const sameOriginBackend', codeBlockStart);
  if (codeBlockStart < 0 || sameOriginStart < 0) throw new Error('Could not locate the callback block in public/login.js.');
  const currentCodeBlock = source.slice(codeBlockStart, sameOriginStart);
  if (!currentCodeBlock.includes('expectedNonce')) {
    source = source.slice(0, codeBlockStart) + `  if (code) {
    if (nativeClient()) {
      const returnedNonce = params.get('nonce') || '';
      const expectedNonce = sessionStorage.getItem('gpp_mobile_oauth_nonce') || localStorage.getItem('gpp_mobile_oauth_nonce') || '';
      if (!returnedNonce || !expectedNonce || returnedNonce !== expectedNonce) {
        status.textContent = 'GitHub sign-in could not be matched to this app session.';
        error.textContent = 'For your security, this login callback was rejected. Return to the app and start GitHub sign-in again.';
        error.style.display = 'block';
        setup.classList.remove('hidden');
        return;
      }
    }
    const base = backendFromCurrentPage();
    if (!base) { status.textContent = 'Enter your backend URL to finish sign-in.'; setup.classList.remove('hidden'); }
    else exchange(base).catch(err => { status.textContent='Login failed'; error.textContent=err.message; error.style.display='block'; setup.classList.remove('hidden'); });
    return;
  }
` + source.slice(sameOriginStart);
  }
  if (source !== original) write('public/login.js', source);
}

// 2) Copy platform-specific shell/config/build helpers. Do not overwrite
//    public/app.js, server routes other than OAuth, or existing deployment config.
for (const relativePath of [
  'electron/main.cjs',
  'electron-builder.yml',
  'capacitor.config.ts',
  'scripts/configure-android-oauth.mjs',
  'scripts/prepare-android.mjs',
  'scripts/build-android.mjs',
  'native/android/app/src/main/java/com/githubprojectpusher/app/MainActivity.java',
  'docs/PLATFORM_OAUTH_FIX.md',
  '.github/workflows/build-linux-appimage.yml'
]) copyTemplate(relativePath);

// Apply the URL callback filter to the source scaffold without deleting the
// existing theme/provider/configChanges declarations.
function ensureManifestCallback(relativePath) {
  const fullPath = path.join(projectRoot, relativePath);
  if (!fs.existsSync(fullPath)) return;
  let manifest = fs.readFileSync(fullPath, 'utf8');
  const activityMatch = manifest.match(/<activity\b(?=[^>]*android:name="[^"]*MainActivity")[^>]*>[\s\S]*?<\/activity>/);
  if (!activityMatch) throw new Error(`Could not find MainActivity in ${relativePath}`);
  let activity = activityMatch[0];
  if (!activity.includes('android:launchMode="singleTask"')) {
    activity = activity.replace(/<activity\b/, '<activity android:launchMode="singleTask"');
  }
  if (!activity.includes('android:scheme="com.githubprojectpusher.app"')) {
    activity = activity.replace('</activity>', `
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="com.githubprojectpusher.app" android:host="auth" android:path="/callback" />
            </intent-filter>
        </activity>`);
  }
  manifest = manifest.replace(activityMatch[0], activity);
  fs.writeFileSync(fullPath, manifest);
}
ensureManifestCallback('native/android/app/src/main/AndroidManifest.xml');
ensureManifestCallback('android/app/src/main/AndroidManifest.xml');

// Preserve package.json and all dependency versions; adjust only the Electron
// install-script allowlist key that no longer matches the pinned major version.
{
  const { text } = read('package.json');
  const pkg = JSON.parse(text);
  pkg.allowScripts = { ...(pkg.allowScripts || {}) };
  if (pkg.allowScripts['electron@39.0.0'] && !pkg.allowScripts.electron) {
    delete pkg.allowScripts['electron@39.0.0'];
    pkg.allowScripts.electron = true;
    write('package.json', JSON.stringify(pkg, null, 2) + '\n');
  }
}

// Prevent a Windows artifact build from trying to publish a release.
{
  const f = path.join(projectRoot, '.github/workflows/build-windows-msi.yml');
  if (fs.existsSync(f)) {
    const before = fs.readFileSync(f, 'utf8');
    const after = before.replace('npm run build:windows-installer -- --x64\n', 'npm run build:windows-installer -- --x64 --publish never\n');
    if (after !== before) fs.writeFileSync(f, after);
  }
}

console.log('Applied the platform OAuth patch. No APK or desktop installer was built.');
