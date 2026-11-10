import type { AgentFinishOutcome, AgentFinishReason, AgentToolName, ToolCallStatus, TurnOutcome } from '@operation-agent/contracts';

// The Agent Loop (ARCHITECTURE §6.1): it lives in the isolated Worker and decides what happens next, but it owns no
// conversation content and no capability. It asks Express for each model turn, asks Express to run the tool calls the
// model made (only those the task allows), and reports how the loop ended. Express re-checks everything it is asked.

export interface AgentPort {
  modelTurn(taskId: string, turn: number): Promise<TurnOutcome>;
  toolCall(taskId: string, turn: number, toolCallId: string): Promise<{ status: ToolCallStatus; summary: string }>;
  finish(taskId: string, outcome: AgentFinishOutcome, reason: AgentFinishReason): Promise<void>;
}
export interface AgentTask {
  readonly taskId: string;
  readonly tools: readonly AgentToolName[];
  readonly maxTurns: number;
  /** Set by agent.cancel; checked between every step. */
  cancelled(): boolean;
}
export interface AgentResult { outcome: AgentFinishOutcome; reason: AgentFinishReason; turns: number }

/** Tool calls of one turn run in small parallel batches (the Read Adapter itself admits four at a time). */
export const TOOL_BATCH = 4;

export async function runAgentLoop(task: AgentTask, port: AgentPort): Promise<AgentResult> {
  let turns = 0;
  const end = async (outcome: AgentFinishOutcome, reason: AgentFinishReason): Promise<AgentResult> => {
    await port.finish(task.taskId, outcome, reason);
    return { outcome, reason, turns };
  };
  const stopped = (): Promise<AgentResult> => end('stopped', 'cancelled');
  try {
    for (let turn = 1; turn <= task.maxTurns; turn++) {
      if (task.cancelled()) return await stopped();
      const result = await port.modelTurn(task.taskId, turn);
      turns = turn;
      if (task.cancelled()) return await stopped();
      if (result.status === 'failed') return await (result.code === 'cancelled' ? stopped() : end('failed', 'model_failed'));
      const view = result.view;
      switch (view.stopReason) {
        case 'end_turn': case 'stop_sequence': return await end('completed', 'end_turn');
        case 'refusal': return await end('failed', 'refusal');
        case 'context_exhausted': return await end('failed', 'context_exhausted');
        // The provider paused a long turn; asking for the next turn resumes it.
        case 'pause_turn': continue;
        case 'max_tokens':
          // A truncated text answer is still an answer. Truncated tool calls are never run: Express answers them with
          // an error result, and the next turn lets the model retry.
          if (!view.toolCalls.length) return await end('completed', 'max_tokens');
          continue;
        case 'tool_use': {
          const allowed = view.toolCalls.filter(call => (task.tools as readonly string[]).includes(call.name));
          for (let index = 0; index < allowed.length; index += TOOL_BATCH) {
            if (task.cancelled()) return await stopped();
            await Promise.all(allowed.slice(index, index + TOOL_BATCH).map(call => port.toolCall(task.taskId, turn, call.id)));
          }
          continue;
        }
        default: return await end('failed', 'other');
      }
    }
    return await end('failed', 'turn_limit');
  } catch {
    // A broken channel or a reply that fails its contract ends the loop; Express decides what that means for the task.
    try { return await end('failed', 'protocol_error'); } catch { return { outcome: 'failed', reason: 'protocol_error', turns }; }
  }
}
