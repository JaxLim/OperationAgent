import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { replayTaskEvents } from '../../packages/contracts/dist/index.js';
import { openStore } from '../../apps/server/dist/persistence/store.js';
import type { Store } from '../../apps/server/dist/persistence/store.js';

const ids = { toolCallId: randomUUID(), attemptId: randomUUID() };
const summary = (taskId: string) => ({ type: 'tool_output_summary' as const, taskId, ...ids, stdoutBytes: 4, stderrBytes: 0,
  sampledBytes: 4, truncatedBytes: 0, exitCode: 0, diagnostics: [] });

function withStore(run: (directory: string, open: () => Store) => void): void {
  const cache = resolve('.cache'); mkdirSync(cache, { recursive: true });
  const directory = mkdtempSync(resolve(cache, 'tasks-'));
  try { run(directory, () => openStore(directory, randomUUID())); }
  finally { if (directory.startsWith(cache + sep)) rmSync(directory, { recursive: true, force: true }); }
}
const project = (store: Store): string => store.addProject({ name: 'repo', path: `C:/work/${randomUUID()}` }).id;

test('a task and its seq-1 event commit together, and an unknown project writes nothing', () => withStore((_, open) => {
  const store = open();
  try {
    assert.throws(() => store.createTask(randomUUID(), randomUUID()), /NOT_FOUND/);
    const projectId = project(store);
    const { task, event } = store.createTask(projectId, randomUUID());
    assert.deepEqual({ state: task.state, lastSeq: task.lastSeq, projectId: task.projectId }, { state: 'CREATED', lastSeq: 1, projectId });
    assert.deepEqual({ type: event.type, seq: event.seq, taskId: event.taskId }, { type: 'task_created', seq: 1, taskId: task.id });
    assert.deepEqual(store.listTaskEvents(task.id, 0), [event]);
    assert.equal(store.getTask(randomUUID()), null);
    assert.throws(() => store.listTaskEvents(randomUUID(), 0), /NOT_FOUND/);
    for (const [after, limit] of [[-1, 10], [0, 0], [0, 201], [0.5, 10]]) assert.throws(() => store.listTaskEvents(task.id, after!, limit), /VALIDATION_ERROR/);
  } finally { store.close(true); }
}));

test('transitions are checked, gap-free and replayable; rejected ones write nothing', () => withStore((_, open) => {
  const store = open();
  try {
    const { task } = store.createTask(project(store), randomUUID());
    const step = (to: Parameters<Store['transitionTask']>[1], extra = {}) => store.transitionTask(task.id, to, { requestId: randomUUID(), ...extra });
    step('QUEUED'); step('RUNNING');
    assert.throws(() => step('CREATED'), /INVALID_TRANSITION/);
    step('STOPPING');
    assert.throws(() => step('STOPPED'), /CLEANUP_UNCONFIRMED/);
    assert.throws(() => step('FAILED'), /INVALID_TRANSITION/);
    assert.equal(store.getTask(task.id)?.lastSeq, 4);
    const stopped = step('STOPPED', { cleanupConfirmed: true, sideEffects: 'UNKNOWN', reason: 'User stopped the task' });
    assert.deepEqual(stopped.event.payload, { from: 'STOPPING', to: 'STOPPED', sideEffects: 'UNKNOWN', reason: 'User stopped the task' });
    assert.throws(() => step('FAILED'), /INVALID_TRANSITION/);
    const events = store.listTaskEvents(task.id, 0);
    assert.deepEqual(events.map(event => event.seq), [1, 2, 3, 4, 5]);
    assert.deepEqual(replayTaskEvents(task.id, 0, null, events), { ok: true, state: 'STOPPED', lastSeq: 5 });
    // A client resuming from its cursor sees only the tail, in order.
    assert.deepEqual(store.listTaskEvents(task.id, 3).map(event => event.seq), [4, 5]);
    assert.deepEqual(store.listTaskEvents(task.id, 1, 2).map(event => event.seq), [2, 3]);
    assert.deepEqual(store.listTaskEvents(task.id, 5), []);
  } finally { store.close(true); }
}));

test('a repeated request id is applied once, and reusing it for another operation is rejected', () => withStore((_, open) => {
  const store = open();
  try {
    const projectId = project(store), createId = randomUUID(), queueId = randomUUID(), summaryId = randomUUID();
    const first = store.createTask(projectId, createId);
    assert.deepEqual(store.createTask(projectId, createId), first);
    assert.throws(() => store.createTask(project(store), createId), /REQUEST_CONFLICT/);
    const queued = store.transitionTask(first.task.id, 'QUEUED', { requestId: queueId });
    assert.deepEqual(store.transitionTask(first.task.id, 'QUEUED', { requestId: queueId }).event, queued.event);
    assert.throws(() => store.transitionTask(first.task.id, 'STOPPING', { requestId: queueId }), /REQUEST_CONFLICT/);
    const recorded = store.recordToolSummary(summary(first.task.id), summaryId);
    assert.deepEqual(store.recordToolSummary(summary(first.task.id), summaryId).event, recorded.event);
    assert.throws(() => store.recordToolSummary(summary(first.task.id), queueId), /REQUEST_CONFLICT/);
    // Same request id and tool call, but a different result or task: a conflict, never the earlier commit.
    const other = store.createTask(projectId, randomUUID()).task.id;
    for (const changed of [{ exitCode: 1 }, { exitCode: null }, { stdoutBytes: 5 }, { sampledBytes: 3 }, { taskId: other },
      { diagnostics: [{ severity: 'error' as const, summary: 'failed' }] }]) {
      assert.throws(() => store.recordToolSummary({ ...summary(first.task.id), ...changed }, summaryId), /REQUEST_CONFLICT/, JSON.stringify(changed));
    }
    for (const changed of [{ sideEffects: 'UNKNOWN' as const }, { reason: 'Different reason' }]) {
      assert.throws(() => store.transitionTask(first.task.id, 'QUEUED', { requestId: queueId, ...changed }), /REQUEST_CONFLICT/, JSON.stringify(changed));
    }
    assert.throws(() => store.transitionTask(other, 'QUEUED', { requestId: queueId }), /REQUEST_CONFLICT/);
    assert.deepEqual(store.listTaskEvents(first.task.id, 0).map(event => event.type), ['task_created', 'task_state_changed', 'tool_output_summary']);
    assert.deepEqual(store.listTaskEvents(other, 0).map(event => event.type), ['task_created']);
    assert.equal(store.getTask(first.task.id)?.state, 'QUEUED');
  } finally { store.close(true); }
}));

