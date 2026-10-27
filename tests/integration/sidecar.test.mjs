import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CONTROL_ROUTES, CONTROL_POLICY } from '../../packages/contracts/dist/index.js';
import { root, launchSidecar, httpCall, closeDirectory } from './sidecar-helper.mjs';

async function directory(t) {
  const cache = resolve(root, '.cache'); await mkdir(cache, { recursive: true });
  const path = await mkdtemp(resolve(cache, 'sidecar-test-'));
  t.after(async () => { await closeDirectory(path); if (path.startsWith(cache + sep)) await rm(path, { recursive: true, force: true }); });
  return path;
}
test('real staged Node/Express authenticates, rejects illegal access and rolls back a failing transaction', { timeout: 30_000 }, async t => {
  const sidecar = await launchSidecar(await directory(t)); t.after(() => sidecar.close());
  assert.equal(sidecar.ready.pid, sidecar.child.pid); assert.equal(sidecar.ready.parentPid, process.pid);
  assert.equal(sidecar.ready.node, '24.22.1'); assert.equal(sidecar.ready.abi, '137');
  const health = await sidecar.call('GET', CONTROL_ROUTES.health);
  assert.equal(health.status, 200); assert.equal(health.authenticated, true); assert.equal(health.body.agentReady, false);
  for (const headers of [{ 'x-oa-signature': '' }, { 'x-oa-signature': 'a'.repeat(64) }, { 'x-oa-protocol': '99' }]) {
    assert.equal((await sidecar.call('GET', CONTROL_ROUTES.health, undefined, { headers })).status, 401);
  }
  for (const headers of [{ host: 'localhost' }, { origin: 'https://evil.invalid' }, { origin: 'null' }, { 'x-forwarded-for': '127.0.0.1' }]) {
    assert.equal((await sidecar.call('GET', CONTROL_ROUTES.health, undefined, { headers })).status, 403);
  }
  for (const auth of [{ expressRunId: randomUUID() }, { mainRunId: randomUUID() }, { timestamp: String(Date.now() - 60_000) }]) {
    assert.equal((await sidecar.call('GET', CONTROL_ROUTES.health, undefined, { auth })).status, 401);
  }
  const requestId = randomUUID();
  assert.equal((await sidecar.call('GET', CONTROL_ROUTES.health, undefined, { auth: { requestId } })).status, 200);
  assert.equal((await sidecar.call('GET', CONTROL_ROUTES.health, undefined, { auth: { requestId } })).status, 401);
  assert.equal((await sidecar.call('POST', CONTROL_ROUTES.taskStart, {})).body.error, 'WORKER_ISOLATION_UNAVAILABLE');
  assert.equal((await sidecar.call('POST', CONTROL_ROUTES.records, { records: [], extra: true })).status, 400);
  assert.equal((await sidecar.call('POST', CONTROL_ROUTES.records, 'x'.repeat(17000))).status, 400);
  const id = randomUUID();
  assert.equal((await sidecar.call('POST', CONTROL_ROUTES.records, { records: [{ id, value: 'persisted' }] })).status, 201);
  assert.equal((await sidecar.call('POST', CONTROL_ROUTES.records, { records: [{ id: randomUUID(), value: 'rollback' }, { id, value: 'duplicate' }] })).status, 409);
  const rows = await sidecar.call('GET', CONTROL_ROUTES.records);
  assert.equal(rows.body.records.length, 1); assert.equal(rows.body.records[0].id, id);
  await sidecar.close(); assert.equal(sidecar.child.exitCode, 0);
  assert.equal(sidecar.logs().includes(sidecar.bootstrap.token), false);
});

test('real process kill preserves committed SQLite data, reconciles interrupted runs and rejects the old identity', { timeout: 30_000 }, async t => {
  const path = await directory(t); const first = await launchSidecar(path); t.after(() => first.close());
  const id = randomUUID();
  await first.call('POST', CONTROL_ROUTES.records, { records: [{ id, value: 'survive SIGKILL' }] });
  first.child.kill('SIGKILL'); await first.exited;
  const second = await launchSidecar(path); t.after(() => second.close());
  assert.notEqual(second.ready.expressRunId, first.ready.expressRunId);
  assert.equal((await second.call('GET', CONTROL_ROUTES.health)).body.recoveredRuns, 1);
  assert.equal((await second.call('GET', CONTROL_ROUTES.records)).body.records[0].id, id);
  assert.equal((await httpCall(second.ready.port, first.bootstrap)).status, 401);
  await second.close(); assert.equal(second.child.exitCode, 0);
  const third = await launchSidecar(path); t.after(() => third.close());
  assert.equal((await third.call('GET', CONTROL_ROUTES.health)).body.recoveredRuns, 0);
  assert.equal((await third.call('GET', CONTROL_ROUTES.records)).body.records.length, 1);
});

test('bootstrap failures, concurrent DB owners and inherited-channel disconnect fail closed', { timeout: 30_000 }, async t => {
  const path = await directory(t);
  await assert.rejects(launchSidecar(path, { bootstrap: { parentPid: 1 } }), /EXIT_BEFORE_READY/);
  await assert.rejects(launchSidecar(path, { bootstrap: { protocolVersion: 'invalid' } }), /EXIT_BEFORE_READY/);
  const live = await launchSidecar(path); t.after(() => live.close());
  await assert.rejects(launchSidecar(path), /EXIT_BEFORE_READY/);
  live.child.disconnect(); await live.exited;
  assert.equal(live.child.exitCode, 1);
  await assert.rejects(live.call('GET', CONTROL_ROUTES.health));
});

test('the live HTTP listener enforces its bounded request window', { timeout: 30_000 }, async t => {
  const live = await launchSidecar(await directory(t), { heartbeat: false });
  for (let index = 0; index < CONTROL_POLICY.maxRequestsPerWindow; index++) {
    assert.equal((await live.call('GET', CONTROL_ROUTES.health)).status, 200);
  }
  assert.equal((await live.call('POST', CONTROL_ROUTES.records, { records: [{ id: randomUUID(), value: 'must be denied' }] })).status, 429);
  await live.close(); assert.equal(live.child.exitCode, 0);
});

test('a responsive Sidecar expires its lease when its parent stops authenticated traffic', { timeout: 20_000 }, async t => {
  const path = await directory(t); const live = await launchSidecar(path, { heartbeat: false });
  assert.equal((await live.call('GET', CONTROL_ROUTES.health)).status, 200);
  await live.exited;
  assert.equal(live.child.exitCode, 1);
  const recovered = await launchSidecar(path);
  assert.equal((await recovered.call('GET', CONTROL_ROUTES.health)).body.recoveredRuns, 1);
});
