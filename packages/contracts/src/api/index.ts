import { z } from 'zod';
import { PROTOCOL_VERSION } from '../version/index.js';
import { ServiceTreeIdentitySchema } from '../ipc/identity.js';
import { ModelEndpointSchema } from './model.js';

export const CONTROL_POLICY = Object.freeze({ handshakeMs: 10_000, requestMs: 2_000, heartbeatMs: 1_000,
  missedHeartbeats: 3, shutdownMs: 5_000, killWaitMs: 2_000, restartWindowMs: 60_000, maxRestarts: 3,
  // 100 records × 256 UTF-16 code units may expand to six JSON bytes per unit, plus record metadata.
  maxBodyBytes: 16_384, maxResponseBytes: 196_608, maxRequestsPerWindow: 240, maxHeartbeatsPerWindow: 60, authWindowMs: 30_000 });
export const CONTROL_ROUTES = Object.freeze({ health: '/v1/health', heartbeat: '/v1/heartbeat', records: '/v1/smoke-records', taskStart: '/v1/tasks/start',
  overview: '/v1/overview', settings: '/v1/settings', projects: '/v1/projects', projectRemove: '/v1/projects/remove', runs: '/v1/runs',
  tasks: '/v1/tasks', taskSnapshot: '/v1/tasks/snapshot', taskEvents: '/v1/tasks/events',
  // M2 model settings: fixed operations only; there is no generic provider proxy.
  modelSettings: '/v1/model/settings', modelCredential: '/v1/model/credential', modelCredentialClear: '/v1/model/credential/clear',
  modelTest: '/v1/model/test' });
export const ControlErrorSchema = z.enum(['VALIDATION_ERROR', 'AUTHENTICATION_FAILED', 'IDENTITY_MISMATCH',
  'SERVICE_UNAVAILABLE', 'DATABASE_UNAVAILABLE', 'RECORD_CONFLICT', 'RATE_LIMITED', 'WORKER_ISOLATION_UNAVAILABLE', 'NOT_FOUND', 'LIMIT_EXCEEDED',
  // The client's cursor is past the committed log (e.g. another database); it must refetch the snapshot.
  'CURSOR_AHEAD',
  // SEC-14: OS-backed encryption is unavailable, so a key is refused instead of being stored weakly.
  'SECURE_STORAGE_UNAVAILABLE']);
export type ControlError = z.infer<typeof ControlErrorSchema>;
export const ControlFailureSchema = z.strictObject({ error: ControlErrorSchema });
export const SmokeRecordInputSchema = z.strictObject({ id: z.uuid(), value: z.string().min(1).max(256) });
export const SmokeBatchSchema = z.strictObject({ records: z.array(SmokeRecordInputSchema).min(1).max(10) });
export const SmokeRecordSchema = SmokeRecordInputSchema.extend({ createdAt: z.iso.datetime() });
export const SmokeRecordsSchema = z.strictObject({ records: z.array(SmokeRecordSchema).max(100) });
export type SmokeBatch = z.infer<typeof SmokeBatchSchema>;
export type SmokeRecord = z.infer<typeof SmokeRecordSchema>;
export type SmokeRecords = z.infer<typeof SmokeRecordsSchema>;
export const ControlHealthSchema = z.strictObject({ protocolVersion: z.literal(PROTOCOL_VERSION),
  ...ServiceTreeIdentitySchema.shape, controlPlaneReady: z.literal(true), agentReady: z.literal(false),
  databaseVersion: z.literal(5), recoveredRuns: z.number().int().nonnegative() });
export type ControlHealth = z.infer<typeof ControlHealthSchema>;
export const BootstrapSchema = z.strictObject({ kind: z.literal('bootstrap'), protocolVersion: z.literal(PROTOCOL_VERSION),
  ...ServiceTreeIdentitySchema.shape, token: z.string().regex(/^[a-f0-9]{64}$/),
  dataDirectory: z.string().min(1).max(4096), parentPid: z.number().int().positive(),
  // Absent in production (the fixed Anthropic endpoint applies); tests may point Express at a loopback fake provider.
  modelEndpoint: ModelEndpointSchema.optional() });
export type Bootstrap = z.infer<typeof BootstrapSchema>;
export const SidecarReadySchema = z.strictObject({ kind: z.literal('ready'), protocolVersion: z.literal(PROTOCOL_VERSION),
  ...ServiceTreeIdentitySchema.shape, pid: z.number().int().positive(), parentPid: z.number().int().positive(),
  port: z.number().int().min(1).max(65535), node: z.string(), abi: z.string() });
export type SidecarReady = z.infer<typeof SidecarReadySchema>;
export const ShutdownSchema = z.strictObject({ kind: z.literal('shutdown'), ...ServiceTreeIdentitySchema.shape });
export const AuthHeadersSchema = z.strictObject({ mainRunId: z.uuid(), expressRunId: z.uuid(),
  requestId: z.uuid(), timestamp: z.string().regex(/^\d{13}$/), signature: z.string().regex(/^[a-f0-9]{64}$/) });
export type AuthHeaders = z.infer<typeof AuthHeadersSchema>;
// Canonical strings only; cryptography and I/O remain in the owning processes.
export function requestProof(input: Omit<AuthHeaders, 'signature'>, method: string, path: string, body: string): string {
  return JSON.stringify(['OA-HTTP-1', PROTOCOL_VERSION, input.mainRunId, input.expressRunId, input.requestId, input.timestamp, method, path, body]);
}
export function responseProof(input: Pick<AuthHeaders, 'mainRunId' | 'expressRunId' | 'requestId'>, status: number, body: string): string {
  return JSON.stringify(['OA-RESPONSE-1', input.mainRunId, input.expressRunId, input.requestId, status, body]);
}
