import { AGENT_RUN_LIMITS, AGENT_TOOL_DEFINITIONS, PROVIDER_ENDPOINTS, RETRYABLE_TURN_FAILURES, TurnViewSchema } from '@operation-agent/contracts';
import type { LinkedProvider, TurnFailureCode, TurnStopReason } from '@operation-agent/contracts';
import { readBounded } from './providers.js';
import { sendCustomChat } from './custom-transport.js';
import type { AgentTurnResult, TurnInput } from './turns.js';

const chatPaths: Record<LinkedProvider, string> = {
  openai: '/v1/chat/completions', google: '/v1beta/openai/chat/completions', openrouter: '/api/v1/chat/completions',
};
type Input = Omit<TurnInput, 'model'> & { model: string };
type ChatMessage = Record<string, unknown>;

function requestMessages(input: Input): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: 'system', content: input.system }];
  for (const { role, content } of input.messages) {
    if (typeof content === 'string') { messages.push({ role, content }); continue; }
    for (const block of content ?? []) {
      if (role === 'assistant') {
        // The original assistant message is attached to its first normalized block for lossless tool replay.
        if ('linkedMessage' in block) messages.push(block.linkedMessage as ChatMessage);
      } else if (block.type === 'text') messages.push({ role, content: block.text });
      else if (block.type === 'tool_result') messages.push({ role: 'tool', tool_call_id: block.tool_use_id, content: block.content });
    }
  }
  return messages;
}

interface Reply {
  model?: string;
  choices: { finish_reason: string; message: {
    role: string; content: string | null; refusal?: string;
    tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[];
  } }[];
  usage: { prompt_tokens: number; completion_tokens: number; prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } };
}
const stopReasons: Record<string, TurnStopReason> = { stop: 'end_turn', tool_calls: 'tool_use', length: 'max_tokens', content_filter: 'refusal' };
function normalize(reply: Reply, input: Input, started: number): AgentTurnResult {
  const { message, finish_reason } = reply.choices[0]!;
  if (message.role !== 'assistant') throw new Error('response_invalid');
  const stopReason = message.refusal ? 'refusal' : stopReasons[finish_reason] ?? 'other';
  // An interrupted function call is neither a usable request nor a completed text-only answer.
  if (message.tool_calls?.length && stopReason !== 'tool_use') throw new Error('response_invalid');
  const text = message.content ?? message.refusal ?? '';
  const replay: Extract<AgentTurnResult, { status: 'ok' }>['replay'] = [];
  if (text) replay.push({ type: 'text', citations: null, text });
  const seen = new Set<string>();
  const toolCalls = (message.tool_calls ?? []).map(call => {
    if (call.type !== 'function' || seen.has(call.id) || !input.tools.some(name => name === call.function.name)) throw new Error('response_invalid');
    seen.add(call.id);
    const tool = { id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments) as unknown };
    replay.push({ type: 'tool_use', ...tool });
    return tool;
  });
  if (stopReason === 'tool_use' && !toolCalls.length) throw new Error('response_invalid');
  if (replay.length) Object.assign(replay[0]!, { linkedMessage: message });
  const usage = reply.usage;
  const cacheReadTokens = usage.prompt_tokens_details?.cached_tokens ?? 0;
  const cacheWriteTokens = usage.prompt_tokens_details?.cache_write_tokens ?? 0;
  const view = TurnViewSchema.parse({ turn: input.turn, model: reply.model ?? input.model, stopReason,
    text: text.slice(0, AGENT_RUN_LIMITS.maxViewTextChars), textTruncated: text.length > AGENT_RUN_LIMITS.maxViewTextChars,
    toolCalls, usage: { inputTokens: usage.prompt_tokens - cacheReadTokens - cacheWriteTokens, outputTokens: usage.completion_tokens,
      cacheReadTokens, cacheWriteTokens }, fallback: false });
  return { status: 'ok', replay, view, timing: { durationMs: Math.round(performance.now() - started), ttftMs: null },
    context: { promptTokens: usage.prompt_tokens, compacted: false } };
}

function failed(code: TurnFailureCode, httpStatus: number | null = null): AgentTurnResult {
  return { status: 'failed', code, retryable: RETRYABLE_TURN_FAILURES.includes(code), httpStatus };
}
const statusCodes: Record<number, TurnFailureCode> = { 401: 'auth_failed', 403: 'permission_denied', 404: 'model_unavailable',
  413: 'context_too_long', 429: 'rate_limited', 529: 'overloaded' };
const DEFAULT_RETRY_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 5_000;

function retryDelay(response: Response): number | null {
  if (response.status !== 429 && response.status !== 529) return null;
  const after = response.headers.get('retry-after');
  if (after === null) return DEFAULT_RETRY_DELAY_MS;
  const delay = /^\d+$/.test(after) ? Number(after) * 1_000
    : /^[a-z]{3}/i.test(after) ? Date.parse(after) - Date.now() : NaN;
  // A provider asking for a longer wait should get a failure, not an early repeat request.
  return delay <= MAX_RETRY_DELAY_MS ? Math.max(0, delay) : null;
}

function waitForRetry(delay: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delay);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export type ChatTarget = LinkedProvider | 'huggingface' | { baseUrl: string; allowLocal: boolean };
export async function runLinkedTurn(provider: ChatTarget, input: Input): Promise<AgentTurnResult> {
  const deadline = AbortSignal.timeout(AGENT_RUN_LIMITS.turnTimeoutMs);
  const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
  const started = performance.now();
  const tools = input.tools.map(name => ({ type: 'function', function: { name, description: AGENT_TOOL_DEFINITIONS[name].description,
    parameters: AGENT_TOOL_DEFINITIONS[name].input_schema } }));
  try {
    signal.throwIfAborted();
    const init: RequestInit = { method: 'POST', redirect: 'error', signal,
      headers: { authorization: 'Bearer ' + input.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ model: input.model, messages: requestMessages(input), ...(tools.length && { tools }) }) };
    const send = () => typeof provider === 'object' ? sendCustomChat(provider.baseUrl, provider.allowLocal, init) :
      fetch(provider === 'huggingface' ? 'https://router.huggingface.co/v1/chat/completions' : PROVIDER_ENDPOINTS[provider] + chatPaths[provider], init);
    let response = await send();
    const delay = retryDelay(response);
    if (delay !== null) {
      await response.body?.cancel();
      await waitForRetry(delay, signal);
      signal.throwIfAborted();
      response = await send();
    }
    if (!response.ok) {
      await response.body?.cancel();
      return failed(statusCodes[response.status] ?? (response.status >= 500 ? 'provider_error' : 'invalid_request'), response.status);
    }
    const body = await readBounded(response, AGENT_RUN_LIMITS.maxConversationBytes / 4);
    if (!body) return failed('response_invalid');
    try { return normalize(JSON.parse(body) as Reply, input, started); } catch { return failed('response_invalid'); }
  } catch {
    if (signal.aborted) return failed(signal.reason?.name === 'TimeoutError' ? 'timed_out' : 'cancelled');
    return failed('unreachable');
  }
}
