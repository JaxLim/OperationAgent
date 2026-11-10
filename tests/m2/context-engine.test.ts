import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { CLAUDE_MODELS, CONTEXT_POLICIES, TaskEventSchema, summarizeTaskUsage } from '../../packages/contracts/dist/index.js';
import type { TaskEvent } from '../../packages/contracts/dist/index.js';
import { CONTEXT_BETAS, contextManagement, createTurnGateway, replayContent, usageOf } from '../../apps/server/dist/models/turns.js';
import { Conversation } from '../../apps/server/dist/agent/conversation.js';
import { messageStart, messageStop, sse, textBlock, toolBlock, withProvider } from './support/fake-provider.ts';
import type { ProviderBody } from './support/fake-provider.ts';
import { AGENT_HARNESS_KEY, withAgentHarness } from './support/agent-harness.ts';
import { CLEARING_ALTERNATIVE, COST_SCENARIOS, modelCost } from '../../scripts/bench-agent.ts';

// The context engine (ADR-PLAT-001 D1/D2): server-side context edits requested by policy, an append-only conversation,
// honest token and timing accounting, and a safe way out if the provider rejects the feature. Everything runs against a
// local fake of the Messages API through the real SDK stream parser; the provider's own behavior is not tested here.

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const turnInput = (overrides: Record<string, unknown> = {}) => ({ apiKey: AGENT_HARNESS_KEY, model: 'claude-sonnet-5-5' as const, turn: 1,
  system: 'You read code.', messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hello' }] }], tools: ['read_file' as const],
  ...overrides });
const compactionBlock = (index: number, summary: string): Record<string, unknown>[] => [
  { type: 'content_block_start', index, content_block: { type: 'compaction', content: null, encrypted_content: null } },
  { type: 'content_block_delta', index, delta: { type: 'compaction_delta', content: summary, encrypted_content: 'opaque-1' } },
  { type: 'content_block_stop', index }];
const rejected = (status: number, type: string) => (res: ServerResponse): void => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type, message: 'Unexpected value(s) for the `anthropic-beta` header' } }));
};
const invalidRequest = rejected(400, 'invalid_request_error');
/** A summary block whose summarization failed: its content stays null and the provider treats it as a no-op. */
const failedCompactionBlock = (index: number): Record<string, unknown>[] => [
  { type: 'content_block_start', index, content_block: { type: 'compaction', content: null, encrypted_content: null } },
  { type: 'content_block_delta', index, delta: { type: 'compaction_delta', content: null, encrypted_content: null } },
  { type: 'content_block_stop', index }];
/** A request body without the context parameter, to compare a managed request with an unmanaged one. */
const unmanaged = (body: ProviderBody): Record<string, unknown> => Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'context_management'));
const turnEvents = (events: TaskEvent[]) => events.flatMap(event => event.type === 'assistant_turn' ? [event.payload] : []);

test('the policy table keeps every model far inside its window, and Haiku under its long-prompt price step', () => {
  assert.deepEqual(Object.keys(CONTEXT_POLICIES).sort(), [...CLAUDE_MODELS].sort(), 'one policy per model the agent can run');
  for (const [model, policy] of Object.entries(CONTEXT_POLICIES)) {
    assert.ok(policy.compactAtInputTokens >= 50_000 && policy.compactAtInputTokens <= 500_000, `${model}: summarized at or before half of the 1M window`);
    assert.ok(Object.isFrozen(policy), model);
  }
  assert.ok(CONTEXT_POLICIES['claude-haiku-5-5'].compactAtInputTokens < 100_000, 'Haiku 5.5 prompts above 100K tokens cost five times more');
  assert.deepEqual(contextManagement(CONTEXT_POLICIES['claude-sonnet-5-5']), { edits: [{ type: 'compact_20260112', trigger: { type: 'input_tokens', value: 300_000 } }] });
  assert.deepEqual(CONTEXT_BETAS, ['compact-2026-01-12']);
});

