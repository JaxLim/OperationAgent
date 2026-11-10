import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { LaunchedFixture } from '../../packages/platform-worker/dist/parent.js';
import { openStore } from '../../apps/server/dist/persistence/store.js';
import type { Store } from '../../apps/server/dist/persistence/store.js';
import { createCredentialService } from '../../apps/server/dist/credentials/service.js';
import type { CryptoBridge } from '../../apps/server/dist/credentials/bridge.js';
import { createTurnGateway } from '../../apps/server/dist/models/turns.js';
import { createToolRouter } from '../../apps/server/dist/tools/router.js';
import { LiveFeed } from '../../apps/server/dist/agent/live.js';
import { TaskRunner } from '../../apps/server/dist/agent/runner.js';
import { AgentWorkerSupervisor } from '../../apps/server/dist/agent/supervisor.js';
import { runAgentRuntime } from '../../apps/agent-worker/dist/runtime.js';
import { messageStart, messageStop, sse, textBlock, withProvider } from './support/fake-provider.ts';
import { SIDECAR_ENVIRONMENT } from '../../packages/contracts/dist/index.js';

// The Express Worker supervisor through FixtureWorker's real lifecycle code (handshake, heartbeat, exit watch, two-phase
// stop, confirmed cleanup), with an in-process carrier in place of the native AppContainer launch. The isolated launch
// itself runs only on the disposable Windows runner (ADR-WIN-001 §3).

const KEY = 'sk-ant-api03-' + 'w'.repeat(40) + 'SUPKEY';
const clock = { schedule(ms: number, callback: () => void) { const timer = setTimeout(callback, ms); return () => clearTimeout(timer); } };
const flip = (value: string): string => Buffer.from(Buffer.from(value, 'latin1').map(byte => byte ^ 0x5a)).toString('latin1');
const fakeBridge: CryptoBridge = { encrypt: async plaintext => Buffer.from(flip(plaintext), 'latin1').toString('base64'),
  decrypt: async ciphertext => flip(Buffer.from(ciphertext, 'base64').toString('latin1')) };
const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

class Pipe {
  private chunks: Uint8Array[] = []; private waiter: (() => void) | undefined; private closed = false;
  push(chunk: Uint8Array): void { if (this.closed) throw new Error('PIPE_IO'); this.chunks.push(chunk.slice()); this.waiter?.(); }
  close(): void { this.closed = true; this.waiter?.(); }
  async read(maxBytes: number, deadlineMs: number): Promise<Uint8Array> {
    const deadline = Date.now() + deadlineMs;
    while (!this.chunks.length) {
      if (this.closed) return new Uint8Array();
      if (Date.now() >= deadline) throw new Error('CHANNEL_DEADLINE');
      await new Promise<void>(resolve => { this.waiter = resolve; setTimeout(resolve, 50); });
    }
    const chunk = this.chunks.shift()!;
    if (chunk.length > maxBytes) { this.chunks.unshift(chunk.subarray(maxBytes)); return chunk.subarray(0, maxBytes); }
    return chunk;
  }
}
interface Launches { pids: number[]; kill: (() => void)[]; unconfirmed: boolean }
let nextPid = 50_000;
function inProcessLauncher(log: Launches) {
  return async (): Promise<LaunchedFixture> => {
    const toWorker = new Pipe(); const toParent = new Pipe(); const pid = nextPid++;
    log.pids.push(pid);
    let markExit!: (code: number) => void; const exit = new Promise<number>(resolve => { markExit = resolve; });
    const end = (code: number): void => { toWorker.close(); toParent.close(); markExit(code); };
    log.kill.push(() => end(9));
    const channel = { read: (max: number, deadline: number) => toWorker.read(max, deadline),
      write: async (frame: Uint8Array) => { toParent.push(frame); return frame.length; },
      close: async () => { toParent.close(); toWorker.close(); return true; } };
    void runAgentRuntime({ channel, clock, newId: () => randomUUID() }).then(() => end(0), () => end(1));
    return {
      baseline: { pid, parentPid: process.pid, integrityRid: 0x1000, appContainer: true, capabilityCount: 0, jobAssignedAtCreation: true,
        noChildProcessCreation: true, inheritedHandleCount: 3, inheritedHandles: 'rpc-pipe,nul-read,stderr-pipe', verifiedBeforeResume: true, profile: 'in-process' },
      read: (max, deadline) => toParent.read(max, deadline),
      write: async frame => { toWorker.push(frame); return frame.length; },
      close: async () => { end(1); await exit; if (log.unconfirmed) throw new Error('WORKER_CLEANUP_UNCONFIRMED'); return true; },
      diagnostics: () => '',
      wait: deadline => Promise.race([exit, delay(deadline).then(() => { throw new Error('WORKER_EXIT_UNCONFIRMED'); })]),
    };
  };
}

