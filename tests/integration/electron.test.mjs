import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve, sep } from 'node:path';
import { root, until, environment, launchSidecar, closeDirectory, httpCall } from './sidecar-helper.mjs';
import { CONTROL_ROUTES, CONTROL_POLICY } from '../../packages/contracts/dist/index.js';
import { openStore } from '../../apps/server/dist/persistence/store.js';

const require = createRequire(import.meta.url);
const electron = require('../../apps/desktop/node_modules/electron');
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function launch(directory, modelEndpoint) {
  const env = { ...environment() };
  for (const key of ['DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR']) if (process.env[key]) env[key] = process.env[key];
  const child = spawn(electron, [resolve(root, 'tests/integration/electron-harness.mjs'), directory, ...(modelEndpoint ? [modelEndpoint] : [])], { cwd: root, env,
    windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let logs = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { logs = (logs + chunk).slice(-65536); });
  const exited = once(child, 'exit');
  const pending = new Map();
  child.on('message', message => {
    if (pending.has(message.id)) { const handler = pending.get(message.id); pending.delete(message.id); handler(message); }
  });
  const readiness = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('ELECTRON_START_TIMEOUT: ' + logs)), 30_000);
    child.once('message', message => { clearTimeout(timeout); if (message.kind === 'ready') resolve(message); else reject(new Error(JSON.stringify(message) + logs)); });
    child.once('exit', () => { clearTimeout(timeout); reject(new Error('ELECTRON_EXIT_BEFORE_READY: ' + logs)); });
    child.once('error', reject);
  });
  try { await readiness; } catch (error) { child.kill('SIGKILL'); await exited.catch(() => {}); throw error; }
  function command(command, input) {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timeout = setTimeout(() => { pending.delete(id); reject(new Error('TEST_COMMAND_TIMEOUT: ' + command + logs)); }, 20_000);
      pending.set(id, message => { clearTimeout(timeout); if (message.error) reject(new Error(message.error)); else resolve(message.value); });
      child.send({ id, command, input }, error => { if (error) { clearTimeout(timeout); pending.delete(id); reject(error); } });
    });
  }
  return { child, exited, command, logs: () => logs,
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try { await command('close'); } finally { if (alive(child.pid)) { const timer = setTimeout(() => child.kill('SIGKILL'), 6000); await exited; clearTimeout(timer); } }
    },
  };
}

