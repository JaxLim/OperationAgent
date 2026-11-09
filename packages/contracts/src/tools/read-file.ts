import { z } from 'zod';

// ARCHITECTURE §5.2 / SEC-08: `read_file` runs only in a short-lived, low-privilege Read Adapter child process launched
// by Express. These shapes are the tool's arguments as an agent may request them and the normalized result Express
// returns. A Worker never sees the workspace root, an absolute path or anything outside the requested file.

export const READ_FILE_LIMITS = Object.freeze({
  maxPathChars: 512, maxSegments: 64, maxSegmentChars: 255,
  defaultMaxBytes: 65_536, maxBytes: 262_144,
  /** Express-side deadline for one child, from spawn to confirmed exit. Registry values outside the range are rejected. */
  defaultTimeoutMs: 5_000, minTimeoutMs: 1_000, maxTimeoutMs: 30_000,
  maxConcurrent: 4, maxQueued: 32,
  /** list_directory: entries returned per call and levels walked. */
  maxEntries: 1_000, maxDepth: 4,
});

export const ReadFileArgsSchema = z.strictObject({
  /** Workspace-relative; `/` or `\` separators. Absolute, drive, UNC, stream and parent-directory forms are refused. */
  path: z.string().min(1).max(READ_FILE_LIMITS.maxPathChars),
  maxBytes: z.number().int().min(1).max(READ_FILE_LIMITS.maxBytes).optional(),
});
export type ReadFileArgs = z.infer<typeof ReadFileArgsSchema>;

/** Policy refusals: deterministic, audited, never retried. */
export const ReadRefusalCodeSchema = z.enum([
  'INVALID_PATH', 'OUTSIDE_WORKSPACE', 'SENSITIVE_PATH', 'NOT_FOUND', 'NOT_A_FILE', 'LINK_REJECTED', 'MULTIPLE_LINKS',
  'BINARY_FILE', 'CHANGED_DURING_READ', 'ACCESS_DENIED', 'WORKSPACE_UNAVAILABLE',
]);
export type ReadRefusalCode = z.infer<typeof ReadRefusalCodeSchema>;

/** Adapter failures: the read did not complete; nothing was returned. */
export const ReadFailureCodeSchema = z.enum(['READ_ADAPTER_UNAVAILABLE', 'TIMED_OUT', 'ADAPTER_FAILED', 'BUSY', 'CLEANUP_UNCONFIRMED']);
export type ReadFailureCode = z.infer<typeof ReadFailureCodeSchema>;

const RelativePathSchema = z.string().min(1).max(READ_FILE_LIMITS.maxPathChars);
export const ReadFileResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('ok'),
    /** Normalized workspace-relative path with `/` separators. */
    path: RelativePathSchema,
    content: z.string().max(READ_FILE_LIMITS.maxBytes),
    /** UTF-8 bytes in `content`; `size` is the whole file. */
    bytes: z.number().int().nonnegative().max(READ_FILE_LIMITS.maxBytes),
    size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    truncated: z.boolean(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  z.strictObject({ status: z.literal('refused'), code: ReadRefusalCodeSchema }),
  z.strictObject({ status: z.literal('failed'), code: ReadFailureCodeSchema, retryable: z.boolean() }),
]);
export type ReadFileResult = z.infer<typeof ReadFileResultSchema>;

export const ListDirectoryArgsSchema = z.strictObject({
  /** Workspace-relative directory; "." or "" is the workspace root. Same refusals as `read_file`. */
  path: z.string().max(READ_FILE_LIMITS.maxPathChars),
  depth: z.number().int().min(1).max(READ_FILE_LIMITS.maxDepth).optional(),
});
export type ListDirectoryArgs = z.infer<typeof ListDirectoryArgsSchema>;
export const DirectoryEntrySchema = z.strictObject({
  /** Workspace-relative, `/` separators. */
  path: RelativePathSchema,
  type: z.enum(['file', 'directory', 'link', 'other']),
  /** Bytes, files only. */
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
});
export type DirectoryEntry = z.infer<typeof DirectoryEntrySchema>;
export const ListDirectoryResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ok'), path: z.string().max(READ_FILE_LIMITS.maxPathChars),
    entries: z.array(DirectoryEntrySchema).max(READ_FILE_LIMITS.maxEntries), truncated: z.boolean() }),
  z.strictObject({ status: z.literal('refused'), code: ReadRefusalCodeSchema }),
  z.strictObject({ status: z.literal('failed'), code: ReadFailureCodeSchema, retryable: z.boolean() }),
]);
export type ListDirectoryResult = z.infer<typeof ListDirectoryResultSchema>;

