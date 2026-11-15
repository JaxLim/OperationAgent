import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { AGENT_RUN_LIMITS, LINKED_PROVIDERS } from '../../packages/contracts/dist/index.js';
import { runLinkedTurn } from '../../apps/server/dist/models/linked-turn.js';
import { Conversation } from '../../apps/server/dist/agent/conversation.js';
import { withAgentHarness } from './support/agent-harness.ts';

const conversation = () => new Conversation('System instructions', 'Read README.md');
const input = () => ({ apiKey: 'test-provider-credential', turn: 1, system: 'System instructions', model: 'custom/model',
  messages: conversation().history(), tools: ['read_file'] as const });
const usage = { prompt_tokens: 30, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 8, cache_write_tokens: 2 } };
const choice = (message: object, finish_reason = 'stop') => ({ finish_reason, message: { role: 'assistant', ...message } });
const answer = (message: object = { content: 'done' }, reason = 'stop') => Response.json({ choices: [choice(message, reason)], usage });
const call = { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{ "path": "README.md" }' } };

test('a task with only an OpenRouter key runs its tool and records both turns against the returned model', async t => {
  const key = 'test-openrouter-key-' + 'x'.repeat(40);
  await withAgentHarness('http://127.0.0.1:1', async harness => {
    const { store } = harness;
    store.saveProviderModel('openrouter', 'vendor/alias');
    store.saveSettings({ ...store.getSettings(), defaultProvider: 'openrouter' });
    let turns = 0;
    t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
      assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
      assert.equal(new Headers(init.headers).get('authorization'), 'Bearer ' + key);
      const body = JSON.parse(String(init.body));
      assert.equal(body.model, 'vendor/alias');
      if (++turns === 1) {
        store.saveSettings({ ...store.getSettings(), defaultProvider: 'anthropic' });
        return Response.json({ model: 'vendor/resolved', choices: [choice({ content: null, tool_calls: [call] }, 'tool_calls')], usage });
      }
      assert.equal(body.messages.at(-1).role, 'tool');
      assert.equal(body.messages.at(-1).tool_call_id, 'call_1');
      if (process.platform === 'win32' && process.arch === 'x64') assert.match(body.messages.at(-1).content, /# Demo/);
      return Response.json({ model: 'vendor/resolved', choices: [choice({ content: 'Finished reading' })], usage });
    });
    assert.equal((await harness.runTask('Read README.md')).state, 'COMPLETED');
    assert.deepEqual(store.listUsage({ after: null }).rows, [{ provider: 'openrouter', model: 'vendor/resolved', turns: 2,
      inputTokens: 40, cacheReadTokens: 16, cacheWriteTokens: 4, outputTokens: 14 }]);
  }, { linkedKey: key });
});

function transport(t: TestContext, ...responses: Response[]) {
  const requests: Request[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    requests.push(new Request(url, init));
    return responses.shift() ?? assert.fail('unexpected request');
  });
  return requests;
}

