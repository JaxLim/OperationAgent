import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CONTROL_POLICY, UpdatePlanInputSchema } from '../../packages/contracts/dist/index.js';
import type { UpdatePlanInput } from '../../packages/contracts/dist/index.js';
import { openStore } from '../../apps/server/dist/persistence/store.js';
import type { Store } from '../../apps/server/dist/persistence/store.js';

function withStore(run: (directory: string, open: () => Store) => void): void {
  const cache = resolve('.cache'); mkdirSync(cache, { recursive: true });
  const directory = mkdtempSync(resolve(cache, 'plans-'));
  try { run(directory, () => openStore(directory, randomUUID())); }
  finally { if (directory.startsWith(cache + sep)) rmSync(directory, { recursive: true, force: true }); }
}
function task(store: Store, running = true): string {
  const project = store.addProject({ name: 'plans', path: `C:/work/${randomUUID()}` });
  const id = store.createTask(project.id, randomUUID()).task.id;
  if (running) for (const state of ['QUEUED', 'RUNNING'] as const) store.transitionTask(id, state, { requestId: randomUUID() });
  return id;
}
const input = (): UpdatePlanInput => UpdatePlanInputSchema.parse({ steps: [
  { id: 'read', title: 'Read code', status: 'in_progress' },
  { id: 'verify', title: 'Verify behavior', status: 'pending', dependsOn: ['read'] },
] });

test('plan revisions persist with events and snapshots; identical content keeps its original turn', () => withStore((_, open) => {
  const store = open();
  const id = task(store), legacy = task(store, false);
  try {
    const first = store.updateTaskPlan(id, 'first', 1, input());
    assert.deepEqual(first, { plan: { ...input(), revision: 1, turn: 1 }, changed: true });
    const before = store.getTask(id)!;
    assert.deepEqual(store.updateTaskPlan(id, 'noop', 2, input()), { plan: first.plan, changed: false });
    assert.deepEqual(store.getTask(id), before);
    const replan: UpdatePlanInput = { steps: [
      { id: 'read', title: 'Review updated code', status: 'completed', dependsOn: [] },
      { id: 'verify', title: 'Run focused checks', status: 'in_progress', dependsOn: ['read'] },
    ] };
    const second = store.updateTaskPlan(id, 'second', 3, replan);
    assert.deepEqual(second, { plan: { ...replan, revision: 2, turn: 3 }, changed: true });
    assert.deepEqual(store.getTask(id)?.plan, second.plan);
    assert.equal(Object.hasOwn(store.listTasks(10).find(item => item.id === id)!, 'plan'), false);
    assert.equal(Object.hasOwn(store.getTask(legacy)!, 'plan'), false);
    assert.equal(Object.hasOwn(store.listTasks(10).find(item => item.id === legacy)!, 'plan'), false);
    const events = store.listTaskEvents(id, 0).filter(event => event.type === 'plan_updated');
    assert.deepEqual(events.map(event => event.payload), [{ callId: 'first', plan: first.plan }, { callId: 'second', plan: second.plan }]);
    store.close(true);
    const reopened = open();
    try {
      assert.deepEqual(reopened.getTask(id)?.plan, second.plan);
      assert.equal(Object.hasOwn(reopened.listTasks(10).find(item => item.id === id)!, 'plan'), false);
      assert.equal(Object.hasOwn(reopened.getTask(legacy)!, 'plan'), false);
      assert.deepEqual(reopened.updateTaskPlan(id, 'first', 1, input()), { plan: first.plan, changed: false });
      assert.deepEqual(reopened.updateTaskPlan(id, 'noop', 2, input()), { plan: first.plan, changed: false });
      assert.deepEqual(reopened.getTask(id)?.plan, second.plan, 'historical replay never restores an old snapshot');
    } finally { reopened.close(true); }
  } finally { store.close(true); }
}));

