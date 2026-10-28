// P1.4/P1.5 real restricted fixture acceptance. ADR-WIN-001 authorizes AppContainer profile creation and
// runtime ACL grants only on a disposable runner, so on any other host this suite fails as BLOCKED.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(import.meta.dirname, '../..');
const runtime = resolve(root, '.cache/worker-fixture/runtime');
const runner = process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_OS === 'Windows' && process.platform === 'win32' && process.arch === 'x64';
const blocked = runner ? false : 'BLOCKED';
function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } }
async function until(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('TIMEOUT: ' + label);
    await delay(50);
  }
}
async function host(t) {
  const child = spawn(process.execPath, [resolve(import.meta.dirname, 'express-host.mjs'), runtime], { cwd: root, windowsHide: true,
    shell: false, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let logs = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { logs = (logs + chunk).slice(-32768); });
  const exited = once(child, 'exit'); const pending = new Map();
  child.on('message', message => { const handler = pending.get(message.id); if (handler) { pending.delete(message.id); handler(message); } });
  await new Promise((resolve, reject) => { child.once('message', resolve); child.once('exit', () => reject(new Error('HOST_EXIT: ' + logs))); });
  const call = (command, input) => new Promise((resolve, reject) => {
    const id = randomUUID(); const timer = setTimeout(() => { pending.delete(id); reject(new Error('HOST_TIMEOUT: ' + command + logs)); }, 45_000);
    pending.set(id, message => { clearTimeout(timer); if (message.error) reject(new Error(message.error)); else resolve(message.value); });
    child.send({ id, command, input });
  });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } });
  return { child, call, exited, logs: () => logs };
}

test('BLOCKED unless running on a disposable Windows x64 runner', () => {
  assert.ok(runner, 'BLOCKED: restricted fixture requires a disposable GitHub Actions Windows x64 runner (ADR-WIN-001 §3)');
});

test('public CreateProcessW launches a pre-restricted fixture that completes OWIP/1 and stops in two phases', { skip: blocked, timeout: 120_000 }, async t => {
  const express = await host(t);
  const started = await express.call('start');
  const baseline = started.baseline;
  assert.equal(baseline.parentPid, started.hostPid, 'Express is the direct parent');
  assert.equal(baseline.appContainer, true); assert.equal(baseline.capabilityCount, 0);
  assert.ok(baseline.integrityRid <= 0x1000, 'low integrity or lower'); assert.equal(baseline.jobAssignedAtCreation, true);
  assert.equal(baseline.noChildProcessCreation, true); assert.equal(baseline.inheritedHandleCount, 1); assert.equal(baseline.verifiedBeforeResume, true);
  const health = await express.call('health');
  assert.equal(health.result.kind, 'health'); assert.equal(health.result.agentReady, false); assert.equal(health.workerRunId, started.workerRunId);
  await delay(3_500);
  const snapshot = await express.call('snapshot');
  assert.equal(snapshot.state, 'ready'); assert.equal(snapshot.worker.session.missedHeartbeats, 0);
  const exit = await express.call('stop');
  assert.equal(exit.cleanup, 'confirmed'); assert.equal(exit.exitCode, 0);
  assert.equal(alive(baseline.pid), false);
});

for (const [mode, reason] of [['exit', /RPC_DISCONNECTED|WORKER_EXITED/], ['hang', /RPC_HEARTBEAT_FAILED|RPC_REQUEST_TIMEOUT/],
  ['invalid-frame', /OWIP_MAGIC_INVALID/], ['foreign-identity', /IDENTITY_MISMATCH/], ['duplicate-response', /RPC_UNCORRELATED_RESPONSE/]]) {
  test(`real fixture fault ${mode} is rejected, the session fails closed and the Job is reclaimed`, { skip: blocked, timeout: 120_000 }, async t => {
    const express = await host(t);
    const { baseline } = await express.call('start');
    const exit = await express.call('fault', mode);
    assert.match(exit.reason, reason); assert.equal(exit.cleanup, 'confirmed');
    await until(() => !alive(baseline.pid), 10_000, 'worker exit');
    await express.call('stop');
  });
}

test('the in-flight quota is enforced against the real Worker and cleanup is confirmed', { skip: blocked, timeout: 120_000 }, async t => {
  const express = await host(t);
  const { baseline } = await express.call('start');
  const burst = await express.call('burst', 70);
  assert.ok(burst.rejected > 0);
  const exit = burst.exit;
  assert.match(exit.reason, /RPC_IN_FLIGHT_LIMIT/); assert.equal(exit.cleanup, 'confirmed');
  await until(() => !alive(baseline.pid), 10_000, 'worker exit');
});

test('SEC-17: a killed Express takes its Worker with it and a new Express only gets a new Worker', { skip: blocked, timeout: 120_000 }, async t => {
  const first = await host(t);
  const old = await first.call('start');
  first.child.kill('SIGKILL'); await first.exited;
  await until(() => !alive(old.baseline.pid), 10_000, 'old worker reclaimed by Job close');
  const second = await host(t);
  const fresh = await second.call('start');
  assert.notEqual(fresh.expressRunId, old.expressRunId); assert.notEqual(fresh.workerRunId, old.workerRunId);
  assert.notEqual(fresh.baseline.pid, old.baseline.pid); assert.equal(fresh.baseline.parentPid, fresh.hostPid);
  assert.equal(alive(old.baseline.pid), false);
  const tasklist = spawnSync(resolve(process.env.SystemRoot, 'System32/tasklist.exe'), ['/FI', `PID eq ${old.baseline.pid}`, '/NH'], { encoding: 'utf8' });
  assert.doesNotMatch(tasklist.stdout, new RegExp(`\\b${old.baseline.pid}\\b`));
  await second.call('stop');
});

test('a hung Worker is terminated and repeated crashes exhaust the restart budget without leftovers', { skip: blocked, timeout: 180_000 }, async t => {
  const express = await host(t);
  const pids = [(await express.call('start')).baseline.pid];
  for (let attempt = 0; attempt < 4; attempt++) {
    await express.call('fault', attempt === 0 ? 'hang' : 'exit');
    const state = await until(async () => {
      const value = await express.call('snapshot');
      return (attempt === 3 ? value.state === 'budget-exhausted' : value.state === 'ready' && !pids.includes(value.worker.pid)) && value;
    }, 30_000, 'supervisor state');
    if (attempt < 3) pids.push(state.worker.pid);
  }
  const final = await express.call('snapshot');
  assert.equal(final.restarts, 3); assert.equal(final.history.length, 4);
  assert.ok(final.history.every(entry => entry.cleanup === 'confirmed'));
  for (const pid of pids) assert.equal(alive(pid), false);
});
