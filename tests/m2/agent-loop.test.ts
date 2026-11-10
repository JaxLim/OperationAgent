import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { PROTOCOL_VERSION, TaskEventSchema } from '../../packages/contracts/dist/index.js';
import type { RpcRequest, TaskEvent } from '../../packages/contracts/dist/index.js';
import { RpcSession } from '../../packages/worker-transport/dist/index.js';
import { openStore } from '../../apps/server/dist/persistence/store.js';
import type { Store } from '../../apps/server/dist/persistence/store.js';
import { createCredentialService } from '../../apps/server/dist/credentials/service.js';
import type { CryptoBridge } from '../../apps/server/dist/credentials/bridge.js';
import { createTurnGateway } from '../../apps/server/dist/models/turns.js';
import { createToolRouter } from '../../apps/server/dist/tools/router.js';
import { LiveFeed } from '../../apps/server/dist/agent/live.js';
import { TaskRunner } from '../../apps/server/dist/agent/runner.js';
import { createAgentSession } from '../../apps/server/dist/agent/host.js';
import { formatListResult, formatReadResult } from '../../apps/server/dist/agent/tool-results.js';
import { runAgentRuntime } from '../../apps/agent-worker/dist/runtime.js';
import type { AgentResult } from '../../apps/agent-worker/dist/agent.js';

// The M2 agent loop end to end, in one process: the real Worker runtime and the real Express session exchange OWIP
// frames over an in-memory duplex channel; Express runs the real Task Runner, SQLite store, credential service, Read
// Adapter child processes and SDK-based gateway against a local fake of the Messages API. Only process isolation (the
// AppContainer launch) is absent here; that path is tested on the disposable Windows runner.

const WINDOWS = process.platform === 'win32' && process.arch === 'x64';
const KEY = 'sk-ant-api03-' + 'q'.repeat(40) + 'LOOPKEY';
const CANARY = `OA-FILE-CONTENT-${randomUUID()}`;
const clock = { schedule(ms: number, callback: () => void) { const timer = setTimeout(callback, ms); return () => clearTimeout(timer); } };
const fakeBridge = (): CryptoBridge => {
  const flip = (value: string): string => Buffer.from(Buffer.from(value, 'latin1').map(byte => byte ^ 0x5a)).toString('latin1');
  return { encrypt: async plaintext => Buffer.from(flip(plaintext), 'latin1').toString('base64'),
    decrypt: async ciphertext => flip(Buffer.from(ciphertext, 'base64').toString('latin1')) };
};

// --- fake Messages API ---------------------------------------------------------------------------------------------
type Body = { messages: { role: string; content: unknown }[]; [key: string]: unknown };
type Script = (res: ServerResponse, body: Body) => void;
const sse = (res: ServerResponse, events: Record<string, unknown>[], end = true): void => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const event of events) res.write(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`);
  if (end) res.end();
};
const start = { type: 'message_start', message: { id: 'msg_loop', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [],
  stop_reason: null, stop_sequence: null, usage: { input_tokens: 50, output_tokens: 1 } } };
const stop = (reason: string) => [{ type: 'message_delta', delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 9 } }, { type: 'message_stop' }];
const text = (index: number, value: string) => [{ type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index, delta: { type: 'text_delta', text: value } }, { type: 'content_block_stop', index }];
const tool = (index: number, id: string, name: string, input: unknown) => [{ type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } },
  { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }, { type: 'content_block_stop', index }];

async function withProvider(scripts: Script[], run: (endpoint: string, bodies: Body[]) => Promise<void>): Promise<void> {
  const bodies: Body[] = [];
  const server: Server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Body;
      bodies.push(body);
      scripts[Math.min(bodies.length - 1, scripts.length - 1)]!(res, body);
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  try { await run(`http://127.0.0.1:${address.port}`, bodies); } finally { server.closeAllConnections(); server.close(); }
}

