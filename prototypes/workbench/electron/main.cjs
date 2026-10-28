// Standalone desktop window for the UI prototype. It only displays the built static bundle:
// no preload, no Node integration, sandboxed renderer, every non-bundle request cancelled.
// It is deliberately unrelated to apps/desktop (no Express sidecar, no Worker, no IPC).
'use strict';

const { app, BrowserWindow, Menu, nativeTheme, session } = require('electron');
const path = require('node:path');
const { fileURLToPath } = require('node:url');

const DIST = path.resolve(__dirname, '..', 'dist');
const INDEX = path.join(DIST, 'index.html');

function insideBundle(url) {
  if (url.startsWith('devtools://')) return true;
  if (!url.startsWith('file://')) return false;
  const file = path.resolve(fileURLToPath(url));
  return file === DIST || file.startsWith(DIST + path.sep);
}

app.enableSandbox();
app.setName('OperationAgent Prototype');

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !insideBundle(details.url) }));

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 640,
    title: 'OperationAgent — prototype',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#151514' : '#f7f6f3',
    show: false,
    autoHideMenuBar: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, spellcheck: false },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.once('ready-to-show', () => win.show());
  void win.loadFile(INDEX);
});

app.on('window-all-closed', () => app.quit());