test('the policy follows its evidence: in the cost model summarizing is never dearer than clearing, and short tasks are untouched', () => {
  // The model is arithmetic over the provider's published prices (scripts/bench-agent.ts), not a measurement. It is
  // pinned here so the policy and the reasoning recorded for it cannot drift apart unnoticed.
  for (const [name, scenario] of Object.entries(COST_SCENARIOS)) {
    for (const model of CLAUDE_MODELS) {
      const unmanaged = modelCost(model, null, scenario), production = modelCost(model, CONTEXT_POLICIES[model], scenario);
      const clearing = modelCost(model, CLEARING_ALTERNATIVE[model]!, scenario);
      const label = `${name} / ${model}`;
      assert.equal(production.turnsOverWindow, 0, `${label}: never over the window`);
      assert.equal(production.clears, 0, `${label}: production requests no clearing`);
      assert.ok(production.inputCostInBaseTokens <= clearing.inputCostInBaseTokens, `${label}: ${production.inputCostInBaseTokens} vs clearing ${clearing.inputCostInBaseTokens}`);
      assert.ok(production.inputCostInBaseTokens <= unmanaged.inputCostInBaseTokens, `${label}: never dearer than unmanaged`);
      if (unmanaged.peakPromptTokens < CONTEXT_POLICIES[model].compactAtInputTokens) assert.deepEqual(production, unmanaged, `${label}: below the threshold nothing changes`);
    }
  }
  const heavy = COST_SCENARIOS['heavy: 40 turns x 4 reads of 16K tokens']!;
  assert.ok(modelCost('claude-sonnet-5-5', null, heavy).turnsOverWindow > 0, 'unmanaged, a heavy task runs out of context');
  assert.ok(modelCost('claude-opus-5-5', CLEARING_ALTERNATIVE['claude-opus-5-5']!, heavy).inputCostInBaseTokens >
    modelCost('claude-opus-5-5', null, heavy).inputCostInBaseTokens, 'clearing with a full round kept costs more than doing nothing here');
});

test('gateway: a policy adds the server-side edits and their betas; without one the request is exactly what it was', async () => {
  const reply = (res: ServerResponse): void => sse(res, [messageStart(), ...textBlock(0, 'ok'), ...messageStop('end_turn')]);
  await withProvider([reply], async (endpoint, bodies, headers) => {
    const gateway = createTurnGateway({ endpoint, maxRetries: 0 });
    const sonnet = CONTEXT_POLICIES['claude-sonnet-5-5'], haiku = CONTEXT_POLICIES['claude-haiku-5-5'];
    for (const input of [turnInput(), turnInput({ context: null }), turnInput({ context: sonnet }),
      turnInput({ model: 'claude-haiku-5-5' }), turnInput({ model: 'claude-haiku-5-5', context: haiku })]) {
      assert.equal((await gateway.runTurn(input)).status, 'ok');
    }
    // Unmanaged requests: identical bodies, no context parameter, and only the fallback beta where the model has one.
    assert.deepEqual(bodies[0], bodies[1]);
    assert.ok(!('context_management' in bodies[0]!) && !('context_management' in bodies[3]!));
    assert.deepEqual([headers[0]!['anthropic-beta'], headers[3]!['anthropic-beta']], [FALLBACK_BETA, undefined]);
    assert.deepEqual([bodies[0]!.fallbacks, bodies[3]!.fallbacks], ['default', undefined]);
    // Managed requests: the edit from the policy, the compaction beta after the fallback beta, nothing else changed.
    assert.deepEqual(bodies[2]!.context_management, contextManagement(sonnet));
    assert.deepEqual(bodies[4]!.context_management, contextManagement(haiku));
    assert.equal(headers[2]!['anthropic-beta'], [FALLBACK_BETA, ...CONTEXT_BETAS].join(','));
    assert.equal(headers[4]!['anthropic-beta'], CONTEXT_BETAS.join(','));
    assert.deepEqual([bodies[2]!.fallbacks, bodies[4]!.fallbacks], ['default', undefined], 'Haiku has no server-side fallback');
    assert.deepEqual(unmanaged(bodies[2]!), bodies[0], 'system, tools, messages and every other parameter are untouched');
  });
});

