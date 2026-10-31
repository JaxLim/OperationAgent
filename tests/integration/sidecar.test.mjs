import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CONTROL_ROUTES, CONTROL_POLICY, TASK_API_LIMITS, catchUpTaskEvents } from '../../packages/contracts/dist/index.js';
import { openStore } from '../../apps/server/dist/persistence/store.js';
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
  assert.equal((await sidecar.call('POST', CONTROL_ROUTES.taskStart, {})).body.error, 'VALIDATION_ERROR');
  const refused = await sidecar.call('POST', CONTROL_ROUTES.taskStart, { projectId: randomUUID(), prompt: 'do work' });
  assert.equal(refused.status, 503); assert.equal(refused.body.error, 'WORKER_ISOLATION_UNAVAILABLE');
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
  const heartbeat = await live.call('GET', CONTROL_ROUTES.heartbeat);
  assert.equal(heartbeat.status, 200);
  assert.equal(heartbeat.authenticated, true);
  await live.close(); assert.equal(live.child.exitCode, 0);
});

test('unauthenticated and replayed bursts cannot consume authenticated request or heartbeat capacity', { timeout: 30_000 }, async t => {
  const live = await launchSidecar(await directory(t), { heartbeat: false });
  const requestId = randomUUID();
  assert.equal((await live.call('GET', CONTROL_ROUTES.health, undefined, { auth: { requestId } })).status, 200);
  for (let index = 0; index <= CONTROL_POLICY.maxRequestsPerWindow; index++) {
    const reply = index % 2 === 0
      ? await live.call('GET', CONTROL_ROUTES.health, undefined, { headers: { 'x-oa-signature': 'a'.repeat(64) } })
      : await live.call('GET', CONTROL_ROUTES.health, undefined, { auth: { requestId } });
    assert.ok([401, 429].includes(reply.status));
    assert.equal(reply.authenticated, false);
  }
  assert.equal((await live.call('GET', CONTROL_ROUTES.health)).status, 200);
  const heartbeat = await live.call('GET', CONTROL_ROUTES.heartbeat);
  assert.equal(heartbeat.status, 200); assert.equal(heartbeat.authenticated, true);
});

test('the reserved heartbeat lane is bounded and still rejects replay across lanes', { timeout: 30_000 }, async t => {
  const live = await launchSidecar(await directory(t), { heartbeat: false });
  const requestId = randomUUID();
  for (let index = 0; index < CONTROL_POLICY.maxHeartbeatsPerWindow; index++) {
    const auth = index === 0 ? { requestId } : {};
    assert.equal((await live.call('GET', CONTROL_ROUTES.heartbeat, undefined, { auth })).status, 200);
  }
  const limited = await live.call('GET', CONTROL_ROUTES.heartbeat);
  assert.equal(limited.status, 429); assert.equal(limited.authenticated, true);
  assert.equal((await live.call('GET', CONTROL_ROUTES.health, undefined, { auth: { requestId } })).status, 401);
  assert.equal((await live.call('GET', CONTROL_ROUTES.health)).status, 200);
});

test('a responsive Sidecar expires its lease when its parent stops authenticated traffic', { timeout: 20_000 }, async t => {
  const path = await directory(t); const live = await launchSidecar(path, { heartbeat: false });
  assert.equal((await live.call('GET', CONTROL_ROUTES.health)).status, 200);
  await live.exited;
  assert.equal(live.child.exitCode, 1);
  const recovered = await launchSidecar(path);
  assert.equal((await recovered.call('GET', CONTROL_ROUTES.health)).body.recoveredRuns, 1);
});

