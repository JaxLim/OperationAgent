// M2: the production agent runtime, launched through the production native launcher (launchWorker: AppContainer + Job
// + HANDLE_LIST, token baseline verified before resume), runs a real read-only task end to end against a local fake of
// the Messages API. It creates an AppContainer profile and grants the runtime ACL, so (ADR-WIN-001 §3) it runs only on a
// disposable Windows x64 runner; anywhere else it is BLOCKED, never skipped into a pass.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { openStore } from '../../apps/server/dist/persistence/store.js';
import { createCredentialService } from '../../apps/server/dist/credentials/service.js';
import { createTurnGateway } from '../../apps/server/dist/models/turns.js';
import { createToolRouter } from '../../apps/server/dist/tools/router.js';
import { LiveFeed } from '../../apps/server/dist/agent/live.js';
import { TaskRunner } from '../../apps/server/dist/agent/runner.js';
import { AgentWorkerSupervisor } from '../../apps/server/dist/agent/supervisor.js';
import { SIDECAR_ENVIRONMENT } from '../../packages/contracts/dist/index.js';

const runner = process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_OS === 'Windows' && process.platform === 'win32' && process.arch === 'x64';
const root = resolve(import.meta.dirname, '../..');
const runtime = resolve(root, 'build/stage/win-x64/sidecar/worker');
const KEY = 'sk-ant-api03-' + 'r'.repeat(40) + 'RUNNERKEY';
const CANARY = `OA-AGENT-RUNTIME-${randomUUID()}`;

test('BLOCKED unless running on a disposable Windows x64 runner', () => {
  assert.ok(runner, 'BLOCKED: the isolated agent runtime requires a disposable GitHub Actions Windows x64 runner (ADR-WIN-001 §3)');
});

test('the isolated agent runtime runs a read-only task end to end and its cleanup is confirmed', { skip: runner ? false : 'BLOCKED', timeout: 180_000 }, async t => {
  for (const file of ['node.exe', 'bootstrap.mjs', 'channel.node', 'package.json']) assert.ok(existsSync(resolve(runtime, file)), `staged ${file}`);
  const cache = resolve(root, '.cache'); mkdirSync(cache, { recursive: true });
  const base = mkdtempSync(resolve(cache, 'agent-runtime-'));
  const workspace = resolve(base, 'workspace'); mkdirSync(resolve(workspace, 'src'), { recursive: true });
  writeFileSync(resolve(workspace, 'README.md'), `# Runner demo\n${CANARY}\n`);
  writeFileSync(resolve(workspace, 'src', 'main.ts'), 'export const ok = true;\n');
  const bodies = [];
  const sse = (res, events, end = true) => { res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`); if (end) res.end(); };
  const start = { type: 'message_start', message: { id: 'msg_r', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [],
    stop_reason: null, stop_sequence: null, usage: { input_tokens: 30, output_tokens: 1 } } };
  const stop = reason => [{ type: 'message_delta', delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 5 } }, { type: 'message_stop' }];
  const tool = (index, id, name, input) => [{ type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } },
    { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }, { type: 'content_block_stop', index }];
  const text = (index, value) => [{ type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index, delta: { type: 'text_delta', text: value } }, { type: 'content_block_stop', index }];
  const scripts = [res => sse(res, [start, ...tool(0, 'toolu_l', 'list_directory', { path: '.', depth: 2 }), ...tool(1, 'toolu_r', 'read_file', { path: 'README.md' }), ...stop('tool_use')]),
    res => sse(res, [start, ...text(0, 'It is a runner demo.'), ...stop('end_turn')])];
  const provider = createServer((req, res) => { const chunks = []; req.on('data', c => chunks.push(c));
    req.on('end', () => { bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8'))); scripts[Math.min(bodies.length - 1, scripts.length - 1)](res); }); });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  const store = openStore(resolve(base, 'data'), randomUUID());
  const flip = value => Buffer.from(Buffer.from(value, 'latin1').map(byte => byte ^ 0x5a)).toString('latin1');
  const credentials = createCredentialService(store, { encrypt: async p => Buffer.from(flip(p), 'latin1').toString('base64'), decrypt: async c => flip(Buffer.from(c, 'base64').toString('latin1')) });
  await credentials.set(KEY);
  const projectId = store.addProject({ name: 'runner', path: workspace }).id;
  const holder = {};
  const taskRunner = new TaskRunner({ store, credentials, gateway: createTurnGateway({ endpoint: `http://127.0.0.1:${provider.address().port}`, maxRetries: 0 }),
    tools: createToolRouter({ store }), model: () => 'claude-sonnet-5-5', live: new LiveFeed(), stopGraceMs: () => 5_000, ensureWorker: () => holder.supervisor.ensure() });
  const supervisor = holder.supervisor = new AgentWorkerSupervisor({ runtimeDirectory: runtime, expressRunId: randomUUID(), runner: taskRunner });
  // Launch from exactly the environment Main gives the Express sidecar, so the Main → Express boundary is exercised too.
  // Built the way Main builds it: each allowed name is looked up through process.env (case-insensitive on Windows) and
  // set under its contract spelling. Filtering the existing keys by exact name is wrong here: a runner step started from
  // Git Bash spells the variable SYSTEMROOT, so that would drop SystemRoot and no child Node process could start.
  const saved = { ...process.env };
  const sidecarEnvironment = Object.fromEntries(SIDECAR_ENVIRONMENT.filter(key => process.env[key]).map(key => [key, process.env[key]]));
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, sidecarEnvironment);
  assert.ok(process.env.SystemRoot && process.env.LOCALAPPDATA, 'the sidecar environment carries SystemRoot and LOCALAPPDATA');
  t.after(() => { for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, saved); });
  try {
    const task = await taskRunner.start(projectId, 'What is this project?', randomUUID());
    const deadline = Date.now() + 120_000;
    while (!['COMPLETED', 'FAILED', 'INTERRUPTED'].includes(store.getTask(task.id).state) && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
    const events = store.listTaskEvents(task.id, 0);
    t.diagnostic(JSON.stringify({ state: store.getTask(task.id).state, supervisor: supervisor.snapshot(), events: events.map(e => e.type) }));
    assert.equal(store.getTask(task.id).state, 'COMPLETED');
    const calls = events.filter(e => e.type === 'tool_call').map(e => [e.payload.tool, e.payload.status]);
    assert.deepEqual(calls.sort(), [['list_directory', 'ok'], ['read_file', 'ok']]);
    const results = bodies[1].messages[2].content;
    assert.ok(results.some(r => r.tool_use_id === 'toolu_r' && r.content.includes(CANARY)), 'Express read the file and gave it to the model');
    const snapshot = supervisor.snapshot();
    assert.equal(snapshot.state, 'ready'); assert.equal(snapshot.launches, 1); assert.ok(snapshot.pid > 0);
    const bytes = readdirSync(resolve(base, 'data')).map(name => readFileSync(resolve(base, 'data', name)).toString('latin1')).join('');
    assert.ok(!bytes.includes(CANARY) && !bytes.includes(KEY), 'no file content or key in the database');
  } finally {
    await supervisor.stop();
    store.close(true); provider.closeAllConnections(); provider.close();
    if (base.startsWith(cache + sep)) rmSync(base, { recursive: true, force: true });
  }
  assert.equal(supervisor.snapshot().state, 'idle', 'the Worker stopped with confirmed cleanup (profile deleted, ACL restored)');
});
