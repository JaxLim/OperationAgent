import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from 'node:http';
import { once } from 'node:events';
import { AGENT_RUN_LIMITS, AGENT_TOOL_DEFINITIONS, ListDirectoryArgsSchema, ReadFileArgsSchema, TurnDeltaSchema, TurnOutcomeSchema,
  TurnViewSchema } from '../../packages/contracts/dist/index.js';
import type { TurnDelta } from '../../packages/contracts/dist/index.js';
import { createTurnGateway, failureOf, guardedFetch, replayContent, stopReasonOf } from '../../apps/server/dist/models/turns.js';
import { Conversation, NOT_EXECUTED } from '../../apps/server/dist/agent/conversation.js';

// M2 streaming turns against a local fake of the Messages API: real HTTP, real SSE framing, the real SDK stream parser.

const KEY = 'sk-ant-api03-' + 'k'.repeat(40) + 'LEAKPROBE';
type Recorded = { method: string; url: string; headers: IncomingHttpHeaders; body: Record<string, unknown> };
type Script = (req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>) => void | Promise<void>;

const sse = (res: ServerResponse, events: Record<string, unknown>[], end = true): void => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const event of events) res.write(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`);
  if (end) res.end();
};
const start = (model = 'claude-sonnet-5-5'): Record<string, unknown> => ({ type: 'message_start', message: { id: 'msg_test', type: 'message', role: 'assistant',
  model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 120, output_tokens: 1, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 } } });
const stop = (reason: string, output = 42): Record<string, unknown>[] => [
  { type: 'message_delta', delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: output } }, { type: 'message_stop' }];
const text = (index: number, value: string): Record<string, unknown>[] => [
  { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index, delta: { type: 'text_delta', text: value } }, { type: 'content_block_stop', index }];
const thinking = (index: number, value: string): Record<string, unknown>[] => [
  { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } },
  { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: value } },
  { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: 'sig-' + index } }, { type: 'content_block_stop', index }];
const toolUse = (index: number, id: string, name: string, input: unknown): Record<string, unknown>[] => {
  const json = JSON.stringify(input);
  return [{ type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } },
    { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json.slice(0, 5) } },
    { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json.slice(5) } }, { type: 'content_block_stop', index }];
};

async function withProvider(scripts: Script[], run: (endpoint: string, requests: Recorded[]) => Promise<void>): Promise<void> {
  const requests: Recorded[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      const script = scripts[Math.min(requests.length - 1, scripts.length - 1)]!;
      void Promise.resolve(script(req, res, body)).catch(() => res.destroy());
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  try { await run(`http://127.0.0.1:${address.port}`, requests); }
  finally { server.closeAllConnections(); server.close(); }
}
const input = (overrides: Record<string, unknown> = {}) => ({ apiKey: KEY, model: 'claude-sonnet-5-5' as const, turn: 1, system: 'You are a careful code reader.',
  messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'What does README.md say?' }] }], tools: ['read_file', 'list_directory'] as const, ...overrides });

test('agent contracts: tool JSON schemas match the Zod argument contracts; views, deltas and outcomes are strict', () => {
  for (const [name, schema] of [['read_file', ReadFileArgsSchema], ['list_directory', ListDirectoryArgsSchema]] as const) {
    const json = AGENT_TOOL_DEFINITIONS[name].input_schema as { required: string[]; properties: Record<string, unknown>; additionalProperties: boolean };
    assert.equal(json.additionalProperties, false);
    assert.deepEqual(Object.keys(json.properties).sort(), Object.keys(schema.shape).sort(), name);
    assert.deepEqual(json.required, Object.entries(schema.shape).filter(([, field]) => !field.isOptional()).map(([key]) => key), name);
  }
  assert.equal(ReadFileArgsSchema.safeParse({ path: 'a', maxBytes: 262_145 }).success, false);
  assert.equal(ListDirectoryArgsSchema.safeParse({ path: '.', depth: 5 }).success, false);
  assert.equal(ListDirectoryArgsSchema.safeParse({ path: '.', depth: 4 }).success, true);
  const view = { turn: 1, model: 'claude-sonnet-5-5', stopReason: 'end_turn', text: 'hi', textTruncated: false, toolCalls: [],
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, fallback: false };
  assert.equal(TurnViewSchema.safeParse(view).success, true);
  assert.equal(TurnViewSchema.safeParse({ ...view, apiKey: KEY }).success, false, 'unknown fields are refused');
  assert.equal(TurnViewSchema.safeParse({ ...view, turn: AGENT_RUN_LIMITS.maxTurns + 1 }).success, false);
  assert.equal(TurnViewSchema.safeParse({ ...view, toolCalls: [{ id: 'bad id!', name: 'read_file', input: {} }] }).success, false);
  assert.equal(TurnDeltaSchema.safeParse({ kind: 'text', text: '' }).success, false);
  assert.equal(TurnOutcomeSchema.safeParse({ status: 'failed', code: 'rate_limited', retryable: true, httpStatus: 429, body: 'x' }).success, false);
});

