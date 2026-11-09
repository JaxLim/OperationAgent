import Anthropic from '@anthropic-ai/sdk';
import type { BetaContentBlock, BetaMessage, BetaMessageParam, BetaRawMessageStreamEvent, BetaTool } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { AGENT_RUN_LIMITS, AGENT_TOOL_DEFINITIONS, ANTHROPIC_ENDPOINT, ModelEndpointSchema, TurnViewSchema } from '@operation-agent/contracts';
import type { AgentToolName, ClaudeModel, TurnDelta, TurnFailureCode, TurnStopReason, TurnView } from '@operation-agent/contracts';

// Model Gateway, streaming turns (ARCHITECTURE §6.2). The only module that talks to the model provider during a task.
// It uses the official Anthropic SDK, but never through ambient configuration: the key, endpoint, logging, telemetry
// and transport are all explicit, and a guarded fetch only ever reaches the fixed origin, refuses redirects and sends
// an allowlist of headers, so an injected base URL or custom header cannot redirect or annotate the key-bearing request.
// Provider bodies, headers and error text never leave this module: callers get the verbatim assistant content (for the
// Express-held conversation) and a normalized view (for the Worker), or a fixed failure code.

/** Server-side refusal fallback (`fallbacks: "default"`) exists for these models only; Haiku 5.5 has none. */
const FALLBACK_MODELS: readonly ClaudeModel[] = ['claude-opus-5-5', 'claude-sonnet-5-5'];
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
/** The Messages API version this gateway is written and tested against (the version SDK 1.3.0 sends). */
export const ANTHROPIC_API_VERSION = '2026-10-21';
// Headers that carry no authority. Credential, version and beta headers are never forwarded from the SDK: the guard
// sets them itself, because SDK defaults can be overridden by ambient configuration (ANTHROPIC_CUSTOM_HEADERS).
const FORWARDED_HEADERS = new Set(['accept', 'content-type', 'user-agent', 'idempotency-key']);
const DELTA_CHUNK = 16_384;

export interface TurnInput {
  apiKey: string;
  model: ClaudeModel;
  turn: number;
  system: string;
  messages: BetaMessageParam[];
  tools: readonly AgentToolName[];
  signal?: AbortSignal;
  onDelta?: (delta: TurnDelta) => void;
}
export type TurnResult =
  | { status: 'ok'; message: BetaMessage; replay: BetaContentBlock[]; view: TurnView }
  | { status: 'failed'; code: TurnFailureCode; retryable: boolean; httpStatus: number | null };

export interface TurnGateway { runTurn(input: TurnInput): Promise<TurnResult> }
export interface TurnGatewayOptions {
  endpoint?: string | undefined;
  maxRetries?: number;
  timeoutMs?: number;
  /** Tests observe what leaves the gateway; production always uses the platform fetch through the guard. */
  fetch?: typeof fetch;
}

export interface GuardCredential { apiKey: string; betas: readonly string[] }

/**
 * Only the fixed origin and the Messages path; no redirects; an allowlist of inert headers; and the credential, API
 * version and beta headers set here from this turn's own values, whatever the SDK or its environment supplied.
 */
export function guardedFetch(endpoint: string, credential: GuardCredential, base: typeof fetch = fetch): typeof fetch {
  const origin = new URL(endpoint).origin;
  return async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== origin || !/^\/v1\/messages(\?.*)?$/.test(url.pathname + url.search)) throw new TypeError('MODEL_ORIGIN_REJECTED');
    const headers = new Headers();
    for (const [name, value] of new Headers(init?.headers)) {
      const lower = name.toLowerCase();
      if (FORWARDED_HEADERS.has(lower) || lower.startsWith('x-stainless-')) headers.set(lower, value);
    }
    headers.set('authorization', `Bearer ${credential.apiKey}`);
    headers.set('anthropic-version', ANTHROPIC_API_VERSION);
    if (credential.betas.length) headers.set('anthropic-beta', credential.betas.join(','));
    return base(url.href, { ...init, headers, redirect: 'error' });
  };
}

