import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppErrorSchema, ErrorCodeSchema, OutputPolicySchema, TASK_TRANSITIONS, TERMINAL_TASK_STATES, TOOL_OUTPUT_LIMITS,
  TOOL_OUTPUT_PERSISTENCE, TaskEventSchema, TaskStateSchema, ToolOutputEventSchema, checkTaskTransition, replayTaskEvents,
  utf8ByteLength } from '../../packages/contracts/dist/index.js';import type { TaskEvent, TaskState } from '../../packages/contracts/dist/index.js';

const taskId = '11111111-1111-4111-8111-111111111111';
const ids = { taskId, toolCallId: '22222222-2222-4222-8222-222222222222', attemptId: '33333333-3333-4333-8333-333333333333' };
const timestamp = '2026-10-30T00:00:00.000Z';
const uuid = (n: number): string => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
const delta = () => ({ type: 'tool_output_delta', ...ids, stream: 'stdout', chunkSeq: 0, byteOffset: 0, data: 'ok\n', timestamp });
const summary = () => ({ type: 'tool_output_summary', ...ids, stdoutBytes: 10, stderrBytes: 2, sampledBytes: 12, truncatedBytes: 0,
  exitCode: 0, diagnostics: [{ severity: 'warning', summary: 'deprecated flag' }] });
const policy = () => ({ realtime: 'bounded-stream', deltaPersistence: 'transient', finalPersistence: 'redacted-summary',
  maxChunkBytes: 4_096, maxBufferedBytes: 65_536, maxPersistedSummaryBytes: 4_096 });

test('tool output events are strict, correlated and bounded in UTF-8 bytes', () => {
  for (const event of [delta(), summary(), { type: 'tool_output_truncated', ...ids, stream: 'stderr', droppedBytes: 512 }]) {
    assert.equal(ToolOutputEventSchema.safeParse(event).success, true, event.type);
  }
  for (const change of [{ extra: true }, { stream: 'stdin' }, { chunkSeq: -1 }, { taskId: 'task-1' }, { attemptId: undefined },
    { data: 'x'.repeat(TOOL_OUTPUT_LIMITS.maxChunkBytes + 1) }, { data: 'é'.repeat(TOOL_OUTPUT_LIMITS.maxChunkBytes / 2 + 1) },
    { type: 'tool_output_persisted' }]) {
    assert.equal(ToolOutputEventSchema.safeParse({ ...delta(), ...change }).success, false, JSON.stringify(change).slice(0, 60));
  }
  assert.equal(ToolOutputEventSchema.safeParse({ ...delta(), data: 'x'.repeat(TOOL_OUTPUT_LIMITS.maxChunkBytes) }).success, true);
  assert.deepEqual(['a', 'é', '€', '\u{1F600}', '\ud800'].map(utf8ByteLength), [1, 2, 3, 4, 3]);
  assert.equal(ToolOutputEventSchema.safeParse({ type: 'tool_output_truncated', ...ids, stream: 'stdout', droppedBytes: 0 }).success, false);
});

test('summaries reject inconsistent counts and unbounded diagnostics', () => {
  for (const change of [{ sampledBytes: 13 }, { truncatedBytes: 13 }, { exitCode: 1.5 },
    { diagnostics: Array.from({ length: TOOL_OUTPUT_LIMITS.maxDiagnostics + 1 }, () => ({ severity: 'error', summary: 'x' })) },
    { diagnostics: [{ severity: 'info', summary: 'x' }] }, { diagnostics: [{ severity: 'error', summary: 'x'.repeat(513) }] }]) {
    assert.equal(ToolOutputEventSchema.safeParse({ ...summary(), ...change }).success, false, JSON.stringify(change).slice(0, 60));
  }
  assert.equal(ToolOutputEventSchema.safeParse({ ...summary(), exitCode: null }).success, true);
});

