import { launchIsolatedWorker } from '@operation-agent/platform-worker/parent';
import { RestartBudget } from '@operation-agent/platform-supervision';
import { FixtureWorker, clock } from '../worker/launcher.js';
import type { FixtureExit, FixtureLaunchOptions } from '../worker/launcher.js';
import { createAgentSession } from './host.js';
import type { TaskRunner } from './runner.js';

// Express's supervisor for the isolated agent Worker (ARCHITECTURE §3, §8.3; ADR-WIN-001). The Worker is launched on
// demand through the native AppContainer + Job launcher, its session is bound to the Task Runner, and its exit
// interrupts any task it was running. A launch never reuses an old Worker (each gets a new run identity), an exit whose
// cleanup was not confirmed blocks every further launch, and repeated failures exhaust a bounded budget.

export type AgentWorkerState = 'idle' | 'starting' | 'ready' | 'unavailable';
export interface AgentWorkerSupervisorOptions {
  runtimeDirectory: string;
  expressRunId: string;
  runner: TaskRunner;
  /** Tests substitute an in-process carrier; production always uses the native isolated launcher. */
  launcher?: FixtureLaunchOptions['launcher'];
  target?: string;
}
export interface AgentWorkerSnapshot { state: AgentWorkerState; launches: number; lastError: string | null; pid: number | null }

export class AgentWorkerSupervisor {
  private worker: FixtureWorker | undefined;
  private launching: Promise<void> | undefined;
  private state: AgentWorkerState = 'idle';
  private lastError: string | null = null;
  private launches = 0;
  private stopped = false;
  private readonly budget = new RestartBudget();
  constructor(private readonly options: AgentWorkerSupervisorOptions) {}

  snapshot(): AgentWorkerSnapshot {
    return { state: this.state, launches: this.launches, lastError: this.lastError, pid: this.worker?.baseline.pid ?? null };
  }

  /** Resolves once a qualified Worker is attached to the runner; rejects (fail closed) when none can be. */
  ensure(): Promise<void> {
    if (this.state === 'ready' && this.worker) return Promise.resolve();
    if (this.stopped || this.state === 'unavailable') return Promise.reject(new Error('WORKER_ISOLATION_UNAVAILABLE'));
    this.launching ??= this.launch().finally(() => { this.launching = undefined; });
    return this.launching;
  }

  private async launch(): Promise<void> {
    const decision = this.budget.request(Date.now());
    if (!decision.allowed) { this.unavailable('RESTART_BUDGET_EXHAUSTED'); throw new Error('WORKER_ISOLATION_UNAVAILABLE'); }
    this.state = 'starting'; this.launches++;
    const { runner } = this.options;
    try {
      const worker = await FixtureWorker.launch({
        target: this.options.target ?? `${process.platform}-${process.arch}`,
        runtimeDirectory: this.options.runtimeDirectory, expressRunId: this.options.expressRunId,
        launcher: this.options.launcher ?? launchIsolatedWorker,
        session: (transport, identity, onClose) => {
          const agent = createAgentSession({ identity, clock, transport, runner, onClose });
          return { session: agent.session, handshake: challenge => agent.handshake(challenge) };
        },
      });
      if (this.stopped) { await worker.stop().catch(() => {}); throw new Error('WORKER_ISOLATION_UNAVAILABLE'); }
      this.worker = worker; this.state = 'ready'; this.lastError = null;
      void worker.closed.then(exit => this.exited(worker, exit));
    } catch (error) {
      // A launch that failed without confirming its cleanup (native creation or a failed handshake) may have left a
      // process, profile or ACL behind: no further Worker is ever launched by this control plane.
      if (cleanupUnconfirmed(error)) this.unavailable('CLEANUP_UNCONFIRMED');
      else {
        this.lastError = (error instanceof Error ? error.message : 'WORKER_ISOLATION_UNAVAILABLE').slice(0, 512);
        if (this.state === 'starting') this.state = 'idle';
      }
      throw new Error('WORKER_ISOLATION_UNAVAILABLE', { cause: error });
    }
  }

  private exited(worker: FixtureWorker, exit: FixtureExit): void {
    if (this.worker !== worker) return;
    this.worker = undefined;
    // The session already detached the runner (interrupting its task); make sure even a silent exit does too.
    this.options.runner.detach('The agent worker exited');
    if (exit.cleanup !== 'confirmed') { this.unavailable('CLEANUP_UNCONFIRMED'); return; }
    if (!this.stopped) { this.state = 'idle'; this.lastError = exit.reason.slice(0, 512); }
  }

  private unavailable(reason: string): void { this.state = 'unavailable'; this.lastError = reason; }

  /** Graceful two-phase stop of the current Worker; afterwards no launch is accepted. */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.launching?.catch(() => {});
    const worker = this.worker; this.worker = undefined;
    this.options.runner.detach('The control plane is shutting down');
    if (worker) await worker.stop().catch(() => {});
    if (this.state !== 'unavailable') this.state = 'idle';
  }
}

/** Native creation reports WORKER_CREATION_CLEANUP_UNCONFIRMED; a failed start reports its cleanup on the error itself. */
function cleanupUnconfirmed(error: unknown): boolean {
  if (error && typeof error === 'object' && 'cleanup' in error && error.cleanup !== 'confirmed') return true;
  const message = error instanceof Error ? error.message : '';
  return /CLEANUP_UNCONFIRMED/.test(message) || /cleanup unconfirmed/.test(message);
}