async function fixture(t, modelEndpoint) {
  const cache = resolve(root, '.cache'); await mkdir(cache, { recursive: true });
  const directory = await mkdtemp(resolve(cache, 'electron-test-')); const hosts = [];
  t.after(async () => { for (const host of hosts) await host.close(); if (directory.startsWith(cache + sep)) await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const create = async () => { const host = await launch(directory, modelEndpoint); hosts.push(host); return host; };
  create.directory = directory;
  return create;
}

test('real Electron Main → sandboxed Preload → authenticated Express → SQLite, restart and normal exit', { timeout: 90_000 }, async t => {
  const create = await fixture(t); const host = await create();
  const first = await host.command('snapshot');
  assert.equal(first.electron, '45.0.0'); assert.equal(first.mainPid, host.child.pid); assert.notEqual(first.pid, first.mainPid);
  assert.equal(first.renderer.health.controlPlaneReady, true); assert.equal(first.renderer.health.agentReady, false);
  assert.equal(first.renderer.node, 'undefined'); assert.equal(first.renderer.require, 'undefined');
  assert.deepEqual(first.renderer.keys.sort(), ['getFoundationInfo', 'getControlPlaneHealth', 'listSmokeRecords', 'writeSmokeRecords', 'getDesktopStatus',
    'retryControlPlane', 'getOverview', 'getSettings', 'saveSettings', 'listProjects', 'addProject', 'removeProject', 'listRuns', 'startTask', 'stopTask', 'listTaskMessages', 'readTaskLive',
    'listTasks', 'getTask', 'listTaskEvents', 'getModelSettings', 'saveModelChoice', 'setApiKey', 'clearApiKey', 'testModelConnection',
    'getProviders', 'setProviderKey', 'clearProviderKey', 'testProvider', 'listProviderModels', 'saveProviderModel', 'listUsage',
    'saveCustomProvider', 'removeCustomProvider', 'beginHfLogin', 'pollHfLogin', 'cancelHfLogin', 'configureHf',
    'listAgents', 'saveAgent', 'removeAgent', 'listMcpServers', 'saveMcpServer', 'removeMcpServer', 'listProjectSkills', 'setProjectSkill',
    'previewProjectSkill', 'listGitHubSkills', 'previewGitHubSkill'].sort());
  assert.equal(first.renderer.mounted, true);
  assert.equal(await host.command('csp'), 'blocked'); assert.equal(await host.command('invalid-input'), 'rejected');
  assert.match(await host.command('foreign-window'), /IPC_SENDER_REJECTED/);
  assert.equal(await host.command('navigation'), true);
  const id = randomUUID(); await host.command('write', { records: [{ id, value: '真实 Renderer 持久化 "UTF-8"' }] });
  process.kill(first.pid, 'SIGKILL');
  const restarted = await until(async () => {
    const state = await host.command('state'); return state.state === 'ready' && state.expressRunId !== first.expressRunId ? state : false;
  }, 25_000);
  assert.equal(alive(first.pid), false); assert.notEqual(restarted.pid, first.pid);
  assert.equal((await host.command('snapshot')).renderer.health.recoveredRuns, 1);
  assert.equal((await host.command('list')).records[0].id, id);
  assert.equal((await host.command('list')).records[0].value, '真实 Renderer 持久化 "UTF-8"');
  await host.close(); assert.equal(host.child.exitCode, 0); assert.equal(alive(restarted.pid), false);
  const reopened = await create();
  assert.equal((await reopened.command('snapshot')).renderer.health.recoveredRuns, 0);
  assert.equal((await reopened.command('list')).records[0].id, id);
});

test('a full result of maximally escaped UTF-8 records round-trips through the real Preload bridge', { timeout: 45_000 }, async t => {
  const create = await fixture(t); const host = await create();
  const records = Array.from({ length: 100 }, () => ({ id: randomUUID(), value: '\u0000'.repeat(253) + '持久化' }));
  for (let offset = 0; offset < records.length; offset += 10) await host.command('write', { records: records.slice(offset, offset + 10) });
  const result = await host.command('list');
  assert.ok(Buffer.byteLength(JSON.stringify(result)) > 65_536);
  assert.equal(result.records.length, 100);
  assert.deepEqual(result.records.map(record => record.id).sort(), records.map(record => record.id).sort());
  assert.ok(result.records.every(record => record.value === records[0].value));
  await host.close();
  const reopened = await create();
  assert.deepEqual((await reopened.command('list')).records, result.records);
});

test('unauthenticated traffic and a real Renderer burst preserve Main heartbeats and the Sidecar lease', { timeout: 45_000 }, async t => {
  const host = await (await fixture(t))();
  const first = await host.command('state');
  const stranger = { mainRunId: randomUUID(), expressRunId: randomUUID(), token: '0'.repeat(64) };
  for (let index = 0; index <= CONTROL_POLICY.maxRequestsPerWindow; index++) {
    assert.ok([401, 429].includes((await httpCall(first.port, stranger)).status));
  }
  const burst = await host.command('health-burst', CONTROL_POLICY.maxRequestsPerWindow + 1);
  assert.ok(burst.accepted > 0); assert.ok(burst.rejected > 0);
  await delay(CONTROL_POLICY.shutdownMs + 2 * CONTROL_POLICY.heartbeatMs);
  const after = await host.command('state');
  assert.equal(after.state, 'ready'); assert.equal(after.pid, first.pid);
  assert.equal(after.expressRunId, first.expressRunId); assert.equal(after.restarts, 0);
});

test('real Main crash closes the inherited channel and the responsive Sidecar exits', { timeout: 60_000 }, async t => {
  const create = await fixture(t); const host = await create(); const first = await host.command('snapshot');
  host.child.kill('SIGKILL'); await host.exited;
  await until(() => !alive(first.pid), 8000);
  const next = await create();
  assert.equal((await next.command('snapshot')).renderer.health.recoveredRuns, 1);
});

test('repeated real Sidecar crashes exhaust the bounded restart budget', { timeout: 90_000 }, async t => {
  const create = await fixture(t); const host = await create();
  for (let attempt = 0; attempt < 4; attempt++) {
    const state = await host.command('state'); assert.equal(state.state, 'ready');
    process.kill(state.pid, 'SIGKILL');
    await until(async () => {
      const next = await host.command('state');
      return attempt === 3 ? next.state === 'budget-exhausted' : next.state === 'ready' && next.expressRunId !== state.expressRunId;
    }, 25_000);
  }
  const exhausted = await host.command('state'); assert.equal(exhausted.pid, null); assert.equal(exhausted.restarts, 3);
  await assert.rejects(host.command('snapshot'), /SERVICE_UNAVAILABLE/);
});

test('the production Main entry flushes SQLite and exits through the real window-close lifecycle', { timeout: 45_000 }, async t => {
  const cache = resolve(root, '.cache'); await mkdir(cache, { recursive: true });
  const directory = await mkdtemp(resolve(cache, 'electron-entry-'));
  const database = resolve(directory, 'control-plane');
  const child = spawn(electron, [resolve(root, 'tests/integration/electron-entry.mjs'), directory], {
    cwd: root, env: environment(), windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    await closeDirectory(database);
    if (directory.startsWith(cache + sep)) await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  let logs = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { logs = (logs + chunk).slice(-65536); });
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ENTRY_TIMEOUT: ' + logs)), 30_000);
    child.once('message', message => { clearTimeout(timer); resolve(message); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('ENTRY_FAILED: ' + logs)); });
  });
  assert.equal(result.health.controlPlaneReady, true); assert.equal(result.health.agentReady, false);
  await exited; assert.equal(child.exitCode, 0);
  const reopened = await launchSidecar(database);
  assert.equal((await reopened.call('GET', CONTROL_ROUTES.health)).body.recoveredRuns, 0);
  assert.equal((await reopened.call('GET', CONTROL_ROUTES.records)).body.records[0].id, result.id);
});