test('plan calls deduplicate by task, turn and call id, reject changed input and replay after completion', () => withStore((_, open) => {
  const store = open();
  try {
    const id = task(store), other = task(store);
    const first = store.updateTaskPlan(id, 'same', 1, input());
    const before = store.getTask(id)!;
    assert.deepEqual(store.updateTaskPlan(id, 'same', 1, input()), { plan: first.plan, changed: false });
    const changed = input(); changed.steps[0]!.title = 'Different title';
    assert.throws(() => store.updateTaskPlan(id, 'same', 1, changed), /REQUEST_CONFLICT/);
    assert.deepEqual(store.getTask(id), before);
    assert.equal(store.updateTaskPlan(other, 'same', 1, changed).changed, true);
    assert.equal(store.updateTaskPlan(id, 'same', 2, changed).plan.revision, 2);
    const noop = store.updateTaskPlan(id, 'noop', 3, changed);
    const latest = store.getTask(id)!.plan;
    store.transitionTask(id, 'COMPLETED', { requestId: randomUUID() });
    const completed = store.getTask(id)!;
    assert.deepEqual(store.updateTaskPlan(id, 'same', 1, input()), { plan: first.plan, changed: false });
    assert.deepEqual(store.updateTaskPlan(id, 'noop', 3, changed), noop);
    assert.throws(() => store.updateTaskPlan(id, 'same', 1, changed), /REQUEST_CONFLICT/);
    assert.throws(() => store.updateTaskPlan(id, 'noop', 3, input()), /REQUEST_CONFLICT/);
    assert.throws(() => store.updateTaskPlan(id, 'new', 4, changed), /TASK_TERMINAL/);
    assert.deepEqual(store.getTask(id), completed);
    assert.deepEqual(completed.plan, latest);
  } finally { store.close(true); }
}));

test('plan writes require RUNNING, validate dependencies, allow dynamic replans and record stalled events', () => withStore((_, open) => {
  const store = open();
  try {
    const id = task(store, false);
    assert.throws(() => store.updateTaskPlan(randomUUID(), 'missing', 1, input()), /NOT_FOUND/);
    for (const state of ['CREATED', 'QUEUED', 'WAITING_APPROVAL', 'STOPPING', 'INTERRUPTED'] as const) {
      if (state === 'QUEUED') store.transitionTask(id, state, { requestId: randomUUID() });
      if (state === 'WAITING_APPROVAL') {
        store.transitionTask(id, 'RUNNING', { requestId: randomUUID() });
        store.transitionTask(id, state, { requestId: randomUUID() });
      }
      if (state === 'STOPPING' || state === 'INTERRUPTED') store.transitionTask(id, state, { requestId: randomUUID() });
      assert.throws(() => store.updateTaskPlan(id, state, 1, input()), /INVALID_TRANSITION/);
    }
    store.transitionTask(id, 'RUNNING', { requestId: randomUUID(), userConfirmed: true });
    const before = store.getTask(id)!;
    const invalid = input(); invalid.steps[0]!.dependsOn = ['verify'];
    assert.throws(() => store.updateTaskPlan(id, 'invalid', 1, invalid));
    assert.throws(() => store.updateTaskPlan(id, '', 1, input()));
    assert.throws(() => store.updateTaskPlan(id, 'bad-turn', 0, input()));
    assert.deepEqual(store.getTask(id), before);
    store.updateTaskPlan(id, 'initial', 1, input());
    const reduced: UpdatePlanInput = { steps: [{ id: 'read', title: 'Changed scope', status: 'pending', dependsOn: [] }] };
    assert.equal(store.updateTaskPlan(id, 'replan', 2, reduced).plan.revision, 2, 'steps may be removed');
    const plan = store.getTask(id)?.plan;
    const stalled = store.appendAgentEvent(id, 'plan_stalled', { turn: 6 });
    assert.equal(stalled.event.type, 'plan_stalled');
    assert.deepEqual(stalled.event.payload, { turn: 6 });
    assert.deepEqual(stalled.task.plan, plan);
  } finally { store.close(true); }
}));

test('a failure after snapshot and event writes rolls back the plan, event sequence and call history', () => withStore((directory, open) => {
  const store = open();
  const id = task(store);
  let first: ReturnType<Store['updateTaskPlan']>;
  try { first = store.updateTaskPlan(id, 'first', 1, input()); }
  finally { store.close(true); }
  const raw = new DatabaseSync(resolve(directory, 'control-plane.sqlite'));
  try {
    raw.exec(`CREATE TRIGGER fail_plan_call BEFORE INSERT ON task_plan_calls WHEN NEW.call_id = 'fail'
      BEGIN SELECT RAISE(ABORT, 'INJECTED'); END`);
  } finally { raw.close(); }
  const reopened = open();
  try {
    reopened.transitionTask(id, 'RUNNING', { requestId: randomUUID(), userConfirmed: true });
    const before = reopened.getTask(id)!;
    const changed = input(); changed.steps[0]!.title = 'Must roll back';
    assert.throws(() => reopened.updateTaskPlan(id, 'fail', 2, changed), /INJECTED/);
    assert.deepEqual(reopened.getTask(id), before);
    assert.deepEqual(reopened.getTask(id)?.plan, first.plan);
    assert.equal(reopened.listTaskEvents(id, 0).length, before.lastSeq);
    assert.equal(reopened.updateTaskPlan(id, 'retry', 2, changed).plan.revision, 2);
  } finally { reopened.close(true); }
}));