// --- in-memory duplex channel ------------------------------------------------------------------------------------
class Inbox {
  private chunks: Uint8Array[] = []; private waiters: ((chunk: Uint8Array) => void)[] = []; closed = false;
  push(chunk: Uint8Array): void { const waiter = this.waiters.shift(); if (waiter) waiter(chunk); else this.chunks.push(chunk); }
  read(): Promise<Uint8Array> {
    const chunk = this.chunks.shift();
    if (chunk) return Promise.resolve(chunk);
    if (this.closed) return Promise.resolve(new Uint8Array(0));
    return new Promise(resolve => this.waiters.push(resolve));
  }
  close(): void { this.closed = true; for (const waiter of this.waiters.splice(0)) waiter(new Uint8Array(0)); }
}

interface Harness { store: Store; runner: TaskRunner; projectId: string; root: string; base: string; live: LiveFeed; finished: Map<string, AgentResult>;
  crash(): void; workerDone: Promise<void>; framesToWorker(): number }
async function withAgent(endpoint: string, run: (harness: Harness) => Promise<void>, options: { configured?: boolean } = {}): Promise<void> {
  const cache = resolve('.cache'); mkdirSync(cache, { recursive: true });
  const base = mkdtempSync(resolve(cache, 'agent-loop-'));
  const root = resolve(base, 'workspace'); mkdirSync(resolve(root, 'src'), { recursive: true });
  writeFileSync(resolve(root, 'README.md'), `# Demo\n${CANARY}\n`);
  writeFileSync(resolve(root, 'src', 'index.ts'), 'export const answer = 42;\n');
  writeFileSync(resolve(root, '.env'), 'TOKEN=secret');
  const store = openStore(resolve(base, 'data'), randomUUID());
  const projectId = store.addProject({ name: 'demo', path: root }).id;
  const credentials = createCredentialService(store, fakeBridge());
  if (options.configured !== false) await credentials.set(KEY);
  const live = new LiveFeed();
  const runner = new TaskRunner({ store, credentials, gateway: createTurnGateway({ endpoint, maxRetries: 0 }), tools: createToolRouter({ store }),
    model: () => 'claude-sonnet-5-5', live, stopGraceMs: () => 5_000 });
  const identity = { expressRunId: randomUUID(), workerRunId: randomUUID() };
  const toWorker = new Inbox(); const toExpress: Uint8Array[] = [];
  const express: { session?: RpcSession } = {};
  let crashed = false;
  const finished = new Map<string, AgentResult>();
  const workerDone = runAgentRuntime({
    channel: {
      read: () => toWorker.read(),
      write: async frame => { if (crashed) throw new Error('closed'); const copy = frame.slice(); queueMicrotask(() => { try { express.session?.receive(copy); } catch { /* session failed */ } }); return frame.length; },
      close: async () => { toWorker.close(); return true; },
    }, clock, newId: () => randomUUID(), onFinished: (taskId, result) => finished.set(taskId, result) });
  void toExpress;
  let frames = 0;
  const agent = createAgentSession({ identity, clock, runner, transport: { write: async frame => { if (!crashed) { frames++; toWorker.push(frame.slice()); } }, close: () => toWorker.close() } });
  express.session = agent.session;
  await agent.handshake('b'.repeat(64));
  const harness: Harness = { store, runner, projectId, root, base, live, finished, workerDone, framesToWorker: () => frames,
    crash: () => { crashed = true; toWorker.close(); agent.session.disconnect(); } };
  try { await run(harness); }
  finally {
    if (!crashed) { toWorker.close(); agent.session.close(); }
    await workerDone.catch(() => {});
    store.close(true);
    if (base.startsWith(cache + sep)) rmSync(base, { recursive: true, force: true });
  }
}
const until = async (check: () => boolean, ms = 10_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!check()) { if (Date.now() > deadline) throw new Error('timed out waiting'); await new Promise(resolve => setTimeout(resolve, 20)); }
};
const events = (store: Store, taskId: string): TaskEvent[] => store.listTaskEvents(taskId, 0);
const states = (list: TaskEvent[]): string[] => list.flatMap(event => event.type === 'task_state_changed' ? [event.payload.to] : []);

