import type { WorkerRpcClient } from '@operation-agent/worker-transport';
export type { WorkerRpcClient };

// No process creation, fixture execution or Agent Loop is available in P1.1.
export function startWorker(): never { throw new Error('WORKER_ISOLATION_UNAVAILABLE'); }