test('workbench settings persist, invalid input and Worker-less task starts are refused through the real bridge', { timeout: 60_000 }, async t => {
  const create = await fixture(t); const host = await create();
  const result = await host.command('workbench');
  assert.equal(result.saved.theme, 'dark'); assert.equal(result.saved.stopGraceMs, 10000);
  assert.equal(result.saved.maxAgentTurns, 10); assert.equal(result.invalidTurnLimit, 'rejected');
  assert.equal(result.tooLong, 'rejected'); assert.match(result.missing, /NOT_FOUND/);
  assert.deepEqual(result.task, { accepted: false, error: 'WORKER_ISOLATION_UNAVAILABLE' });
  assert.equal(result.emptyTask, 'rejected'); assert.equal(result.forged, 'rejected');
  assert.equal(result.overview.agentReady, false); assert.equal(result.overview.database.version, 14);
  assert.equal(result.overview.worker.error, 'WORKER_ISOLATION_UNAVAILABLE');
  assert.equal(result.overview.tools.read, 'READ_ADAPTER_UNAVAILABLE');
  assert.deepEqual(result.overview.capabilities,
    { ui: 'unverified', read: 'unavailable', gitRead: 'unavailable', highRisk: 'unavailable', workerIsolation: 'unverified' });
  assert.equal(result.runs.runs[0].outcome, 'RUNNING'); assert.deepEqual(result.projects.projects, []);
  // P2.2 read-only task views: a refused start persists nothing, and unknown or malformed queries fail closed.
  assert.deepEqual(result.tasks, { tasks: [] });
  assert.match(result.missingTask, /NOT_FOUND/); assert.match(result.missingEvents, /NOT_FOUND/); assert.equal(result.badCursor, 'rejected');
  await host.close();
  const reopened = await create();
  const again = await reopened.command('workbench');
  assert.equal(again.after.theme, 'dark'); assert.equal(again.after.stopGraceMs, 10000);
  assert.equal(again.after.maxAgentTurns, 10);
  assert.deepEqual(again.runs.runs.slice(0, 2).map(run => run.outcome), ['RUNNING', 'CLEAN']);
});

