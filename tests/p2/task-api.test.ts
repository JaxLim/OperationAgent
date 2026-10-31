import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TASK_API_LIMITS, TaskEventPageSchema, TaskEventSchema, TaskEventsQuerySchema, catchUpTaskEvents } from '../../packages/contracts/dist/index.js';
import type { TaskEvent, TaskState } from '../../packages/contracts/dist/index.js';

const taskId = '11111111-1111-4111-8111-111111111111';
const uuid = (n: number): string => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
const at = '2026-10-31T00:00:00.000Z';
const path: TaskState[] = ['CREATED', 'QUEUED', 'RUNNING', 'WAITING_APPROVAL', 'RUNNING', 'COMPLETED'];
const log: TaskEvent[] = path.map((state, index) => TaskEventSchema.parse(index === 0
  ? { eventId: uuid(1), taskId, seq: 1, occurredAt: at, requestId: null, type: 'task_created', payload: { projectId: uuid(99) } }
  : { eventId: uuid(index + 1), taskId, seq: index + 1, occurredAt: at, requestId: null, type: 'task_state_changed',
    payload: { from: path[index - 1], to: state, sideEffects: null, reason: null } }));
const page = (afterSeq: number, size: number) => {
  const events = log.slice(afterSeq, afterSeq + size);
  return { taskId, afterSeq, lastSeq: log.length, events, hasMore: afterSeq + events.length < log.length };
};

test('a page proves it continues the cursor without gaps and always makes progress', () => {
  for (const after of [0, 2, 5, 6]) assert.equal(TaskEventPageSchema.safeParse(page(after, 2)).success, true, String(after));
  const valid = page(0, 2);
  for (const change of [{ afterSeq: 1 }, { events: [log[0], log[2]] }, { hasMore: false }, { lastSeq: 1 }, { events: [], hasMore: true },
    { taskId: uuid(5) }, { extra: true }, { events: Array.from({ length: TASK_API_LIMITS.maxEventsPerPage + 1 }, () => log[0]) }]) {
    assert.equal(TaskEventPageSchema.safeParse({ ...valid, ...change }).success, false, JSON.stringify(change).slice(0, 60));
  }
  for (const query of [{ taskId, afterSeq: -1 }, { taskId, afterSeq: 0.5 }, { taskId, afterSeq: 0, limit: 0 }, { taskId, afterSeq: 0, path: '/' }]) {
    assert.equal(TaskEventsQuerySchema.safeParse(query).success, false, JSON.stringify(query));
  }
});

test('catch-up pulls every page from a cursor and rebuilds the committed state', async () => {
  const calls: number[] = [];
  const fetch = async (after: number) => { calls.push(after); return page(after, 2); };
  assert.deepEqual(await catchUpTaskEvents(taskId, 0, null, fetch), { ok: true, state: 'COMPLETED', lastSeq: 6, events: log });
  assert.deepEqual(calls, [0, 2, 4]);
  assert.deepEqual(await catchUpTaskEvents(taskId, 3, 'RUNNING', fetch), { ok: true, state: 'COMPLETED', lastSeq: 6, events: log.slice(3) });
  assert.deepEqual(await catchUpTaskEvents(taskId, 6, 'COMPLETED', fetch), { ok: true, state: 'COMPLETED', lastSeq: 6, events: [] });
});

test('catch-up stops on any inconsistent page instead of guessing', async () => {
  assert.deepEqual(await catchUpTaskEvents(taskId, 3, 'QUEUED', async after => page(after, 2)), { ok: false, error: 'STATE_DISCONTINUITY' });
  assert.deepEqual(await catchUpTaskEvents(taskId, 0, null, async after => ({ ...page(after, 2), taskId: uuid(5),
    events: [] , hasMore: true })), { ok: false, error: 'PAGE_INVALID' });
  // A server answering for a different cursor, or a foreign task's page, is rejected.
  assert.deepEqual(await catchUpTaskEvents(taskId, 2, 'QUEUED', async () => page(0, 2)), { ok: false, error: 'PAGE_INVALID' });
  assert.deepEqual(await catchUpTaskEvents(uuid(5), 0, null, async after => page(after, 2)), { ok: false, error: 'PAGE_INVALID' });
  assert.deepEqual(await catchUpTaskEvents(taskId, 0, null, async () => 'not a page'), { ok: false, error: 'PAGE_INVALID' });
  assert.deepEqual(await catchUpTaskEvents(taskId, 0, null, async after => page(after, 1), 3), { ok: false, error: 'TOO_MANY_PAGES' });
});
