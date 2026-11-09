import type { BetaContentBlock, BetaContentBlockParam, BetaMessageParam, BetaToolResultBlockParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { AGENT_RUN_LIMITS } from '@operation-agent/contracts';
import type { TurnStopReason } from '@operation-agent/contracts';

// The authoritative transcript of one task, held by Express (ARCHITECTURE §6.1: the Worker sends logical requests and
// never conversation content). Assistant content is stored exactly as the provider returned it (after fallback replay
// filtering), because thinking blocks must be replayed unchanged and the history must stay append-only. Tool results
// are created here from what Express itself executed; every tool call of a turn gets exactly one result before the next
// turn, so the request always satisfies the provider's tool_use/tool_result pairing.

export type ConversationState = 'awaiting_model' | 'awaiting_tools' | 'closed';
export interface PendingToolCall { id: string; name: string; input: unknown; executable: boolean }

export const NOT_EXECUTED = 'This tool call was not executed.';

export class Conversation {
  private readonly messages: BetaMessageParam[];
  private pending: PendingToolCall[] = [];
  private readonly results = new Map<string, { content: string; isError: boolean }>();
  private bytes: number;
  private state: ConversationState = 'awaiting_model';
  private turns = 0;

  constructor(readonly system: string, prompt: string) {
    if (!prompt.trim() || prompt.length > AGENT_RUN_LIMITS.maxPromptChars) throw new Error('VALIDATION_ERROR');
    this.messages = [{ role: 'user', content: [{ type: 'text', text: prompt }] }];
    this.bytes = Buffer.byteLength(system) + Buffer.byteLength(JSON.stringify(this.messages));
  }

  get status(): ConversationState { return this.state; }
  get turnCount(): number { return this.turns; }
  get sizeBytes(): number { return this.bytes; }
  /** A copy for one request; the stored history is never handed out for mutation. */
  history(): BetaMessageParam[] { return structuredClone(this.messages); }

  private append(message: BetaMessageParam): void {
    const size = Buffer.byteLength(JSON.stringify(message));
    if (this.bytes + size > AGENT_RUN_LIMITS.maxConversationBytes) throw new Error('CONVERSATION_TOO_LARGE');
    this.messages.push(message); this.bytes += size;
  }

  /**
   * Records one model turn. Tool calls become pending; they may run only when the turn stopped to use tools, and only up
   * to the per-turn cap. A turn that stopped at max_tokens can carry a truncated tool input, so its calls never run.
   */
  acceptTurn(content: readonly BetaContentBlock[], stopReason: TurnStopReason): PendingToolCall[] {
    if (this.state !== 'awaiting_model') throw new Error('CONVERSATION_STATE');
    if (this.turns >= AGENT_RUN_LIMITS.maxTurns) throw new Error('TURN_LIMIT');
    this.turns++;
    // A turn with no content (a refusal before any output) is not appended: an empty assistant message is invalid.
    if (content.length) this.append({ role: 'assistant', content: content as BetaContentBlockParam[] });
    const calls = content.flatMap(block => (block.type === 'tool_use' ? [block] : []));
    this.pending = calls.map((block, index) => ({ id: block.id, name: block.name, input: block.input,
      executable: stopReason === 'tool_use' && index < AGENT_RUN_LIMITS.maxToolCallsPerTurn }));
    this.results.clear();
    this.state = this.pending.length ? 'awaiting_tools' : 'awaiting_model';
    return this.pending.map(call => ({ ...call }));
  }

  /** The pending call with this id, exactly as the model asked for it; undefined for anything else. */
  pendingCall(id: string): PendingToolCall | undefined {
    const call = this.state === 'awaiting_tools' ? this.pending.find(item => item.id === id) : undefined;
    return call ? { ...call } : undefined;
  }

  /** One result per executable pending call, recorded once. */
  recordResult(id: string, content: string, isError: boolean): void {
    const call = this.pendingCall(id);
    if (!call || !call.executable || this.results.has(id)) throw new Error('TOOL_CALL_UNKNOWN');
    this.results.set(id, { content, isError });
  }

  /** Answers every pending call (recorded results, or "not executed" errors) in one user message. */
  closeRound(): void {
    if (this.state !== 'awaiting_tools') throw new Error('CONVERSATION_STATE');
    const blocks: BetaToolResultBlockParam[] = this.pending.map(call => {
      const result = this.results.get(call.id);
      return { type: 'tool_result', tool_use_id: call.id, content: result?.content ?? NOT_EXECUTED, is_error: result?.isError ?? true };
    });
    this.append({ role: 'user', content: blocks });
    this.pending = []; this.results.clear();
    this.state = 'awaiting_model';
  }

  close(): void { this.state = 'closed'; this.pending = []; this.results.clear(); }
}
