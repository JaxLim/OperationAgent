import type { ServiceTreeIdentity } from '@operation-agent/contracts';
export type { ServiceTreeIdentity };

// Pure supervision policy shared by Main (Express service tree) and Express (direct Worker child).
// No process, timer or OS capability lives here; owners inject time and actions.

export const SUPERVISION_POLICY = Object.freeze({ restartWindowMs: 60_000, maxRestarts: 3, baseBackoffMs: 250,
  defaultGraceMs: 5_000, maxGraceMs: 30_000, confirmMs: 2_000 });

export interface RestartDecision { readonly allowed: boolean; readonly delayMs: number; readonly restarts: number }

/** A sliding-window restart budget with exponential backoff. Exhaustion is sticky until reset. */
export class RestartBudget {
  private attempts: number[] = [];
  private exhausted = false;
  constructor(private readonly maxRestarts: number = SUPERVISION_POLICY.maxRestarts,
    private readonly windowMs: number = SUPERVISION_POLICY.restartWindowMs, private readonly baseBackoffMs: number = SUPERVISION_POLICY.baseBackoffMs) {
    if (!Number.isInteger(maxRestarts) || maxRestarts < 0 || !(windowMs > 0) || !(baseBackoffMs >= 0)) throw new Error('VALIDATION_ERROR');
  }
  get restarts(): number { return this.attempts.length; }
  get isExhausted(): boolean { return this.exhausted; }
  request(now: number): RestartDecision {
    if (this.exhausted) return { allowed: false, delayMs: 0, restarts: this.attempts.length };
    this.attempts = this.attempts.filter(time => now - time < this.windowMs);
    if (this.attempts.length >= this.maxRestarts) { this.exhausted = true; return { allowed: false, delayMs: 0, restarts: this.attempts.length }; }
    this.attempts.push(now);
    return { allowed: true, delayMs: this.baseBackoffMs * 2 ** (this.attempts.length - 1), restarts: this.attempts.length };
  }
  reset(): void { this.attempts = []; this.exhausted = false; }
}

/** Grace periods outside 5–30 s are rejected when registered, never clamped. */
export function validateGraceMs(value: number): number {
  if (!Number.isInteger(value) || value < SUPERVISION_POLICY.defaultGraceMs || value > SUPERVISION_POLICY.maxGraceMs) throw new Error('GRACE_PERIOD_OUT_OF_RANGE');
  return value;
}

export interface TwoPhaseActions {
  /** Ask the child to exit on its own (shutdown RPC or message). Rejection means escalate. */
  graceful(): Promise<void>;
  /** Resolves once exit is observed; rejects at its own deadline. */
  exited(deadlineMs: number): Promise<void>;
  /** Forcefully terminate the whole owned tree (Job object / process group). */
  force(): Promise<void>;
}
export interface TwoPhaseReport { readonly phase: 'graceful' | 'forced'; readonly confirmed: true }

/**
 * Graceful request bounded by the grace period, then forced termination with a confirmation deadline.
 * Cleanup is only reported once exit was actually observed; otherwise the promise rejects and the
 * owner must fail closed (no new side-effecting dispatch).
 */
export async function stopInTwoPhases(actions: TwoPhaseActions, graceMs: number = SUPERVISION_POLICY.defaultGraceMs,
  confirmMs: number = SUPERVISION_POLICY.confirmMs): Promise<TwoPhaseReport> {
  validateGraceMs(graceMs);
  try {
    await actions.graceful();
    await actions.exited(graceMs);
    return { phase: 'graceful', confirmed: true };
  } catch { /* Escalate below. */ }
  try {
    await actions.force();
    await actions.exited(confirmMs);
  } catch { throw new Error('CLEANUP_UNCONFIRMED'); }
  return { phase: 'forced', confirmed: true };
}
