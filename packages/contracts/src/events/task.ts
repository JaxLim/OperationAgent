import { z } from 'zod';
import { ToolOutputSummarySchema } from './tool-output.js';

// ARCHITECTURE §7.2/§7.3/§8.1. Express is the only writer: it checks a transition here, then commits the
// state and its event in one transaction before anything is broadcast. Contracts hold no I/O.

export const TaskStateSchema = z.enum(['CREATED', 'QUEUED', 'RUNNING', 'WAITING_APPROVAL', 'COMPLETED', 'FAILED',
  'STOPPING', 'STOPPED', 'INTERRUPTED']);
export type TaskState = z.infer<typeof TaskStateSchema>;
/** Recorded apart from the task state: STOPPED is never rewritten to FAILED, and UNKNOWN never means "no effect". */
export const SideEffectStatusSchema = z.enum(['VERIFIED', 'PARTIAL_CHANGES', 'UNKNOWN']);
export type SideEffectStatus = z.infer<typeof SideEffectStatusSchema>;

// §8.1 diagram, plus the edges §8.2–8.4 require: a user stop and a service loss can happen before RUNNING,
// a pending approval can be stopped or interrupted, and a stop whose cleanup is lost becomes INTERRUPTED.
export const TASK_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = Object.freeze({
  CREATED: Object.freeze(['QUEUED', 'STOPPING', 'INTERRUPTED'] as const),
  QUEUED: Object.freeze(['RUNNING', 'FAILED', 'STOPPING', 'INTERRUPTED'] as const),
  RUNNING: Object.freeze(['WAITING_APPROVAL', 'COMPLETED', 'FAILED', 'STOPPING', 'INTERRUPTED'] as const),
  WAITING_APPROVAL: Object.freeze(['RUNNING', 'STOPPING', 'INTERRUPTED'] as const),
  STOPPING: Object.freeze(['STOPPED', 'INTERRUPTED'] as const),
  INTERRUPTED: Object.freeze(['QUEUED', 'RUNNING'] as const),
  COMPLETED: Object.freeze([] as const),
  FAILED: Object.freeze([] as const),
  STOPPED: Object.freeze([] as const),
});
export const TERMINAL_TASK_STATES: readonly TaskState[] = Object.freeze(['COMPLETED', 'FAILED', 'STOPPED'] as const);

/** Facts only Express can establish; never taken from a Worker or the Renderer. */
export interface TransitionContext { readonly userConfirmed?: boolean; readonly cleanupConfirmed?: boolean }
export type TransitionCheck = { allowed: true } | { allowed: false; reason: 'INVALID_TRANSITION' | 'USER_CONFIRMATION_REQUIRED' | 'CLEANUP_UNCONFIRMED' };

export function checkTaskTransition(from: TaskState, to: TaskState, context: TransitionContext = {}): TransitionCheck {
  if (!TASK_TRANSITIONS[from].includes(to)) return { allowed: false, reason: 'INVALID_TRANSITION' };
  // ADR-005: an interrupted task resumes only on an explicit user choice after verification.
  if (from === 'INTERRUPTED' && context.userConfirmed !== true) return { allowed: false, reason: 'USER_CONFIRMATION_REQUIRED' };
  // ADR-009: STOPPED is shown only after the process tree is confirmed gone.
  if (to === 'STOPPED' && context.cleanupConfirmed !== true) return { allowed: false, reason: 'CLEANUP_UNCONFIRMED' };
  return { allowed: true };
}

export const TASK_EVENT_LIMITS = Object.freeze({ maxReasonChars: 256 });
const eventBase = {
  eventId: z.uuid(), taskId: z.uuid(),
  // Per-task, gap-free and starting at 1, so a client can resume from the last seq it applied.
  seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  occurredAt: z.iso.datetime(),
  requestId: z.uuid().nullable(),
};
export const TaskCreatedEventSchema = z.strictObject({ ...eventBase, type: z.literal('task_created'),
  payload: z.strictObject({ projectId: z.uuid() }) });
export const TaskStateChangedEventSchema = z.strictObject({ ...eventBase, type: z.literal('task_state_changed'),
  payload: z.strictObject({ from: TaskStateSchema, to: TaskStateSchema, sideEffects: SideEffectStatusSchema.nullable(),
    // Redacted, user-safe text; never raw tool output or provider errors.
    reason: z.string().min(1).max(TASK_EVENT_LIMITS.maxReasonChars).nullable() }) })
  .refine(event => TASK_TRANSITIONS[event.payload.from].includes(event.payload.to), 'INVALID_TRANSITION');
export const TaskToolSummaryEventSchema = z.strictObject({ ...eventBase, type: z.literal('tool_output_summary'),
  payload: ToolOutputSummarySchema }).refine(event => event.payload.taskId === event.taskId, 'TASK_MISMATCH');
export const TaskEventSchema = z.union([TaskCreatedEventSchema, TaskStateChangedEventSchema, TaskToolSummaryEventSchema]);
export type TaskEvent = z.infer<typeof TaskEventSchema>;

export type EventSequenceError = 'TASK_MISMATCH' | 'SEQUENCE_GAP' | 'DUPLICATE_EVENT' | 'CREATED_NOT_FIRST' | 'STATE_DISCONTINUITY';

/**
 * Checks a page of already-validated events continues a task's log after `afterSeq` with the given current
 * state (null before task_created). Returns the resulting state, or the first violation; never repairs.
 */
export function replayTaskEvents(taskId: string, afterSeq: number, state: TaskState | null, events: readonly TaskEvent[]):
  { ok: true; state: TaskState | null; lastSeq: number } | { ok: false; error: EventSequenceError; seq: number } {
  const seen = new Set<string>();
  let lastSeq = afterSeq;
  for (const event of events) {
    if (event.taskId !== taskId) return { ok: false, error: 'TASK_MISMATCH', seq: event.seq };
    if (seen.has(event.eventId)) return { ok: false, error: 'DUPLICATE_EVENT', seq: event.seq };
    if (event.seq !== lastSeq + 1) return { ok: false, error: 'SEQUENCE_GAP', seq: event.seq };
    seen.add(event.eventId);
    lastSeq = event.seq;
    if (event.type === 'task_created') {
      if (event.seq !== 1 || state !== null) return { ok: false, error: 'CREATED_NOT_FIRST', seq: event.seq };
      state = 'CREATED';
    } else if (state === null) {
      return { ok: false, error: 'CREATED_NOT_FIRST', seq: event.seq };
    } else if (event.type === 'task_state_changed') {
      if (event.payload.from !== state) return { ok: false, error: 'STATE_DISCONTINUITY', seq: event.seq };
      state = event.payload.to;
    }
  }
  return { ok: true, state, lastSeq };
}

/** Express's committed view of one task; `lastSeq` is the cursor a client resumes events from. */
export const TaskSnapshotSchema = z.strictObject({ id: z.uuid(), projectId: z.uuid(), state: TaskStateSchema,
  lastSeq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime() });
export type TaskSnapshot = z.infer<typeof TaskSnapshotSchema>;
