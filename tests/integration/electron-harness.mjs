// Test-only entry point. Never included in Desktop or Sidecar production files.
import { app, BrowserWindow } from 'electron';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDesktop } from '../../apps/desktop/dist/main/host.js';

app.disableHardwareAcceleration();
const root = resolve(import.meta.dirname, '../..');
const stageDirectory = resolve(root, 'build/stage', `${{ win32: 'win', darwin: 'mac', linux: 'linux' }[process.platform]}-${process.arch}`, 'sidecar');
let host;
const initial = { kind: 'test-start', dataDirectory: process.argv[2] };
if (!initial.dataDirectory?.startsWith(resolve(root, '.cache'))) app.exit(1);
app.setPath('userData', initial.dataDirectory);
// A poisoned parent environment must not reach the independent Node sidecar.
process.env.NODE_OPTIONS = '--require=operation-agent-must-never-load';
process.env.NODE_PATH = resolve(root, '.cache/untrusted-modules');
process.env.PATH = resolve(root, '.cache/untrusted-executables');
void app.whenReady().then(async () => {
  try {
    host = await startDesktop({ stageDirectory, dataDirectory: resolve(initial.dataDirectory, 'database'), show: false, requireControlPlane: true });
    process.send({ kind: 'ready', pid: process.pid });
  } catch (error) { process.send({ kind: 'failed', error: error.message }, () => app.exit(1)); }
});

process.on('message', async message => {
  if (!host || !message.id) return;
  try {
    let value;
    switch (message.command) {
      case 'snapshot':
        value = { ...host.supervisor.snapshot(), mainPid: process.pid, electron: process.versions.electron,
          renderer: await host.window.webContents.executeJavaScript(`(async () => ({
            health: await window.operationAgent.getControlPlaneHealth(),
            node: typeof process, require: typeof require,
            keys: Object.keys(window.operationAgent), mounted: document.querySelector('#root').childElementCount > 0
          }))()`) };
        break;
      case 'state': value = host.supervisor.snapshot(); break;
      case 'health-burst':
        value = await host.window.webContents.executeJavaScript(`(async () => {
          let accepted = 0, rejected = 0;
          for (let i = 0; i < ${JSON.stringify(message.input)}; i++) {
            try { await window.operationAgent.getControlPlaneHealth(); accepted++; } catch { rejected++; }
          }
          return { accepted, rejected };
        })()`);
        break;
      case 'workbench':
        value = await host.window.webContents.executeJavaScript(`(async () => {
          const api = window.operationAgent; const settings = await api.getSettings();
          const saved = await api.saveSettings({ ...settings, theme: 'dark', stopGraceMs: 10000 });
          const tooLong = await api.saveSettings({ ...settings, stopGraceMs: 31000 }).then(() => 'allowed', () => 'rejected');
          const missing = await api.saveSettings({ ...settings, activeProjectId: crypto.randomUUID() }).then(() => 'allowed', error => error.message);
          const task = await api.startTask({ projectId: crypto.randomUUID(), prompt: 'run anything' });
          const emptyTask = await api.startTask({ projectId: crypto.randomUUID(), prompt: '   ' }).then(() => 'allowed', () => 'rejected');
          const forged = await api.removeProject({ id: 'not-a-uuid' }).then(() => 'allowed', () => 'rejected');
          return { saved, tooLong, missing, task, emptyTask, forged, overview: await api.getOverview(), runs: await api.listRuns(),
            projects: await api.listProjects(), after: await api.getSettings() };
        })()`);
        break;
      case 'write': value = await host.window.webContents.executeJavaScript(`window.operationAgent.writeSmokeRecords(${JSON.stringify(message.input)})`); break;
      case 'list': value = await host.window.webContents.executeJavaScript('window.operationAgent.listSmokeRecords()'); break;
      case 'csp':
        value = await host.window.webContents.executeJavaScript(`fetch('http://127.0.0.1:${host.supervisor.snapshot().port}/v1/health').then(() => 'allowed', () => 'blocked')`);
        break;
      case 'invalid-input':
        value = await host.window.webContents.executeJavaScript("window.operationAgent.writeSmokeRecords({records:[],exec:'invalid'}).then(()=>'allowed',()=>'rejected')");
        break;
      case 'foreign-window': {
        const foreign = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
          preload: fileURLToPath(new URL('../../apps/desktop/dist/preload/index.cjs', import.meta.url)) } });
        try {
          await foreign.loadFile(resolve(root, 'apps/desktop/dist/renderer/index.html'));
          value = await foreign.webContents.executeJavaScript("window.operationAgent.getControlPlaneHealth().then(()=>'allowed',error=>String(error.message))");
        } finally { foreign.destroy(); }
        break;
      }
      case 'navigation': {
        const original = host.window.webContents.getURL();
        await host.window.webContents.executeJavaScript("location.href='https://example.invalid'");
        await new Promise(resolve => setTimeout(resolve, 100));
        value = host.window.webContents.getURL() === original;
        break;
      }
      case 'close':
        await host.stop(); process.send({ id: message.id, value: 'closed' }, () => app.exit(0)); return;
      default: throw new Error('UNKNOWN_TEST_COMMAND');
    }
    process.send({ id: message.id, value });
  } catch (error) { process.send({ id: message.id, error: error.message }); }
});
process.on('disconnect', () => { void host?.stop().finally(() => app.exit(1)); });
