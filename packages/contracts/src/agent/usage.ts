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
  /** All prompt tokens sent: uncached, cache-read and cache-written together. */
  readonly promptTokens: number;
  /** The share of prompt tokens served from the provider's cache (0 to 1); null before any prompt token. */
  readonly cacheHitRatio: number | null;
  /** The largest prompt of any single turn; null when no turn recorded it. */
  readonly peakPromptTokens: number | null;
  /** Wall-clock time in model turns and in tool calls, over the events that recorded it. */
  readonly modelMs: number;
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
  let modelMs = 0, toolMs = 0, compactions = 0;
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
      toolMs += event.payload.durationMs ?? 0;
    }
  }
  const promptTokens = inputTokens + cacheReadTokens + cacheWriteTokens;
  ttfts.sort((a, b) => a - b);
  const middle = ttfts.length >> 1;
  const medianTtftMs = !ttfts.length ? null : ttfts.length % 2 ? ttfts[middle]! : Math.round((ttfts[middle - 1]! + ttfts[middle]!) / 2);
  return { turns, toolCalls, inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens, promptTokens,
    cacheHitRatio: promptTokens ? cacheReadTokens / promptTokens : null, peakPromptTokens, modelMs, toolMs, medianTtftMs,
    compactions, contextManaged };
}