test('agent loop: a read-only task explores, reads, answers and completes; Express builds every tool result', async () => {
  await withProvider([
    res => sse(res, [start, ...text(0, 'Let me look around.'), ...tool(1, 'toolu_list', 'list_directory', { path: '.' }),
      ...tool(2, 'toolu_read', 'read_file', { path: 'README.md' }), ...tool(3, 'toolu_env', 'read_file', { path: '.env' }),
      ...tool(4, 'toolu_bash', 'bash', { command: 'rm -rf /' }), ...stop('tool_use')]),
    res => sse(res, [start, ...text(0, 'The README describes a demo project.'), ...stop('end_turn')]),
  ], async (endpoint, bodies) => {
    await withAgent(endpoint, async ({ store, runner, projectId, base, live, finished }) => {
      const task = await runner.start(projectId, 'What is this project?', randomUUID());
      assert.equal(task.state, 'RUNNING');
      await until(() => store.getTask(task.id)?.state === 'COMPLETED');
      assert.deepEqual(finished.get(task.id), { outcome: 'completed', reason: 'end_turn', turns: 2 });
      // The second request carries Express-built results for all four calls, in order, answering each exactly once.
      const results = (bodies[1]!.messages[2]!.content as { tool_use_id: string; is_error: boolean; content: string }[]);
      assert.deepEqual(results.map(result => [result.tool_use_id, result.is_error]), [['toolu_list', !WINDOWS], ['toolu_read', !WINDOWS],
        ['toolu_env', true], ['toolu_bash', true]]);
      if (WINDOWS) {
        assert.match(results[0]!.content, /README\.md/); assert.match(results[1]!.content, new RegExp(CANARY));
        assert.match(results[2]!.content, /^Refused: The path is protected/);
      }
      assert.match(results[3]!.content, /^This tool call was not executed\./, 'a tool the task does not have is never run');
      assert.deepEqual(bodies[1]!.messages.map(message => message.role), ['user', 'assistant', 'user']);
      const log = events(store, task.id);
      assert.deepEqual(log.map(event => event.type), ['task_created', 'task_state_changed', 'user_message', 'task_state_changed', 'assistant_turn',
        'tool_call', 'tool_call', 'tool_call', 'assistant_turn', 'task_state_changed']);
      assert.deepEqual(states(log), ['QUEUED', 'RUNNING', 'COMPLETED']);
      for (const event of log) assert.equal(TaskEventSchema.safeParse(event).success, true);
      const calls = log.flatMap(event => event.type === 'tool_call' ? [[event.payload.tool, event.payload.target, event.payload.status, event.payload.code]] : []);
      assert.deepEqual(calls.sort(), WINDOWS
        ? [['list_directory', '.', 'ok', null], ['read_file', '.env', 'refused', 'SENSITIVE_PATH'], ['read_file', 'README.md', 'ok', null]]
        : [['list_directory', '.', 'failed', 'READ_ADAPTER_UNAVAILABLE'], ['read_file', '.env', 'failed', 'READ_ADAPTER_UNAVAILABLE'],
          ['read_file', 'README.md', 'failed', 'READ_ADAPTER_UNAVAILABLE']]);
      const messages = store.listTaskMessages(task.id);
      assert.deepEqual(messages.map(message => [message.role, message.turn, message.text]), [['user', 0, 'What is this project?'],
        ['assistant', 1, 'Let me look around.'], ['assistant', 2, 'The README describes a demo project.']]);
      const page = live.read(task.id, 0);
      assert.ok(page.deltas.some(item => item.delta.kind === 'text') && page.deltas.some(item => item.delta.kind === 'tool_call'));
      assert.equal(page.done, true);
      // File contents went to the model only: the database holds decisions, metadata and the conversation text.
      const bytes = readdirSync(resolve(base, 'data')).map(name => readFileSync(resolve(base, 'data', name)).toString('latin1')).join('');
      assert.ok(!bytes.includes(CANARY) && !bytes.includes('TOKEN=secret') && !bytes.includes(KEY));
      assert.equal(runner.busy, false);
    });
  });
});

