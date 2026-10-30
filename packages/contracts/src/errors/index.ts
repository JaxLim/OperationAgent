import { z } from 'zod';

export const ErrorCodeSchema = z.enum(['VALIDATION_ERROR', 'PROTOCOL_MISMATCH', 'IDENTITY_MISMATCH',
  'WORKER_ISOLATION_UNAVAILABLE', 'NOT_IMPLEMENTED']);
export const RpcErrorSchema = z.strictObject({
  code: z.union([z.literal(-32600), z.literal(-32602), z.literal(-32000)]),
  message: ErrorCodeSchema,
  data: z.strictObject({ retryable: z.literal(false) }),
});
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

// ARCHITECTURE §8.5/§9.1 domain errors for the task API. Kept apart from the RPC set above, whose
// handshake-only codes stay unchanged. `details` is omitted until a producer needs a whitelisted shape.
export const DomainErrorCodeSchema = z.enum(['VALIDATION_ERROR', 'PERMISSION_DENIED', 'APPROVAL_REQUIRED',
  'WORKER_ISOLATION_UNAVAILABLE', 'SANDBOX_UNAVAILABLE', 'READ_ADAPTER_UNAVAILABLE', 'CAPABILITY_UNAVAILABLE',
  'INVALID_TRANSITION', 'NOT_FOUND', 'SERVICE_UNAVAILABLE']);
export type DomainErrorCode = z.infer<typeof DomainErrorCodeSchema>;
export const AppErrorSchema = z.strictObject({ code: DomainErrorCodeSchema, message: z.string().min(1).max(512),
  requestId: z.uuid(), retryable: z.boolean() });
export type AppError = z.infer<typeof AppErrorSchema>;
