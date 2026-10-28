import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { root, until, environment, launchSidecar, closeDirectory, httpCall } from './sidecar-helper.mjs';
import { CONTROL_ROUTES, CONTROL_POLICY } from '../../packages/contracts/dist/index.js';

const require = createRequire(import.meta.url);
const electron = require('../../apps/desktop/node_modules/electron');
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function launch(directory) {
  const env = { ...environment() };
  for (const key of ['DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR']) if (process.env[key]) env[key] = process.env[key];
  const child = spawn(electron, [resolve(root, 'tests/integration/electron-harness.mjs'), directory], { cwd: root, env,
    windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let logs = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { logs = (logs + chunk).slice(-65536); });
  const exited = once(child, 'exit');
  const pending = new Map();
  child.on('message', message => {
    if (pending.has(message.id)) { const handler = pending.get(message.id); pending.delete(message.id); handler(message); }
  });
  const readiness = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('ELECTRON_START_TIMEOUT: ' + logs)), 30_000);
    child.once('message', message => { clearTimeout(timeout); if (message.kind === 'ready') resolve(message); else reject(new Error(JSON.stringify(message) + logs)); });
    child.once('exit', () => { clearTimeout(timeout); reject(new Error('ELECTRON_EXIT_BEFORE_READY: ' + logs)); });
    child.once('error', reject);
  });
  try { await readiness; } catch (error) { child.kill('SIGKILL'); await exited.catch(() => {}); throw error; }
  function command(command, input) {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timeout = setTimeout(() => { pending.delete(id); reject(new Error('TEST_COMMAND_TIMEOUT: ' + command + logs)); }, 20_000);
      pending.set(id, message => { clearTimeout(timeout); if (message.error) reject(new Error(message.error)); else resolve(message.value); });
      child.send({ id, command, input }, error => { if (error) { clearTimeout(timeout); pending.delete(id); reject(error); } });
    });
  }
  return { child, exited, command, logs: () => logs,
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try { await command('close'); } finally { if (alive(child.pid)) { const timer = setTimeout(() => child.kill('SIGKILL'), 6000); await exited; clearTimeout(timer); } }
    },
  };
}

