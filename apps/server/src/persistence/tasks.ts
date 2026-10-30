import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { TERMINAL_TASK_STATES, TaskEventSchema, TaskSnapshotSchema, TaskStateSchema, ToolOutputSummarySchema,
  checkTaskTransition } from '@operation-agent/contracts';
import type { SideEffectStatus, TaskEvent, TaskSnapshot, TaskState, ToolOutputSummary, TransitionContext } from '@operation-agent/contracts';

// ARCHITECTURE §7.3: every state change and its event commit in one transaction, the per-task seq is gap-free,
// and a request id is applied once. Callers broadcast only what these methods return, i.e. after commit.

export const TASK_LOG_LIMITS = Object.freeze({ maxEventsPerPage: 200 });
export interface TaskCommit { task: TaskSnapshot; event: TaskEvent }
export interface TransitionInput extends TransitionContext {
  requestId: string;
  sideEffects?: SideEffectStatus | null;
  reason?: string | null;
}
export interface TaskLog {
  /** Creates the task and its seq-1 task_created event together. Throws NOT_FOUND for an unregistered project. */
  createTask(projectId: string, requestId: string): TaskCommit;
  /** Throws NOT_FOUND, INVALID_TRANSITION, USER_CONFIRMATION_REQUIRED or CLEANUP_UNCONFIRMED; nothing is written. */
  transitionTask(taskId: string, to: TaskState, input: TransitionInput): TaskCommit;
  /** Persists the redacted summary only (deltas are never stored). Throws NOT_FOUND or TASK_TERMINAL. */
  recordToolSummary(summary: ToolOutputSummary, requestId: string): TaskCommit;
  getTask(taskId: string): TaskSnapshot | null;
  /** Events after the cursor in seq order, at most one page. Throws NOT_FOUND for an unknown task. */
  listTaskEvents(taskId: string, afterSeq: number, limit?: number): TaskEvent[];
  /**
   * A new Express never adopts an old Worker (SEC-17), so every unfinished task becomes INTERRUPTED. Must run
   * inside the caller's startup transaction. Side effects are UNKNOWN once work may have been dispatched.
   */
  interruptUnfinished(): number;
}

type EventRow = { taskId: string; seq: number; eventId: string; type: string; requestId: string | null; occurredAt: string; payload: string };
type TaskRow = { id: string; projectId: string; state: string; lastSeq: number; createdAt: string; updatedAt: string };
const eventColumns = `task_id AS taskId, seq, event_id AS eventId, type, request_id AS requestId, occurred_at AS occurredAt, payload`;
const DISPATCH_POSSIBLE: readonly TaskState[] = ['RUNNING', 'WAITING_APPROVAL', 'STOPPING'];

