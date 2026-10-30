import { z } from 'zod';

// ARCHITECTURE §9.1.1 / AGENTS §7. Deltas are realtime only; Express's Tool Registry fixes what is
// persisted and never trusts a Worker or MCP declaration. These are shapes, not a stream implementation.

export const TOOL_OUTPUT_LIMITS = Object.freeze({ maxChunkBytes: 16_384, maxBufferedBytes: 1_048_576,
  maxPersistedSummaryBytes: 16_384, maxDiagnostics: 20, maxDiagnosticChars: 512 });

/** UTF-8 length without platform encoders; a lone surrogate counts as its 3-byte replacement character. */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const char of value) {
    const code = char.codePointAt(0)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

const byteCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const correlation = { taskId: z.uuid(), toolCallId: z.uuid(), attemptId: z.uuid() };
export const ToolStreamSchema = z.enum(['stdout', 'stderr']);
export type ToolStream = z.infer<typeof ToolStreamSchema>;

export const ToolOutputDeltaSchema = z.strictObject({
  type: z.literal('tool_output_delta'), ...correlation, stream: ToolStreamSchema,
  chunkSeq: byteCount, byteOffset: byteCount,
  data: z.string().refine(value => utf8ByteLength(value) <= TOOL_OUTPUT_LIMITS.maxChunkBytes, 'CHUNK_TOO_LARGE'),
  timestamp: z.iso.datetime(),
});
export type ToolOutputDelta = z.infer<typeof ToolOutputDeltaSchema>;

/** Gap marker for slow consumers; the dropped bytes are not recoverable by replay. */
export const ToolOutputTruncatedSchema = z.strictObject({
  type: z.literal('tool_output_truncated'), ...correlation, stream: ToolStreamSchema, droppedBytes: byteCount.min(1),
});
export type ToolOutputTruncated = z.infer<typeof ToolOutputTruncatedSchema>;

export const ToolDiagnosticSchema = z.strictObject({ severity: z.enum(['warning', 'error']),
  summary: z.string().min(1).max(TOOL_OUTPUT_LIMITS.maxDiagnosticChars) });
export const ToolOutputSummarySchema = z.strictObject({
  type: z.literal('tool_output_summary'), ...correlation,
  stdoutBytes: byteCount, stderrBytes: byteCount, sampledBytes: byteCount, truncatedBytes: byteCount,
  exitCode: z.number().int().nullable(),
  diagnostics: z.array(ToolDiagnosticSchema).max(TOOL_OUTPUT_LIMITS.maxDiagnostics),
}).refine(value => value.sampledBytes <= value.stdoutBytes + value.stderrBytes &&
  value.truncatedBytes <= value.stdoutBytes + value.stderrBytes, 'SUMMARY_COUNTS_INCONSISTENT');
export type ToolOutputSummary = z.infer<typeof ToolOutputSummarySchema>;

export const OutputPolicySchema = z.strictObject({
  realtime: z.literal('bounded-stream'),
  // V1 forbids per-chunk persistence; no other value is representable.
  deltaPersistence: z.literal('transient'),
  finalPersistence: z.literal('redacted-summary'),
  maxChunkBytes: z.number().int().min(1).max(TOOL_OUTPUT_LIMITS.maxChunkBytes),
  maxBufferedBytes: z.number().int().min(1).max(TOOL_OUTPUT_LIMITS.maxBufferedBytes),
  maxPersistedSummaryBytes: z.number().int().min(1).max(TOOL_OUTPUT_LIMITS.maxPersistedSummaryBytes),
}).refine(value => value.maxBufferedBytes >= value.maxChunkBytes, 'BUFFER_SMALLER_THAN_CHUNK');
export type OutputPolicy = z.infer<typeof OutputPolicySchema>;

export const ToolOutputEventSchema = z.discriminatedUnion('type', [ToolOutputDeltaSchema, ToolOutputTruncatedSchema, ToolOutputSummarySchema]);
export type ToolOutputEvent = z.infer<typeof ToolOutputEventSchema>;

/** Only the redacted summary is a durable audit event; deltas and gap markers stay in memory. */
export const TOOL_OUTPUT_PERSISTENCE = Object.freeze({
  tool_output_delta: 'transient', tool_output_truncated: 'transient', tool_output_summary: 'persisted',
} as const satisfies Record<ToolOutputEvent['type'], 'transient' | 'persisted'>);