test('gateway: a turn reports when its first content arrived, how long it took and whether the provider summarized', async () => {
  const usage = { output_tokens: 30, iterations: [
    { type: 'compaction', input_tokens: 5_000, output_tokens: 800, cache_read_input_tokens: 200, cache_creation_input_tokens: 0 },
    { type: 'message', input_tokens: 1_200, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 300 }] };
  const managed = (res: ServerResponse): void => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`event: message_start\ndata: ${JSON.stringify(messageStart())}\n\n`);
    setTimeout(() => {
      for (const event of [...compactionBlock(0, 'Earlier work, summarized.'), ...textBlock(1, 'Continuing.'),
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage, context_management: { applied_edits: [] } },
        { type: 'message_stop' }]) res.write(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    }, 60);
  };
  await withProvider([managed, res => sse(res, [messageStart(), ...messageStop('end_turn')])], async endpoint => {
    const gateway = createTurnGateway({ endpoint, maxRetries: 0 });
    const result = await gateway.runTurn(turnInput({ context: CONTEXT_POLICIES['claude-sonnet-5-5'] }));
    assert.equal(result.status, 'ok');
    if (result.status !== 'ok') return;
    assert.ok(result.timing.ttftMs !== null && result.timing.ttftMs >= 50 && result.timing.ttftMs <= result.timing.durationMs, JSON.stringify(result.timing));
    assert.deepEqual(result.context, { promptTokens: 1_500, compacted: true });
    // Billed tokens include the summarization the provider ran; the prompt size does not.
    assert.deepEqual(result.view.usage, { inputTokens: 40 + 5_000, outputTokens: 30 + 800, cacheReadTokens: 200, cacheWriteTokens: 0 });
    assert.deepEqual(result.replay.map(block => block.type), ['compaction', 'text']);
    assert.equal(result.view.text, 'Continuing.', 'the summary is not shown as answer text');
    // A turn with no content block has no time to first content.
    const empty = await gateway.runTurn(turnInput());
    assert.ok(empty.status === 'ok' && empty.timing.ttftMs === null && empty.context.promptTokens === 40 && !empty.context.compacted);
  });
  // A deterministic clock: 0 at the request, 120 at the first content block, 400 when the message is complete.
  const ticks = [0, 120, 400];
  await withProvider([res => sse(res, [messageStart(), ...textBlock(0, 'hi'), ...messageStop('end_turn')])], async endpoint => {
    const timed = await createTurnGateway({ endpoint, maxRetries: 0, now: () => ticks.shift() ?? 400 }).runTurn(turnInput());
    assert.deepEqual(timed.status === 'ok' && timed.timing, { ttftMs: 120, durationMs: 400 });
  });
  assert.deepEqual(usageOf({ input_tokens: 10, output_tokens: 2, cache_read_input_tokens: null, cache_creation_input_tokens: null,
    iterations: null } as Parameters<typeof usageOf>[0]), { usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 }, promptTokens: 10 });
  // After a server-side fallback the prompt that was answered is the fallback model's iteration, not the declined one.
  assert.equal(usageOf({ input_tokens: 1_400, output_tokens: 9, cache_read_input_tokens: 100, cache_creation_input_tokens: 0, iterations: [
    { type: 'message', input_tokens: 500, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    { type: 'fallback_message', input_tokens: 900, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 }],
  } as unknown as Parameters<typeof usageOf>[0]).promptTokens, 1_000);
  // A summary block and a fallback marker show the user nothing: alone they are not "first content"; a failed
  // summarization (null content) is replayed like any block but is not reported as a summary.
  await withProvider([
    res => sse(res, [messageStart(), ...compactionBlock(0, 'Summary only.'), ...messageStop('end_turn')]),
    res => sse(res, [messageStart(), ...failedCompactionBlock(0), ...textBlock(1, 'Still here.'), ...messageStop('end_turn')]),
  ], async endpoint => {
    const gateway = createTurnGateway({ endpoint, maxRetries: 0 });
    const markerOnly = await gateway.runTurn(turnInput({ context: CONTEXT_POLICIES['claude-sonnet-5-5'] }));
    assert.ok(markerOnly.status === 'ok' && markerOnly.timing.ttftMs === null && markerOnly.context.compacted);
    const failed = await gateway.runTurn(turnInput({ context: CONTEXT_POLICIES['claude-sonnet-5-5'] }));
    assert.ok(failed.status === 'ok' && failed.timing.ttftMs !== null && failed.context.compacted === false);
    assert.deepEqual(failed.status === 'ok' && failed.replay.map(block => block.type), ['compaction', 'text']);
  });
});