test('streaming turn: deltas arrive live, thinking replays verbatim, tool input is assembled, and the request is cached and strict', async () => {
  await withProvider([(_req, res) => sse(res, [start(), ...thinking(0, 'Look at the README first.'), ...text(1, 'Let me read it.'),
    ...toolUse(2, 'toolu_01A', 'read_file', { path: 'README.md' }), ...stop('tool_use')])], async (endpoint, requests) => {
    const deltas: TurnDelta[] = [];
    const result = await createTurnGateway({ endpoint }).runTurn({ ...input(), onDelta: delta => deltas.push(delta) });
    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.deepEqual(result.view, { turn: 1, model: 'claude-sonnet-5-5', stopReason: 'tool_use', text: 'Let me read it.', textTruncated: false,
      toolCalls: [{ id: 'toolu_01A', name: 'read_file', input: { path: 'README.md' } }],
      usage: { inputTokens: 120, outputTokens: 42, cacheReadTokens: 100, cacheWriteTokens: 20 }, fallback: false });
    assert.deepEqual(result.replay.map(block => block.type), ['thinking', 'text', 'tool_use']);
    assert.deepEqual(result.replay[0], { type: 'thinking', thinking: 'Look at the README first.', signature: 'sig-0' });
    assert.deepEqual(deltas, [{ kind: 'thinking', text: 'Look at the README first.' }, { kind: 'text', text: 'Let me read it.' },
      { kind: 'tool_call', id: 'toolu_01A', name: 'read_file' }]);
    const [request] = requests;
    assert.equal(request!.method, 'POST'); assert.match(request!.url, /^\/v1\/messages/);
    assert.equal(request!.headers.authorization, `Bearer ${KEY}`); assert.equal(request!.headers['x-api-key'], undefined);
    assert.equal(request!.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
    assert.equal(request!.headers['anthropic-version'], '2026-10-21');
    const body = request!.body;
    assert.equal(body.model, 'claude-sonnet-5-5'); assert.equal(body.stream, true); assert.equal(body.max_tokens, AGENT_RUN_LIMITS.maxOutputTokens);
    assert.equal(body.fallbacks, 'default');
    assert.deepEqual(body.thinking, { type: 'adaptive', display: 'summarized' });
    assert.deepEqual(body.cache_control, { type: 'ephemeral' });
    assert.deepEqual(body.system, [{ type: 'text', text: 'You are a careful code reader.', cache_control: { type: 'ephemeral' } }]);
    assert.deepEqual((body.tools as { name: string; strict: boolean }[]).map(tool => [tool.name, tool.strict]), [['read_file', true], ['list_directory', true]]);
    assert.ok(!('temperature' in body) && !('tool_choice' in body), 'no sampling parameters and no forced tool choice');
  });
});

test('streaming turn: Haiku 5.5 sends no fallback; refusals, max_tokens and context exhaustion map to stop reasons', async () => {
  await withProvider([(_req, res) => sse(res, [start('claude-haiku-5-5'), ...text(0, 'Done.'), ...stop('end_turn')]),
    (_req, res) => sse(res, [start(), ...stop('refusal')]),
    (_req, res) => sse(res, [start(), ...toolUse(0, 'toolu_cut', 'read_file', { path: 'a' }), ...stop('max_tokens')]),
    (_req, res) => sse(res, [start(), ...text(0, 'x'), ...stop('model_context_window_exceeded')])], async (endpoint, requests) => {
    const gateway = createTurnGateway({ endpoint });
    const haiku = await gateway.runTurn(input({ model: 'claude-haiku-5-5' }));
    assert.equal(haiku.status === 'ok' && haiku.view.stopReason, 'end_turn');
    assert.ok(!('fallbacks' in requests[0]!.body) && requests[0]!.headers['anthropic-beta'] === undefined);
    const refusal = await gateway.runTurn(input());
    assert.deepEqual(refusal.status === 'ok' && [refusal.view.stopReason, refusal.replay.length], ['refusal', 0]);
    const cut = await gateway.runTurn(input());
    assert.equal(cut.status === 'ok' && cut.view.stopReason, 'max_tokens');
    const full = await gateway.runTurn(input());
    assert.equal(full.status === 'ok' && full.view.stopReason, 'context_exhausted');
  });
  assert.equal(stopReasonOf('compaction'), 'other'); assert.equal(stopReasonOf(undefined), 'other');
});

test('streaming turn: provider failures are normalized, retryable ones are retried, and no provider text escapes', async () => {
  const fail = (status: number, type: string, headers: Record<string, string> = {}): Script => (_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify({ type: 'error', error: { type, message: `provider says ${KEY}` } }));
  };
  // 529 then 429 then success: the SDK retries with the provider's retry-after.
  await withProvider([fail(529, 'overloaded_error', { 'retry-after': '0' }), fail(429, 'rate_limit_error', { 'retry-after': '0' }),
    (_req, res) => sse(res, [start(), ...text(0, 'ok'), ...stop('end_turn')])], async (endpoint, requests) => {
    const result = await createTurnGateway({ endpoint, maxRetries: 2 }).runTurn(input());
    assert.equal(result.status, 'ok'); assert.equal(requests.length, 3);
  });
  for (const [status, type, code] of [[401, 'authentication_error', 'auth_failed'], [403, 'permission_error', 'permission_denied'],
    [404, 'not_found_error', 'model_unavailable'], [413, 'request_too_large', 'context_too_long'], [400, 'invalid_request_error', 'invalid_request'],
    [529, 'overloaded_error', 'overloaded'], [500, 'api_error', 'provider_error']] as const) {
    await withProvider([fail(status, type, { 'retry-after': '0' })], async (endpoint, requests) => {
      const result = await createTurnGateway({ endpoint, maxRetries: 1 }).runTurn(input());
      assert.deepEqual(result, { status: 'failed', code, retryable: ['overloaded', 'provider_error'].includes(code), httpStatus: status }, String(status));
      assert.equal(requests.length, status >= 500 ? 2 : 1, 'only server-side failures are retried');
      assert.ok(!JSON.stringify(result).includes('provider says'));
    });
  }
  // A mid-stream error event has no HTTP status; only its type is used.
  await withProvider([(_req, res) => sse(res, [start(), ...text(0, 'partial'), { type: 'error', error: { type: 'overloaded_error', message: 'x' } }])],
    async endpoint => {
      assert.deepEqual(await createTurnGateway({ endpoint, maxRetries: 0 }).runTurn(input()),
        { status: 'failed', code: 'overloaded', retryable: true, httpStatus: null });
    });
  assert.equal(failureOf(new Error('boom'), undefined).code, 'response_invalid');
});