test('the Workbench lists committed tasks, replays their events and resyncs after a control-plane restart', { timeout: 90_000 }, async t => {
  const create = await fixture(t);
  // Seed through the Express store: one finished task with a tool result, one left RUNNING.
  const seed = openStore(resolve(create.directory, 'database'), randomUUID());
  const projectId = seed.addProject({ name: 'seeded', path: 'C:/OperationAgentP23/seeded' }).id;
  const step = (taskId, to) => seed.transitionTask(taskId, to, { requestId: randomUUID() });
  const done = seed.createTask(projectId, randomUUID()).task.id;
  step(done, 'QUEUED'); step(done, 'RUNNING');
  seed.recordToolSummary({ type: 'tool_output_summary', taskId: done, toolCallId: randomUUID(), attemptId: randomUUID(), stdoutBytes: 2048,
    stderrBytes: 12, sampledBytes: 2060, truncatedBytes: 0, exitCode: 0, diagnostics: [{ severity: 'warning', summary: '1 deprecated option' }] }, randomUUID());
  step(done, 'COMPLETED');
  const running = seed.createTask(projectId, randomUUID()).task.id;
  step(running, 'QUEUED'); step(running, 'RUNNING');
  seed.close(true);

  const host = await create();
  const completed = await host.command('task-ui', { taskId: done, click: true, entries: 5 });
  assert.equal(completed.rows, 2); assert.equal(completed.entries, 5);
  assert.match(completed.pill, /Completed/); assert.match(completed.meta, /5 ?\/ ?5 events/); assert.equal(completed.interrupted, false);
  assert.match(completed.text, /exit 0/); assert.match(completed.text, /1 deprecated option/);
  // Opening the sidecar recovered the RUNNING task: INTERRUPTED with unknown side effects, never resumed.
  const interrupted = await host.command('task-ui', { taskId: running, click: true, entries: 4 });
  assert.equal(interrupted.entries, 4); assert.match(interrupted.pill, /Interrupted/); assert.equal(interrupted.interrupted, true);
  assert.match(interrupted.text, /side effects UNKNOWN/);
  await host.command('capture', `p1/${process.platform}-${process.arch}/workbench-task.png`);
  assert.equal(await host.command('new-task-shortcut'), 'composer-focused');
  await host.command('task-ui', { taskId: running, click: true, entries: 4 });

  const before = await host.command('state');
  process.kill(before.pid, 'SIGKILL');
  await until(async () => { const state = await host.command('state'); return state.state === 'ready' && state.expressRunId !== before.expressRunId; }, 25_000);
  // The new Express instance serves the same committed log; the view resumes from its cursor.
  const after = await host.command('task-ui', { taskId: running, entries: 4, fresh: true });
  assert.deepEqual([after.entries, after.rows], [4, 2]); assert.match(after.meta, /4 ?\/ ?4 events/);
});