async function fixture(t) {
  const cache = resolve(root, '.cache'); await mkdir(cache, { recursive: true });
  const directory = await mkdtemp(resolve(cache, 'electron-test-')); const hosts = [];
  t.after(async () => { for (const host of hosts) await host.close(); if (directory.startsWith(cache + sep)) await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return async () => { const host = await launch(directory); hosts.push(host); return host; };
}

test('real Electron Main → sandboxed Preload → authenticated Express → SQLite, restart and normal exit', { timeout: 90_000 }, async t => {
  const create = await fixture(t); const host = await create();
  const first = await host.command('snapshot');
  assert.equal(first.electron, '45.0.0'); assert.equal(first.mainPid, host.child.pid); assert.notEqual(first.pid, first.mainPid);
  assert.equal(first.renderer.health.controlPlaneReady, true); assert.equal(first.renderer.health.agentReady, false);
  assert.equal(first.renderer.node, 'undefined'); assert.equal(first.renderer.require, 'undefined');
  assert.deepEqual(first.renderer.keys.sort(), ['getFoundationInfo', 'getControlPlaneHealth', 'listSmokeRecords', 'writeSmokeRecords'].sort());
  assert.equal(await host.command('csp'), 'blocked'); assert.equal(await host.command('invalid-input'), 'rejected');
  assert.match(await host.command('foreign-window'), /IPC_SENDER_REJECTED/);
  assert.equal(await host.command('navigation'), true);
  const id = randomUUID(); await host.command('write', { records: [{ id, value: '真实 Renderer 持久化 "UTF-8"' }] });
  process.kill(first.pid, 'SIGKILL');
  const restarted = await until(async () => {
    const state = await host.command('state'); return state.state === 'ready' && state.expressRunId !== first.expressRunId ? state : false;
  }, 25_000);
  assert.equal(alive(first.pid), false); assert.notEqual(restarted.pid, first.pid);
  assert.equal((await host.command('snapshot')).renderer.health.recoveredRuns, 1);
  assert.equal((await host.command('list')).records[0].id, id);
  assert.equal((await host.command('list')).records[0].value, '真实 Renderer 持久化 "UTF-8"');
  await host.close(); assert.equal(host.child.exitCode, 0); assert.equal(alive(restarted.pid), false);
  const reopened = await create();
  assert.equal((await reopened.command('snapshot')).renderer.health.recoveredRuns, 0);
  assert.equal((await reopened.command('list')).records[0].id, id);
});

test('a full result of maximally escaped UTF-8 records round-trips through the real Preload bridge', { timeout: 45_000 }, async t => {
  const create = await fixture(t); const host = await create();
  const records = Array.from({ length: 100 }, () => ({ id: randomUUID(), value: '\u0000'.repeat(253) + '持久化' }));
  for (let offset = 0; offset < records.length; offset += 10) await host.command('write', { records: records.slice(offset, offset + 10) });
  const result = await host.command('list');
  assert.ok(Buffer.byteLength(JSON.stringify(result)) > 65_536);
  assert.equal(result.records.length, 100);
  assert.deepEqual(result.records.map(record => record.id).sort(), records.map(record => record.id).sort());
  assert.ok(result.records.every(record => record.value === records[0].value));
  await host.close();
  const reopened = await create();
  assert.deepEqual((await reopened.command('list')).records, result.records);
});

test('unauthenticated traffic and a real Renderer burst preserve Main heartbeats and the Sidecar lease', { timeout: 45_000 }, async t => {
  const host = await (await fixture(t))();
  const first = await host.command('state');
  const stranger = { mainRunId: randomUUID(), expressRunId: randomUUID(), token: '0'.repeat(64) };
  for (let index = 0; index <= CONTROL_POLICY.maxRequestsPerWindow; index++) {
    assert.ok([401, 429].includes((await httpCall(first.port, stranger)).status));
  }
  const burst = await host.command('health-burst', CONTROL_POLICY.maxRequestsPerWindow + 1);
  assert.ok(burst.accepted > 0); assert.ok(burst.rejected > 0);
  await delay(CONTROL_POLICY.shutdownMs + 2 * CONTROL_POLICY.heartbeatMs);
  const after = await host.command('state');
  assert.equal(after.state, 'ready'); assert.equal(after.pid, first.pid);
  assert.equal(after.expressRunId, first.expressRunId); assert.equal(after.restarts, 0);
});

test('real Main crash closes the inherited channel and the responsive Sidecar exits', { timeout: 60_000 }, async t => {
  const create = await fixture(t); const host = await create(); const first = await host.command('snapshot');
  host.child.kill('SIGKILL'); await host.exited;
  await until(() => !alive(first.pid), 8000);
  const next = await create();
  assert.equal((await next.command('snapshot')).renderer.health.recoveredRuns, 1);
});

test('repeated real Sidecar crashes exhaust the bounded restart budget', { timeout: 90_000 }, async t => {
  const create = await fixture(t); const host = await create();
  for (let attempt = 0; attempt < 4; attempt++) {
    const state = await host.command('state'); assert.equal(state.state, 'ready');
    process.kill(state.pid, 'SIGKILL');
    await until(async () => {
      const next = await host.command('state');
      return attempt === 3 ? next.state === 'budget-exhausted' : next.state === 'ready' && next.expressRunId !== state.expressRunId;
    }, 25_000);
  }
  const exhausted = await host.command('state'); assert.equal(exhausted.pid, null); assert.equal(exhausted.restarts, 3);
  await assert.rejects(host.command('snapshot'), /CONTROL_PLANE_REQUEST_FAILED/);
});

test('the production Main entry flushes SQLite and exits through the real window-close lifecycle', { timeout: 45_000 }, async t => {
  const cache = resolve(root, '.cache'); await mkdir(cache, { recursive: true });
  const directory = await mkdtemp(resolve(cache, 'electron-entry-'));
  const database = resolve(directory, 'control-plane');
  const child = spawn(electron, [resolve(root, 'tests/integration/electron-entry.mjs'), directory], {
    cwd: root, env: environment(), windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    await closeDirectory(database);
    if (directory.startsWith(cache + sep)) await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  let logs = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { logs = (logs + chunk).slice(-65536); });
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ENTRY_TIMEOUT: ' + logs)), 30_000);
    child.once('message', message => { clearTimeout(timer); resolve(message); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('ENTRY_FAILED: ' + logs)); });
  });
  assert.equal(result.health.controlPlaneReady, true); assert.equal(result.health.agentReady, false);
  await exited; assert.equal(child.exitCode, 0);
  const reopened = await launchSidecar(database);
  assert.equal((await reopened.call('GET', CONTROL_ROUTES.health)).body.recoveredRuns, 0);
  assert.equal((await reopened.call('GET', CONTROL_ROUTES.records)).body.records[0].id, result.id);
});
