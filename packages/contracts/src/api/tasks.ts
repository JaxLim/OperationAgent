import { z } from 'zod';
import { TaskEventSchema, TaskSnapshotSchema, replayTaskEvents } from '../events/task.js';
import { utf8ByteLength } from '../events/tool-output.js';
import { AGENT_RUN_LIMITS, TurnDeltaSchema } from '../agent/turn.js';
import type { EventSequenceError, TaskEvent, TaskState } from '../events/task.js';

// ARCHITECTURE §7.3 rule 5: a client reads the committed snapshot, then pulls events after its cursor. Nothing here
// depends on process memory, so a reconnect rebuilds the same state. Read-only: no route creates or runs a task.

export const TASK_API_LIMITS = Object.freeze({
  maxTasks: 50, maxEventsPerPage: 200,
  // Serialized events per page, so a page of 16 KiB tool summaries stays far below CONTROL_POLICY.maxResponseBytes.
  maxPageBytes: 61_440,
  // 50 pages × 200 events bounds one catch-up in memory and time.
  maxCatchUpPages: 50,
});

const cursor = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const TaskRefSchema = z.strictObject({ taskId: z.uuid() });
export type TaskRef = z.infer<typeof TaskRefSchema>;
export const TaskEventsQuerySchema = z.strictObject({ taskId: z.uuid(), afterSeq: cursor,
  limit: z.number().int().min(1).max(TASK_API_LIMITS.maxEventsPerPage).optional() });
export type TaskEventsQuery = z.infer<typeof TaskEventsQuerySchema>;
export const TaskListSchema = z.strictObject({ tasks: z.array(TaskSnapshotSchema).max(TASK_API_LIMITS.maxTasks) });
export type TaskList = z.infer<typeof TaskListSchema>;

/**
 * One page of a task's log. The shape itself proves it continues the cursor without gaps, belongs to one task, and
 * makes progress whenever `hasMore` is true, so a client loop always terminates.
 */
export const TaskEventPageSchema = z.strictObject({
  taskId: z.uuid(), afterSeq: cursor, lastSeq: cursor.min(1),
  events: z.array(TaskEventSchema).max(TASK_API_LIMITS.maxEventsPerPage), hasMore: z.boolean(),
}).refine(page => page.events.every((event, index) => event.taskId === page.taskId && event.seq === page.afterSeq + index + 1), 'PAGE_DISCONTINUOUS')
  .refine(page => page.afterSeq + page.events.length <= page.lastSeq, 'PAGE_BEYOND_LOG')
  .refine(page => page.hasMore === page.afterSeq + page.events.length < page.lastSeq, 'PAGE_HAS_MORE_MISMATCH')
  .refine(page => !page.hasMore || page.events.length > 0, 'PAGE_NO_PROGRESS');
export type TaskEventPage = z.infer<typeof TaskEventPageSchema>;

export type CatchUpError = EventSequenceError | 'PAGE_INVALID' | 'TOO_MANY_PAGES';
export type CatchUpResult = { ok: true; state: TaskState | null; lastSeq: number; events: TaskEvent[] } | { ok: false; error: CatchUpError };

/**
 * Pulls every event after `afterSeq` page by page and replays it onto `state` (null before task_created). Any
 * invalid page or sequence violation stops with an error; the caller then refetches the snapshot instead of guessing.
 */
export async function catchUpTaskEvents(taskId: string, afterSeq: number, state: TaskState | null,
  fetchPage: (afterSeq: number) => Promise<unknown>, maxPages: number = TASK_API_LIMITS.maxCatchUpPages): Promise<CatchUpResult> {
  const events: TaskEvent[] = [];
  let cursorSeq = afterSeq;
  for (let pages = 0; pages < maxPages; pages++) {
    const parsed = TaskEventPageSchema.safeParse(await fetchPage(cursorSeq));
    if (!parsed.success || parsed.data.taskId !== taskId || parsed.data.afterSeq !== cursorSeq) return { ok: false, error: 'PAGE_INVALID' };
    const replayed = replayTaskEvents(taskId, cursorSeq, state, parsed.data.events);
    if (!replayed.ok) return { ok: false, error: replayed.error };
    events.push(...parsed.data.events);
    state = replayed.state; cursorSeq = replayed.lastSeq;
    if (!parsed.data.hasMore) return { ok: true, state, lastSeq: cursorSeq, events };
  }
  return { ok: false, error: 'TOO_MANY_PAGES' };
}

// M2 conversation text (migration 009): the prompt a person wrote and the model's answer per turn. Never tool results.
export const TASK_MESSAGE_LIMITS = Object.freeze({ maxTextBytes: 524_288, maxMessages: 2 * 40 + 2 });
export const TaskMessageSchema = z.strictObject({
  id: z.uuid(), taskId: z.uuid(), role: z.enum(['user', 'assistant']),
  /** 0 for the prompt; the model turn number for an answer. */
  turn: z.number().int().min(0).max(1_000),
  text: z.string().refine(value => utf8ByteLength(value) <= TASK_MESSAGE_LIMITS.maxTextBytes, 'MESSAGE_TOO_LARGE'),
  createdAt: z.iso.datetime(),
});
export type TaskMessage = z.infer<typeof TaskMessageSchema>;
export const TaskMessageListSchema = z.strictObject({ taskId: z.uuid(), messages: z.array(TaskMessageSchema).max(TASK_MESSAGE_LIMITS.maxMessages) });
export type TaskMessageList = z.infer<typeof TaskMessageListSchema>;

// Live stream deltas (transient, never persisted). A reader resumes from its cursor; if older deltas were evicted it is
// told so (`gap`) and rebuilds from the committed messages and events instead.
export const TASK_LIVE_LIMITS = Object.freeze({ maxBufferedBytes: 1_048_576, maxDeltasPerPage: 500, retainFinishedMs: 120_000 });
export const LiveDeltaSchema = z.strictObject({
  seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  turn: z.number().int().min(1).max(AGENT_RUN_LIMITS.maxTurns),
  delta: TurnDeltaSchema,
});
export type LiveDelta = z.infer<typeof LiveDeltaSchema>;
export const TaskLivePageSchema = z.strictObject({
  taskId: z.uuid(), afterSeq: z.number().int().nonnegative(), nextSeq: z.number().int().nonnegative(),
  deltas: z.array(LiveDeltaSchema).max(TASK_LIVE_LIMITS.maxDeltasPerPage),
  /** Deltas after the cursor were evicted before this read. */
  gap: z.boolean(),
  /** The task is no longer producing deltas. */
  done: z.boolean(),
}).refine(page => page.deltas.every((item, index) => item.seq > page.afterSeq && (index === 0 || item.seq > page.deltas[index - 1]!.seq)), 'PAGE_UNORDERED');
export type TaskLivePage = z.infer<typeof TaskLivePageSchema>;
