import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { USAGE_PAGE_SIZE, UsagePageSchema } from '@operation-agent/contracts';
import type { UsagePage, UsageQuery } from '@operation-agent/contracts';
import { AGENT_EVENT_TYPES, CHECKPOINT_LIMITS, TASK_MESSAGE_LIMITS, TERMINAL_TASK_STATES, TaskCheckpointSchema, TaskEventSchema, TaskMessageSchema, TaskSnapshotSchema, TaskStateSchema,
  TaskPlanSchema, ToolCallViewSchema, ToolOutputSummarySchema, UpdatePlanInputSchema, checkTaskTransition } from '@operation-agent/contracts';
import type { AgentEventType, SideEffectStatus, TaskEvent, TaskMessage, TaskSnapshot, TaskState, ToolOutputSummary,
  TaskCheckpoint, TaskPlan, TransitionContext, UpdatePlanInput } from '@operation-agent/contracts';

// ARCHITECTURE §7.3: every state change and its event commit in one transaction, the per-task seq is gap-free,
// and a request id is applied once. Callers broadcast only what these methods return, i.e. after commit.

export const TASK_LOG_LIMITS = Object.freeze({ maxEventsPerPage: 200 });
export interface TaskCommit { task: TaskSnapshot; event: TaskEvent }
export interface TransitionInput extends TransitionContext {
  requestId: string;
  sideEffects?: SideEffectStatus | null;
  reason?: string | null;
}
interface Continuation {
  previousTaskId: string;
  resume: boolean;
}
export interface TaskLog {
  listUsage(input: UsageQuery): UsagePage;
  /** Creates the task and its seq-1 task_created event together. Throws NOT_FOUND for an unregistered project. */
  createTask(projectId: string, requestId: string, continuation?: Continuation, seed?: TaskCheckpoint): TaskCommit;
  /** Throws NOT_FOUND, INVALID_TRANSITION, USER_CONFIRMATION_REQUIRED or CLEANUP_UNCONFIRMED; nothing is written. */
  transitionTask(taskId: string, to: TaskState, input: TransitionInput): TaskCommit;
  /** Persists the redacted summary only (deltas are never stored). Throws NOT_FOUND or TASK_TERMINAL. */
  recordToolSummary(summary: ToolOutputSummary, requestId: string): TaskCommit;
  /** Appends a metadata-only agent event to an unfinished task without changing its state. Throws NOT_FOUND or TASK_TERMINAL. */
  appendAgentEvent(taskId: string, type: AgentEventType, payload: unknown, checkpoint?: TaskCheckpoint): TaskCommit;
  /** RUNNING only; identical content keeps the revision/turn. Historical calls replay even after completion. */
  updateTaskPlan(taskId: string, callId: string, turn: number, input: UpdatePlanInput): { plan: TaskPlan; changed: boolean };
  /** Stores prompt or answer text (bounded) for an unfinished task. Throws NOT_FOUND, TASK_TERMINAL or VALIDATION_ERROR. */
  addTaskMessage(taskId: string, role: TaskMessage['role'], turn: number, text: string): TaskMessage;
  /** Oldest first; rows that no longer validate are skipped. Throws NOT_FOUND for an unknown task. */
  listTaskMessages(taskId: string): TaskMessage[];
  pageSessionMessages(taskId: string, after: number): { messages: TaskMessage[]; hasMore: boolean };
  getCheckpoint(taskId: string): TaskCheckpoint | null;
  hasContinuation(taskId: string): boolean;
  getTask(taskId: string): TaskSnapshot | null;
  /** The task a create request already made (its task_created event carries the request id), or null. */
  taskForRequest(requestId: string): TaskSnapshot | null;
  /** Most recently created first; omits plans to keep the bounded list response small. */
  listTasks(limit: number): TaskSnapshot[];
  /** Events after the cursor in seq order, at most one page. Throws NOT_FOUND for an unknown task. */
  listTaskEvents(taskId: string, afterSeq: number, limit?: number): TaskEvent[];
  /**
   * A new Express never adopts an old Worker (SEC-17), so every unfinished task becomes INTERRUPTED. Must run
   * inside the caller's startup transaction. Side effects are UNKNOWN once work may have been dispatched.
   */
  interruptUnfinished(): number;
}

type EventRow = { taskId: string; seq: number; eventId: string; type: string; requestId: string | null; occurredAt: string; payload: string };
type TaskRow = Omit<TaskSnapshot, 'plan' | 'resumable' | 'previousTaskId' | 'sessionId'>
  & { sessionId: string | null; previousTaskId: string | null; checkpoint: number };
