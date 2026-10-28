import { randomBytes, randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION } from '@operation-agent/contracts';
import type { FixtureFault, RpcRequest, RpcResponse, WorkerIdentity } from '@operation-agent/contracts';
import { OWIP_POLICY, RpcSession } from '@operation-agent/worker-transport';
import type { TransportClock } from '@operation-agent/worker-transport';
import { launchIsolatedFixture } from '@operation-agent/platform-worker/parent';
import type { FixtureBaseline, LaunchedFixture } from '@operation-agent/platform-worker/parent';
import { RestartBudget, SUPERVISION_POLICY, stopInTwoPhases } from '@operation-agent/platform-supervision';
import type { TwoPhaseReport } from '@operation-agent/platform-supervision';

// Express platform WorkerLauncher for the P1 restricted fixture. The release sidecar never calls it and
// does not stage the native launcher, so production reports WORKER_ISOLATION_UNAVAILABLE.

export const clock: TransportClock = { schedule(milliseconds, callback) { const timer = setTimeout(callback, milliseconds); return () => clearTimeout(timer); } };
const READ_BYTES = 65_536; const READ_DEADLINE_MS = 30_000; const WAIT_SLICE_MS = 30_000;

export interface FixtureLaunchOptions {
  target: string; runtimeDirectory: string; expressRunId: string;
  /** Defaults to the native public-API launcher; in-process transport tests substitute a pipe pair. */
  launcher?: typeof launchIsolatedFixture;
}
export type FixtureState = 'starting' | 'ready' | 'stopping' | 'stopped' | 'failed';
export interface FixtureExit { readonly reason: string; readonly exitCode: number | null; readonly cleanup: 'confirmed' | 'unconfirmed' }

export class FixtureWorker {
  readonly identity: WorkerIdentity;
  private state: FixtureState = 'starting';
  private failure: string | undefined;
  private exitCode: number | null = null;
  private exitObserved = false;
  private exitWaiters: (() => void)[] = [];
  private closing: Promise<void> | undefined;
  private cleanup: 'confirmed' | 'unconfirmed' | undefined;
  private finish!: (exit: FixtureExit) => void;
  /** Settles once the process exit and native cleanup were observed or declared unconfirmed. */
  readonly closed: Promise<FixtureExit> = new Promise(resolve => { this.finish = resolve; });
  private session: RpcSession | undefined;
  private constructor(private readonly native: LaunchedFixture, expressRunId: string) {
    this.identity = { expressRunId, workerRunId: randomUUID() };
  }
  get baseline(): FixtureBaseline { return this.native.baseline; }

  static async launch(options: FixtureLaunchOptions): Promise<FixtureWorker> {
    const native = await (options.launcher ?? launchIsolatedFixture)(options.target, options.runtimeDirectory);
    const worker = new FixtureWorker(native, options.expressRunId);
    return worker.start();
  }

  private async start(): Promise<FixtureWorker> {
    const session = new RpcSession({ identity: this.identity, role: 'express', clock, transport: {
      write: async frame => {
        const count = await this.native.write(Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength), OWIP_POLICY.requestMs);
        if (count !== frame.length) throw new Error('OWIP_SHORT_WRITE');
      },
      close: () => { void this.terminate(); },
    }, onClose: error => { if (this.state !== 'stopping' && this.state !== 'stopped') this.fail(error.message); } });
    this.session = session;
    void this.readLoop(session);
    void this.watchExit();
    try {
      await session.startHandshake(randomBytes(32).toString('hex'), randomUUID());
      if (this.state !== 'starting') throw new Error(this.failure ?? 'RPC_CLOSED');
      session.startHeartbeat(randomUUID);
      this.state = 'ready';
      return this;
    } catch (error) {
      this.fail(error instanceof Error ? error.message : 'RPC_HANDSHAKE_FAILED');
      await this.closed;
      throw new Error('WORKER_ISOLATION_UNAVAILABLE: ' + (this.failure ?? 'handshake failed'), { cause: error });
    }
  }
  private async readLoop(session: RpcSession): Promise<void> {
    try {
      for (;;) {
        const chunk = await this.native.read(READ_BYTES, READ_DEADLINE_MS);
        if (!chunk.length) { session.disconnect(); return; }
        session.receive(chunk);
      }
    } catch (error) { this.fail(error instanceof Error ? error.message : 'RPC_READ_FAILED'); }
  }
  private async watchExit(): Promise<void> {
    while (!this.exitObserved && this.cleanup === undefined) {
      try { this.exitCode = await this.native.wait(WAIT_SLICE_MS); this.exitObserved = true; }
      catch (error) {
        if (error instanceof Error && /WORKER_EXIT_UNCONFIRMED/.test(error.message)) continue;
        // The process handle is released by native cleanup; terminate() records whether exit was confirmed.
        await this.terminate();
      }
    }
    if (this.state === 'ready' || this.state === 'starting') this.fail('WORKER_EXITED');
    for (const waiter of this.exitWaiters.splice(0)) waiter();
  }
  private exited(deadlineMs: number): Promise<void> {
    if (this.exitObserved || this.cleanup === 'confirmed') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WORKER_EXIT_UNCONFIRMED')), deadlineMs);
      this.exitWaiters.push(() => { clearTimeout(timer); resolve(); });
    });
  }
  private fail(reason: string): void {
    if (this.state === 'failed' || this.state === 'stopped') return;
    this.failure ??= reason; this.state = 'failed';
    this.session?.close();
    void this.terminate();
  }
  /** Native close terminates the Job if still running, confirms exit and releases profile/ACL. */
  private terminate(): Promise<void> {
    this.closing ??= this.native.close().then(() => { this.cleanup = 'confirmed'; this.exitObserved = true; },
      () => { this.cleanup = 'unconfirmed'; }).then(() => {
      for (const waiter of this.exitWaiters.splice(0)) waiter();
      if (this.state !== 'stopped') this.state = this.state === 'stopping' ? 'stopped' : 'failed';
      this.finish({ reason: this.failure ?? 'STOPPED', exitCode: this.exitCode, cleanup: this.cleanup ?? 'unconfirmed' });
    });
    return this.closing;
  }
  snapshot(): { state: FixtureState; failure: string | null; workerRunId: string; pid: number; exitCode: number | null;
    session: ReturnType<RpcSession['snapshot']> | null } {
    return { state: this.state, failure: this.failure ?? null, workerRunId: this.identity.workerRunId, pid: this.baseline.pid,
      exitCode: this.exitCode, session: this.session?.snapshot() ?? null };
  }
  private call(method: 'health' | 'fixture.fault' | 'shutdown', params: unknown): Promise<RpcResponse> {
    if (!this.session || (this.state !== 'ready' && !(this.state === 'stopping' && method === 'shutdown'))) return Promise.reject(new Error('WORKER_NOT_READY'));
    const id = randomUUID();
    return this.session.request({ jsonrpc: '2.0', protocolVersion: PROTOCOL_VERSION, ...this.identity, role: 'express',
      id, requestId: id, method, params } as RpcRequest);
  }
  health(): Promise<RpcResponse> { return this.call('health', {}); }
  /** Fixture-only fault injection for P1 transport and supervision tests. */
  fault(mode: FixtureFault): Promise<RpcResponse> { return this.call('fixture.fault', { mode }); }
  /** Two-phase stop: shutdown RPC within the grace period, then Job termination and confirmed exit. */
  async stop(graceMs: number = SUPERVISION_POLICY.defaultGraceMs): Promise<TwoPhaseReport> {
    if (this.state === 'ready') this.state = 'stopping';
    const report = await stopInTwoPhases({
      graceful: async () => { if (this.state !== 'stopping') throw new Error('WORKER_NOT_READY'); await this.call('shutdown', { reason: 'normal' }); },
      exited: deadlineMs => this.exited(deadlineMs),
      force: () => this.terminate(),
    }, graceMs).catch(async error => { await this.terminate(); throw error; });
    // Profile/ACL release and handle closing always run; only a confirmed native cleanup counts.
    await this.terminate();
    if (this.cleanup !== 'confirmed') throw new Error('CLEANUP_UNCONFIRMED');
    return report;
  }
}