export function stopReasonOf(reason: string | null | undefined): TurnStopReason {
  switch (reason) {
    case 'end_turn': case 'tool_use': case 'max_tokens': case 'refusal': case 'pause_turn': case 'stop_sequence': return reason;
    case 'model_context_window_exceeded': return 'context_exhausted';
    default: return 'other';
  }
}

/**
 * The content to send back next turn. After a mid-output fallback, blocks before the last `fallback` marker that only
 * the declined model could use (thinking, redacted thinking, tool calls, unpaired server tool calls, unknown types) are
 * dropped; text and everything after the marker replay unchanged. Without a fallback the content replays verbatim.
 */
export function replayContent(content: readonly BetaContentBlock[]): BetaContentBlock[] {
  const boundary = content.map(block => block.type).lastIndexOf('fallback');
  if (boundary < 0) return [...content];
  const resultIds = new Set(content.flatMap(block => 'tool_use_id' in block && typeof block.tool_use_id === 'string' ? [block.tool_use_id] : []));
  return content.filter((block, index) => {
    if (index >= boundary) return true;
    if (block.type === 'text') return true;
    if (block.type === 'server_tool_use') return resultIds.has(block.id);
    return block.type.endsWith('_tool_result');
  });
}

export function failureOf(error: unknown, signal: AbortSignal | undefined): { code: TurnFailureCode; retryable: boolean; httpStatus: number | null } {
  const result = (code: TurnFailureCode, httpStatus: number | null = null): ReturnType<typeof failureOf> =>
    ({ code, retryable: ['rate_limited', 'overloaded', 'provider_error', 'unreachable', 'timed_out'].includes(code), httpStatus });
  const reason: unknown = signal?.aborted ? signal.reason : undefined;
  if (reason && typeof reason === 'object' && 'name' in reason && reason.name === 'TimeoutError') return result('timed_out');
  if (error instanceof Anthropic.APIUserAbortError || signal?.aborted) return result('cancelled');
  if (error instanceof Anthropic.APIConnectionTimeoutError) return result('timed_out');
  if (error instanceof Anthropic.APIConnectionError) return result('unreachable');
  if (error instanceof Anthropic.APIError) {
    const status = typeof error.status === 'number' ? error.status : null;
    if (status === 401) return result('auth_failed', status);
    if (status === 403) return result('permission_denied', status);
    if (status === 404) return result('model_unavailable', status);
    if (status === 413) return result('context_too_long', status);
    if (status === 429) return result('rate_limited', status);
    if (status === 529) return result('overloaded', status);
    if (status !== null && status >= 500) return result('provider_error', status);
    if (status !== null && status >= 400) return result('invalid_request', status);
    // A mid-stream SSE `error` event has no HTTP status; only its type is read, never its message.
    const type = (error.error as { error?: { type?: unknown } } | undefined)?.error?.type;
    if (type === 'overloaded_error') return result('overloaded');
    if (type === 'rate_limit_error') return result('rate_limited');
    return result('provider_error');
  }
  return result('response_invalid');
}

function viewOf(turn: number, model: ClaudeModel, message: BetaMessage, replay: readonly BetaContentBlock[]): TurnView {
  const text = replay.flatMap(block => (block.type === 'text' ? [block.text] : [])).join('');
  const toolCalls = replay.flatMap(block => (block.type === 'tool_use' ? [{ id: block.id, name: block.name,
    input: block.input && typeof block.input === 'object' && !Array.isArray(block.input) ? block.input as Record<string, unknown> : {} }] : []));
  const usage = message.usage;
  return TurnViewSchema.parse({
    turn, model, stopReason: stopReasonOf(message.stop_reason),
    text: text.slice(0, AGENT_RUN_LIMITS.maxViewTextChars), textTruncated: text.length > AGENT_RUN_LIMITS.maxViewTextChars,
    // Beyond the per-turn cap the extra calls are not shown; Express answers them with an error result.
    toolCalls: toolCalls.slice(0, AGENT_RUN_LIMITS.maxToolCallsPerTurn),
    usage: { inputTokens: usage.input_tokens ?? 0, outputTokens: usage.output_tokens ?? 0,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0, cacheWriteTokens: usage.cache_creation_input_tokens ?? 0 },
    fallback: message.content.some(block => block.type === 'fallback'),
  });
}