test('task snapshots and byte-bounded event pages rebuild a committed task over the real authenticated API', { timeout: 30_000 }, async t => {
  // Seed through the Express store itself, then serve it from a separately started staged sidecar.
  const path = await directory(t);
  const seed = openStore(path, randomUUID());
  const projectId = seed.addProject({ name: 'repo', path: 'C:/OperationAgentP22/repo' }).id;
  const { task } = seed.createTask(projectId, randomUUID());
  for (const to of ['QUEUED', 'RUNNING']) seed.transitionTask(task.id, to, { requestId: randomUUID() });
  // Eight near-limit summaries (~15.6 KiB each) force several pages under the page byte budget.
  for (let index = 0; index < 8; index++) {
    seed.recordToolSummary({ type: 'tool_output_summary', taskId: task.id, toolCallId: randomUUID(), attemptId: randomUUID(), stdoutBytes: 1,
      stderrBytes: 0, sampledBytes: 1, truncatedBytes: 0, exitCode: 0,
      diagnostics: Array.from({ length: 10 }, () => ({ severity: 'warning', summary: '中'.repeat(500) })) }, randomUUID());
  }
  seed.transitionTask(task.id, 'COMPLETED', { requestId: randomUUID() });
  seed.close(true);

  const live = await launchSidecar(path); t.after(() => live.close());
  const list = await live.call('GET', CONTROL_ROUTES.tasks);
  assert.equal(list.status, 200); assert.equal(list.authenticated, true);
  assert.deepEqual(list.body.tasks.map(item => [item.id, item.state, item.lastSeq]), [[task.id, 'COMPLETED', 12]]);
  const snapshot = await live.call('POST', CONTROL_ROUTES.taskSnapshot, { taskId: task.id });
  assert.deepEqual(snapshot.body, list.body.tasks[0]);

  const pages = [];
  const fetchPage = async afterSeq => {
    const page = await live.call('POST', CONTROL_ROUTES.taskEvents, { taskId: task.id, afterSeq });
    assert.equal(page.status, 200); assert.equal(page.authenticated, true);
    pages.push(page.body.events.length);
    // The server's budget counts each serialized event; a single event always fits.
    const bytes = page.body.events.reduce((total, event) => total + Buffer.byteLength(JSON.stringify(event)), 0);
    assert.ok(page.body.events.length <= 1 || bytes <= TASK_API_LIMITS.maxPageBytes, String(bytes));
    return page.body;
  };
  const full = await catchUpTaskEvents(task.id, 0, null, fetchPage);
  assert.equal(full.ok, true); assert.equal(full.state, 'COMPLETED'); assert.equal(full.lastSeq, 12);
  assert.deepEqual(full.events.map(event => event.seq), Array.from({ length: 12 }, (_, index) => index + 1));
  assert.ok(pages.length >= 3, `expected several byte-bounded pages, got ${JSON.stringify(pages)}`);
  // A reconnecting client resumes from its cursor and the state it had applied.
  const resumed = await catchUpTaskEvents(task.id, full.events[5].seq, 'RUNNING', fetchPage);
  assert.equal(resumed.ok, true); assert.equal(resumed.state, 'COMPLETED'); assert.deepEqual(resumed.events.map(event => event.seq), [7, 8, 9, 10, 11, 12]);
  // A state that does not match the log at the cursor is detected rather than silently adopted.
  assert.equal((await catchUpTaskEvents(task.id, 2, 'CREATED', fetchPage)).error, 'STATE_DISCONTINUITY');

  const limited = await live.call('POST', CONTROL_ROUTES.taskEvents, { taskId: task.id, afterSeq: 0, limit: 2 });
  assert.deepEqual([limited.body.events.length, limited.body.hasMore], [2, true]);
  assert.deepEqual((await live.call('POST', CONTROL_ROUTES.taskEvents, { taskId: task.id, afterSeq: 12 })).body,
    { taskId: task.id, afterSeq: 12, lastSeq: 12, events: [], hasMore: false });
  const ahead = await live.call('POST', CONTROL_ROUTES.taskEvents, { taskId: task.id, afterSeq: 13 });
  assert.deepEqual([ahead.status, ahead.body.error], [409, 'CURSOR_AHEAD']);
  for (const body of [{ taskId: randomUUID(), afterSeq: 0 }]) {
    assert.equal((await live.call('POST', CONTROL_ROUTES.taskEvents, body)).status, 404);
  }
  assert.equal((await live.call('POST', CONTROL_ROUTES.taskSnapshot, { taskId: randomUUID() })).status, 404);
  for (const body of [{ taskId: task.id, afterSeq: 0, extra: true }, { taskId: task.id, afterSeq: -1 }, { taskId: task.id, afterSeq: 0, limit: 0 },
    { taskId: task.id, afterSeq: 0, limit: TASK_API_LIMITS.maxEventsPerPage + 1 }, { taskId: 'task-1', afterSeq: 0 }]) {
    assert.equal((await live.call('POST', CONTROL_ROUTES.taskEvents, body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await live.call('POST', CONTROL_ROUTES.taskSnapshot, { taskId: task.id, state: 'RUNNING' })).status, 400);
});
