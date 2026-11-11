import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import type { ClaudeModel, ContextPolicy, TaskEvent } from '../../../packages/contracts/dist/index.js';
import type { RpcSession } from '../../../packages/worker-transport/dist/index.js';
import { openStore } from '../../../apps/server/dist/persistence/store.js';
import type { Store } from '../../../apps/server/dist/persistence/store.js';
import { createCredentialService } from '../../../apps/server/dist/credentials/service.js';
import type { CryptoBridge } from '../../../apps/server/dist/credentials/bridge.js';
import { createTurnGateway } from '../../../apps/server/dist/models/turns.js';
import { createToolRouter } from '../../../apps/server/dist/tools/router.js';
import { LiveFeed } from '../../../apps/server/dist/agent/live.js';
import { TaskRunner } from '../../../apps/server/dist/agent/runner.js';
import { createAgentSession } from '../../../apps/server/dist/agent/host.js';
import { runAgentRuntime } from '../../../apps/agent-worker/dist/runtime.js';

// The agent in one process, for tests and the offline benchmark: the real Worker runtime and the real Express session
// exchange OWIP frames over an in-memory channel, and Express runs the real Task Runner, SQLite store, credential
// service, Read Adapter child processes and SDK gateway against whatever endpoint the caller provides. Only the
// AppContainer launch is absent; that path runs on the disposable Windows runner.

export const AGENT_HARNESS_KEY = 'sk-ant-api03-' + 'h'.repeat(40) + 'HARNESSKEY';
const clock = { schedule(ms: number, callback: () => void) { const timer = setTimeout(callback, ms); return () => clearTimeout(timer); } };
const fakeBridge = (): CryptoBridge => {
  const flip = (value: string): string => Buffer.from(Buffer.from(value, 'latin1').map(byte => byte ^ 0x5a)).toString('latin1');
  return { encrypt: async plaintext => Buffer.from(flip(plaintext), 'latin1').toString('base64'),
    decrypt: async ciphertext => flip(Buffer.from(ciphertext, 'base64').toString('latin1')) };
};

class Inbox {
  private chunks: Uint8Array[] = []; private waiters: ((chunk: Uint8Array) => void)[] = []; private closed = false;
  push(chunk: Uint8Array): void { const waiter = this.waiters.shift(); if (waiter) waiter(chunk); else this.chunks.push(chunk); }
  read(): Promise<Uint8Array> {
    const chunk = this.chunks.shift();
    if (chunk) return Promise.resolve(chunk);
    if (this.closed) return Promise.resolve(new Uint8Array(0));
    return new Promise(resolve => this.waiters.push(resolve));
  }
  close(): void { this.closed = true; for (const waiter of this.waiters.splice(0)) waiter(new Uint8Array(0)); }
}

export interface AgentHarnessOptions {
  model?: ClaudeModel;
  /** Passed to the Task Runner; omit for the fixed production policy table. */
  contextPolicy?: (model: ClaudeModel) => ContextPolicy | null;
  /** Workspace files to create, by project-relative path. */
  files?: Record<string, string>;
}
export interface AgentHarness { store: Store; runner: TaskRunner; projectId: string; root: string;
  /** Starts a task and resolves once it has reached a final state; returns its committed events. */
  runTask(prompt: string, timeoutMs?: number): Promise<{ taskId: string; state: string; events: TaskEvent[] }> }

export async function withAgentHarness(endpoint: string, run: (harness: AgentHarness) => Promise<void>, options: AgentHarnessOptions = {}): Promise<void> {
  const cache = resolve('.cache'); mkdirSync(cache, { recursive: true });
  const base = mkdtempSync(resolve(cache, 'agent-harness-'));
  const root = resolve(base, 'workspace'); mkdirSync(root, { recursive: true });
  for (const [path, content] of Object.entries(options.files ?? { 'README.md': '# Demo\n' })) {
    const target = resolve(root, path);
    if (!target.startsWith(root + sep)) throw new Error('file outside the workspace');
    mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, content);
  }
  const store = openStore(resolve(base, 'data'), randomUUID());
  const projectId = store.addProject({ name: 'harness', path: root }).id;
  const credentials = createCredentialService(store, fakeBridge());
  await credentials.set(AGENT_HARNESS_KEY);
  const model = options.model ?? 'claude-sonnet-5-5';
  const runner = new TaskRunner({ store, credentials, gateway: createTurnGateway({ endpoint, maxRetries: 0 }), tools: createToolRouter({ store }),
    model: () => model, live: new LiveFeed(), stopGraceMs: () => 5_000, ...(options.contextPolicy ? { contextPolicy: options.contextPolicy } : {}) });
  const identity = { expressRunId: randomUUID(), workerRunId: randomUUID() };
  const toWorker = new Inbox();
  const express: { session?: RpcSession } = {};
  const workerDone = runAgentRuntime({ clock, newId: () => randomUUID(), channel: {
    read: () => toWorker.read(),
    write: async frame => { const copy = frame.slice(); queueMicrotask(() => { try { express.session?.receive(copy); } catch { /* The session has failed. */ } }); return frame.length; },
    close: async () => { toWorker.close(); return true; },
  } });
  const agent = createAgentSession({ identity, clock, runner, transport: { write: async frame => { toWorker.push(frame.slice()); }, close: () => toWorker.close() } });
  express.session = agent.session;
  await agent.handshake('c'.repeat(64));
  const harness: AgentHarness = { store, runner, projectId, root,
    async runTask(prompt, timeoutMs = 60_000) {
      const task = await runner.start(projectId, prompt, randomUUID());
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const state = store.getTask(task.id)!.state;
        if (['COMPLETED', 'FAILED', 'STOPPED', 'INTERRUPTED'].includes(state)) {
          const events: TaskEvent[] = [];
          for (;;) { const page = store.listTaskEvents(task.id, events.length); events.push(...page); if (page.length < 200) break; }
          return { taskId: task.id, state, events };
        }
        if (Date.now() > deadline) throw new Error(`task still ${state} after ${timeoutMs} ms`);
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    } };
  try { await run(harness); }
  finally {
    toWorker.close(); agent.session.close();
    await workerDone.catch(() => {});
    store.close(true);
    if (base.startsWith(cache + sep)) rmSync(base, { recursive: true, force: true });
  }
}
