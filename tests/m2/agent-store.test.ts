import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TASK_LIVE_LIMITS, TASK_MESSAGE_LIMITS, TaskLivePageSchema, TaskMessageSchema, replayTaskEvents } from '../../packages/contracts/dist/index.js';
import { openStore } from '../../apps/server/dist/persistence/store.js';
import type { Store } from '../../apps/server/dist/persistence/store.js';
import { LiveFeed } from '../../apps/server/dist/agent/live.js';

// Migration 009 and the agent's persistence: metadata-only task events, append-only conversation text, and the
// transient live feed. Nothing here stores a tool result or a stream delta.

function withStore(run: (store: Store, directory: string) => void): void {
  const cache = resolve('.cache'); mkdirSync(cache, { recursive: true });
  const directory = mkdtempSync(resolve(cache, 'agent-store-'));
  const store = openStore(directory, randomUUID());
  try { run(store, directory); } finally { store.close(true); if (directory.startsWith(cache + sep)) rmSync(directory, { recursive: true, force: true }); }
}
const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };

test('migration 009: agent events are metadata only, replay keeps state, and finished tasks accept nothing more', () => {
  withStore((store, directory) => {
    const projectId = store.addProject({ name: 'p', path: 'C:\\work\\p' }).id;
    const task = store.createTask(projectId, randomUUID()).task;
    store.transitionTask(task.id, 'QUEUED', { requestId: randomUUID() });
    const prompt = store.addTaskMessage(task.id, 'user', 0, 'Explain the build');
    store.appendAgentEvent(task.id, 'user_message', { messageId: prompt.id, chars: 17 });
    store.transitionTask(task.id, 'RUNNING', { requestId: randomUUID() });
    store.appendAgentEvent(task.id, 'assistant_turn', { turn: 1, model: 'claude-sonnet-5-5', messageId: null, stopReason: 'tool_use',
      toolCalls: 1, fallback: false, usage });
    store.appendAgentEvent(task.id, 'tool_call', { turn: 1, callId: 'toolu_1', tool: 'read_file', target: 'package.json', status: 'ok', code: null, size: 120 });
    assert.throws(() => store.appendAgentEvent(task.id, 'tool_call', { turn: 1, callId: 'toolu_2', tool: 'read_file', target: 'x', status: 'ok',
      code: null, size: 1, content: 'file text' }), 'unknown fields, such as file content, are refused');
    assert.throws(() => store.appendAgentEvent(task.id, 'task_state_changed' as never, {}), /VALIDATION_ERROR/);
    const events = store.listTaskEvents(task.id, 0);
    assert.deepEqual(events.map(event => event.seq), [1, 2, 3, 4, 5, 6]);
    const replayed = replayTaskEvents(task.id, 0, null, events);
    assert.deepEqual(replayed.ok && [replayed.state, replayed.lastSeq], ['RUNNING', 6], 'agent events do not change state');
    store.transitionTask(task.id, 'COMPLETED', { requestId: randomUUID(), sideEffects: 'VERIFIED' });
    assert.throws(() => store.appendAgentEvent(task.id, 'user_message', { messageId: randomUUID(), chars: 1 }), /TASK_TERMINAL/);
    assert.throws(() => store.addTaskMessage(task.id, 'assistant', 2, 'late'), /TASK_TERMINAL/);
    assert.deepEqual(store.listTaskMessages(task.id).map(message => message.text), ['Explain the build']);
    // The rebuilt task_events keeps its append-only and gap-free triggers; task_messages is append-only too.
    store.close(true);
    const raw = new DatabaseSync(resolve(directory, 'control-plane.sqlite'));
    try {
      assert.throws(() => raw.exec("UPDATE task_events SET payload = '{}'"), /TASK_EVENTS_APPEND_ONLY/);
      assert.throws(() => raw.exec('DELETE FROM task_events'), /TASK_EVENTS_APPEND_ONLY/);
      assert.throws(() => raw.exec("UPDATE task_messages SET text = 'changed'"), /TASK_MESSAGES_APPEND_ONLY/);
      assert.throws(() => raw.exec('DELETE FROM task_messages'), /TASK_MESSAGES_APPEND_ONLY/);
      assert.throws(() => raw.prepare(`INSERT INTO task_events(task_id, seq, event_id, type, request_id, occurred_at, payload) VALUES (?, 99, ?, 'tool_call', NULL, ?, '{}')`)
        .run(task.id, randomUUID(), new Date().toISOString()), /TASK_EVENT_SEQUENCE_GAP/);
      assert.equal((raw.prepare('SELECT count(*) AS total FROM task_events WHERE task_id = ?').get(task.id) as { total: number }).total, 7);
    } finally { raw.close(); }
  });
});