test('task lists omit large plans while individual snapshots retain the complete plan', () => withStore((_, open) => {
  const store = open();
  try {
    const large = UpdatePlanInputSchema.parse({ steps: Array.from({ length: 24 }, (_, index) => ({
      id: `step_${index}`, title: '中'.repeat(135), status: 'pending', dependsOn: [],
    })) });
    const ids = Array.from({ length: 50 }, () => {
      const id = task(store);
      store.updateTaskPlan(id, 'large', 1, large);
      return id;
    });
    const listed = store.listTasks(200);
    assert.equal(listed.length, 50);
    assert.ok(listed.every(item => !Object.hasOwn(item, 'plan')));
    assert.ok(Buffer.byteLength(JSON.stringify({ tasks: listed })) < CONTROL_POLICY.maxResponseBytes);
    for (const id of ids) assert.deepEqual(store.getTask(id)?.plan, { ...large, revision: 1, turn: 1 });
  } finally { store.close(true); }
}));

test('011 databases upgrade without losing events, request uniqueness or append-only sequence guards', () => withStore((directory, open) => {
  const path = resolve(directory, 'control-plane.sqlite');
  const legacy = new DatabaseSync(path);
  const id = randomUUID(), projectId = randomUUID(), requestId = randomUUID(), eventId = randomUUID();
  const timestamp = '2026-11-17T00:00:00.000Z';
  try {
    legacy.function('oa_utf16_length', { deterministic: true }, (value: unknown) => typeof value === 'string' ? value.length : 0);
    legacy.exec('PRAGMA foreign_keys = ON; CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, sha256 TEXT NOT NULL) STRICT');
    const names = readdirSync('apps/server/migrations').sort().filter(name => Number(name.slice(0, 3)) <= 11);
    for (const [index, name] of names.entries()) {
      const sql = readFileSync(resolve('apps/server/migrations', name), 'utf8');
      legacy.exec(sql);
      legacy.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(index + 1, createHash('sha256').update(sql).digest('hex'));
    }
    legacy.prepare(`INSERT INTO tasks VALUES (?, ?, 'CREATED', 1, ?, ?)`).run(id, projectId, timestamp, timestamp);
    legacy.prepare(`INSERT INTO task_events VALUES (?, 1, ?, 'task_created', ?, ?, ?)`).run(id, eventId, requestId, timestamp, JSON.stringify({ projectId }));
  } finally { legacy.close(); }
  const store = open();
  try {
    assert.equal(store.databaseVersion, 13);
    assert.equal(Object.hasOwn(store.getTask(id)!, 'plan'), false);
    assert.deepEqual(store.listTaskEvents(id, 0)[0], { taskId: id, seq: 1, eventId, type: 'task_created', requestId,
      occurredAt: timestamp, payload: { projectId } });
    store.transitionTask(id, 'RUNNING', { requestId: randomUUID(), userConfirmed: true });
    store.updateTaskPlan(id, 'after-upgrade', 1, input());
    store.appendAgentEvent(id, 'plan_stalled', { turn: 5 });
  } finally { store.close(true); }
  const inspect = new DatabaseSync(path);
  try {
    inspect.function('oa_utf16_length', { deterministic: true }, (value: unknown) => typeof value === 'string' ? value.length : 0);
    assert.equal(inspect.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
    assert.deepEqual(inspect.prepare('PRAGMA foreign_key_check').all(), []);
    assert.throws(() => inspect.prepare('UPDATE task_events SET payload = ? WHERE seq = 1').run('{}'), /TASK_EVENTS_APPEND_ONLY/);
    assert.throws(() => inspect.prepare('DELETE FROM task_events WHERE seq = 1').run(), /TASK_EVENTS_APPEND_ONLY/);
    const next = Number(inspect.prepare('SELECT last_seq FROM tasks WHERE id = ?').get(id)?.last_seq) + 1;
    assert.throws(() => inspect.prepare(`INSERT INTO task_events VALUES (?, ?, ?, 'plan_stalled', NULL, ?, '{}')`)
      .run(id, next + 1, randomUUID(), timestamp), /TASK_EVENT_SEQUENCE_GAP/);
    assert.throws(() => inspect.prepare(`INSERT INTO task_events VALUES (?, ?, ?, 'plan_stalled', ?, ?, '{}')`)
      .run(id, next, randomUUID(), requestId, timestamp), /UNIQUE constraint failed/);
  } finally { inspect.close(); }
}));
