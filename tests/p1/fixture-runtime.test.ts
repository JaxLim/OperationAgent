// In-process pairing of the real fixture runtime and the real Express FixtureWorker over an in-memory pipe.
// This exercises protocol, fault and supervision logic only; OS isolation is tested on the disposable runner.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { runFixture } from '../../apps/agent-worker/dist/fixture.js';
import { FixtureSupervisor, FixtureWorker, clock } from '../../apps/server/dist/worker/launcher.js';
import type { LaunchedFixture } from '../../packages/platform-worker/dist/parent.js';

class Pipe {
  private chunks: Uint8Array[] = [];
  private waiter: (() => void) | undefined;
  private closed = false;
  push(chunk: Uint8Array): void { if (this.closed) throw new Error('PIPE_IO (win32=232)'); this.chunks.push(chunk.slice()); this.waiter?.(); }
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

let nextPid = 40_000;
function inProcessLauncher(log: { pids: number[]; alive: Set<number> }) {
  return async (): Promise<LaunchedFixture> => {
    const toWorker = new Pipe(); const toParent = new Pipe(); const pid = nextPid++;
    log.pids.push(pid); log.alive.add(pid);
    let markExit!: (code: number) => void; const exit = new Promise<number>(resolve => { markExit = resolve; });
    const end = (code: number): void => { toWorker.close(); toParent.close(); log.alive.delete(pid); markExit(code); };
    const channel = { read: (max: number, deadline: number) => toWorker.read(max, deadline),
      write: async (frame: Uint8Array) => { toParent.push(frame); return frame.length; },
      close: async () => { toParent.close(); toWorker.close(); return true; } };
    void runFixture(channel, clock).then(() => end(0), () => end(1));
    return {
      baseline: { pid, parentPid: process.pid, integrityRid: 0x1000, appContainer: true, capabilityCount: 0, jobAssignedAtCreation: true,
        noChildProcessCreation: true, inheritedHandleCount: 3, inheritedHandles: 'rpc-pipe,nul-read,nul-write', verifiedBeforeResume: true, profile: 'in-process' },
      read: (max, deadline) => toParent.read(max, deadline),
      write: async frame => { toWorker.push(frame); return frame.length; },
      close: async () => { end(1); await exit; return true; },
      wait: deadline => Promise.race([exit, delay(deadline).then(() => { throw new Error('WORKER_EXIT_UNCONFIRMED'); })]),
    };
  };
}
const options = (log: { pids: number[]; alive: Set<number> }) => ({ target: 'in-process', runtimeDirectory: '.', expressRunId: randomUUID(), launcher: inProcessLauncher(log) });

test('the fixture completes the channel-only handshake, answers health and stops gracefully', async () => {
  const log = { pids: [] as number[], alive: new Set<number>() };
  const worker = await FixtureWorker.launch(options(log));
  const health = await worker.health();
  assert.ok('result' in health && health.result.kind === 'health' && health.result.agentReady === false);
  await delay(2_500);
  assert.equal(worker.snapshot().state, 'ready'); assert.equal(worker.snapshot().session?.missedHeartbeats, 0);
  assert.deepEqual(await worker.stop(), { phase: 'graceful', confirmed: true });
  assert.equal((await worker.closed).cleanup, 'confirmed'); assert.equal(log.alive.size, 0);
});

for (const [mode, reason] of [['exit', /RPC_DISCONNECTED|WORKER_EXITED/], ['invalid-frame', /OWIP_MAGIC_INVALID/],
  ['foreign-identity', /IDENTITY_MISMATCH/], ['duplicate-response', /RPC_UNCORRELATED_RESPONSE/]] as const) {
  test(`fixture fault ${mode} fails the session closed and the Worker is terminated`, async () => {
    const log = { pids: [] as number[], alive: new Set<number>() };
    const worker = await FixtureWorker.launch(options(log));
    await worker.fault(mode).catch(() => undefined);
    const exit = await worker.closed;
    assert.match(exit.reason, reason); assert.equal(exit.cleanup, 'confirmed');
    assert.equal(worker.snapshot().state, 'failed'); assert.equal(log.alive.size, 0);
    await assert.rejects(worker.health(), /WORKER_NOT_READY/);
  });
}

test('exceeding the in-flight request quota fails closed instead of queueing without bound', async () => {
  const log = { pids: [] as number[], alive: new Set<number>() };
  const worker = await FixtureWorker.launch(options(log));
  const results = await Promise.allSettled(Array.from({ length: 70 }, () => worker.health()));
  assert.ok(results.some(result => result.status === 'rejected'));
  assert.match((await worker.closed).reason, /RPC_IN_FLIGHT_LIMIT/); assert.equal(log.alive.size, 0);
});

test('the supervisor restarts unexpected exits with new run identities until the budget is exhausted', async () => {
  const log = { pids: [] as number[], alive: new Set<number>() };
  const supervisor = new FixtureSupervisor(options(log));
  const runs = new Set<string>();
  let worker = await supervisor.start();
  for (let attempt = 0; attempt < 4; attempt++) {
    runs.add(worker.identity.workerRunId);
    await worker.fault('exit').catch(() => undefined); await worker.closed;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const state = supervisor.snapshot();
      if (attempt === 3 ? state.state === 'budget-exhausted' : state.state === 'ready' && supervisor.worker && supervisor.worker !== worker) break;
      await delay(50);
    }
    if (attempt < 3) worker = supervisor.worker!;
  }
  const state = supervisor.snapshot();
  assert.equal(state.state, 'budget-exhausted'); assert.equal(state.restarts, 3); assert.equal(runs.size, 4);
  assert.equal(state.history.length, 4); assert.ok(state.history.every(entry => entry.cleanup === 'confirmed'));
  assert.equal(log.alive.size, 0); await supervisor.stop();
});
