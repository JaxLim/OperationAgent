import { z } from 'zod';
import { PROTOCOL_VERSION } from '../version/index.js';
import { RpcErrorSchema } from '../errors/index.js';

export const RunIdSchema = z.uuid();
export const WorkerIdentitySchema = z.strictObject({ expressRunId: RunIdSchema, workerRunId: RunIdSchema });
export type WorkerIdentity = z.infer<typeof WorkerIdentitySchema>;
export const PeerRoleSchema = z.enum(['express', 'worker']);
export type PeerRole = z.infer<typeof PeerRoleSchema>;
const envelope = {
  jsonrpc: z.literal('2.0'), protocolVersion: z.literal(PROTOCOL_VERSION),
  ...WorkerIdentitySchema.shape, requestId: RunIdSchema, id: RunIdSchema,
};
const correlated = (value: { id: string; requestId: string }): boolean => value.id === value.requestId;
export const HealthSchema = z.strictObject({ controlPlaneReady: z.literal(false), agentReady: z.literal(false) });
const hello = z.strictObject({ minimumProtocolVersion: z.literal(PROTOCOL_VERSION),
  capabilities: z.tuple([z.literal('health'), z.literal('shutdown')]) });
export const RpcRequestSchema = z.discriminatedUnion('method', [
  z.strictObject({ ...envelope, role: z.literal('worker'), method: z.literal('hello'), params: hello }),
  z.strictObject({ ...envelope, role: z.literal('express'), method: z.literal('health'), params: z.strictObject({}) }),
  z.strictObject({ ...envelope, role: z.literal('express'), method: z.literal('shutdown'), params: z.strictObject({ reason: z.literal('normal') }) }),
]).refine(correlated, 'CORRELATION_MISMATCH');
const result = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('hello'), ...hello.shape, ...HealthSchema.shape }),
  z.strictObject({ kind: z.literal('health'), ...HealthSchema.shape }),
  z.strictObject({ kind: z.literal('shutdown'), stopped: z.literal(true) }),
]);
export const RpcResponseSchema = z.union([
  z.strictObject({ ...envelope, role: PeerRoleSchema, result }),
  z.strictObject({ ...envelope, role: PeerRoleSchema, error: RpcErrorSchema }),
]).refine(correlated, 'CORRELATION_MISMATCH');
export const RpcMessageSchema = z.union([RpcRequestSchema, RpcResponseSchema]);
export type RpcRequest = z.infer<typeof RpcRequestSchema>;
export type RpcResponse = z.infer<typeof RpcResponseSchema>;
export type RpcMessage = z.infer<typeof RpcMessageSchema>;
