import { z } from 'zod';
import { PROTOCOL_VERSION } from '../version/index.js';

// Local preload build metadata only; no Main/Express health or business IPC yet.
export const FoundationInfoSchema = z.strictObject({
  protocolVersion: z.literal(PROTOCOL_VERSION), component: z.literal('preload'), instanceId: z.uuid(),
  phase: z.literal('P1.1'), controlPlaneReady: z.literal(false), agentReady: z.literal(false),
});
export type FoundationInfo = z.infer<typeof FoundationInfoSchema>;
export const ServiceTreeIdentitySchema = z.strictObject({ mainRunId: z.uuid(), expressRunId: z.uuid() });
export type ServiceTreeIdentity = z.infer<typeof ServiceTreeIdentitySchema>;
export interface DesktopApi { getFoundationInfo(): FoundationInfo }
