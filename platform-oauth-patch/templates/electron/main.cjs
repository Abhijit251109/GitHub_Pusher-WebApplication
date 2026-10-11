require('dotenv/config');

const { app, BrowserWindow, shell } = require('electron');
const path = require('node:path');

const APP_URL = process.env.GPP_APP_URL || process.env.PUBLIC_BASE_URL || 'https://github-pusher-g3ac.onrender.com';
const APP_PROTOCOL = 'com.githubprojectpusher.app';
const OAUTH_HOST = 'auth';
const OAUTH_PATH = '/callback';
const OAUTH_NONCE_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const OAUTH_CODE_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

let mainWindow = null;
let pendingOAuthCallback = null;

function parseOAuthCallback(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ''));
    const code = url.searchParams.get('code') || '';
    const nonce = url.searchParams.get('nonce') || '';
    if (url.protocol !== `${APP_PROTOCOL}:` || url.hostname !== OAUTH_HOST || url.pathname !== OAUTH_PATH) return null;
    if (!OAUTH_CODE_PATTERN.test(code) || !OAUTH_NONCE_PATTERN.test(nonce)) return null;
    return { code, nonce };
  } catch {
    return null;
  }
}

function callbackPageUrl({ code, nonce }) {
  const target = new URL('/login.html', APP_URL);
  target.searchParams.set('code', code);
  target.searchParams.set('nonce', nonce);
  target.searchParams.set('source', 'desktop');
  return target.toString();
}

function isDesktopOAuthStart(rawUrl) {
  try {
    const target = new URL(rawUrl);
    const appOrigin = new URL(APP_URL).origin;
    return target.origin === appOrigin
      && target.pathname === '/api/auth/login'
      && target.searchParams.get('client') === 'desktop';
  } catch {
    return false;
  }
}

function openPendingOAuthCallback() {
  if (!pendingOAuthCallback || !mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.webContents.isLoading()) return;

  const callback = pendingOAuthCallback;
  pendingOAuthCallback = null;
  mainWindow.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
  mainWindow.loadURL(callbackPageUrl(callback)).catch(error => {
    console.error('Could not open the GitHub sign-in return page:', error.message);
  });
}

function handleProtocolUrl(rawUrl) {
  const callback = parseOAuthCallback(rawUrl);
  if (!callback) return false;

  pendingOAuthCallback = callback;
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isLoading()) {
    openPendingOAuthCallback();
  }
  return true;
}

// Windows/Linux pass custom URLs as process arguments (including on a second
// launch); macOS emits open-url. Register listeners before app.whenReady().
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, commandLine) => {
    const deepLink = commandLine.find(value => String(value).startsWith(`${APP_PROTOCOL}://`));
    if (deepLink) handleProtocolUrl(deepLink);
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.on('open-url', (event, url) => {
    event.preventDefault();
    handleProtocolUrl(url);
  });

  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(APP_PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient(APP_PROTOCOL);
  }

  function createWindow() {
    mainWindow = new BrowserWindow({
      width: 1440,
      height: 940,
      minWidth: 1024,
      minHeight: 700,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url).catch(error => console.error('Could not open external link:', error.message));
      return { action: 'deny' };
    });

    // OAuth must run in the system browser so it has a single, consistent cookie
    // jar. The backend sends the result back through our registered app URI.
    mainWindow.webContents.on('will-navigate', (event, url) => {
      if (!isDesktopOAuthStart(url)) return;
      event.preventDefault();
      shell.openExternal(url).catch(error => console.error('Could not open GitHub sign-in:', error.message));
    });
    mainWindow.webContents.on('did-finish-load', openPendingOAuthCallback);
    mainWindow.on('closed', () => { mainWindow = null; });
    mainWindow.loadURL(APP_URL).catch(error => console.error('Could not load GitHub Project Pusher:', error.message));
  }

  app.whenReady().then(() => {
    createWindow();

    // If the OS launched a new process for the original deep link, process it
    // after the window has loaded. The single-instance event handles later links.
    const startupLink = process.argv.find(value => String(value).startsWith(`${APP_PROTOCOL}://`));
    if (startupLink) handleProtocolUrl(startupLink);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