test('a summary block is conversation content: kept across a fallback, stored verbatim and sent back unchanged', async () => {
  const summary = { type: 'compaction', content: 'Earlier work, summarized.', encrypted_content: 'opaque-1' };
  const blocks = [summary, { type: 'thinking', thinking: 't', signature: 's' }, { type: 'fallback' }, { type: 'text', text: 'after' }];
  assert.deepEqual(replayContent(blocks as Parameters<typeof replayContent>[0]).map(block => block.type), ['compaction', 'fallback', 'text']);

  await withProvider([
    res => sse(res, [messageStart(), ...compactionBlock(0, 'Earlier work, summarized.'), ...toolBlock(1, 'toolu_1', 'read_file', { path: 'README.md' }), ...messageStop('tool_use')]),
    res => sse(res, [messageStart(), ...textBlock(0, 'Done.'), ...messageStop('end_turn')]),
  ], async (endpoint, bodies) => {
    const gateway = createTurnGateway({ endpoint, maxRetries: 0 });
    const conversation = new Conversation('You read code.', 'Summarize the project.');
    const first = await gateway.runTurn(turnInput({ system: conversation.system, messages: conversation.history(), context: CONTEXT_POLICIES['claude-sonnet-5-5'] }));
    assert.equal(first.status, 'ok');
    if (first.status !== 'ok') return;
    conversation.acceptTurn(first.replay, first.view.stopReason);
    conversation.recordResult('toolu_1', 'file text', false);
    conversation.closeRound();
    await gateway.runTurn(turnInput({ turn: 2, system: conversation.system, messages: conversation.history(), context: CONTEXT_POLICIES['claude-sonnet-5-5'] }));
    const assistant = bodies[1]!.messages[1] as { role: string; content: Record<string, unknown>[] };
    assert.equal(assistant.role, 'assistant');
    assert.deepEqual(assistant.content[0], summary, 'the provider gets its own block back, byte for byte');
    assert.deepEqual(bodies[1]!.messages.slice(0, 1), bodies[0]!.messages, 'nothing before the summary was removed or changed');
  });
});

test('the conversation Express sends is append-only: system, tools and every earlier message never change', async () => {
  // The provider binds thinking blocks and its prompt cache to the exact prefix it was sent, so this is the property
  // the whole context engine rests on. Several tool rounds, parallel calls, a refused call and a call the task does not
  // have; on a platform without the Read Gate the tools fail, which changes the results but not the property.
  const rounds = 6;
  const scripts = Array.from({ length: rounds }, (_, round) => (res: ServerResponse): void => sse(res, [messageStart(),
    ...textBlock(0, `Round ${round + 1}.`), ...toolBlock(1, `toolu_${round}_a`, 'read_file', { path: `src/file${round}.ts` }),
    ...toolBlock(2, `toolu_${round}_b`, round % 2 ? 'list_directory' : 'read_file', round % 2 ? { path: 'src' } : { path: '.env' }),
    ...(round === 2 ? toolBlock(3, 'toolu_bash', 'bash', { command: 'ls' }) : []), ...messageStop('tool_use')]));
  const files = Object.fromEntries([['README.md', '# Demo\n'], ['.env', 'TOKEN=secret'],
    ...Array.from({ length: rounds }, (_, index) => [`src/file${index}.ts`, `export const value${index} = ${'x'.repeat(2_000)};\n`])]) as Record<string, string>;
  await withProvider([...scripts, res => sse(res, [messageStart(), ...textBlock(0, 'All read.'), ...messageStop('end_turn')])], async (endpoint, bodies, headers) => {
    await withAgentHarness(endpoint, async harness => {
      const task = await harness.runTask('Read everything.');
      assert.equal(task.state, 'COMPLETED');
      assert.equal(bodies.length, rounds + 1);
      const serialized = (value: unknown): string => JSON.stringify(value);
      for (let index = 1; index < bodies.length; index++) {
        const previous = bodies[index - 1]!, current = bodies[index]!;
        for (const key of ['system', 'tools', 'model', 'thinking', 'cache_control', 'context_management', 'max_tokens']) {
          assert.equal(serialized(current[key]), serialized(previous[key]), `request ${index + 1}: ${key} changed`);
        }
        assert.equal(headers[index]!['anthropic-beta'], headers[0]!['anthropic-beta']);
        assert.ok(current.messages.length === previous.messages.length + 2, `request ${index + 1} appends one assistant turn and one result message`);
        previous.messages.forEach((message, position) =>
          assert.equal(serialized(current.messages[position]), serialized(message), `request ${index + 1}: message ${position} was rewritten`));
      }
      // Every tool call of a round is answered in the one message that follows it, in the order the model made them.
      const last = bodies.at(-1)!.messages as { role: string; content: { type: string; id?: string; tool_use_id?: string }[] }[];
      for (let position = 1; position < last.length; position += 2) {
        const calls = last[position]!.content.flatMap(block => block.type === 'tool_use' ? [block.id] : []);
        assert.deepEqual(last[position + 1]!.content.map(block => block.tool_use_id), calls);
      }
      assert.equal(turnEvents(task.events).every(turn => turn.context?.managed === true), true);
    }, { files });
  });
});