test('streaming turn: cancellation and the turn deadline stop a stalled stream; redirects and closed ports fail closed', async () => {
  const stall: Script = (_req, res) => sse(res, [start(), ...text(0, 'thinking about it')], false);
  await withProvider([stall], async endpoint => {
    const controller = new AbortController();
    const pending = createTurnGateway({ endpoint, maxRetries: 0 }).runTurn({ ...input(), signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    assert.deepEqual(await pending, { status: 'failed', code: 'cancelled', retryable: false, httpStatus: null });
    const started = Date.now();
    assert.deepEqual(await createTurnGateway({ endpoint, maxRetries: 0, timeoutMs: 300 }).runTurn(input()),
      { status: 'failed', code: 'timed_out', retryable: true, httpStatus: null });
    assert.ok(Date.now() - started < 5_000);
  });
  let reached = false;
  await withProvider([(_req, res) => { reached = true; res.end(); }], async target => {
    await withProvider([(_req, res) => { res.writeHead(307, { location: `${target}/v1/messages` }); res.end(); }], async endpoint => {
      const result = await createTurnGateway({ endpoint, maxRetries: 0 }).runTurn(input());
      assert.equal(result.status === 'failed' && result.code, 'unreachable');
    });
  });
  assert.equal(reached, false, 'the key never follows a redirect');
  assert.deepEqual(await createTurnGateway({ endpoint: 'http://127.0.0.1:9', maxRetries: 0 }).runTurn(input()),
    { status: 'failed', code: 'unreachable', retryable: true, httpStatus: null });
});

test('streaming turn: ambient ANTHROPIC_* variables cannot redirect the request, add headers or turn on logging', async () => {
  const saved = { ...process.env };
  try {
    await withProvider([(_req, res) => sse(res, [start(), ...text(0, 'ok'), ...stop('end_turn')])], async (endpoint, requests) => {
      process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9';
      process.env.ANTHROPIC_CUSTOM_HEADERS = 'x-exfiltrate: yes\nauthorization: Bearer stolen\nanthropic-version: 2020-01-01\nanthropic-beta: injected-beta';
      process.env.ANTHROPIC_AUTH_TOKEN = 'ambient-token'; process.env.ANTHROPIC_API_KEY = 'ambient-key'; process.env.ANTHROPIC_LOG = 'debug';
      const logged: unknown[] = [];
      const original = console.log; const debug = console.debug; console.log = (...args) => logged.push(args); console.debug = (...args) => logged.push(args);
      try { assert.equal((await createTurnGateway({ endpoint }).runTurn(input())).status, 'ok'); }
      finally { console.log = original; console.debug = debug; }
      const headers = requests[0]!.headers;
      assert.equal(headers.authorization, `Bearer ${KEY}`, 'the task key, never an ambient or injected credential');
      assert.equal(headers['x-exfiltrate'], undefined);
      assert.equal(headers['anthropic-version'], '2026-10-21'); assert.equal(headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
      assert.ok(!JSON.stringify(logged).includes(KEY) && logged.length === 0, 'nothing is logged');
    });
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
  const guard = guardedFetch('http://127.0.0.1:1234', { apiKey: 'turn-key', betas: [] }, async (url, init) => new Response(JSON.stringify({ url, headers: [...new Headers(init?.headers)] })));
  await assert.rejects(guard('http://127.0.0.1:9999/v1/messages'), /MODEL_ORIGIN_REJECTED/);
  await assert.rejects(guard('http://127.0.0.1:1234/v1/models'), /MODEL_ORIGIN_REJECTED/);
  const echoed = await (await guard('http://127.0.0.1:1234/v1/messages?beta=true', { headers: { authorization: 'Bearer k', 'x-api-key': 'k',
    'x-other': 'no', cookie: 'c' } })).json() as { headers: [string, string][] };
  assert.deepEqual(echoed.headers, [['anthropic-version', '2026-10-21'], ['authorization', 'Bearer turn-key']],
    'credential and version come from the guard; other headers are dropped');
});

test('fallback replay: blocks only the declined model could use are dropped before the last fallback marker', () => {
  const content = [
    { type: 'thinking', thinking: '', signature: 's1' }, { type: 'text', text: 'Partial ', citations: null },
    { type: 'tool_use', id: 'toolu_x', name: 'read_file', input: { path: 'a' } }, { type: 'redacted_thinking', data: 'r' },
    { type: 'fallback', from: { model: 'claude-sonnet-5-5' }, to: { model: 'claude-sonnet-5' } },
    { type: 'thinking', thinking: '', signature: 's2' }, { type: 'tool_use', id: 'toolu_y', name: 'list_directory', input: { path: '.' } },
  ] as unknown as Parameters<typeof replayContent>[0];
  assert.deepEqual(replayContent(content).map(block => block.type), ['text', 'fallback', 'thinking', 'tool_use']);
  assert.deepEqual(replayContent(content.slice(0, 4)).map(block => block.type), ['thinking', 'text', 'tool_use', 'redacted_thinking']);
});

test('conversation: append-only history, one result per tool call, truncated or excess calls never run, bounded size', () => {
  assert.throws(() => new Conversation('sys', '   '), /VALIDATION_ERROR/);
  const conversation = new Conversation('sys', 'Explain the build.');
  const turn = [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: 'Reading.', citations: null },
    { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'package.json' } },
    { type: 'tool_use', id: 'toolu_2', name: 'list_directory', input: { path: '.' } }] as unknown as Parameters<Conversation['acceptTurn']>[0];
  const calls = conversation.acceptTurn(turn, 'tool_use');
  assert.deepEqual(calls.map(call => [call.id, call.executable]), [['toolu_1', true], ['toolu_2', true]]);
  assert.equal(conversation.status, 'awaiting_tools');
  assert.throws(() => conversation.acceptTurn(turn, 'end_turn'), /CONVERSATION_STATE/);
  conversation.recordResult('toolu_1', '{"name":"demo"}', false);
  assert.throws(() => conversation.recordResult('toolu_1', 'again', false), /TOOL_CALL_UNKNOWN/);
  assert.throws(() => conversation.recordResult('toolu_forged', 'x', false), /TOOL_CALL_UNKNOWN/);
  conversation.closeRound();
  const history = conversation.history();
  assert.deepEqual(history.map(message => message.role), ['user', 'assistant', 'user']);
  assert.deepEqual(history[1]!.content, turn, 'assistant content is stored verbatim');
  assert.deepEqual(history[2]!.content, [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"name":"demo"}', is_error: false },
    { type: 'tool_result', tool_use_id: 'toolu_2', content: NOT_EXECUTED, is_error: true }]);
  (history[0]!.content as { text: string }[])[0]!.text = 'mutated';
  assert.notEqual(JSON.stringify(conversation.history()), JSON.stringify(history), 'history() hands out copies');
  // A turn cut off at max_tokens still needs results, but none of its calls may run.
  const cut = conversation.acceptTurn([{ type: 'tool_use', id: 'toolu_3', name: 'read_file', input: { path: 'p' } }] as unknown as Parameters<Conversation['acceptTurn']>[0], 'max_tokens');
  assert.equal(cut[0]!.executable, false);
  assert.throws(() => conversation.recordResult('toolu_3', 'x', false), /TOOL_CALL_UNKNOWN/);
  conversation.closeRound();
  const many = Array.from({ length: AGENT_RUN_LIMITS.maxToolCallsPerTurn + 2 }, (_, index) => ({ type: 'tool_use', id: `toolu_m${index}`, name: 'read_file', input: { path: 'p' } }));
  const capped = conversation.acceptTurn(many as unknown as Parameters<Conversation['acceptTurn']>[0], 'tool_use');
  assert.equal(capped.filter(call => call.executable).length, AGENT_RUN_LIMITS.maxToolCallsPerTurn);
  conversation.closeRound();
  // An empty refusal adds no assistant message.
  const before = conversation.history().length;
  conversation.acceptTurn([], 'refusal');
  assert.equal(conversation.history().length, before);
  const big = new Conversation('sys', 'x');
  big.acceptTurn([{ type: 'tool_use', id: 'toolu_big', name: 'read_file', input: { path: 'p' } }] as unknown as Parameters<Conversation['acceptTurn']>[0], 'tool_use');
  big.recordResult('toolu_big', 'y'.repeat(AGENT_RUN_LIMITS.maxConversationBytes), false);
  assert.throws(() => big.closeRound(), /CONVERSATION_TOO_LARGE/);
});