function emit(onDelta: TurnInput['onDelta'], kind: 'text' | 'thinking', text: string): void {
  if (!onDelta) return;
  for (let index = 0; index < text.length; index += DELTA_CHUNK) {
    try { onDelta({ kind, text: text.slice(index, index + DELTA_CHUNK) }); } catch { /* A slow or failed live view never stops the turn. */ }
  }
}

export function createTurnGateway(options: TurnGatewayOptions = {}): TurnGateway {
  const endpoint = ModelEndpointSchema.parse(options.endpoint ?? ANTHROPIC_ENDPOINT);
  const timeoutMs = options.timeoutMs ?? AGENT_RUN_LIMITS.turnTimeoutMs;
  const maxRetries = options.maxRetries ?? 2;
  const silent = { debug() {}, info() {}, warn() {}, error() {} };
  return {
    async runTurn(input) {
      const deadline = AbortSignal.timeout(timeoutMs);
      const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
      const betas = FALLBACK_MODELS.includes(input.model) ? [FALLBACK_BETA] : [];
      const transport = guardedFetch(endpoint, { apiKey: input.apiKey, betas }, options.fetch ?? fetch);
      // One client per turn: the key exists only for this request's lifetime and is never shared or cached.
      const client = new Anthropic({ apiKey: input.apiKey, baseURL: endpoint, maxRetries, timeout: timeoutMs, fetch: transport,
        logLevel: 'off', logger: silent, openTelemetry: { traces: false, propagation: false }, defaultHeaders: {} });
      // Inputs are short paths, so the provider's buffered, strict validation is kept (no eager input streaming); Express
      // still re-validates every input against the Zod contract before anything runs.
      const tools: BetaTool[] = [...new Set(input.tools)].map(name => ({ name, description: AGENT_TOOL_DEFINITIONS[name].description,
        input_schema: AGENT_TOOL_DEFINITIONS[name].input_schema as BetaTool['input_schema'], strict: true }));
      try {
        const stream = client.beta.messages.stream({
          model: input.model,
          max_tokens: AGENT_RUN_LIMITS.maxOutputTokens,
          // Stable prefix (tools, then system) first and cached; the growing conversation is cached by the top-level breakpoint.
          system: [{ type: 'text', text: input.system, cache_control: { type: 'ephemeral' } }],
          cache_control: { type: 'ephemeral' },
          messages: input.messages,
          tools,
          thinking: { type: 'adaptive', display: 'summarized' },
          ...(betas.length ? { betas, fallbacks: 'default' as const } : {}),
        }, { signal });
        stream.on('streamEvent', (event: BetaRawMessageStreamEvent) => {
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') emit(input.onDelta, 'text', event.delta.text);
          else if (event.type === 'content_block_delta' && event.delta.type === 'thinking_delta') emit(input.onDelta, 'thinking', event.delta.thinking);
          else if (event.type === 'content_block_start' && event.content_block.type === 'tool_use' && /^[A-Za-z0-9_-]{1,128}$/.test(event.content_block.id)) {
            try { input.onDelta?.({ kind: 'tool_call', id: event.content_block.id, name: event.content_block.name.slice(0, 128) || 'tool' }); } catch { /* Live view only. */ }
          }
        });
        const message = await stream.finalMessage();
        const replay = replayContent(message.content);
        return { status: 'ok', message, replay, view: viewOf(input.turn, input.model, message, replay) };
      } catch (error) {
        return { status: 'failed', ...failureOf(error, signal) };
      }
    },
  };
}