test('if the provider rejects a managed request, the task continues unmanaged: one retry, recorded, never repeated', async () => {
  const answer = (res: ServerResponse, body: ProviderBody): void => ('context_management' in body ? invalidRequest(res)
    : body.messages.length === 1 ? sse(res, [messageStart(), ...toolBlock(0, 'toolu_1', 'list_directory', { path: '.' }), ...messageStop('tool_use')])
      : sse(res, [messageStart(), ...textBlock(0, 'Answered.'), ...messageStop('end_turn')]));
  await withProvider([answer], async (endpoint, bodies, headers) => {
    await withAgentHarness(endpoint, async harness => {
      const task = await harness.runTask('What is here?');
      assert.equal(task.state, 'COMPLETED');
      // Turn 1 managed (rejected), turn 1 again unmanaged, turn 2 unmanaged: the feature is not tried a second time.
      assert.deepEqual(bodies.map(body => 'context_management' in body), [true, false, false]);
      assert.deepEqual(headers.map(header => header['anthropic-beta']), [[FALLBACK_BETA, ...CONTEXT_BETAS].join(','), FALLBACK_BETA, FALLBACK_BETA]);
      assert.deepEqual(bodies[1], unmanaged(bodies[0]!), 'the retry is the same request without the feature');
      assert.deepEqual(turnEvents(task.events).map(turn => [turn.turn, turn.context?.managed]), [[1, false], [2, false]]);
      assert.equal(summarizeTaskUsage(task.events).contextManaged, false);
    });
  });
  // A provider that answers the managed request with 403 or 404 (the feature is not available to this key or model)
  // is handled the same way.
  for (const [status, type] of [[403, 'permission_error'], [404, 'not_found_error']] as const) {
    const reply = (res: ServerResponse, body: ProviderBody): void => ('context_management' in body ? rejected(status, type)(res)
      : sse(res, [messageStart(), ...textBlock(0, 'Answered.'), ...messageStop('end_turn')]));
    await withProvider([reply], async (endpoint, bodies) => {
      await withAgentHarness(endpoint, async harness => {
        const task = await harness.runTask('What is here?');
        assert.equal(task.state, 'COMPLETED', `HTTP ${status}`);
        assert.deepEqual(bodies.map(body => 'context_management' in body), [true, false]);
        assert.deepEqual(turnEvents(task.events).map(turn => turn.context?.managed), [false]);
      });
    });
  }
  // Failures that are not a rejection of the request itself are never retried this way.
  await withProvider([rejected(401, 'authentication_error')], async (endpoint, bodies) => {
    await withAgentHarness(endpoint, async harness => {
      assert.equal((await harness.runTask('What is here?')).state, 'FAILED');
      assert.equal(bodies.length, 1);
    });
  });
  // A request that is invalid for another reason still fails the task: one unmanaged retry, then the normal failure.
  await withProvider([invalidRequest], async (endpoint, bodies) => {
    await withAgentHarness(endpoint, async harness => {
      const task = await harness.runTask('What is here?');
      assert.equal(task.state, 'FAILED');
      assert.deepEqual(bodies.map(body => 'context_management' in body), [true, false]);
    });
  });
  // With the policy off nothing is managed and nothing is retried.
  await withProvider([invalidRequest], async (endpoint, bodies) => {
    await withAgentHarness(endpoint, async harness => {
      assert.equal((await harness.runTask('What is here?')).state, 'FAILED');
      assert.deepEqual(bodies.map(body => 'context_management' in body), [false]);
    }, { contextPolicy: () => null });
  });
});