test('agent loop: a Worker can neither forge tool calls nor reach another task, turn or tool', async () => {
  // Turn 1 asks for a tool; turn 2 then streams forever, so the task is known to sit in a running turn 2.
  await withProvider([res => sse(res, [start, ...tool(0, 'toolu_one', 'read_file', { path: 'README.md' }), ...stop('tool_use')]),
    res => sse(res, [start, ...text(0, 'Still working')], false)], async (endpoint, bodies) => {
    await withAgent(endpoint, async ({ store, runner, projectId }) => {
      const reject = (method: string, params: unknown) => runner.handle({ jsonrpc: '2.0', protocolVersion: PROTOCOL_VERSION,
        expressRunId: randomUUID(), workerRunId: randomUUID(), id: randomUUID(), requestId: randomUUID(), role: 'worker', method, params } as RpcRequest);
      assert.equal(await reject('model.turn', { taskId: randomUUID(), turn: 1 }), null, 'unknown task');
      const requestId = randomUUID();
      const task = await runner.start(projectId, 'Read the README', requestId);
      await until(() => bodies.length === 2);
      const auditBefore = store.listToolAudit().length;
      assert.equal(await reject('model.turn', { taskId: task.id, turn: 2 }), null, 'a turn already requested cannot be requested again');
      assert.equal(await reject('model.turn', { taskId: task.id, turn: 3 }), null, 'no second turn while one is in flight');
      assert.equal(await reject('model.turn', { taskId: task.id, turn: 7 }), null, 'turns cannot be skipped');
      assert.equal(await reject('tool.call', { taskId: task.id, turn: 1, toolCallId: 'toolu_one' }), null, 'a past turn is refused');
      assert.equal(await reject('tool.call', { taskId: task.id, turn: 9, toolCallId: 'toolu_one' }), null, 'a future turn is refused');
      assert.equal(await reject('tool.call', { taskId: task.id, turn: 2, toolCallId: 'toolu_forged' }), null, 'no tool runs while a model turn runs');
      assert.equal(store.listToolAudit().length, auditBefore, 'nothing reached the Read Adapter');
      assert.equal(bodies.length, 2, 'no second model request was made');
      // A retried start returns the committed task even while the runner is busy; a reused id for another project is refused.
      assert.equal((await runner.start(projectId, 'Read the README', requestId)).id, task.id);
      const other = store.addProject({ name: 'other', path: 'C:\\work\\other' }).id;
      await assert.rejects(runner.start(other, 'Read the README', requestId), /VALIDATION_ERROR/);
      await assert.rejects(runner.start(projectId, 'Another task', randomUUID()), /AGENT_BUSY/);
      assert.equal((await runner.stop(task.id)).state, 'STOPPED');
    });
  });
});

test('agent session: heartbeats keep an idle session alive; tool summaries always fit the reply contract', async () => {
  await withProvider([res => sse(res, [start, ...text(0, 'ok'), ...stop('end_turn')])], async endpoint => {
    await withAgent(endpoint, async ({ framesToWorker }) => {
      const before = framesToWorker();
      await new Promise(resolve => setTimeout(resolve, 2_300));
      assert.ok(framesToWorker() - before >= 2, 'Express keeps probing the Worker while nothing else happens');
    });
  });
  const long = Array.from({ length: 60 }, () => 'directory').join('/') + '/file.ts';
  const read = formatReadResult({ status: 'ok', path: long, content: 'x', bytes: 1, size: 1, truncated: false, sha256: 'a'.repeat(64) }, long);
  const listed = formatListResult({ status: 'ok', path: long, entries: [], truncated: false, unlisted: [] }, long);
  const refused = formatReadResult({ status: 'refused', code: 'NOT_FOUND' }, long);
  for (const summary of [read.summary, listed.summary, refused.summary]) {
    assert.ok(summary.length <= 256, summary);
    assert.match(summary, /file\.ts/, 'the file name stays visible');
  }
});

