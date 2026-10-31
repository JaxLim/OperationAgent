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
import { openStore } from '../../apps/server/dist/persistence/store.js';

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
  const create = async () => { const host = await launch(directory); hosts.push(host); return host; };
  create.directory = directory;
  return create;
}

test('real Electron Main → sandboxed Preload → authenticated Express → SQLite, restart and normal exit', { timeout: 90_000 }, async t => {
  const create = await fixture(t); const host = await create();
  const first = await host.command('snapshot');
  assert.equal(first.electron, '45.0.0'); assert.equal(first.mainPid, host.child.pid); assert.notEqual(first.pid, first.mainPid);
  assert.equal(first.renderer.health.controlPlaneReady, true); assert.equal(first.renderer.health.agentReady, false);
  assert.equal(first.renderer.node, 'undefined'); assert.equal(first.renderer.require, 'undefined');
  assert.deepEqual(first.renderer.keys.sort(), ['getFoundationInfo', 'getControlPlaneHealth', 'listSmokeRecords', 'writeSmokeRecords', 'getDesktopStatus',
    'retryControlPlane', 'getOverview', 'getSettings', 'saveSettings', 'listProjects', 'addProject', 'removeProject', 'listRuns', 'startTask',
    'listTasks', 'getTask', 'listTaskEvents'].sort());
  assert.equal(first.renderer.mounted, true);
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
  await assert.rejects(host.command('snapshot'), /SERVICE_UNAVAILABLE/);
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

test('workbench settings persist, invalid input and Worker-less task starts are refused through the real bridge', { timeout: 60_000 }, async t => {
  const create = await fixture(t); const host = await create();
  const result = await host.command('workbench');
  assert.equal(result.saved.theme, 'dark'); assert.equal(result.saved.stopGraceMs, 10000);
  assert.equal(result.tooLong, 'rejected'); assert.match(result.missing, /NOT_FOUND/);
  assert.deepEqual(result.task, { accepted: false, error: 'WORKER_ISOLATION_UNAVAILABLE' });
  assert.equal(result.emptyTask, 'rejected'); assert.equal(result.forged, 'rejected');
  assert.equal(result.overview.agentReady, false); assert.equal(result.overview.database.version, 4);
  assert.equal(result.overview.worker.error, 'WORKER_ISOLATION_UNAVAILABLE');
  assert.ok(Object.values(result.overview.capabilities).every(value => value !== 'verified'));
  assert.equal(result.runs.runs[0].outcome, 'RUNNING'); assert.deepEqual(result.projects.projects, []);
  // P2.2 read-only task views: a refused start persists nothing, and unknown or malformed queries fail closed.
  assert.deepEqual(result.tasks, { tasks: [] });
  assert.match(result.missingTask, /NOT_FOUND/); assert.match(result.missingEvents, /NOT_FOUND/); assert.equal(result.badCursor, 'rejected');
  await host.close();
  const reopened = await create();
  const again = await reopened.command('workbench');
  assert.equal(again.after.theme, 'dark'); assert.equal(again.after.stopGraceMs, 10000);
  assert.deepEqual(again.runs.runs.slice(0, 2).map(run => run.outcome), ['RUNNING', 'CLEAN']);
});

test('the Workbench lists committed tasks, replays their events and resyncs after a control-plane restart', { timeout: 90_000 }, async t => {
  const create = await fixture(t);
  // Seed through the Express store: one finished task with a tool result, one left RUNNING.
  const seed = openStore(resolve(create.directory, 'database'), randomUUID());
  const projectId = seed.addProject({ name: 'seeded', path: 'C:/OperationAgentP23/seeded' }).id;
  const step = (taskId, to) => seed.transitionTask(taskId, to, { requestId: randomUUID() });
  const done = seed.createTask(projectId, randomUUID()).task.id;
  step(done, 'QUEUED'); step(done, 'RUNNING');
  seed.recordToolSummary({ type: 'tool_output_summary', taskId: done, toolCallId: randomUUID(), attemptId: randomUUID(), stdoutBytes: 2048,
    stderrBytes: 12, sampledBytes: 2060, truncatedBytes: 0, exitCode: 0, diagnostics: [{ severity: 'warning', summary: '1 deprecated option' }] }, randomUUID());
  step(done, 'COMPLETED');
  const running = seed.createTask(projectId, randomUUID()).task.id;
  step(running, 'QUEUED'); step(running, 'RUNNING');
  seed.close(true);

  const host = await create();
  const completed = await host.command('task-ui', { taskId: done, click: true, entries: 5 });
  assert.equal(completed.rows, 2); assert.equal(completed.entries, 5);
  assert.match(completed.pill, /Completed/); assert.match(completed.meta, /5 ?\/ ?5 events/); assert.equal(completed.interrupted, false);
  assert.match(completed.text, /exit 0/); assert.match(completed.text, /1 deprecated option/);
  // Opening the sidecar recovered the RUNNING task: INTERRUPTED with unknown side effects, never resumed.
  const interrupted = await host.command('task-ui', { taskId: running, click: true, entries: 4 });
  assert.equal(interrupted.entries, 4); assert.match(interrupted.pill, /Interrupted/); assert.equal(interrupted.interrupted, true);
  assert.match(interrupted.text, /side effects UNKNOWN/);
  await host.command('capture', `p1/${process.platform}-${process.arch}/workbench-task.png`);

  const before = await host.command('state');
  process.kill(before.pid, 'SIGKILL');
  await until(async () => { const state = await host.command('state'); return state.state === 'ready' && state.expressRunId !== before.expressRunId; }, 25_000);
  // The new Express instance serves the same committed log; the view resumes from its cursor.
  const after = await host.command('task-ui', { taskId: running, entries: 4, fresh: true });
  assert.deepEqual([after.entries, after.rows], [4, 2]); assert.match(after.meta, /4 ?\/ ?4 events/);
});
