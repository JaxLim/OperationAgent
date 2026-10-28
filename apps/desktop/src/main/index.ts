import { app, BrowserWindow } from 'electron';
import { fileURLToPath } from 'node:url';

// Empty engineering host only; no sidecar or Worker is started by this entry point.
async function createFoundationWindow(): Promise<void> {
  const window = new BrowserWindow({ webPreferences: {
    contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
    preload: fileURLToPath(new URL('../preload/index.cjs', import.meta.url)),
  } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  await window.loadFile(fileURLToPath(new URL('../renderer/index.html', import.meta.url)));
}

void app.whenReady().then(createFoundationWindow).catch(() => app.exit(1));
app.on('window-all-closed', () => app.quit());