test('agent loop: Stop aborts a streaming turn, the loop confirms, and the task is STOPPED with cleanup confirmed', async () => {
  await withProvider([res => sse(res, [start, ...text(0, 'Thinking for a very long time')], false)], async endpoint => {
    await withAgent(endpoint, async ({ store, runner, projectId, finished }) => {
      const task = await runner.start(projectId, 'Take your time', randomUUID());
      await until(() => runner.busy && store.getTask(task.id)?.state === 'RUNNING');
      await new Promise(resolve => setTimeout(resolve, 200));
      const started = Date.now();
      const stopped = await runner.stop(task.id);
      assert.equal(stopped.state, 'STOPPED');
      assert.ok(Date.now() - started < 5_000);
      assert.deepEqual(states(events(store, task.id)), ['QUEUED', 'RUNNING', 'STOPPING', 'STOPPED']);
      await until(() => finished.has(task.id));
      assert.equal(finished.get(task.id)!.outcome, 'stopped');
      await assert.rejects(runner.stop(task.id), /INVALID_TRANSITION/);
    });
  });
});

test('agent loop: a lost Worker interrupts its task (never reconnected); preconditions are explicit domain errors', async () => {
  await withProvider([res => sse(res, [start, ...text(0, 'Working')], false)], async endpoint => {
    await withAgent(endpoint, async ({ store, runner, projectId, crash }) => {
      await assert.rejects(runner.start(projectId, '   ', randomUUID()), /VALIDATION_ERROR/);
      await assert.rejects(runner.start(randomUUID(), 'x', randomUUID()), /NOT_FOUND/);
      const task = await runner.start(projectId, 'Long job', randomUUID());
      await assert.rejects(runner.start(projectId, 'Second job', randomUUID()), /AGENT_BUSY/);
      await until(() => store.getTask(task.id)?.state === 'RUNNING');
      crash();
      await until(() => store.getTask(task.id)?.state === 'INTERRUPTED');
      const last = events(store, task.id).at(-1)!;
      assert.ok(last.type === 'task_state_changed' && last.payload.sideEffects === 'VERIFIED' && /worker exited/.test(last.payload.reason ?? ''));
      assert.equal(runner.available, false);
      await assert.rejects(runner.start(projectId, 'After the crash', randomUUID()), /WORKER_ISOLATION_UNAVAILABLE/);
    });
    await withAgent(endpoint, async ({ runner, projectId }) => {
      await assert.rejects(runner.start(projectId, 'No key yet', randomUUID()), /MODEL_NOT_CONFIGURED/);
    }, { configured: false });
  });
});

test('agent capability: a runtime that does not offer it fails the handshake, and agent methods are refused on a base session', async () => {
  const identity = { expressRunId: randomUUID(), workerRunId: randomUUID() };
  const frames: Uint8Array[] = []; const failures: string[] = [];
  // A refusing Worker closes its carrier, which Express observes as a disconnect.
  const peer: { express?: RpcSession } = {};
  const worker = new RpcSession({ identity, role: 'worker', clock, transport: { async write(frame) { frames.push(frame); }, close() {} },
    onClose: error => { failures.push(error.message); queueMicrotask(() => peer.express?.disconnect()); } });
  const express = peer.express = new RpcSession({ identity, role: 'express', clock, transport: { async write(frame) { try { worker.receive(frame); } catch { /* recorded */ } }, close() {} },
    onClose: () => {} });
  await assert.rejects(express.startHandshake('c'.repeat(64), randomUUID(), ['health', 'shutdown', 'agent']));
  assert.deepEqual(failures, ['RPC_CAPABILITY_REJECTED']);
  const base = new RpcSession({ identity, role: 'express', clock, transport: { async write() {}, close() {} } });
  const id = randomUUID();
  await assert.rejects(base.request({ jsonrpc: '2.0', protocolVersion: PROTOCOL_VERSION, ...identity, id, requestId: id, role: 'express',
    method: 'agent.run', params: { taskId: randomUUID(), tools: ['read_file'], maxTurns: 1 } } as RpcRequest), /RPC_NOT_READY|RPC_CAPABILITY_REJECTED/);
});