test('summaries are bounded by their persisted UTF-8 size, not only by diagnostic counts', () => {
  const cjk = (chars: number) => ({ severity: 'error', summary: '中'.repeat(chars) });
  // 20 diagnostics × 512 CJK characters pass every per-field limit but exceed the persisted ceiling.
  const oversized = { ...summary(), diagnostics: Array.from({ length: TOOL_OUTPUT_LIMITS.maxDiagnostics }, () => cjk(512)) };
  assert.equal(ToolOutputEventSchema.safeParse(oversized).success, false);
  // Fill to exactly the ceiling with multibyte text, then add one byte.
  const size = (value: unknown) => utf8ByteLength(JSON.stringify(value));
  const exact = { ...summary(), diagnostics: [] as Array<{ severity: string; summary: string }> };
  while (size({ ...exact, diagnostics: [...exact.diagnostics, cjk(512)] }) <= TOOL_OUTPUT_LIMITS.maxPersistedSummaryBytes) exact.diagnostics.push(cjk(512));
  exact.diagnostics.push(cjk(1));
  while (size(exact) + 3 <= TOOL_OUTPUT_LIMITS.maxPersistedSummaryBytes) exact.diagnostics.at(-1)!.summary += '中';
  exact.diagnostics.at(-1)!.summary += 'x'.repeat(TOOL_OUTPUT_LIMITS.maxPersistedSummaryBytes - size(exact));
  assert.equal(size(exact), TOOL_OUTPUT_LIMITS.maxPersistedSummaryBytes);
  assert.equal(ToolOutputEventSchema.safeParse(exact).success, true);
  exact.diagnostics.at(-1)!.summary += 'x';
  assert.equal(ToolOutputEventSchema.safeParse(exact).success, false);
});

test('output policy cannot request per-chunk persistence or exceed the trusted limits', () => {
  assert.equal(OutputPolicySchema.safeParse(policy()).success, true);
  for (const change of [{ deltaPersistence: 'persisted' }, { finalPersistence: 'raw' }, { realtime: 'unbounded' },
    { maxChunkBytes: 0 }, { maxChunkBytes: TOOL_OUTPUT_LIMITS.maxChunkBytes + 1 }, { maxBufferedBytes: TOOL_OUTPUT_LIMITS.maxBufferedBytes + 1 },
    { maxBufferedBytes: 1_024 }, { persistenceClass: 'audit' }]) {
    assert.equal(OutputPolicySchema.safeParse({ ...policy(), ...change }).success, false, JSON.stringify(change));
  }
  assert.deepEqual({ ...TOOL_OUTPUT_PERSISTENCE }, { tool_output_delta: 'transient', tool_output_truncated: 'transient', tool_output_summary: 'persisted' });
  assert.equal(Object.isFrozen(TOOL_OUTPUT_PERSISTENCE), true);
});

test('task transitions follow ARCHITECTURE §8.1 and terminal states never change', () => {
  const states = TaskStateSchema.options;
  assert.deepEqual(Object.keys(TASK_TRANSITIONS).sort(), [...states].sort());
  for (const terminal of TERMINAL_TASK_STATES) {
    for (const to of states) assert.equal(checkTaskTransition(terminal, to, { userConfirmed: true, cleanupConfirmed: true }).allowed, false);
  }
  const allowed: Array<[TaskState, TaskState]> = [['CREATED', 'QUEUED'], ['QUEUED', 'RUNNING'], ['RUNNING', 'WAITING_APPROVAL'],
    ['WAITING_APPROVAL', 'RUNNING'], ['RUNNING', 'COMPLETED'], ['RUNNING', 'FAILED'], ['RUNNING', 'STOPPING'], ['RUNNING', 'INTERRUPTED']];
  for (const [from, to] of allowed) assert.deepEqual(checkTaskTransition(from, to), { allowed: true }, `${from}->${to}`);
  for (const [from, to] of [['STOPPED', 'FAILED'], ['STOPPING', 'FAILED'], ['STOPPING', 'COMPLETED'], ['CREATED', 'RUNNING'],
    ['WAITING_APPROVAL', 'COMPLETED'], ['INTERRUPTED', 'COMPLETED']] as Array<[TaskState, TaskState]>) {
    assert.deepEqual(checkTaskTransition(from, to, { userConfirmed: true }), { allowed: false, reason: 'INVALID_TRANSITION' }, `${from}->${to}`);
  }
  assert.equal(Object.isFrozen(TASK_TRANSITIONS) && Object.isFrozen(TASK_TRANSITIONS.RUNNING), true);
});

test('STOPPED needs confirmed cleanup and resuming INTERRUPTED needs the user', () => {
  assert.deepEqual(checkTaskTransition('STOPPING', 'STOPPED'), { allowed: false, reason: 'CLEANUP_UNCONFIRMED' });
  assert.deepEqual(checkTaskTransition('STOPPING', 'STOPPED', { cleanupConfirmed: true }), { allowed: true });
  assert.deepEqual(checkTaskTransition('STOPPING', 'INTERRUPTED'), { allowed: true });
  for (const to of ['QUEUED', 'RUNNING'] as const) {
    assert.deepEqual(checkTaskTransition('INTERRUPTED', to), { allowed: false, reason: 'USER_CONFIRMATION_REQUIRED' });
    assert.deepEqual(checkTaskTransition('INTERRUPTED', to, { userConfirmed: true }), { allowed: true });
  }
});

