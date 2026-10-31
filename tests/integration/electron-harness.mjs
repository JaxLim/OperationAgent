// Test-only entry point. Never included in Desktop or Sidecar production files.
import { app, BrowserWindow, safeStorage } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDesktop } from '../../apps/desktop/dist/main/host.js';

app.disableHardwareAcceleration();
const root = resolve(import.meta.dirname, '../..');
const stageDirectory = resolve(root, 'build/stage', `${{ win32: 'win', darwin: 'mac', linux: 'linux' }[process.platform]}-${process.arch}`, 'sidecar');
let host;
const initial = { kind: 'test-start', dataDirectory: process.argv[2], modelEndpoint: process.argv[3] };
if (!initial.dataDirectory?.startsWith(resolve(root, '.cache'))) app.exit(1);
app.setPath('userData', initial.dataDirectory);
// A poisoned parent environment must not reach the independent Node sidecar.
process.env.NODE_OPTIONS = '--require=operation-agent-must-never-load';
process.env.NODE_PATH = resolve(root, '.cache/untrusted-modules');
process.env.PATH = resolve(root, '.cache/untrusted-executables');
void app.whenReady().then(async () => {
  try {
    host = await startDesktop({ stageDirectory, dataDirectory: resolve(initial.dataDirectory, 'database'), show: false, requireControlPlane: true,
      ...(initial.modelEndpoint ? { modelEndpoint: initial.modelEndpoint } : {}) });
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
          const missingTask = await api.getTask({ taskId: crypto.randomUUID() }).then(() => 'allowed', error => error.message);
          const missingEvents = await api.listTaskEvents({ taskId: crypto.randomUUID(), afterSeq: 0 }).then(() => 'allowed', error => error.message);
          const badCursor = await api.listTaskEvents({ taskId: crypto.randomUUID(), afterSeq: -1 }).then(() => 'allowed', () => 'rejected');
          return { saved, tooLong, missing, task, emptyTask, forged, overview: await api.getOverview(), runs: await api.listRuns(),
            tasks: await api.listTasks(), missingTask, missingEvents, badCursor,
            projects: await api.listProjects(), after: await api.getSettings() };
        })()`);
        break;
      case 'task-ui': {
        // Drives the real Workbench DOM: optionally clicks a task row, then waits until its committed log is synced.
        const { taskId, click, entries, fresh } = message.input;
        value = await host.window.webContents.executeJavaScript(`(async () => {
          const wait = async (check, ms = 15000) => { const end = Date.now() + ms;
            while (Date.now() < end) { const found = check(); if (found) return found; await new Promise(done => setTimeout(done, 50)); }
            throw new Error('UI_TIMEOUT ' + document.querySelector('[data-sync]')?.textContent); };
          const id = ${JSON.stringify(taskId)}; const since = Date.now();
          if (${JSON.stringify(Boolean(click))}) (await wait(() => document.querySelector('.task-row[data-task-id="' + id + '"]'))).click();
          await wait(() => document.querySelector('section[data-task-id="' + id + '"] [data-sync="synced"]') &&
            (!${JSON.stringify(Boolean(fresh))} || Number(document.querySelector('[data-synced-at]').dataset.syncedAt) > since) &&
            document.querySelectorAll('.timeline-entry').length >= ${JSON.stringify(entries ?? 1)});
          const detail = document.querySelector('section[data-task-id="' + id + '"]');
          return { rows: document.querySelectorAll('.task-row[data-task-id]').length, entries: detail.querySelectorAll('.timeline-entry').length,
            pill: detail.querySelector('.task-meta .pill').textContent, meta: detail.querySelector('[data-sync]').textContent,
            interrupted: Boolean(detail.querySelector('.column > .tone-notice-warn')), text: detail.querySelector('.timeline').textContent };
        })()`);
        break;
      }
      case 'model-api': {
        // M2 model settings through the real Preload → Main → Express → Crypto Bridge path.
        value = await host.window.webContents.executeJavaScript(`(async () => {
          const api = window.operationAgent; const key = ${JSON.stringify(message.input.key)};
          const errorOf = promise => promise.then(() => 'allowed', error => error.message);
          const before = await api.getModelSettings();
          const invalid = await errorOf(api.setApiKey({ apiKey: 'too short' }));
          const extra = await errorOf(api.setApiKey({ apiKey: key, provider: 'other' }));
          const badModel = await errorOf(api.saveModelChoice({ model: 'gpt-4' }));
          const chosen = await api.saveModelChoice({ model: 'claude-opus-5-5' });
          const saved = await api.setApiKey({ apiKey: key });
          const test = await api.testModelConnection();
          return { before, invalid, extra, badModel, chosen, saved, test, after: await api.getModelSettings() };
        })()`);
        break;
      }
      case 'model-unavailable': {
        // SEC-14 through the real bridge: make OS-backed encryption report unavailable, then try to save a key.
        const original = safeStorage.isAsyncEncryptionAvailable;
        try { safeStorage.isAsyncEncryptionAvailable = async () => false; } catch { value = 'unpatchable'; break; }
        if (safeStorage.isAsyncEncryptionAvailable === original) { value = 'unpatchable'; break; }
        try {
          value = await host.window.webContents.executeJavaScript(`(async () => {
            const api = window.operationAgent;
            const view = await api.getModelSettings();
            const error = await api.setApiKey({ apiKey: ${JSON.stringify(message.input.key)} }).then(() => 'allowed', failure => failure.message);
            return { view, error, after: await api.getModelSettings() };
          })()`);
        } finally { safeStorage.isAsyncEncryptionAvailable = original; }
        break;
      }
      case 'model-clear':
        value = await host.window.webContents.executeJavaScript(`(async () => {
          const api = window.operationAgent; const cleared = await api.clearApiKey();
          return { cleared, test: await api.testModelConnection() };
        })()`);
        break;
      case 'model-test': value = await host.window.webContents.executeJavaScript('window.operationAgent.testModelConnection()'); break;
      case 'model-ui':
        // Drives the real Settings → Model DOM: types a key, saves it, then runs Test connection.
        value = await host.window.webContents.executeJavaScript(`(async () => {
          const key = ${JSON.stringify(message.input.key)};
          const wait = async (check, ms = 15000) => { const end = Date.now() + ms;
            while (Date.now() < end) { const found = check(); if (found) return found; await new Promise(done => setTimeout(done, 50)); }
            throw new Error('UI_TIMEOUT ' + (document.querySelector('.modal')?.textContent ?? 'no dialog')); };
          await wait(() => document.querySelector('.statusbar .sb-button'));
          window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true }));
          (await wait(() => document.querySelector('.settings-nav button[data-section="Model"]'))).click();
          const input = await wait(() => { const found = document.querySelector('input[aria-label="Anthropic API key"]'); return found && !found.disabled ? found : null; });
          const emptyState = document.querySelector('.key-form')?.dataset.keyState;
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, key);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          (await wait(() => { const button = document.querySelector('.key-form button[type="submit"]'); return button && !button.disabled ? button : null; })).click();
          const saved = await wait(() => document.querySelector('[data-key-state="configured"]'));
          const leftInDom = document.documentElement.outerHTML.includes(key) || [...document.querySelectorAll('input')].some(field => field.value.includes(key));
          (await wait(() => { const button = document.querySelector('[data-action="test-connection"]'); return button && !button.disabled ? button : null; })).click();
          const result = await wait(() => document.querySelector('[data-test-status]'));
          return { emptyState, masked: saved.querySelector('.key-mask').textContent, leftInDom, status: result.dataset.testStatus,
            resultText: result.textContent, credential: document.querySelector('[data-credential]').dataset.credential,
            active: document.querySelector('.model-option.is-active').dataset.model };
        })()`);
        break;
      case 'appearance':
        // Evidence only: switch the saved theme through the bridge so the next capture shows the other palette.
        value = await host.window.webContents.executeJavaScript(`window.operationAgent.getSettings().then(settings =>
          window.operationAgent.saveSettings({ ...settings, theme: ${JSON.stringify(message.input)} })).then(settings => settings.theme)`);
        await new Promise(done => setTimeout(done, 300));
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
      case 'new-task-shortcut':
        // Ctrl+N from an open task must leave it and focus the request composer.
        value = await host.window.webContents.executeJavaScript(`(async () => {
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true }));
          const end = Date.now() + 5000;
          while (Date.now() < end) {
            const active = document.activeElement;
            if (!document.querySelector('section[data-task-id]') && active?.getAttribute('aria-label') === 'Task request') return 'composer-focused';
            await new Promise(done => setTimeout(done, 50));
          }
          return document.querySelector('section[data-task-id]') ? 'task-still-open' : 'composer-not-focused';
        })()`);
        break;
      case 'capture': {
        // Evidence screenshot of the real hidden window; only into the workspace artifacts directory.
        const target = resolve(root, 'artifacts', message.input);
        if (!target.startsWith(resolve(root, 'artifacts'))) throw new Error('CAPTURE_PATH_REJECTED');
        mkdirSync(dirname(target), { recursive: true });
        // A hidden window is not repainted; show it without focus long enough to paint the current DOM.
        host.window.setSize(1360, 860); host.window.showInactive();
        await new Promise(done => setTimeout(done, 800));
        writeFileSync(target, (await host.window.webContents.capturePage()).toPNG());
        host.window.hide();
        value = target; break;
      }
      case 'close':
        await host.stop(); process.send({ id: message.id, value: 'closed' }, () => app.exit(0)); return;
      default: throw new Error('UNKNOWN_TEST_COMMAND');
    }
    process.send({ id: message.id, value });
  } catch (error) { process.send({ id: message.id, error: error.message }); }
});
process.on('disconnect', () => { void host?.stop().finally(() => app.exit(1)); });
