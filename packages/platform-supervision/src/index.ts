import type { ServiceTreeIdentity } from '@operation-agent/contracts';
export type { ServiceTreeIdentity };
export function requireServiceTreeSupervisor(): never {
  throw new Error('NOT_IMPLEMENTED: P1.5 service tree supervision');
}
