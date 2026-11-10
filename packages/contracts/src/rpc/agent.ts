import { z } from 'zod';
import { AGENT_RUN_LIMITS, AgentToolNameSchema, ToolCallViewSchema, TurnOutcomeSchema } from '../agent/turn.js';

// M2 agent RPC (ARCHITECTURE §6.1, ADR-WIN-001 §4). Open only on a session whose handshake negotiated the `agent`
// capability; the P1 fixture never negotiates it. Each method is fixed to one direction by its role:
//   Express → Worker: agent.run (start the loop for a task), agent.cancel
//   Worker → Express: model.turn (run the next model turn), tool.call (execute one tool call the model made),
//                     agent.finish (report the loop's outcome)
// The Worker sends no conversation content: Express holds it, executes tools from its own record of the model's calls,
// and returns only normalized views and short summaries.

export const AGENT_CAPABILITY = 'agent' as const;
export const AGENT_RPC_METHODS = Object.freeze(['agent.run', 'agent.cancel', 'model.turn', 'tool.call', 'agent.finish'] as const);
export type AgentRpcMethod = typeof AGENT_RPC_METHODS[number];

/** Deadlines per method. A model turn may stream for minutes (plus provider retries); everything else is short. */
export const RPC_METHOD_DEADLINES_MS: Readonly<Partial<Record<AgentRpcMethod, number>>> = Object.freeze({
  'model.turn': AGENT_RUN_LIMITS.turnTimeoutMs + 60_000,
  'tool.call': 90_000,
  'agent.finish': 30_000,
});

const taskId = z.uuid();
export const AgentFinishOutcomeSchema = z.enum(['completed', 'failed', 'stopped']);
export const AgentFinishReasonSchema = z.enum(['end_turn', 'max_tokens', 'refusal', 'context_exhausted', 'turn_limit', 'model_failed',
  'cancelled', 'protocol_error', 'other']);
export type AgentFinishOutcome = z.infer<typeof AgentFinishOutcomeSchema>;
export type AgentFinishReason = z.infer<typeof AgentFinishReasonSchema>;

export const AgentRunParamsSchema = z.strictObject({
  taskId,
  /** The tools this task may use; the Worker never calls others, and Express re-checks every call against this set. */
  tools: z.array(AgentToolNameSchema).min(1).max(AgentToolNameSchema.options.length)
    .refine(tools => new Set(tools).size === tools.length, 'DUPLICATE_TOOL'),
  maxTurns: z.number().int().min(1).max(AGENT_RUN_LIMITS.maxTurns),
});
export const AgentCancelParamsSchema = z.strictObject({ taskId });
export const ModelTurnParamsSchema = z.strictObject({ taskId, turn: z.number().int().min(1).max(AGENT_RUN_LIMITS.maxTurns) });
export const ToolCallParamsSchema = z.strictObject({ taskId, turn: z.number().int().min(1).max(AGENT_RUN_LIMITS.maxTurns),
  toolCallId: ToolCallViewSchema.shape.id });
export const AgentFinishParamsSchema = z.strictObject({ taskId, outcome: AgentFinishOutcomeSchema, reason: AgentFinishReasonSchema });

/** What a Worker learns about one tool call: whether it ran and a short human summary, never the content. */
export const ToolCallStatusSchema = z.enum(['ok', 'refused', 'failed', 'skipped']);
export type ToolCallStatus = z.infer<typeof ToolCallStatusSchema>;

export const AGENT_RESULTS = [
  z.strictObject({ kind: z.literal('agent.run'), accepted: z.literal(true) }),
  z.strictObject({ kind: z.literal('agent.cancel'), cancelled: z.boolean() }),
  z.strictObject({ kind: z.literal('model.turn'), outcome: TurnOutcomeSchema }),
  z.strictObject({ kind: z.literal('tool.call'), status: ToolCallStatusSchema, summary: z.string().min(1).max(256) }),
  z.strictObject({ kind: z.literal('agent.finish'), accepted: z.boolean() }),
] as const;