async function withSupervisor(endpoint: string, run: (context: { store: Store; runner: TaskRunner; supervisor: AgentWorkerSupervisor;
  projectId: string; launches: Launches }) => Promise<void>, launcher?: () => Promise<LaunchedFixture>): Promise<void> {
  const cache = resolve('.cache'); mkdirSync(cache, { recursive: true });
  const base = mkdtempSync(resolve(cache, 'agent-worker-'));
  const root = resolve(base, 'workspace'); mkdirSync(root, { recursive: true }); writeFileSync(resolve(root, 'README.md'), '# hi\n');
  const store = openStore(resolve(base, 'data'), randomUUID());
  const projectId = store.addProject({ name: 'w', path: root }).id;
  const credentials = createCredentialService(store, fakeBridge); await credentials.set(KEY);
  const launches: Launches = { pids: [], kill: [], unconfirmed: false };
  const holder: { supervisor?: AgentWorkerSupervisor } = {};
  const runner = new TaskRunner({ store, credentials, gateway: createTurnGateway({ endpoint, maxRetries: 0 }), tools: createToolRouter({ store }),
    model: () => 'claude-haiku-5-5', live: new LiveFeed(), stopGraceMs: () => 5_000, ensureWorker: () => holder.supervisor!.ensure() });
  const supervisor = holder.supervisor = new AgentWorkerSupervisor({ runtimeDirectory: 'C:\\in-process', expressRunId: randomUUID(), runner,
    launcher: launcher ?? inProcessLauncher(launches), target: 'in-process' });
  try { await run({ store, runner, supervisor, projectId, launches }); }
  finally { await supervisor.stop(); store.close(true); if (base.startsWith(cache + sep)) rmSync(base, { recursive: true, force: true }); }
}
const until = async (check: () => boolean, ms = 10_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!check()) { if (Date.now() > deadline) throw new Error('timed out waiting'); await delay(20); }
};

test('agent worker: launched on the first task, reused for the next, and stopped with the control plane', async () => {
  await withProvider([(res) => sse(res, [messageStart('claude-haiku-5-5'), ...textBlock(0, 'Done.'), ...messageStop('end_turn')])], async endpoint => {
    await withSupervisor(endpoint, async ({ store, runner, supervisor, projectId, launches }) => {
      assert.deepEqual(supervisor.snapshot(), { state: 'idle', launches: 0, lastError: null, pid: null }, 'nothing is launched before a task');
      const first = await runner.start(projectId, 'First question', randomUUID());
      await until(() => store.getTask(first.id)?.state === 'COMPLETED');
      const second = await runner.start(projectId, 'Second question', randomUUID());
      await until(() => store.getTask(second.id)?.state === 'COMPLETED');
      assert.equal(launches.pids.length, 1, 'one Worker serves both tasks');
      assert.equal(supervisor.snapshot().state, 'ready');
      await supervisor.stop();
      assert.equal(runner.available, false);
      await assert.rejects(supervisor.ensure(), /WORKER_ISOLATION_UNAVAILABLE/);
    });
  });
});

test('agent worker: a Worker that dies mid-task interrupts it, and the next task gets a new Worker identity', async () => {
  await withProvider([(res) => sse(res, [messageStart('claude-haiku-5-5'), ...textBlock(0, 'Still thinking')], false),
    (res) => sse(res, [messageStart('claude-haiku-5-5'), ...textBlock(0, 'Recovered.'), ...messageStop('end_turn')])], async endpoint => {
    await withSupervisor(endpoint, async ({ store, runner, supervisor, projectId, launches }) => {
      const doomed = await runner.start(projectId, 'Long job', randomUUID());
      await delay(300);
      launches.kill[0]!();
      await until(() => store.getTask(doomed.id)?.state === 'INTERRUPTED');
      await until(() => supervisor.snapshot().state === 'idle');
      const next = await runner.start(projectId, 'Try again', randomUUID());
      await until(() => store.getTask(next.id)?.state === 'COMPLETED');
      assert.equal(launches.pids.length, 2);
      assert.notEqual(launches.pids[0], launches.pids[1]);
    });
  });
});

