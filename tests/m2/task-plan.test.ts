import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TaskPlanSchema, UpdatePlanInputSchema, PLAN_LIMITS } from '../../packages/contracts/dist/index.js';
import { withAgentHarness } from './support/agent-harness.ts';

const step = (id: string, status = 'pending', dependsOn: string[] = []) => ({ id, title: 'Step ' + id, status, dependsOn });
test('plans accept valid ordered dependencies and reject duplicate IDs, cycles and premature completion', () => {
  assert.ok(TaskPlanSchema.safeParse({ revision: 1, turn: 1, steps: [step('a','completed'),step('b','in_progress',['a'])] }).success);
  for (const steps of [[step('a'),step('a')], [step('a','pending',['b'])], [step('a','pending',['a'])],
    [step('a','pending',['b']),step('b','pending',['a'])], [step('a'),step('b','completed',['a'])],
    [step('a','in_progress'),step('b','in_progress')], [step('a'),step('b','pending',['a','a'])]]) {
    assert.equal(UpdatePlanInputSchema.safeParse({ steps }).success, false);
  }
});

test('a real Worker publishes and completes a plan through the selected model route', async t => {
  const replies = [
    { steps: [step('inspect','in_progress'),step('answer','pending',['inspect'])] },
    { steps: [step('inspect','completed'),step('answer','in_progress',['inspect'])] },
    { steps: [step('inspect','completed'),step('answer','completed',['inspect'])] },
  ];
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    assert.ok(body.tools.some((tool: { function: { name: string } }) => tool.function.name === 'update_plan'));
    const input = replies[calls++];
    return Response.json({ model: 'vendor/model', choices: [{ finish_reason: input ? 'tool_calls' : 'stop',
      message: { role: 'assistant', content: input ? null : 'Done', ...(input && { tool_calls: [
        { id: 'plan_' + calls, type: 'function', function: { name: 'update_plan', arguments: JSON.stringify(input) } },
      ] }) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
  });
  await withAgentHarness('http://127.0.0.1:1', async ({ store, runTask }) => {
    store.saveProviderModel('openrouter','vendor/model');
    store.saveSettings({ ...store.getSettings(), defaultProvider: 'openrouter' });
    const result = await runTask('Inspect the project then answer');
    assert.equal(result.state,'COMPLETED');
    assert.equal(result.events.filter(event => event.type === 'plan_updated').length,3);
    assert.equal(store.getTask(result.taskId)?.plan?.revision,3);
    assert.ok(store.getTask(result.taskId)?.plan?.steps.every(item => item.status === 'completed'));
    const durations = result.events.flatMap(event => event.type === 'tool_call' && event.payload.tool === 'update_plan'
      ? [event.payload.durationMs ?? 0] : []).sort((a,b) => a-b);
    t.diagnostic(JSON.stringify({ planUpdates: durations.length, medianMs: durations[1] }));
  }, { linkedKey: 'test-openrouter-key-' + 'x'.repeat(40) });
});

test('stalled plans produce bounded append-only reminders and retain unfinished steps at completion', async t => {
  let calls = 0;
  const steps = [step('inspect','in_progress')];
  const messages: unknown[][] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    messages.push(body.messages);
    const finish = ++calls > PLAN_LIMITS.stalledTurns * (PLAN_LIMITS.maxReminders + 1);
    return Response.json({ choices: [{ finish_reason: finish ? 'stop' : 'tool_calls', message: { role: 'assistant',
      content: finish ? 'Finished' : null, ...(!finish && { tool_calls: [{ id: 'plan_' + calls, type: 'function',
        function: { name: 'update_plan', arguments: JSON.stringify({ steps }) } }] }) } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 } });
  });
  await withAgentHarness('http://127.0.0.1:1', async ({ store, runTask }) => {
    store.saveProviderModel('openrouter','vendor/model');
    store.saveSettings({ ...store.getSettings(), defaultProvider: 'openrouter' });
    const result = await runTask('Inspect project');
    assert.equal(result.state,'COMPLETED');
    assert.equal(result.events.filter(e => e.type === 'plan_stalled').length, PLAN_LIMITS.maxReminders);
    assert.equal(result.events.filter(e => e.type === 'plan_updated').length,1);
    assert.equal(store.getTask(result.taskId)?.plan?.steps[0]?.status,'in_progress');
    const final = JSON.stringify(messages.at(-1));
    assert.equal(final.split('Your task plan has made no recorded progress').length - 1, PLAN_LIMITS.maxReminders);
  }, { linkedKey: 'test-openrouter-key-' + 'x'.repeat(40) });
});
