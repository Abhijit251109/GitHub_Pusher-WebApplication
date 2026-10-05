const { app, BrowserWindow, shell } = require('electron');
const path = require('path');

const APP_URL = process.env.GPP_APP_URL || 'https://github-pusher-g3ac.onrender.com';

function createWindow() {
  const win = new BrowserWindow({
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
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.loadURL(APP_URL);
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
