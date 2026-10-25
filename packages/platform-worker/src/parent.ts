import type { WorkerIdentity } from '@operation-agent/contracts';

export interface WorkerLaunchIdentity extends WorkerIdentity { readonly mode: 'isolated-fixture' }
export function requireWorkerLauncher(): never {
  throw new Error('WORKER_ISOLATION_UNAVAILABLE');
}