test('once a summary is part of the history the feature is not switched off: that block cannot be sent without it', async () => {
  const script = (res: ServerResponse, body: ProviderBody): void => (body.messages.length === 1
    ? sse(res, [messageStart(), ...compactionBlock(0, 'Summary.'), ...toolBlock(1, 'toolu_1', 'list_directory', { path: '.' }), ...messageStop('tool_use')])
    : invalidRequest(res));
  await withProvider([script], async (endpoint, bodies) => {
    await withAgentHarness(endpoint, async harness => {
      const task = await harness.runTask('Long task.');
      assert.equal(task.state, 'FAILED');
      assert.deepEqual(bodies.map(body => 'context_management' in body), [true, true], 'no unmanaged retry after a summary');
      assert.deepEqual(turnEvents(task.events).map(turn => [turn.context?.compacted, turn.context?.managed]), [[true, true]]);
    });
  });
  const failedSummary = (res: ServerResponse, body: ProviderBody): void => (body.messages.length === 1
    ? sse(res, [messageStart(), ...failedCompactionBlock(0), ...toolBlock(1, 'toolu_1', 'list_directory', { path: '.' }), ...messageStop('tool_use')])
    : invalidRequest(res));
  await withProvider([failedSummary], async (endpoint, bodies) => {
    await withAgentHarness(endpoint, async harness => {
      const task = await harness.runTask('Long task.');
      assert.equal(task.state, 'FAILED');
      assert.deepEqual(bodies.map(body => 'context_management' in body), [true, true], 'the block is in the history, so the feature stays on');
      assert.deepEqual(turnEvents(task.events).map(turn => turn.context?.compacted), [false], 'a failed summarization is not a summary');
      assert.equal(summarizeTaskUsage(task.events).compactions, 0);
    });
  });
});