test('M2 conversation: a committed agent task shows its prompt, Markdown answers, tool calls and outcome; model text stays inert', { timeout: 90_000 }, async t => {
  const create = await fixture(t);
  const seed = openStore(resolve(create.directory, 'database'), randomUUID());
  const projectId = seed.addProject({ name: 'agent', path: 'C:/OperationAgentM2/agent' }).id;
  const task = seed.createTask(projectId, randomUUID()).task.id;
  const step = to => seed.transitionTask(task, to, { requestId: randomUUID(), sideEffects: to === 'COMPLETED' ? 'VERIFIED' : null,
    reason: to === 'COMPLETED' ? 'Read-only task: no files were changed' : null });
  const usage = { inputTokens: 900, outputTokens: 120, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const context = promptTokens => ({ promptTokens, managed: true, compacted: false });
  step('QUEUED');
  const prompt = seed.addTaskMessage(task, 'user', 0, 'How is this project built?');
  seed.appendAgentEvent(task, 'user_message', { messageId: prompt.id, chars: 26 });
  step('RUNNING');
  const first = seed.addTaskMessage(task, 'assistant', 1, 'Let me look at the layout first.');
  seed.appendAgentEvent(task, 'assistant_turn', { turn: 1, model: 'claude-sonnet-5-5', messageId: first.id, stopReason: 'tool_use', toolCalls: 3, fallback: false, usage,
    timing: { ttftMs: 400, durationMs: 2_100 }, context: context(900) });
  seed.appendAgentEvent(task, 'tool_call', { turn: 1, callId: 'toolu_a', tool: 'list_directory', target: '.', status: 'ok', code: null, size: 12, durationMs: 80 });
  seed.appendAgentEvent(task, 'tool_call', { turn: 1, callId: 'toolu_b', tool: 'read_file', target: '.env', status: 'refused', code: 'SENSITIVE_PATH', size: null, durationMs: 5 });
  seed.appendAgentEvent(task, 'tool_call', { turn: 1, callId: 'toolu_c', tool: 'read_file', target: 'package.json', status: 'ok', code: null, size: 348, durationMs: 8 });
  const answer = ['## Build', '', 'It uses **pnpm** and `tsc -b`:', '', '```bash', 'pnpm install', 'pnpm build', '```', '',
    '- Lint with `pnpm lint`', '- Test with `pnpm test`', '', 'Injected <img src=x onerror="window.__pwned=1"> stays text.'].join('\n');
  const second = seed.addTaskMessage(task, 'assistant', 2, answer);
  seed.appendAgentEvent(task, 'assistant_turn', { turn: 2, model: 'claude-sonnet-5-5', messageId: second.id, stopReason: 'end_turn', toolCalls: 0, fallback: false,
    usage: { inputTokens: 300, outputTokens: 120, cacheReadTokens: 900, cacheWriteTokens: 0 }, timing: { ttftMs: 600, durationMs: 3_400 }, context: context(1_200) });
  step('COMPLETED');

  const addTimingSample = (provider, model, turnTiming, toolDuration) => {
    const { id } = seed.createTask(projectId, randomUUID()).task;
    seed.transitionTask(id, 'QUEUED', { requestId: randomUUID(), sideEffects: null, reason: null });
    const request = seed.addTaskMessage(id, 'user', 0, 'Review the operation.');
    seed.appendAgentEvent(id, 'user_message', { messageId: request.id, chars: request.text.length });
    seed.transitionTask(id, 'RUNNING', { requestId: randomUUID(), sideEffects: null, reason: null });
    const response = seed.addTaskMessage(id, 'assistant', 1, 'The operation finished.');
    seed.appendAgentEvent(id, 'assistant_turn', { turn: 1, provider, model, messageId: response.id, stopReason: 'end_turn', toolCalls: 1,
      fallback: false, usage, ...(turnTiming && { timing: turnTiming }) });
    seed.appendAgentEvent(id, 'tool_call', { turn: 1, callId: 'toolu_timing', tool: 'list_directory', target: '.', status: 'ok',
      code: null, size: 1, ...(toolDuration !== undefined && { durationMs: toolDuration }) });
    seed.transitionTask(id, 'COMPLETED', { requestId: randomUUID(), sideEffects: 'VERIFIED', reason: null });
    return id;
  };
  const buffered = addTimingSample('openai', 'gpt-4o', { ttftMs: null, durationMs: 2_300 }, 750);
  const legacy = addTimingSample('openrouter', 'legacy-model');
  seed.close(true);

  const host = await create();
  const view = await host.command('conversation-ui', { taskId: task, answers: 2 });
  assert.equal(view.prompt, 'How is this project built?');
  assert.equal(view.answers.length, 2);
  assert.match(view.answers[0], /Let me look at the layout first/);
  assert.deepEqual(view.code, ['pnpm install\npnpm build']);
  assert.equal(view.headings, 1); assert.equal(view.listItems, 2);
  assert.equal(view.tools.length, 3);
  assert.match(view.tools[0], /Listed/); assert.match(view.tools[1], /\.env/); assert.match(view.tools[1], /SENSITIVE_PATH/);
  assert.match(view.answers[1], /<img src=x onerror=/, 'markup in model output is shown as text');
  assert.equal(view.images, 0); assert.equal(view.scripts, 0);
  assert.equal(view.pwned, false, 'no handler from model output ever ran');
  assert.match(view.end, /Done/); assert.match(view.end, /no files were changed/);
  assert.deepEqual(view.filePaths, ['package.json']);
  assert.match(view.result, /Completed.*no files were changed/);
  assert.equal(view.resultCode, 'pnpm install\npnpm build');
  assert.equal(view.stop, false, 'a finished task offers no Stop');
  assert.match(view.activity, /Activity log/);
  // The usage line is derived from the committed turn and tool events: 900 + 300 + 900 input tokens, 900 of them cached.
  assert.match(view.usage, /turns 2 · tool calls 3/);
  assert.match(view.usage, /input 2,100 tokens \(43% cached\)/);
  assert.match(view.usage, /output 240 tokens/);
  assert.match(view.usage, /model 5\.5s/);
  assert.match(view.usage, /first content 0\.5s \(median\)/);
  assert.match(view.usage, /tools 0\.1s/);
  await host.command('capture', `m2/${process.platform}-${process.arch}/conversation.png`);
  const bufferedView = await host.command('conversation-ui', { taskId: buffered, answers: 1 });
  assert.match(bufferedView.usage, /model 2\.3s/);
  assert.match(bufferedView.usage, /tools 0\.8s/);
  assert.doesNotMatch(bufferedView.usage, /first content/);
  const legacyView = await host.command('conversation-ui', { taskId: legacy, answers: 1 });
  assert.match(legacyView.usage, /turns 1 · tool calls 1/);
  assert.doesNotMatch(legacyView.usage, /model .*s|first content|tools .*s/);
  const [provider, model, ...counts] = await host.command('usage-ui');
  assert.equal(provider, 'Anthropic');
  assert.equal(model, 'claude-sonnet-5-5');
  assert.deepEqual(counts.map(value => Number(value.replace(/\D/g, ''))), [2, 2100, 900, 0, 240, 2340]);
});

test('M5.3 task plans retain progress and dependencies across terminal states, locales and Electron restart', { timeout: 90_000 }, async t => {
  const create = await fixture(t);
  const seed = openStore(resolve(create.directory, 'database'), randomUUID());
  const tasks = {};
  try {
    const projectId = seed.addProject({ name: 'plans', path: 'C:/OperationAgentM53/plans' }).id;
    const transition = (id, to) => seed.transitionTask(id, to, { requestId: randomUUID(), cleanupConfirmed: true });
    for (const state of ['COMPLETED', 'FAILED', 'STOPPED', 'INTERRUPTED', 'complete', 'legacy']) {
      const id = tasks[state] = seed.createTask(projectId, randomUUID()).task.id;
      transition(id, 'QUEUED'); transition(id, 'RUNNING');
      if (state !== 'legacy') {
        const steps = [
          { id: 'inspect', title: '检查项目 / Inspect project', status: 'in_progress', dependsOn: [] },
          { id: 'verify', title: '验证结果 / Verify results', status: 'pending', dependsOn: ['inspect'] },
          { id: 'report', title: '整理报告 / Report findings', status: 'pending', dependsOn: ['verify'] },
        ];
        assert.equal(seed.updateTaskPlan(id, 'plan_initial', 1, { steps }).changed, true);
        steps[0].status = 'completed'; steps[1].status = 'in_progress';
        const updated = seed.updateTaskPlan(id, 'plan_progress', 2, { steps });
        assert.equal(updated.changed, true); assert.equal(updated.plan.revision, 2);
        assert.equal(seed.updateTaskPlan(id, 'plan_unchanged', 3, { steps }).changed, false);
        seed.appendAgentEvent(id, 'plan_stalled', { turn: 4 });
        if (state === 'complete') seed.updateTaskPlan(id, 'plan_done', 5, { steps: steps.map(step => ({ ...step, status: 'completed' })) });
      }
      if (state === 'STOPPED') transition(id, 'STOPPING');
      transition(id, ['complete', 'legacy'].includes(state) ? 'COMPLETED' : state);
    }
  } finally { seed.close(true); }

  const host = await create();
  assert.equal((await host.command('task-ui', { taskId: tasks.legacy, click: true })).plan, null);
  for (const state of ['COMPLETED', 'FAILED', 'STOPPED', 'INTERRUPTED']) {
    const view = await host.command('task-ui', { taskId: tasks[state], click: true, language: 'en' });
    assert.equal(view.plan.revision, 2); assert.equal(view.plan.completed, 1); assert.equal(view.plan.total, 3);
    assert.deepEqual(view.plan.steps.map(step => step.status), ['completed', 'in_progress', 'pending']);
    assert.match(view.plan.text, /1 of 3 steps completed/);
    assert.match(view.plan.steps[1].text, /Depends on: 检查项目 \/ Inspect project/);
    assert.match(view.plan.steps[2].text, /Depends on: 验证结果 \/ Verify results/);
    assert.match(view.plan.incomplete, /2 steps remain unfinished/);
    assert.equal(view.plan.overflow, false);
    assert.match(view.text, /Task plan updated/); assert.match(view.text, /Plan progress stalled at turn 4/);
    assert.doesNotMatch(view.text, /plan_updated|plan_stalled/);
  }
  for (const [language, count, incomplete, updated, stalled] of [
    ['zh-CN', /已完成 1\/3 步/, /仍有 2 个步骤未完成/, /任务计划已更新/, /第 4 轮计划进度停滞/],
    ['ja', /3 ステップ中 1 ステップ完了/, /未完了のステップが 2 件/, /タスク計画を更新しました/, /ターン 4 で計画の進行が停滞/],
  ]) {
    const view = await host.command('task-ui', { taskId: tasks.FAILED, click: true, language });
    assert.match(view.plan.text, count); assert.match(view.plan.incomplete, incomplete);
    assert.match(view.text, updated); assert.match(view.text, stalled);
  }
  const done = await host.command('task-ui', { taskId: tasks.complete, click: true, language: 'en' });
  assert.equal(done.plan.completed, 3); assert.equal(done.plan.revision, 3); assert.equal(done.plan.incomplete, null);
  await host.command('task-ui', { taskId: tasks.FAILED, click: true });
  await host.command('capture', `m5/${process.platform}-${process.arch}/task-plan.png`);
  await host.close();
  const reopened = await create();
  const restored = await reopened.command('task-ui', { taskId: tasks.STOPPED, click: true });
  assert.equal(restored.plan.completed, 1); assert.equal(restored.plan.revision, 2);
  assert.match(restored.plan.incomplete, /2 steps remain unfinished/);
});

test('project skills and integration catalog: real Electron previews, authorizes, navigates and rechecks skills after restart',
  { skip: (process.platform !== 'win32' || process.arch !== 'x64') && 'win32-x64 only', timeout: 90_000 }, async t => {
    const create = await fixture(t);
    const workspace = resolve(create.directory, 'workspace');
    const folder = resolve(workspace, '.claude', 'skills', 'review');
    await mkdir(folder, { recursive: true });
    const writeSkill = text => writeFile(resolve(folder, 'SKILL.md'),
      `---\nname: review\ndescription: ${text}\n---\n## Checklist\n\n- Read the proposed change.\n- Verify the affected paths.\n\n<img src=x onerror="window.__skillPreviewFired=1">\n`);
    await writeSkill('Read the project before making recommendations');
    const seed = openStore(resolve(create.directory, 'database'), randomUUID());
    const project = seed.addProject({ name: 'With skills', path: workspace });
    seed.saveSettings({ ...seed.getSettings(), activeProjectId: project.id, language: 'en' });
    seed.close(true);

    const host = await create();
    const enabled = await host.command('project-skills-ui', { before: 'available', action: 'enable-skill', after: 'enabled' });
    assert.match(enabled.current, /Revoke/);
    assert.match(enabled.current, /Checklist/);
    assert.equal(enabled.activeContent, false);
    await host.command('capture', `m6/${process.platform}-${process.arch}/project-skills.png`);
    const integrations = await host.command('integrations-ui');
    assert.equal(integrations.providerDetail, 'openai');
    assert.equal(integrations.mcpForm, true);
    await host.close();

    const reopened = await create();
    const saved = await reopened.command('project-skills-ui', { before: 'enabled', after: 'enabled' });
    assert.match(saved.current, /Read the project before making recommendations/);
    await writeSkill('Read the latest project priorities');
    const changed = await reopened.command('project-skills-ui', { before: 'changed', action: 'enable-skill', after: 'enabled' });
    assert.match(changed.initial, /Authorize new version/);
    assert.match(changed.current, /Read the latest project priorities/);
    if (process.env.OA_LIVE_GITHUB_SKILLS === '1') {
      const remote = await reopened.command('github-skills-live');
      assert.ok(remote.count > 0 && remote.previewChars > 0);
      assert.equal(remote.customHasMetadata, false);
      assert.equal(remote.rawHasMetadata, true);
      await reopened.command('capture', `m6/${process.platform}-${process.arch}/github-skills.png`);
      await reopened.close();
      const restarted = await create();
      assert.equal((await restarted.command('github-skills-live', { remove: true })).removed, true);
    }
  });

test('custom provider confirmation encrypts its dedicated key and survives Electron restart', { timeout: 90_000 }, async t => {
  const create = await fixture(t);
  const host = await create();
  const profile = { baseUrl: 'http://127.0.0.1:12345/v1', allowLocal: true, model: 'local-model', apiKey: 'custom-key-' + randomUUID() };
  const cancelled = await host.command('custom-api', { profile, accept: false });
  assert.deepEqual(cancelled.overview.custom, []);
  const saved = await host.command('custom-api', { profile, accept: true });
  assert.match(saved.confirmation, /127\.0\.0\.1/);
  assert.equal(saved.overview.custom[0].baseUrl, profile.baseUrl);
  assert.equal(JSON.stringify(saved).includes(profile.apiKey), false);
  assert.equal((await allBytes(create.directory)).includes(profile.apiKey), false);
  await host.command('close');
  const reopened = await create();
  const view = await reopened.command('providers-get');
  assert.deepEqual(view.custom, saved.overview.custom);
});

test('settings stays centered below caption controls at supported window sizes', { timeout: 90_000 }, async t => {
  const host = await (await fixture(t))();
  for (const [width, height, theme] of [[1360,860,'light'],[1360,860,'dark'],[960,600,'dark'],[1920,1080,'light']]) {
    const view = await host.command('settings-layout', { width, height, theme });
    assert.ok(view.y >= 56, JSON.stringify(view));
    assert.ok(view.x >= 32);
    assert.ok(view.width <= 1120);
    assert.ok(Math.abs(view.x * 2 + view.width - view.viewport[0]) <= 2);
    assert.ok(Math.abs(view.y * 2 + view.height - view.viewport[1]) <= 2);
    assert.equal(view.overflow, false);
    assert.equal(view.brand, 'OperationAgent');
    assert.equal(view.marks, 0);
    if (width === 1360) await host.command('capture', 'ui/settings-' + theme + '.png');
  }
});

/** Every file under a directory, for a plaintext scan of everything Electron, Express and SQLite left on disk. */
async function allBytes(directory) {
  const chunks = [];
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) chunks.push((await readFile(resolve(entry.parentPath, entry.name)).catch(() => Buffer.alloc(0))).toString('latin1'));
  }
  return chunks.join('\n');
}