// Read Adapter child protocol (one line each way over the child's stdin/stdout). The workspace root is a launch
// argument fixed by Express, not part of the request; content travels as base64 so the reply is ASCII and bounded.
export const READ_CHILD_PROTOCOL = 1;
const SegmentsSchema = z.array(z.string().min(1).max(READ_FILE_LIMITS.maxSegmentChars)).max(READ_FILE_LIMITS.maxSegments);
export const ReadChildRequestSchema = z.discriminatedUnion('op', [
  z.strictObject({ v: z.literal(READ_CHILD_PROTOCOL), op: z.literal('read'), segments: SegmentsSchema.min(1),
    maxBytes: z.number().int().min(1).max(READ_FILE_LIMITS.maxBytes) }),
  /** An empty segment list lists the root. */
  z.strictObject({ v: z.literal(READ_CHILD_PROTOCOL), op: z.literal('list'), segments: SegmentsSchema,
    depth: z.number().int().min(1).max(READ_FILE_LIMITS.maxDepth), maxEntries: z.number().int().min(1).max(READ_FILE_LIMITS.maxEntries) }),
]);
export type ReadChildRequest = z.infer<typeof ReadChildRequestSchema>;
export const ReadChildReplySchema = z.discriminatedUnion('status', [
  z.strictObject({ v: z.literal(READ_CHILD_PROTOCOL), status: z.literal('ok'),
    content: z.base64().max(Math.ceil(READ_FILE_LIMITS.maxBytes / 3) * 4),
    size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), truncated: z.boolean() }),
  z.strictObject({ v: z.literal(READ_CHILD_PROTOCOL), status: z.literal('listed'),
    // Child-relative segments of each entry below the listed directory; Express rebuilds and re-checks the paths.
    entries: z.array(z.strictObject({ segments: SegmentsSchema.min(1), type: DirectoryEntrySchema.shape.type,
      size: DirectoryEntrySchema.shape.size })).max(READ_FILE_LIMITS.maxEntries),
    truncated: z.boolean() }),
  z.strictObject({ v: z.literal(READ_CHILD_PROTOCOL), status: z.literal('refused'), code: ReadRefusalCodeSchema }),
]);
export type ReadChildReply = z.infer<typeof ReadChildReplySchema>;
/** Upper bound on one reply line, used by Express to cap the child's stdout. */
export const READ_CHILD_MAX_REPLY_BYTES = Math.max(Math.ceil(READ_FILE_LIMITS.maxBytes / 3) * 4,
  // A full listing: every entry at the deepest path, with JSON escaping headroom.
  READ_FILE_LIMITS.maxEntries * (READ_FILE_LIMITS.maxPathChars * 2 + 128)) + 1_024;

// Express's audit record of one tool decision (migration 007). Never carries file content or the workspace root.
export const TOOL_AUDIT_LIMITS = Object.freeze({ maxRows: 10_000, maxList: 200 });
const nullableId = z.uuid().nullable();
export const ToolAuditInputSchema = z.strictObject({
  toolId: z.enum(['read_file', 'list_directory']),
  projectId: nullableId, taskId: nullableId, toolCallId: nullableId,
  /** Normalized relative path; empty when the requested path was not valid. */
  path: z.string().max(READ_FILE_LIMITS.maxPathChars),
  decision: z.enum(['allowed', 'refused', 'failed']),
  code: z.string().min(1).max(64).regex(/^[A-Z_]+$/).nullable(),
  /** Bytes returned (read_file) or entries returned (list_directory). */
  bytes: z.number().int().nonnegative().max(READ_FILE_LIMITS.maxBytes),
  durationMs: z.number().int().nonnegative(),
});
export type ToolAuditInput = z.infer<typeof ToolAuditInputSchema>;
export const ToolAuditEntrySchema = ToolAuditInputSchema.extend({ id: z.uuid(), createdAt: z.iso.datetime() });
export type ToolAuditEntry = z.infer<typeof ToolAuditEntrySchema>;
