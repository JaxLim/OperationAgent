import { z } from 'zod';

export const ErrorCodeSchema = z.enum(['VALIDATION_ERROR', 'PROTOCOL_MISMATCH', 'IDENTITY_MISMATCH',
  'WORKER_ISOLATION_UNAVAILABLE', 'NOT_IMPLEMENTED']);
export const RpcErrorSchema = z.strictObject({
  code: z.union([z.literal(-32600), z.literal(-32602), z.literal(-32000)]),
  message: ErrorCodeSchema,
  data: z.strictObject({ retryable: z.literal(false) }),
});
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;