export interface FixtureHistoryEntry { readonly workerRunId: string; readonly pid: number; readonly reason: string; readonly cleanup: string }
export type SupervisorState = 'idle' | 'starting' | 'ready' | 'restarting' | 'budget-exhausted' | 'stopped' | 'unavailable';
/** Supervises at most one fixture Worker; restarts after unexpected exit within a bounded budget. */
export class FixtureSupervisor {
  private current: FixtureWorker | undefined;
  private state: SupervisorState = 'idle';
  private wanted = false;
  private readonly budget = new RestartBudget();
  private readonly history: FixtureHistoryEntry[] = [];
  private lastError: string | null = null;
  constructor(private readonly options: FixtureLaunchOptions) {}
  get worker(): FixtureWorker | undefined { return this.current; }
  snapshot(): { state: SupervisorState; restarts: number; worker: ReturnType<FixtureWorker['snapshot']> | null; history: FixtureHistoryEntry[]; lastError: string | null } {
    return { state: this.state, restarts: this.budget.restarts, worker: this.current?.snapshot() ?? null, history: [...this.history], lastError: this.lastError };
  }
  async start(): Promise<FixtureWorker> {
    if (this.wanted) throw new Error('SUPERVISOR_ALREADY_STARTED');
    this.wanted = true; return this.launch();
  }
  private async launch(): Promise<FixtureWorker> {
    this.state = 'starting';
    try {
      const worker = await FixtureWorker.launch(this.options);
      if (!this.wanted) { await worker.stop().catch(() => {}); throw new Error('SUPERVISOR_STOPPED'); }
      this.current = worker; this.state = 'ready';
      void worker.closed.then(exit => this.exited(worker, exit));
      return worker;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : 'WORKER_ISOLATION_UNAVAILABLE';
      this.state = this.wanted ? 'unavailable' : 'stopped'; throw error;
    }
  }
  private exited(worker: FixtureWorker, exit: FixtureExit): void {
    this.history.push({ workerRunId: worker.identity.workerRunId, pid: worker.baseline.pid, reason: exit.reason, cleanup: exit.cleanup });
    if (this.current !== worker) return;
    this.current = undefined;
    if (!this.wanted) { this.state = 'stopped'; return; }
    // Unknown cleanup blocks every new launch: an old Worker might still be alive.
    if (exit.cleanup !== 'confirmed') { this.state = 'unavailable'; this.lastError = 'CLEANUP_UNCONFIRMED'; return; }
    const decision = this.budget.request(Date.now());
    if (!decision.allowed) { this.state = 'budget-exhausted'; return; }
    this.state = 'restarting';
    setTimeout(() => { if (this.wanted) void this.launch().catch(() => {}); }, decision.delayMs);
  }
  async stop(): Promise<void> {
    this.wanted = false;
    const worker = this.current; this.current = undefined;
    if (worker) await worker.stop();
    this.state = 'stopped';
  }
}
