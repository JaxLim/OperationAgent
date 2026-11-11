import { z } from 'zod';
import type { ClaudeModel } from '../api/model.js';

// Context management and turn metrics (ADR-PLAT-001 D1/D2).
//
// The conversation Express holds is append-only: the provider binds every thinking block, and its prompt cache, to the
// exact conversation prefix that produced them, so nothing already sent is ever edited, reordered or removed. Keeping a
// long task inside the context window is therefore left to the provider's own server-side summarization, which does
// not count as an edit of the conversation. This file fixes the policy; the Model Gateway turns it into the request.
// Nothing a Worker, a model or a tool sends can change it.

export interface ContextPolicy {
  /** Ask the provider to summarize the conversation once the prompt reaches this many input tokens. */
  readonly compactAtInputTokens: number;
}

/**
 * One policy per model. All three models have a 1M-token window; the threshold sits far below it because every turn
 * re-reads the whole prompt, so a smaller prompt is cheaper and faster on every turn that follows.
 *
 * Summarization is the only edit requested. Clearing old tool results instead was modelled (`pnpm bench:agent`, the
 * cost model in docs/benchmarks) and rejected for now: to never clear a result the model has not seen yet, a full
 * round of tool calls must be kept, and each clearing then rewrites that whole tail of the prompt cache. Under the
 * provider's published prices that was never cheaper than summarizing and, for tasks that read a lot, cost more than
 * leaving the context alone.
 *
 * Haiku 5.5 is priced five times higher for prompts above 100K tokens, so it is summarized before that step.
 */
export const CONTEXT_POLICIES: Readonly<Record<ClaudeModel, ContextPolicy>> = Object.freeze({
  'claude-opus-5-5': Object.freeze({ compactAtInputTokens: 300_000 }),
  'claude-sonnet-5-5': Object.freeze({ compactAtInputTokens: 300_000 }),
  'claude-haiku-5-5': Object.freeze({ compactAtInputTokens: 80_000 }),
});

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const milliseconds = z.number().int().nonnegative().max(86_400_000);

/** How long a model turn took as Express saw it. `ttftMs` is null when the turn produced no content block. */
export const TurnTimingSchema = z.strictObject({ ttftMs: milliseconds.nullable(), durationMs: milliseconds });
export type TurnTiming = z.infer<typeof TurnTimingSchema>;

/** The context of one turn. Counts and flags only; never any conversation content. */
export const TurnContextSchema = z.strictObject({
  /** The prompt the model saw on this turn, in tokens (uncached, cache-read and cache-written input together). */
  promptTokens: count,
  /** False once context management has been switched off for the task (the provider rejected a managed request). */
  managed: z.boolean(),
  /** The provider summarized the earlier conversation on this turn. */
  compacted: z.boolean(),
});
export type TurnContext = z.infer<typeof TurnContextSchema>;
