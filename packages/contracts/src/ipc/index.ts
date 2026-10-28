import { z } from 'zod';
import { PROTOCOL_VERSION } from '../version/index.js';
import type { ControlHealth, SmokeBatch, SmokeRecords } from '../api/index.js';
export { ServiceTreeIdentitySchema } from './identity.js';
export type { ServiceTreeIdentity } from './identity.js';

// Local build metadata is separate from the authenticated asynchronous health API.
export const FoundationInfoSchema = z.strictObject({
  protocolVersion: z.literal(PROTOCOL_VERSION), component: z.literal('preload'), instanceId: z.uuid(),
  phase: z.literal('P1.3'), controlPlaneReady: z.literal(false), agentReady: z.literal(false),
});
export type FoundationInfo = z.infer<typeof FoundationInfoSchema>;
export const IPC_CHANNELS = Object.freeze({ health: 'oa:control-health', listRecords: 'oa:smoke-list', writeRecords: 'oa:smoke-write' });
export const EmptyInputSchema = z.strictObject({});
export interface DesktopApi {
  getFoundationInfo(): FoundationInfo;
  getControlPlaneHealth(): Promise<ControlHealth>;
  listSmokeRecords(): Promise<SmokeRecords>;
  writeSmokeRecords(input: SmokeBatch): Promise<SmokeRecords>;
}
