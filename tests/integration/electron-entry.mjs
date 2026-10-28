// Exercise the actual production entry and its window-close/before-quit handlers.
import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import { resolve, sep } from 'node:path';

const dataDirectory = process.argv[2];
if (!dataDirectory?.startsWith(resolve(import.meta.dirname, '../../.cache') + sep)) app.exit(1);
app.setPath('userData', dataDirectory); app.disableHardwareAcceleration();
app.on('browser-window-created', (_event, window) => {
  window.hide();
  window.webContents.once('did-finish-load', () => {
    void (async () => {
      const health = await window.webContents.executeJavaScript('window.operationAgent.getControlPlaneHealth()');
      const id = randomUUID();
      await window.webContents.executeJavaScript(`window.operationAgent.writeSmokeRecords(${JSON.stringify({ records: [{ id, value: 'production entry' }] })})`);
      process.send({ health, id }, () => window.close());
    })().catch(() => app.exit(1));
  });
});
await import('../../apps/desktop/dist/main/index.js');