test('only bounded tool summaries are stored, and never on a finished task', () => withStore((_, open) => {
  const store = open();
  try {
    const { task } = store.createTask(project(store), randomUUID());
    assert.throws(() => store.recordToolSummary({ ...summary(task.id), diagnostics: Array.from({ length: 20 },
      () => ({ severity: 'error' as const, summary: '\u4e2d'.repeat(512) })) }, randomUUID()));
    assert.throws(() => store.recordToolSummary(summary(randomUUID()), randomUUID()), /NOT_FOUND/);
    for (const to of ['QUEUED', 'RUNNING', 'COMPLETED'] as const) store.transitionTask(task.id, to, { requestId: randomUUID() });
    assert.throws(() => store.recordToolSummary(summary(task.id), randomUUID()), /TASK_TERMINAL/);
    assert.equal(store.getTask(task.id)?.lastSeq, 4);
  } finally { store.close(true); }
}));

test('restart interrupts unfinished tasks once, marks dispatched work UNKNOWN and reads everything back', () => withStore((_, open) => {
  const store = open();
  const projectId = project(store);
  const make = (...path: Array<'QUEUED' | 'RUNNING' | 'COMPLETED'>) => {
    const { task } = store.createTask(projectId, randomUUID());
    for (const to of path) store.transitionTask(task.id, to, { requestId: randomUUID() });
    return task.id;
  };
  const created = make(), queued = make('QUEUED'), running = make('QUEUED', 'RUNNING'), done = make('QUEUED', 'RUNNING', 'COMPLETED');
  const before = store.listTaskEvents(running, 0);
  store.close(true);

  const reopened = open();
  try {
    assert.equal(reopened.recoveredTasks, 3);
    assert.deepEqual([created, queued, running, done].map(id => reopened.getTask(id)?.state), ['INTERRUPTED', 'INTERRUPTED', 'INTERRUPTED', 'COMPLETED']);
    const after = reopened.listTaskEvents(running, 0);
    assert.deepEqual(after.slice(0, before.length), before);
    const last = after.at(-1)!;
    assert.equal(last.type, 'task_state_changed');
    if (last.type === 'task_state_changed') assert.deepEqual({ ...last.payload, requestId: last.requestId },
      { from: 'RUNNING', to: 'INTERRUPTED', sideEffects: 'UNKNOWN', reason: 'Control plane restarted before the task finished', requestId: null });
    const queuedLast = reopened.listTaskEvents(queued, 0).at(-1)!;
    assert.equal(queuedLast.type === 'task_state_changed' && queuedLast.payload.sideEffects, null);
    // Resuming needs the user's explicit choice (ADR-005).
    assert.throws(() => reopened.transitionTask(running, 'RUNNING', { requestId: randomUUID() }), /USER_CONFIRMATION_REQUIRED/);
    reopened.transitionTask(running, 'RUNNING', { requestId: randomUUID(), userConfirmed: true });
  } finally { reopened.close(true); }
  const third = open();
  try { assert.equal(third.recoveredTasks, 1); assert.equal(third.getTask(done)?.lastSeq, 4); } finally { third.close(true); }
}));

test('the database itself keeps events append-only and gap-free, and a failed commit leaves no event', () => withStore((directory, open) => {
  const store = open();
  const { task } = store.createTask(project(store), randomUUID());
  store.transitionTask(task.id, 'QUEUED', { requestId: randomUUID() });
  store.close(true);
  const raw = new DatabaseSync(resolve(directory, 'control-plane.sqlite'));
  try {
    assert.throws(() => raw.prepare('UPDATE task_events SET payload = ? WHERE seq = 1').run('{}'), /TASK_EVENTS_APPEND_ONLY/);
    assert.throws(() => raw.prepare('DELETE FROM task_events WHERE seq = 2').run(), /TASK_EVENTS_APPEND_ONLY/);
    assert.throws(() => raw.prepare(`INSERT INTO task_events VALUES (?, 4, ?, 'task_created', NULL, '2026-10-30T00:00:00.000Z', '{}')`)
      .run(task.id, randomUUID()), /TASK_EVENT_SEQUENCE_GAP/);
    // Force the task-row update to fail after the event insert, inside the same transaction.
    raw.exec(`CREATE TRIGGER fail_completion BEFORE UPDATE ON tasks WHEN NEW.state = 'COMPLETED' BEGIN SELECT RAISE(ABORT, 'INJECTED'); END`);
  } finally { raw.close(); }
  const reopened = open();
  try {
    reopened.transitionTask(task.id, 'RUNNING', { requestId: randomUUID(), userConfirmed: true });
    const before = reopened.getTask(task.id)!;
    assert.throws(() => reopened.transitionTask(task.id, 'COMPLETED', { requestId: randomUUID() }), /INJECTED/);
    assert.deepEqual(reopened.getTask(task.id), before);
    assert.equal(reopened.listTaskEvents(task.id, 0).length, before.lastSeq);
  } finally { reopened.close(true); }
}));