test('conversation text is bounded per message and per task, and re-validated on read', () => {
  withStore(store => {
    const projectId = store.addProject({ name: 'p', path: 'C:\\work\\q' }).id;
    const task = store.createTask(projectId, randomUUID()).task;
    assert.throws(() => store.addTaskMessage(task.id, 'user', 0, 'x'.repeat(TASK_MESSAGE_LIMITS.maxTextBytes + 1)));
    assert.throws(() => store.addTaskMessage(task.id, 'system' as never, 0, 'x'));
    assert.throws(() => store.addTaskMessage(randomUUID(), 'user', 0, 'x'), /NOT_FOUND/);
    for (let index = 0; index < TASK_MESSAGE_LIMITS.maxMessages; index++) store.addTaskMessage(task.id, index ? 'assistant' : 'user', index, `m${index}`);
    assert.throws(() => store.addTaskMessage(task.id, 'assistant', 999, 'one too many'), /LIMIT_EXCEEDED/);
    const messages = store.listTaskMessages(task.id);
    assert.equal(messages.length, TASK_MESSAGE_LIMITS.maxMessages);
    assert.ok(messages.every(message => TaskMessageSchema.safeParse(message).success));
    assert.deepEqual(messages.slice(0, 3).map(message => message.text), ['m0', 'm1', 'm2'], 'oldest first');
  });
});

test('live feed: ordered cursors, byte-bounded eviction with an explicit gap, done after finish, released after retention', () => {
  let now = 1_000;
  const feed = new LiveFeed(() => now, 200);
  const task = randomUUID();
  for (let index = 0; index < 10; index++) feed.push(task, 1, { kind: 'text', text: `chunk-${index}-${'x'.repeat(10)}` });
  const first = feed.read(task, 0);
  assert.equal(TaskLivePageSchema.safeParse(first).success, true);
  assert.equal(first.gap, true, 'the earliest deltas were evicted');
  assert.equal(first.deltas.at(-1)!.seq, 10);
  assert.ok(first.deltas.length < 10 && first.deltas.every((item, index, all) => index === 0 || item.seq === all[index - 1]!.seq + 1));
  const caughtUp = feed.read(task, first.nextSeq);
  assert.deepEqual([caughtUp.deltas.length, caughtUp.gap, caughtUp.done], [0, false, false]);
  feed.push(task, 2, { kind: 'tool_call', id: 'toolu_x', name: 'read_file' });
  feed.finish(task);
  feed.push(task, 2, { kind: 'text', text: 'after finish is ignored' });
  const last = feed.read(task, first.nextSeq);
  assert.deepEqual(last.deltas.map(item => item.delta.kind), ['tool_call']);
  assert.equal(last.done, true);
  now += TASK_LIVE_LIMITS.retainFinishedMs + 1;
  const released = feed.read(task, 0);
  assert.deepEqual([released.deltas.length, released.done], [0, true]);
  const unknown = randomUUID();
  assert.deepEqual(feed.read(unknown, 5), { taskId: unknown, afterSeq: 5, nextSeq: 5, deltas: [], gap: false, done: true });
});