export function createTaskLog(db: Database.Database): TaskLog {
  const selectTask = db.prepare<[string], TaskRow>(`SELECT id, project_id AS projectId, state, last_seq AS lastSeq,
    created_at AS createdAt, updated_at AS updatedAt FROM tasks WHERE id = ?`);
  const selectByRequest = db.prepare<[string], EventRow>(`SELECT ${eventColumns} FROM task_events WHERE request_id = ?`);
  const selectPage = db.prepare<[string, number, number], EventRow>(`SELECT ${eventColumns} FROM task_events
    WHERE task_id = ? AND seq > ? ORDER BY seq LIMIT ?`);
  const insertEvent = db.prepare(`INSERT INTO task_events(task_id, seq, event_id, type, request_id, occurred_at, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const updateTask = db.prepare('UPDATE tasks SET state = ?, last_seq = ?, updated_at = ? WHERE id = ?');

  // Stored JSON is re-validated on every read; a row that no longer matches the contract fails closed.
  const toEvent = (row: EventRow): TaskEvent => TaskEventSchema.parse({ eventId: row.eventId, taskId: row.taskId, seq: row.seq,
    occurredAt: row.occurredAt, requestId: row.requestId, type: row.type, payload: JSON.parse(row.payload) });
  const task = (id: string): TaskSnapshot | null => { const row = selectTask.get(id); return row ? TaskSnapshotSchema.parse(row) : null; };
  const existing = (id: string): TaskSnapshot => { const found = task(id); if (!found) throw new Error('NOT_FOUND'); return found; };

  /** A repeated request id returns the committed result if it was the same operation, and is rejected otherwise. */
  const replay = (requestId: string, same: (event: TaskEvent) => boolean): TaskCommit | null => {
    const row = selectByRequest.get(requestId);
    if (!row) return null;
    const event = toEvent(row);
    if (!same(event)) throw new Error('REQUEST_CONFLICT');
    return { task: existing(event.taskId), event };
  };
  const append = (current: TaskSnapshot, draft: Pick<TaskEvent, 'type' | 'payload'>, requestId: string | null, state: TaskState): TaskCommit => {
    const occurredAt = new Date().toISOString();
    const event = TaskEventSchema.parse({ ...draft, eventId: randomUUID(), taskId: current.id, seq: current.lastSeq + 1, occurredAt, requestId });
    insertEvent.run(event.taskId, event.seq, event.eventId, event.type, event.requestId, event.occurredAt, JSON.stringify(event.payload));
    updateTask.run(state, event.seq, occurredAt, current.id);
    return { task: existing(current.id), event };
  };
  const change = (current: TaskSnapshot, to: TaskState, input: Omit<TransitionInput, 'requestId'>, requestId: string | null): TaskCommit => {
    const check = checkTaskTransition(current.state, to, input);
    if (!check.allowed) throw new Error(check.reason);
    return append(current, { type: 'task_state_changed', payload: { from: current.state, to,
      sideEffects: input.sideEffects ?? null, reason: input.reason ?? null } } as Pick<TaskEvent, 'type' | 'payload'>, requestId, to);
  };

  return {
    createTask(projectId, requestId) {
      return db.transaction(() => {
        const repeated = replay(requestId, event => event.type === 'task_created' && event.payload.projectId === projectId);
        if (repeated) return repeated;
        if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) throw new Error('NOT_FOUND');
        const now = new Date().toISOString();
        const event = TaskEventSchema.parse({ eventId: randomUUID(), taskId: randomUUID(), seq: 1, occurredAt: now, requestId,
          type: 'task_created', payload: { projectId } });
        db.prepare(`INSERT INTO tasks(id, project_id, state, last_seq, created_at, updated_at) VALUES (?, ?, 'CREATED', 1, ?, ?)`)
          .run(event.taskId, projectId, now, now);
        insertEvent.run(event.taskId, 1, event.eventId, event.type, requestId, now, JSON.stringify(event.payload));
        return { task: existing(event.taskId), event };
      }).immediate();
    },
    transitionTask(taskId, to, input) {
      const target = TaskStateSchema.parse(to);
      return db.transaction(() => replay(input.requestId, event => event.taskId === taskId && event.type === 'task_state_changed' &&
        event.payload.to === target) ?? change(existing(taskId), target, input, input.requestId)).immediate();
    },
    recordToolSummary(input, requestId) {
      const summary = ToolOutputSummarySchema.parse(input);
      return db.transaction(() => {
        const repeated = replay(requestId, event => event.type === 'tool_output_summary' && event.payload.toolCallId === summary.toolCallId &&
          event.payload.attemptId === summary.attemptId);
        if (repeated) return repeated;
        const current = existing(summary.taskId);
        if (TERMINAL_TASK_STATES.includes(current.state)) throw new Error('TASK_TERMINAL');
        return append(current, { type: 'tool_output_summary', payload: summary }, requestId, current.state);
      }).immediate();
    },
    getTask: task,
    listTaskEvents(taskId, afterSeq, limit = TASK_LOG_LIMITS.maxEventsPerPage) {
      if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || !Number.isInteger(limit) || limit < 1 || limit > TASK_LOG_LIMITS.maxEventsPerPage) {
        throw new Error('VALIDATION_ERROR');
      }
      existing(taskId);
      return selectPage.all(taskId, afterSeq, limit).map(toEvent);
    },
    interruptUnfinished() {
      const open = db.prepare<[], { id: string }>(`SELECT id FROM tasks WHERE state NOT IN ('COMPLETED', 'FAILED', 'STOPPED', 'INTERRUPTED')
        ORDER BY created_at, id`).all();
      for (const { id } of open) {
        const current = existing(id);
        change(current, 'INTERRUPTED', { sideEffects: DISPATCH_POSSIBLE.includes(current.state) ? 'UNKNOWN' : null,
          reason: 'Control plane restarted before the task finished' }, null);
      }
      return open.length;
    },
  };
}
