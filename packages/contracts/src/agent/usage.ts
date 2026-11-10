import type { TaskEvent } from '../events/task.js';

// What a task cost and how fast it ran, derived from its committed events (ADR-PLAT-001 D2). A pure function of the log:
// Express, the Renderer and the benchmark all compute the same numbers from the same events, and nothing new is stored.

export interface TaskUsageSummary {
  /** Model turns and tool calls recorded so far. */
  readonly turns: number;
  readonly toolCalls: number;
  /** Billed tokens, summed over turns. `inputTokens` is the uncached part of the prompts. */
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
  /**
   * All billed input tokens: uncached, cache-read and cache-written together. This is the prompts of every turn plus
   * the input of any summarization the provider ran, so it is a cost figure; `peakPromptTokens` is the context size.
   */
  readonly totalInputTokens: number;
  /** The share of `totalInputTokens` served from the provider's cache (0 to 1); null before any input token. */
  readonly cacheHitRatio: number | null;
  /** The largest prompt of any single turn; null when no turn recorded it. */
  readonly peakPromptTokens: number | null;
  /** Time spent in model turns, over the turns that recorded it (turns never overlap). */
  readonly modelMs: number;
  /**
   * Elapsed time during which at least one tool call was running, over the calls that recorded their duration. The
   * calls of one turn run in parallel, so this is the length of the union of their intervals, not the sum.
   */
  readonly toolMs: number;
  /** Median time to the first content of a turn; null when no turn recorded it. */
  readonly medianTtftMs: number | null;
  /** How many times the provider summarized the conversation. */
  readonly compactions: number;
  /** False once any turn ran with context management switched off; null when no turn recorded it. */
  readonly contextManaged: boolean | null;
}

export function summarizeTaskUsage(events: readonly TaskEvent[]): TaskUsageSummary {
  let turns = 0, toolCalls = 0, inputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0, outputTokens = 0;
  let modelMs = 0, compactions = 0;
  const toolIntervals: [number, number][] = [];
  let peakPromptTokens: number | null = null, contextManaged: boolean | null = null;
  const ttfts: number[] = [];
  for (const event of events) {
    if (event.type === 'assistant_turn') {
      const { usage, timing, context } = event.payload;
      turns++;
      inputTokens += usage.inputTokens; cacheReadTokens += usage.cacheReadTokens;
      cacheWriteTokens += usage.cacheWriteTokens; outputTokens += usage.outputTokens;
      if (timing) { modelMs += timing.durationMs; if (timing.ttftMs !== null) ttfts.push(timing.ttftMs); }
      if (context) {
        peakPromptTokens = Math.max(peakPromptTokens ?? 0, context.promptTokens);
        if (context.compacted) compactions++;
        contextManaged = (contextManaged ?? true) && context.managed;
      }
    } else if (event.type === 'tool_call') {
      toolCalls++;
      // The event is committed when the call ends, so the call ran from (end - duration) to end.
      const end = Date.parse(event.occurredAt), duration = event.payload.durationMs;
      if (duration !== undefined && Number.isFinite(end)) toolIntervals.push([end - duration, end]);
    }
  }
  const totalInputTokens = inputTokens + cacheReadTokens + cacheWriteTokens;
  toolIntervals.sort((a, b) => a[0] - b[0]);
  let toolMs = 0, coveredUntil = -Infinity;
  for (const [start, end] of toolIntervals) {
    if (end <= coveredUntil) continue;
    toolMs += end - Math.max(start, coveredUntil);
    coveredUntil = end;
  }
  ttfts.sort((a, b) => a - b);
  const middle = ttfts.length >> 1;
  const medianTtftMs = !ttfts.length ? null : ttfts.length % 2 ? ttfts[middle]! : Math.round((ttfts[middle - 1]! + ttfts[middle]!) / 2);
  return { turns, toolCalls, inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens, totalInputTokens,
    cacheHitRatio: totalInputTokens ? cacheReadTokens / totalInputTokens : null, peakPromptTokens, modelMs, toolMs, medianTtftMs,
    compactions, contextManaged };
}