test('turn and tool metrics are committed with the events, and a task usage summary is a pure function of them', async () => {
  const usage = (input: number, read: number, written: number) => ({ type: 'message_start', message: { id: 'msg', type: 'message', role: 'assistant',
    model: 'claude-sonnet-5-5', content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: input, output_tokens: 1, cache_read_input_tokens: read, cache_creation_input_tokens: written } } });
  await withProvider([
    res => sse(res, [usage(100, 0, 900), ...toolBlock(0, 'toolu_1', 'list_directory', { path: '.' }), ...toolBlock(1, 'toolu_2', 'read_file', { path: 'README.md' }), ...messageStop('tool_use')]),
    res => sse(res, [usage(50, 1_000, 450), ...textBlock(0, 'Answer.'), ...messageStop('end_turn')]),
  ], async endpoint => {
    await withAgentHarness(endpoint, async harness => {
      const task = await harness.runTask('Describe it.');
      assert.equal(task.state, 'COMPLETED');
      const turns = turnEvents(task.events);
      assert.deepEqual(turns.map(turn => turn.context), [
        { promptTokens: 1_000, managed: true, compacted: false }, { promptTokens: 1_500, managed: true, compacted: false }]);
      for (const turn of turns) assert.ok(turn.timing && turn.timing.ttftMs !== null && turn.timing.ttftMs <= turn.timing.durationMs && turn.timing.durationMs < 30_000);
      const calls = task.events.flatMap(event => event.type === 'tool_call' ? [event.payload] : []);
      assert.equal(calls.length, 2);
      for (const call of calls) assert.ok(typeof call.durationMs === 'number' && call.durationMs >= 0 && call.durationMs < 30_000, JSON.stringify(call));
      const summary = summarizeTaskUsage(task.events);
      assert.deepEqual({ ...summary, modelMs: 0, toolMs: 0, medianTtftMs: 0 }, { turns: 2, toolCalls: 2, inputTokens: 150, cacheReadTokens: 1_000,
        cacheWriteTokens: 1_350, outputTokens: 14, totalInputTokens: 2_500, cacheHitRatio: 0.4, peakPromptTokens: 1_500, modelMs: 0, toolMs: 0, medianTtftMs: 0,
        compactions: 0, contextManaged: true });
      assert.equal(summary.modelMs, turns.reduce((sum, turn) => sum + turn.timing!.durationMs, 0));
      // The two calls ran in parallel: elapsed tool time is at least the longer call and at most their sum.
      assert.ok(summary.toolMs >= Math.max(...calls.map(call => call.durationMs!)) - 1 && summary.toolMs <= calls.reduce((sum, call) => sum + call.durationMs!, 0),
        JSON.stringify({ toolMs: summary.toolMs, calls: calls.map(call => call.durationMs) }));
    });
  });
  // Events recorded before these fields existed still validate and simply contribute no timing or context.
  const base = { eventId: randomUUID(), taskId: randomUUID(), occurredAt: new Date(0).toISOString(), requestId: null };
  const older = [
    { ...base, seq: 2, type: 'assistant_turn', payload: { turn: 1, model: 'claude-sonnet-5-5', messageId: null, stopReason: 'tool_use', toolCalls: 1, fallback: false,
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 30, cacheWriteTokens: 0 } } },
    { ...base, eventId: randomUUID(), seq: 3, type: 'tool_call', payload: { turn: 1, callId: 'toolu_1', tool: 'read_file', target: 'a.ts', status: 'ok', code: null, size: 12 } },
  ].map(event => TaskEventSchema.parse(event));
  assert.deepEqual(summarizeTaskUsage(older), { turns: 1, toolCalls: 1, inputTokens: 10, cacheReadTokens: 30, cacheWriteTokens: 0, outputTokens: 5, totalInputTokens: 40,
    cacheHitRatio: 0.75, peakPromptTokens: null, modelMs: 0, toolMs: 0, medianTtftMs: null, compactions: 0, contextManaged: null });
  assert.equal(summarizeTaskUsage([]).cacheHitRatio, null);
  // Tool time is elapsed time with at least one call running: overlapping calls are not counted twice. Calls ending at
  // 100, 150 and 400 ms that ran for 100, 100 and 50 ms cover [0,150] and [350,400]; one contained in another adds nothing.
  const call = (seq: number, endMs: number, durationMs?: number) => TaskEventSchema.parse({ ...base, eventId: randomUUID(), seq, type: 'tool_call',
    occurredAt: new Date(1_000_000 + endMs).toISOString(), payload: { turn: 1, callId: `toolu_${seq}`, tool: 'read_file', target: 'a.ts', status: 'ok', code: null,
      size: 1, ...(durationMs === undefined ? {} : { durationMs }) } });
  assert.equal(summarizeTaskUsage([call(2, 100, 100), call(3, 150, 100), call(4, 400, 50), call(5, 120, 20), call(6, 900)]).toolMs, 200);
  // Unknown or out-of-range metric fields are still rejected: the payloads stay strict.
  for (const extra of [{ timing: { ttftMs: -1, durationMs: 5 } }, { timing: { ttftMs: 1, durationMs: 1, note: 'x' } }, { context: { promptTokens: 1 } }, { prompt: 'text' }]) {
    assert.equal(TaskEventSchema.safeParse({ ...base, seq: 2, type: 'assistant_turn', payload: { turn: 1, model: 'claude-sonnet-5-5', messageId: null,
      stopReason: 'end_turn', toolCalls: 0, fallback: false, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, ...extra } }).success, false,
    JSON.stringify(extra));
  }
});