const created = (): TaskEvent => TaskEventSchema.parse({ eventId: uuid(1), taskId, seq: 1, occurredAt: timestamp, requestId: null,
  type: 'task_created', payload: { projectId: uuid(99) } });
const changed = (seq: number, from: TaskState, to: TaskState, eventId = uuid(seq)): TaskEvent => TaskEventSchema.parse({ eventId, taskId, seq,
  occurredAt: timestamp, requestId: uuid(500 + seq), type: 'task_state_changed', payload: { from, to, sideEffects: null, reason: null } });

test('task events are strict and reject illegal state changes or foreign tool summaries', () => {
  const base = { eventId: uuid(2), taskId, seq: 2, occurredAt: timestamp, requestId: null };
  for (const event of [
    { ...base, type: 'task_state_changed', payload: { from: 'STOPPED', to: 'FAILED', sideEffects: 'PARTIAL_CHANGES', reason: null } },
    { ...base, seq: 0, type: 'task_created', payload: { projectId: uuid(9) } },
    { ...base, type: 'task_created', payload: { projectId: uuid(9), prompt: 'secret' } },
    { ...base, type: 'tool_output_summary', payload: { ...summary(), taskId: uuid(7) } },
    { ...base, type: 'tool_output_delta', payload: delta() },
  ]) assert.equal(TaskEventSchema.safeParse(event).success, false, event.type);
  assert.equal(TaskEventSchema.safeParse({ ...base, type: 'tool_output_summary', payload: summary() }).success, true);
  assert.equal(TaskEventSchema.safeParse({ ...base, type: 'task_state_changed',
    payload: { from: 'STOPPING', to: 'STOPPED', sideEffects: 'UNKNOWN', reason: 'User stopped the task' } }).success, true);
});

test('replay accepts only a gap-free continuation of one task log', () => {
  const log = [created(), changed(2, 'CREATED', 'QUEUED'), changed(3, 'QUEUED', 'RUNNING'), changed(4, 'RUNNING', 'STOPPING')];
  assert.deepEqual(replayTaskEvents(taskId, 0, null, log), { ok: true, state: 'STOPPING', lastSeq: 4 });
  // Resuming from a cursor continues from the snapshot state, not from the beginning.
  assert.deepEqual(replayTaskEvents(taskId, 2, 'QUEUED', log.slice(2)), { ok: true, state: 'STOPPING', lastSeq: 4 });
  assert.deepEqual(replayTaskEvents(taskId, 4, 'STOPPING', []), { ok: true, state: 'STOPPING', lastSeq: 4 });
  assert.deepEqual(replayTaskEvents(taskId, 0, null, [created(), log[2]!]), { ok: false, error: 'SEQUENCE_GAP', seq: 3 });
  assert.deepEqual(replayTaskEvents(taskId, 0, null, [created(), created()]), { ok: false, error: 'DUPLICATE_EVENT', seq: 1 });
  assert.deepEqual(replayTaskEvents(taskId, 1, 'CREATED', [changed(2, 'CREATED', 'QUEUED'), changed(3, 'QUEUED', 'RUNNING', uuid(2))]),
    { ok: false, error: 'DUPLICATE_EVENT', seq: 3 });
  assert.deepEqual(replayTaskEvents(taskId, 0, null, log.slice(1)), { ok: false, error: 'SEQUENCE_GAP', seq: 2 });
  assert.deepEqual(replayTaskEvents(taskId, 1, null, log.slice(1)), { ok: false, error: 'CREATED_NOT_FIRST', seq: 2 });
  assert.deepEqual(replayTaskEvents(taskId, 1, 'CREATED', [changed(2, 'QUEUED', 'RUNNING')]), { ok: false, error: 'STATE_DISCONTINUITY', seq: 2 });
  assert.deepEqual(replayTaskEvents(uuid(5), 0, null, log), { ok: false, error: 'TASK_MISMATCH', seq: 1 });
});

test('domain errors are strict and leave the frozen RPC error set unchanged', () => {
  const error = { code: 'SANDBOX_UNAVAILABLE', message: 'High-risk tools are disabled on this platform', requestId: uuid(3), retryable: false };
  assert.equal(AppErrorSchema.safeParse(error).success, true);
  for (const change of [{ code: 'SPAWN_FALLBACK' }, { details: { stack: 'x' } }, { message: '' }, { requestId: 'r-1' }]) {
    assert.equal(AppErrorSchema.safeParse({ ...error, ...change }).success, false, JSON.stringify(change));
  }
  assert.deepEqual(ErrorCodeSchema.options, ['VALIDATION_ERROR', 'PROTOCOL_MISMATCH', 'IDENTITY_MISMATCH', 'WORKER_ISOLATION_UNAVAILABLE', 'NOT_IMPLEMENTED']);
});
