import { app } from 'electron';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDesktop } from './host.js';

let host: Awaited<ReturnType<typeof startDesktop>> | undefined;
let starting: Promise<void> | undefined;
let exiting = false;
if (!app.requestSingleInstanceLock()) app.exit(0);
else {
  starting = app.whenReady().then(async () => {
    if (exiting) return;
    const platforms: Partial<Record<NodeJS.Platform, string>> = { win32: 'win', darwin: 'mac', linux: 'linux' };
    const builderOS = platforms[process.platform];
    if (!builderOS) throw new Error('UNSUPPORTED_PLATFORM');
    const stageDirectory = app.isPackaged ? resolve(process.resourcesPath, 'sidecar') :
      resolve(fileURLToPath(new URL('../../../../build/stage/', import.meta.url)), `${builderOS}-${process.arch}`, 'sidecar');
    host = await startDesktop({ stageDirectory, dataDirectory: resolve(app.getPath('userData'), 'control-plane') });
    host.window.on('close', event => { if (!exiting) { event.preventDefault(); app.quit(); } });
  });
  void starting.catch(() => { console.error('DESKTOP_START_FAILED'); app.exit(1); });
}
app.on('before-quit', event => {
  if (exiting) return;
  event.preventDefault(); exiting = true;
  void (async () => { await starting; await host?.stop(); })().then(() => app.exit(0)).catch(() => app.exit(1));
});
app.on('window-all-closed', () => app.quit());