const eventColumns = `task_id AS taskId, seq, event_id AS eventId, type, request_id AS requestId, occurred_at AS occurredAt, payload`;
const DISPATCH_POSSIBLE: readonly TaskState[] = ['RUNNING', 'WAITING_APPROVAL', 'STOPPING'];
/** Key-order-independent JSON, so two schema-parsed values compare by content. */
const canonical = (value: unknown): string => JSON.stringify(value, (_, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : item);

export function createTaskLog(db: Database.Database): TaskLog {
  const taskColumns = `id, project_id AS projectId, state, last_seq AS lastSeq, created_at AS createdAt, updated_at AS updatedAt,
    session_id AS sessionId, previous_task_id AS previousTaskId,
    (state = 'INTERRUPTED' AND EXISTS (SELECT 1 FROM task_checkpoints WHERE task_id = tasks.id)) AS checkpoint`;
  const selectTask = db.prepare<[string], TaskRow>(`SELECT ${taskColumns} FROM tasks WHERE id = ?`);
  const selectRecent = db.prepare<[number], TaskRow>(`SELECT ${taskColumns} FROM tasks
    WHERE NOT EXISTS (SELECT 1 FROM tasks next WHERE next.previous_task_id = tasks.id)
    ORDER BY created_at DESC, id LIMIT ?`);
  const selectCheckpoint = db.prepare<[string], { checkpoint: string }>('SELECT checkpoint FROM task_checkpoints WHERE task_id = ?');
  const writeCheckpoint = db.prepare(`INSERT INTO task_checkpoints(task_id, checkpoint) VALUES (?, ?)
    ON CONFLICT(task_id) DO UPDATE SET checkpoint = excluded.checkpoint`);
  const selectNext = db.prepare('SELECT 1 FROM tasks WHERE previous_task_id = ?');
  const selectHistory = db.prepare<[string, number, number, number], TaskMessage>(`
    WITH RECURSIVE history(id, previous, depth) AS (
      SELECT id, previous_task_id, 1 FROM tasks WHERE id = ?
      UNION ALL
      SELECT tasks.id, previous_task_id, history.depth + 1 FROM history JOIN tasks ON tasks.id = history.previous WHERE history.depth < ?
    )
    SELECT m.id, task_id AS taskId, role, turn, text, m.created_at AS createdAt
    FROM history JOIN task_messages m ON m.task_id = history.id
    ORDER BY history.depth DESC, m.rowid LIMIT ? OFFSET ?`);
  const selectByRequest = db.prepare<[string], EventRow>(`SELECT ${eventColumns} FROM task_events WHERE request_id = ?`);
  const selectUsage = db.prepare<[string, string, string, number], UsagePage['rows'][number] & { channel: string }>(`
    WITH turns AS (
      SELECT coalesce(payload ->> '$.provider', 'anthropic') AS provider, payload ->> '$.model' AS model,
        coalesce(payload ->> '$.channel', '') AS channel, payload
      FROM task_events WHERE type = 'assistant_turn'
    )
    SELECT provider, model, channel, count(*) AS turns,
      sum(payload ->> '$.usage.inputTokens') AS inputTokens, sum(payload ->> '$.usage.outputTokens') AS outputTokens,
      sum(payload ->> '$.usage.cacheReadTokens') AS cacheReadTokens, sum(payload ->> '$.usage.cacheWriteTokens') AS cacheWriteTokens
    FROM turns WHERE (provider, model, channel) > (?, ?, ?) GROUP BY provider, model, channel ORDER BY provider, model, channel LIMIT ?`);
  const selectPage = db.prepare<[string, number, number], EventRow>(`SELECT ${eventColumns} FROM task_events
    WHERE task_id = ? AND seq > ? ORDER BY seq LIMIT ?`);
  const insertEvent = db.prepare(`INSERT INTO task_events(task_id, seq, event_id, type, request_id, occurred_at, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const updateTask = db.prepare('UPDATE tasks SET state = ?, last_seq = ?, updated_at = ? WHERE id = ?');
  const selectPlan = db.prepare<[string], { plan: string }>('SELECT plan FROM task_plans WHERE task_id = ?');
  const writePlan = db.prepare(`INSERT INTO task_plans(task_id, plan) VALUES (?, ?)
    ON CONFLICT(task_id) DO UPDATE SET plan = excluded.plan`);
  const selectPlanCall = db.prepare<[string, number, string], { input: string; plan: string }>(
    'SELECT input, plan FROM task_plan_calls WHERE task_id = ? AND turn = ? AND call_id = ?');
  const insertPlanCall = db.prepare('INSERT INTO task_plan_calls(task_id, turn, call_id, input, plan) VALUES (?, ?, ?, ?, ?)');

  // Stored JSON is re-validated on every read; a row that no longer matches the contract fails closed.
  const toEvent = (row: EventRow): TaskEvent => TaskEventSchema.parse({ eventId: row.eventId, taskId: row.taskId, seq: row.seq,
    occurredAt: row.occurredAt, requestId: row.requestId, type: row.type, payload: JSON.parse(row.payload) });
  const view = ({ sessionId, previousTaskId, checkpoint, ...row }: TaskRow): TaskSnapshot => TaskSnapshotSchema.parse({
    ...row, ...(sessionId && { sessionId }), ...(previousTaskId && { previousTaskId }), ...(checkpoint && { resumable: true }),
  });
  const task = (id: string): TaskSnapshot | null => {
    const row = selectTask.get(id);
    if (!row) return null;
    const stored = selectPlan.get(id);
    return { ...view(row), ...(stored && { plan: TaskPlanSchema.parse(JSON.parse(stored.plan)) }) };
  };
  const existing = (id: string): TaskSnapshot => { const found = task(id); if (!found) throw new Error('NOT_FOUND'); return found; };

  /**
   * A repeated request id returns the committed result only if every recorded field of the operation is identical
   * (task, type and the complete normalized payload); any difference is REQUEST_CONFLICT, never a silent replay.
   */
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
    listUsage({ after }) {
      const rows = selectUsage.all(after?.provider ?? '', after?.model ?? '', after?.channel ?? '', USAGE_PAGE_SIZE + 1)
        .map(({ channel, ...row }) => channel ? { ...row, channel } : row);
      return UsagePageSchema.parse({ rows: rows.slice(0, USAGE_PAGE_SIZE), hasMore: rows.length > USAGE_PAGE_SIZE });
    },
    createTask(projectId, requestId, continuation, seed) {
      return db.transaction(() => {
        const previousTaskId = continuation?.previousTaskId;
        const repeated = replay(requestId, event => event.type === 'task_created' && event.payload.projectId === projectId
          && event.payload.previousTaskId === previousTaskId);
        if (repeated) return repeated;
        if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) throw new Error('NOT_FOUND');
        const previous = previousTaskId ? existing(previousTaskId) : null;
        if (previous && previous.projectId !== projectId) throw new Error('NOT_FOUND');
        if (previousTaskId && selectNext.get(previousTaskId)) throw new Error('SESSION_ALREADY_CONTINUED');
        if (previous && previous.state !== (continuation?.resume ? 'INTERRUPTED' : 'COMPLETED')) throw new Error('SESSION_CONTEXT_UNAVAILABLE');
        const now = new Date().toISOString();
        const event = TaskEventSchema.parse({ eventId: randomUUID(), taskId: randomUUID(), seq: 1, occurredAt: now, requestId,
          type: 'task_created', payload: { projectId, ...(previousTaskId && { previousTaskId }) } });
        db.prepare(`INSERT INTO tasks(id, project_id, state, last_seq, created_at, updated_at, session_id, previous_task_id)
          VALUES (?, ?, 'CREATED', 1, ?, ?, ?, ?)`)
          .run(event.taskId, projectId, now, now, previous?.sessionId ?? previousTaskId ?? null, previousTaskId ?? null);
        if (seed) writeCheckpoint.run(event.taskId, JSON.stringify(TaskCheckpointSchema.parse(seed)));
        if (continuation?.resume && previous?.plan) writePlan.run(event.taskId, JSON.stringify(previous.plan));
        insertEvent.run(event.taskId, 1, event.eventId, event.type, requestId, now, JSON.stringify(event.payload));
        return { task: existing(event.taskId), event };
      }).immediate();
    },
    transitionTask(taskId, to, input) {
      const target = TaskStateSchema.parse(to);
      // `from` is derived at commit time and the confirmations are preconditions, so neither is part of the identity.
      return db.transaction(() => replay(input.requestId, event => event.taskId === taskId && event.type === 'task_state_changed' &&
        event.payload.to === target && event.payload.sideEffects === (input.sideEffects ?? null) && event.payload.reason === (input.reason ?? null))
        ?? change(existing(taskId), target, input, input.requestId)).immediate();
    },
    recordToolSummary(input, requestId) {
      const summary = ToolOutputSummarySchema.parse(input);
      return db.transaction(() => {
        const repeated = replay(requestId, event => event.type === 'tool_output_summary' && event.taskId === summary.taskId &&
          canonical(event.payload) === canonical(summary));
        if (repeated) return repeated;
        const current = existing(summary.taskId);
        if (TERMINAL_TASK_STATES.includes(current.state)) throw new Error('TASK_TERMINAL');
        return append(current, { type: 'tool_output_summary', payload: summary }, requestId, current.state);
      }).immediate();
    },
    appendAgentEvent(taskId, type, payload, checkpoint) {
      if (!(AGENT_EVENT_TYPES as readonly string[]).includes(type)) throw new Error('VALIDATION_ERROR');
      return db.transaction(() => {
        const current = existing(taskId);
        if (TERMINAL_TASK_STATES.includes(current.state)) throw new Error('TASK_TERMINAL');
        if (checkpoint) writeCheckpoint.run(taskId, JSON.stringify(TaskCheckpointSchema.parse(checkpoint)));
        return append(current, { type, payload } as Pick<TaskEvent, 'type' | 'payload'>, null, current.state);
      }).immediate();
    },
    updateTaskPlan(taskId, callId, turn, input) {
      const value = UpdatePlanInputSchema.parse(input);
      ToolCallViewSchema.shape.id.parse(callId);
      TaskPlanSchema.shape.turn.parse(turn);
      const normalized = canonical(value);
      return db.transaction(() => {
        // Scope to the turn: providers may reuse a call id in later model turns. Replay precedes state checks.
        const repeated = selectPlanCall.get(taskId, turn, callId);
        if (repeated) {
          if (repeated.input !== normalized) throw new Error('REQUEST_CONFLICT');
          return { plan: TaskPlanSchema.parse(JSON.parse(repeated.plan)), changed: false };
        }
        const current = existing(taskId);
        if (TERMINAL_TASK_STATES.includes(current.state)) throw new Error('TASK_TERMINAL');
        if (current.state !== 'RUNNING') throw new Error('INVALID_TRANSITION');
        const changed = !current.plan || canonical({ steps: current.plan.steps }) !== normalized;
        const plan = changed ? TaskPlanSchema.parse({ ...value, revision: (current.plan?.revision ?? 0) + 1, turn }) : current.plan!;
        const serialized = JSON.stringify(plan);
        if (changed) {
          writePlan.run(taskId, serialized);
          append(current, { type: 'plan_updated', payload: { callId, plan } }, null, current.state);
        }
        // Even a no-op needs an identity and its original result for conflict checks and historical replay.
        insertPlanCall.run(taskId, turn, callId, normalized, serialized);
        return { plan, changed };
      }).immediate();
    },
    addTaskMessage(taskId, role, turn, text) {
      const message = TaskMessageSchema.parse({ id: randomUUID(), taskId, role, turn, text, createdAt: new Date().toISOString() });
      return db.transaction(() => {
        const current = existing(taskId);
        if (TERMINAL_TASK_STATES.includes(current.state)) throw new Error('TASK_TERMINAL');
        const stored = (db.prepare('SELECT count(*) AS total FROM task_messages WHERE task_id = ?').get(taskId) as { total: number }).total;
        if (stored >= TASK_MESSAGE_LIMITS.maxMessages) throw new Error('LIMIT_EXCEEDED');
        db.prepare('INSERT INTO task_messages(id, task_id, role, turn, text, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(message.id, message.taskId, message.role, message.turn, message.text, message.createdAt);
        return message;
      }).immediate();
    },
    listTaskMessages(taskId) {
      existing(taskId);
      return db.prepare<[string, number], TaskMessage>(`SELECT id, task_id AS taskId, role, turn, text, created_at AS createdAt FROM task_messages
        WHERE task_id = ? ORDER BY created_at, rowid LIMIT ?`).all(taskId, TASK_MESSAGE_LIMITS.maxMessages)
        .flatMap(row => { const parsed = TaskMessageSchema.safeParse(row); return parsed.success ? [parsed.data] : []; });
    },
    pageSessionMessages(taskId, after) {
      const size = 8;
      const rows = selectHistory.all(taskId, CHECKPOINT_LIMITS.visibleRuns, size + 1, after);
      return { messages: rows.slice(0, size).map(row => TaskMessageSchema.parse(row)), hasMore: rows.length > size };
    },
    getCheckpoint(taskId) {
      const row = selectCheckpoint.get(taskId);
      return row ? TaskCheckpointSchema.parse(JSON.parse(row.checkpoint)) : null;
    },
    hasContinuation: taskId => Boolean(selectNext.get(taskId)),
    getTask: task,
    taskForRequest(requestId) {
      const row = db.prepare<[string], { taskId: string }>(`SELECT task_id AS taskId FROM task_events WHERE request_id = ? AND type = 'task_created'`).get(requestId);
      return row ? task(row.taskId) : null;
    },
    listTasks(limit) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('VALIDATION_ERROR');
      return selectRecent.all(limit).map(view);
    },
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