test('agent worker: an exit whose cleanup is unconfirmed blocks every further launch (fail closed)', async () => {
  await withProvider([(res) => sse(res, [messageStart('claude-haiku-5-5'), ...textBlock(0, 'Working')], false)], async endpoint => {
    await withSupervisor(endpoint, async ({ store, runner, supervisor, projectId, launches }) => {
      const task = await runner.start(projectId, 'Job', randomUUID());
      launches.unconfirmed = true;
      launches.kill[0]!();
      await until(() => store.getTask(task.id)?.state === 'INTERRUPTED');
      await until(() => supervisor.snapshot().state === 'unavailable');
      assert.equal(supervisor.snapshot().lastError, 'CLEANUP_UNCONFIRMED');
      await assert.rejects(runner.start(projectId, 'Another', randomUUID()), /WORKER_ISOLATION_UNAVAILABLE/);
      assert.equal(launches.pids.length, 1);
    });
  });
});

test('agent worker: a launch that fails without confirmed cleanup blocks every later launch; a confirmed failure stays retryable', async () => {
  await withProvider([(res) => sse(res, [messageStart('claude-haiku-5-5'), ...textBlock(0, 'x'), ...messageStop('end_turn')])], async endpoint => {
    const scenarios = [
      { name: 'native creation', launcher: async (): Promise<LaunchedFixture> => { throw new Error('WORKER_ISOLATION_UNAVAILABLE: WORKER_CREATION_CLEANUP_UNCONFIRMED'); },
        expect: 'unavailable' },
      { name: 'handshake, close unconfirmed', launcher: silentLauncher(false), expect: 'unavailable' },
      { name: 'handshake, close confirmed', launcher: silentLauncher(true), expect: 'idle' },
    ] as const;
    for (const scenario of scenarios) {
      await withSupervisor(endpoint, async ({ runner, supervisor, projectId }) => {
        await assert.rejects(runner.start(projectId, 'Hello', randomUUID()), /WORKER_ISOLATION_UNAVAILABLE/, scenario.name);
        assert.equal(supervisor.snapshot().state, scenario.expect, scenario.name);
        if (scenario.expect === 'unavailable') {
          assert.equal(supervisor.snapshot().lastError, 'CLEANUP_UNCONFIRMED', scenario.name);
          const launches = supervisor.snapshot().launches;
          await assert.rejects(runner.start(projectId, 'Again', randomUUID()), /WORKER_ISOLATION_UNAVAILABLE/);
          assert.equal(supervisor.snapshot().launches, launches, 'no further launch is attempted');
        }
      }, scenario.launcher);
    }
  });
  assert.ok(SIDECAR_ENVIRONMENT.includes('LOCALAPPDATA'), 'the Worker launcher needs LOCALAPPDATA in the sidecar environment');
});

/** A carrier whose Worker never answers the handshake; its close confirms cleanup or not. */
function silentLauncher(confirmed: boolean) {
  return async (): Promise<LaunchedFixture> => {
    let markExit!: (code: number) => void; const exit = new Promise<number>(resolve => { markExit = resolve; });
    return {
      baseline: { pid: nextPid++, parentPid: process.pid, integrityRid: 0x1000, appContainer: true, capabilityCount: 0, jobAssignedAtCreation: true,
        noChildProcessCreation: true, inheritedHandleCount: 3, inheritedHandles: 'rpc-pipe,nul-read,stderr-pipe', verifiedBeforeResume: true, profile: 'silent' },
      read: async () => { await exit; return new Uint8Array(); },
      write: async frame => { markExit(1); return frame.length; },
      close: async () => { markExit(1); if (!confirmed) throw new Error('WORKER_CLEANUP_UNCONFIRMED'); return true; },
      diagnostics: () => '',
      wait: async () => exit,
    };
  };
}