for (const provider of LINKED_PROVIDERS) {
  test(`${provider} sends only selected tools to its official chat endpoint and normalizes reported usage`, async t => {
    const requests = transport(t, answer());
    const result = await runLinkedTurn(provider, input());
    assert.equal(result.status, 'ok');
    assert.equal(result.view.model, 'custom/model');
    assert.deepEqual(result.view.usage, { inputTokens: 20, outputTokens: 7, cacheReadTokens: 8, cacheWriteTokens: 2 });
    assert.deepEqual(result.context, { promptTokens: 30, compacted: false });
    const [req] = requests;
    assert.equal(req!.url, provider === 'google' ? 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'
      : provider === 'openai' ? 'https://api.openai.com/v1/chat/completions' : 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(req!.redirect, 'error');
    assert.equal(req!.method, 'POST');
    assert.equal(req!.headers.get('authorization'), 'Bearer ' + input().apiKey);
    const body = await req!.json() as { model: string; tools: { function: { name: string } }[]; messages: unknown[] };
    assert.equal(body.model, 'custom/model');
    assert.deepEqual(body.tools.map((tool: { function: { name: string } }) => tool.function.name), ['read_file']);
    assert.deepEqual(body.messages, [{ role: 'system', content: 'System instructions' }, { role: 'user', content: 'Read README.md' }]);
  });
}

for (const provider of ['google', 'openrouter'] as const) {
  test(`${provider} replays private metadata and original arguments after cloning parallel tool calls`, async t => {
    const signature = { google: { thought_signature: 'opaque-signature==' } };
    const metadata = provider === 'google' ? { extra_content: signature }
      : { reasoning_details: [{ type: 'reasoning.encrypted', data: 'private-replay', index: 0 }] };
    const message = { role: 'assistant', content: null, ...metadata,
      tool_calls: [{ ...call, extra_content: signature }, { ...call, id: 'call_2' }] };
    const requests = transport(t, answer(message, 'tool_calls'), answer());
    const history = conversation();
    const first = await runLinkedTurn(provider, input());
    assert.equal(first.status, 'ok');
    const calls = history.acceptTurn(first.replay, first.view.stopReason);
    assert.deepEqual(calls.map(c => [c.id, c.executable]), [['call_1', true], ['call_2', true]]);
    assert.doesNotMatch(JSON.stringify(first.view), /signature|private-replay/);
    history.recordResult('call_1', 'result A', false);
    history.recordResult('call_2', 'result B', true);
    history.closeRound();
    const second = await runLinkedTurn(provider, { ...input(), turn: 2, messages: history.history() });
    assert.equal(second.status, 'ok');
    const body = await requests[1]!.json() as { messages: unknown[] };
    assert.deepEqual(body.messages.slice(2), [message, { role: 'tool', tool_call_id: 'call_1', content: 'result A' },
      { role: 'tool', tool_call_id: 'call_2', content: 'result B' }]);
  });
}

test('missing usage, malformed calls, duplicate ids, undeclared tools and excess calls fail closed', async t => {
  const invalidCalls = [[{ ...call, function: { name: 'read_file', arguments: '[]' } }], [call, call],
    [{ ...call, function: { name: 'bash', arguments: '{}' } }], [{ ...call, function: { name: 'read_file', arguments: '{' } }],
    Array.from({ length: AGENT_RUN_LIMITS.maxToolCallsPerTurn + 1 }, (_, i) => ({ ...call, id: 'c' + i }))];
  const responses = [Response.json({ choices: [choice({ content: 'ok' })] }),
    Response.json({ choices: [choice({ content: 'ok' })], usage: { prompt_tokens: 9 } }),
    answer({ content: null, tool_calls: [{ ...call, function: { name: 'read_file', arguments: '{' } }] }, 'length'),
    ...invalidCalls.map(calls => answer({ content: null, tool_calls: calls }, 'tool_calls'))];
  transport(t, ...responses);
  for (let i = 0; i < responses.length; i++) {
    assert.deepEqual(await runLinkedTurn('openai', input()), { status: 'failed', code: 'response_invalid', retryable: false, httpStatus: null });
  }
});

test('HTTP errors are sanitized, pre-cancellation avoids fetch and the deadline interrupts a pending request', async t => {
  const requests = transport(t, new Response('private provider detail', { status: 429 }));
  assert.deepEqual(await runLinkedTurn('openai', input()), { status: 'failed', code: 'rate_limited', retryable: true, httpStatus: 429 });
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await runLinkedTurn('openai', { ...input(), signal: controller.signal }),
    { status: 'failed', code: 'cancelled', retryable: false, httpStatus: null });
  assert.equal(requests.length, 1);
  const deadline = new AbortController();
  t.mock.method(AbortSignal, 'timeout', (ms: number) => { assert.equal(ms, AGENT_RUN_LIMITS.turnTimeoutMs); return deadline.signal; });
  t.mock.method(globalThis, 'fetch', (_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
  }));
  const pending = runLinkedTurn('openai', input());
  deadline.abort(new DOMException('deadline', 'TimeoutError'));
  assert.deepEqual(await pending, { status: 'failed', code: 'timed_out', retryable: true, httpStatus: null });
});