test('M2 model settings: the key goes in once through the real bridge, is encrypted at rest and tested against a fake provider', { timeout: 120_000 }, async t => {
  // A loopback stand-in for api.anthropic.com: accepts exactly the expected key, never anything else.
  const key = `sk-ant-api03-${randomUUID().replaceAll('-', '')}M2LEAKPROBE${'k'.repeat(36)}Qx9v`;
  const seen = [];
  const provider = createServer((req, res) => {
    let body = ''; req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      seen.push({ path: req.url, key: req.headers['x-api-key'], version: req.headers['anthropic-version'], body: JSON.parse(body) });
      res.writeHead(req.headers['x-api-key'] === key ? 200 : 401, { 'content-type': 'application/json' }).end('{"type":"message"}');
    });
  });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  t.after(() => new Promise(done => provider.close(done)));
  const create = await fixture(t, `http://127.0.0.1:${provider.address().port}`);
  const host = await create();

  // Real DOM: Settings → Model, type the key, save it, Test connection.
  const ui = await host.command('model-ui', { key });
  assert.equal(ui.emptyState, 'empty'); assert.equal(ui.leftInDom, false, 'the typed key must be cleared from the DOM once saved');
  assert.equal(ui.masked, 'sk-ant-••••••••••••Qx9v'); assert.equal(ui.credential, 'configured');
  assert.equal(ui.status, 'ok'); assert.match(ui.resultText, /Connected/); assert.equal(ui.active, 'claude-sonnet-5-5');
  assert.deepEqual(seen.at(-1), { path: '/v1/messages', key, version: '2023-06-01',
    body: { model: 'claude-sonnet-5-5', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] } });
  await host.command('capture', `m2/${process.platform}-${process.arch}/settings-model-light.png`);
  await host.command('appearance', 'dark');
  await host.command('capture', `m2/${process.platform}-${process.arch}/settings-model-dark.png`);
  await host.command('appearance', 'system');

  // Fixed operations: schema checks on both sides, a model switch, and a replies that never carry key material.
  const api = await host.command('model-api', { key });
  assert.equal(api.before.credential.configured, true); assert.equal(api.before.secureStorage, 'available');
  assert.equal(api.invalid, 'VALIDATION_ERROR'); assert.equal(api.extra, 'VALIDATION_ERROR'); assert.match(api.badModel, /invalid|Invalid/);
  assert.equal(api.chosen.model, 'claude-opus-5-5');
  assert.deepEqual(Object.keys(api.saved.credential).sort(), ['configured', 'hint', 'updatedAt']);
  assert.equal(api.saved.credential.hint, 'Qx9v');
  assert.equal(api.test.status, 'ok'); assert.equal(api.test.model, 'claude-opus-5-5'); assert.equal(seen.at(-1).body.model, 'claude-opus-5-5');
  assert.equal(JSON.stringify(api).includes('M2LEAKPROBE'), false, 'no reply may contain the key');

  // SEC-14 through the real Main bridge: no OS-backed encryption means no save, and the stored key is untouched.
  const refused = await host.command('model-unavailable', { key: key.replace('Qx9v', 'Zz00') });
  if (refused !== 'unpatchable') {
    assert.equal(refused.view.secureStorage, 'unavailable'); assert.match(refused.error, /SECURE_STORAGE_UNAVAILABLE$/);
    assert.equal(refused.after.credential.hint, 'Qx9v');
  } else t.diagnostic('safeStorage could not be patched in this Electron build; SEC-14 refusal is covered by tests/m2 unit tests');

  // The ciphertext survives a full restart and still decrypts through the new instance's bridge.
  await host.close();
  const reopened = await create();
  assert.equal((await reopened.command('model-test')).status, 'ok');
  assert.equal(seen.at(-1).key, key);
  const cleared = await reopened.command('model-clear');
  assert.deepEqual(cleared.cleared.credential, { configured: false }); assert.equal(cleared.test.status, 'not_configured');
  const logs = host.logs() + reopened.logs();
  await reopened.close();
  // SEC-20: nothing on disk (SQLite, WAL, Chromium profile) or in process output holds the plaintext.
  assert.equal((await allBytes(create.directory)).includes('M2LEAKPROBE'), false, 'plaintext key found on disk');
  assert.equal(logs.includes('M2LEAKPROBE'), false, 'plaintext key found in process output');
});
