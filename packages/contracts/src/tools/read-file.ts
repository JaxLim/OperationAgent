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
  /** read_file line ranges: lines per call, the highest first line, and the lines returned when only a start is given. */
  maxLineCount: 2_000, maxStartLine: 10_000_000, defaultLineCount: 200,
  /**
   * search_text and find_files (ADR-PLAT-001 D3). One call walks at most `maxWalkDepth` levels and opens at most
   * `maxSearchFiles` files of at most `maxSearchFileBytes` each; the child stops itself after `searchBudgetMs` and
   * returns what it has, well before Express's `searchTimeoutMs` deadline would kill it.
   */
  maxQueryChars: 256, maxGlobChars: 128, maxMatchChars: 240,
  defaultSearchResults: 50, maxSearchResults: 200, defaultFindResults: 200, maxFindResults: 500,
  maxWalkDepth: 24, maxSearchFiles: 5_000, maxSearchFileBytes: 1_048_576,
  searchTimeoutMs: 15_000, searchBudgetMs: 9_000,
});

const line = z.number().int().min(1);
export const ReadFileArgsSchema = z.strictObject({
  /** Workspace-relative; `/` or `\` separators. Absolute, drive, UNC, stream and parent-directory forms are refused. */
  path: z.string().min(1).max(READ_FILE_LIMITS.maxPathChars),
  maxBytes: z.number().int().min(1).max(READ_FILE_LIMITS.maxBytes).optional(),
  /** Read a range of lines instead of the start of the file: the first line (1-based) and how many lines. */
  startLine: line.max(READ_FILE_LIMITS.maxStartLine).optional(),
  lineCount: line.max(READ_FILE_LIMITS.maxLineCount).optional(),
});
export type ReadFileArgs = z.infer<typeof ReadFileArgsSchema>;

/** Policy refusals: deterministic, audited, never retried. */
export const ReadRefusalCodeSchema = z.enum([
  'INVALID_PATH', 'OUTSIDE_WORKSPACE', 'SENSITIVE_PATH', 'NOT_FOUND', 'NOT_A_FILE', 'LINK_REJECTED', 'MULTIPLE_LINKS',
  'BINARY_FILE', 'CHANGED_DURING_READ', 'ACCESS_DENIED', 'WORKSPACE_UNAVAILABLE',
  // search_text / find_files: the query is not a valid regular expression, or the name pattern is not a plain file-name pattern.
  'INVALID_QUERY',
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
    /**
     * Present when a range of lines was requested: the first line asked for, how many lines `content` holds, and the
     * file's line count (null when the file is too large to count in one call).
     */
    range: z.strictObject({ startLine: line.max(READ_FILE_LIMITS.maxStartLine), lines: z.number().int().min(0).max(READ_FILE_LIMITS.maxLineCount),
      totalLines: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable() }).optional(),
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
    entries: z.array(DirectoryEntrySchema).max(READ_FILE_LIMITS.maxEntries), truncated: z.boolean(),
    /** Directories whose contents were not read because they could not be pinned (they hold only links or locked entries). */
    unlisted: z.array(z.string().max(READ_FILE_LIMITS.maxPathChars)).max(100) }),
  z.strictObject({ status: z.literal('refused'), code: ReadRefusalCodeSchema }),
  z.strictObject({ status: z.literal('failed'), code: ReadFailureCodeSchema, retryable: z.boolean() }),
]);
export type ListDirectoryResult = z.infer<typeof ListDirectoryResultSchema>;

// search_text and find_files (ADR-PLAT-001 D3): find the place first, then read only that part. Both walk the tree in
// the Read Adapter child under the same rules as list_directory (links never followed, sensitive directories never
// entered); search_text additionally never opens a sensitive, binary, hard-linked or oversized file.
const OptionalDirectorySchema = z.string().max(READ_FILE_LIMITS.maxPathChars).optional();
/** `*` and `?` wildcards on a file name. No path separators: the directory goes in `path`. */
export const FileNamePatternSchema = z.string().min(1).max(READ_FILE_LIMITS.maxGlobChars);
export const SearchTextArgsSchema = z.strictObject({
  /** Text to find, on one line. A plain string unless `regex` is true. */
  query: z.string().min(1).max(READ_FILE_LIMITS.maxQueryChars),
  /** Workspace-relative directory or file to search; the workspace root when omitted. */
  path: OptionalDirectorySchema,
  regex: z.boolean().optional(),
  ignoreCase: z.boolean().optional(),
  /** Only search files whose name matches, for example `*.ts`. */
  fileNames: FileNamePatternSchema.optional(),
  maxResults: z.number().int().min(1).max(READ_FILE_LIMITS.maxSearchResults).optional(),
});
export type SearchTextArgs = z.infer<typeof SearchTextArgsSchema>;
export const SearchMatchSchema = z.strictObject({
  path: RelativePathSchema,
  line: line.max(Number.MAX_SAFE_INTEGER),
  /** The matching line, or a window of it around the match when the line is long. */
  text: z.string().max(READ_FILE_LIMITS.maxMatchChars),
});
export type SearchMatch = z.infer<typeof SearchMatchSchema>;
export const SearchTextResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ok'), path: z.string().max(READ_FILE_LIMITS.maxPathChars),
    matches: z.array(SearchMatchSchema).max(READ_FILE_LIMITS.maxSearchResults),
    /** The result, file, size or time limit was reached before the whole tree was searched. */
    truncated: z.boolean(),
    filesScanned: z.number().int().nonnegative().max(READ_FILE_LIMITS.maxSearchFiles),
    /** Files not searched because they are binary, not UTF-8, larger than the per-file limit, hard-linked or locked. */
    filesSkipped: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }),
  z.strictObject({ status: z.literal('refused'), code: ReadRefusalCodeSchema }),
  z.strictObject({ status: z.literal('failed'), code: ReadFailureCodeSchema, retryable: z.boolean() }),
]);
export type SearchTextResult = z.infer<typeof SearchTextResultSchema>;

export const FindFilesArgsSchema = z.strictObject({
  /** A file-name pattern such as `*.test.ts` or `Dockerfile*`. */
  pattern: FileNamePatternSchema,
  /** Workspace-relative directory to look in; the workspace root when omitted. */
  path: OptionalDirectorySchema,
  maxResults: z.number().int().min(1).max(READ_FILE_LIMITS.maxFindResults).optional(),
});
export type FindFilesArgs = z.infer<typeof FindFilesArgsSchema>;
export const FindFilesResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ok'), path: z.string().max(READ_FILE_LIMITS.maxPathChars),
    entries: z.array(DirectoryEntrySchema).max(READ_FILE_LIMITS.maxFindResults), truncated: z.boolean() }),
  z.strictObject({ status: z.literal('refused'), code: ReadRefusalCodeSchema }),
  z.strictObject({ status: z.literal('failed'), code: ReadFailureCodeSchema, retryable: z.boolean() }),
]);
export type FindFilesResult = z.infer<typeof FindFilesResultSchema>;

// Read Adapter child protocol (one line each way over the child's stdin/stdout). The workspace root is a launch
// argument fixed by Express, not part of the request; content travels as base64 so the reply is ASCII and bounded.
// Version 2 adds line ranges to `read` and the `search` and `find` operations.
export const READ_CHILD_PROTOCOL = 2;
const SegmentsSchema = z.array(z.string().min(1).max(READ_FILE_LIMITS.maxSegmentChars)).max(READ_FILE_LIMITS.maxSegments);
const NamesSchema = z.array(z.string().min(1).max(READ_FILE_LIMITS.maxSegmentChars)).max(64);
/** What every tree operation carries: its own time budget, a result cap, and the directories it must never enter. */
const walkFields = { budgetMs: z.number().int().min(1).max(25_000), skip: NamesSchema, skipSequences: z.array(NamesSchema.min(2).max(8)).max(32) };
export const ReadChildRequestSchema = z.discriminatedUnion('op', [
  z.strictObject({ v: z.literal(READ_CHILD_PROTOCOL), op: z.literal('read'), segments: SegmentsSchema.min(1),
    maxBytes: z.number().int().min(1).max(READ_FILE_LIMITS.maxBytes),
    startLine: line.max(READ_FILE_LIMITS.maxStartLine).optional(), lineCount: line.max(READ_FILE_LIMITS.maxLineCount).optional() })
    .refine(request => (request.startLine === undefined) === (request.lineCount === undefined), 'RANGE_INCOMPLETE'),
  /** An empty segment list lists the root. */
  z.strictObject({ v: z.literal(READ_CHILD_PROTOCOL), op: z.literal('list'), segments: SegmentsSchema,
    depth: z.number().int().min(1).max(READ_FILE_LIMITS.maxDepth), maxEntries: z.number().int().min(1).max(READ_FILE_LIMITS.maxEntries),
    skip: NamesSchema }),
  /** Segments name a directory, or one file to search. File names in `sensitive` are never opened. */
  z.strictObject({ v: z.literal(READ_CHILD_PROTOCOL), op: z.literal('search'), segments: SegmentsSchema, ...walkFields,
    maxResults: z.number().int().min(1).max(READ_FILE_LIMITS.maxSearchResults),
    query: z.string().min(1).max(READ_FILE_LIMITS.maxQueryChars), regex: z.boolean(), ignoreCase: z.boolean(),
    glob: FileNamePatternSchema.nullable(),
    sensitive: z.strictObject({ names: NamesSchema, suffixes: NamesSchema, prefixes: NamesSchema, envAllow: NamesSchema }) }),
  z.strictObject({ v: z.literal(READ_CHILD_PROTOCOL), op: z.literal('find'), segments: SegmentsSchema, ...walkFields,
    maxResults: z.number().int().min(1).max(READ_FILE_LIMITS.maxFindResults), glob: FileNamePatternSchema }),
]);
export type ReadChildRequest = z.infer<typeof ReadChildRequestSchema>;
const ChildEntrySchema = z.strictObject({ segments: SegmentsSchema.min(1), type: DirectoryEntrySchema.shape.type, size: DirectoryEntrySchema.shape.size });
export const ReadChildReplySchema = z.discriminatedUnion('status', [
  z.strictObject({ v: z.literal(READ_CHILD_PROTOCOL), status: z.literal('ok'),
    content: z.base64().max(Math.ceil(READ_FILE_LIMITS.maxBytes / 3) * 4),
    size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), truncated: z.boolean(),
    // Present together, and only for a line-range read.
    startLine: line.max(READ_FILE_LIMITS.maxStartLine).optional(), lines: z.number().int().min(0).max(READ_FILE_LIMITS.maxLineCount).optional(),
    totalLines: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional() }),
  // Segments are relative to the searched directory; empty for a match in the one file that was named.
  z.strictObject({ v: z.literal(READ_CHILD_PROTOCOL), status: z.literal('matched'),
    matches: z.array(z.strictObject({ segments: SegmentsSchema, line: SearchMatchSchema.shape.line, text: SearchMatchSchema.shape.text }))
      .max(READ_FILE_LIMITS.maxSearchResults),
    truncated: z.boolean(), filesScanned: z.number().int().nonnegative().max(READ_FILE_LIMITS.maxSearchFiles),
    filesSkipped: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }),
  z.strictObject({ v: z.literal(READ_CHILD_PROTOCOL), status: z.literal('found'),
    entries: z.array(ChildEntrySchema).max(READ_FILE_LIMITS.maxFindResults), truncated: z.boolean() }),
  z.strictObject({ v: z.literal(READ_CHILD_PROTOCOL), status: z.literal('listed'),
    // Child-relative segments of each entry below the listed directory; Express rebuilds and re-checks the paths.
    entries: z.array(ChildEntrySchema).max(READ_FILE_LIMITS.maxEntries),
    truncated: z.boolean(),
    // Directories (child-relative segments; empty is the listed directory itself) that could not be pinned and were not read.
    unlisted: z.array(SegmentsSchema).max(100) }),
  z.strictObject({ v: z.literal(READ_CHILD_PROTOCOL), status: z.literal('refused'), code: ReadRefusalCodeSchema }),
]);
export type ReadChildReply = z.infer<typeof ReadChildReplySchema>;
/** Upper bound on one reply line, used by Express to cap the child's stdout. */
export const READ_CHILD_MAX_REPLY_BYTES = Math.max(Math.ceil(READ_FILE_LIMITS.maxBytes / 3) * 4,
  // A full listing: every entry at the deepest path, with JSON escaping headroom.
  READ_FILE_LIMITS.maxEntries * (READ_FILE_LIMITS.maxPathChars * 2 + 128),
  READ_FILE_LIMITS.maxFindResults * (READ_FILE_LIMITS.maxPathChars * 2 + 128),
  // A full set of matches: a path and a line that may consist entirely of characters JSON escapes to six bytes.
  READ_FILE_LIMITS.maxSearchResults * (READ_FILE_LIMITS.maxPathChars * 2 + READ_FILE_LIMITS.maxMatchChars * 6 + 128)) + 1_024;

// Express's audit record of one tool decision (migrations 007, 008, 010). Never carries file content, a search query or
// the workspace root.
export const TOOL_AUDIT_LIMITS = Object.freeze({ maxRows: 10_000, maxList: 200 });
const nullableId = z.uuid().nullable();
export const ToolAuditInputSchema = z.strictObject({
  toolId: z.enum(['read_file', 'list_directory', 'search_text', 'find_files']),
  projectId: nullableId, taskId: nullableId, toolCallId: nullableId,
  /** Normalized relative path (for a search, where it started); empty when the requested path was not valid. */
  path: z.string().max(READ_FILE_LIMITS.maxPathChars),
  decision: z.enum(['allowed', 'refused', 'failed']),
  code: z.string().min(1).max(64).regex(/^[A-Z_]+$/).nullable(),
  /** Bytes returned (read_file), entries returned (list_directory, find_files) or matches returned (search_text). */
  bytes: z.number().int().nonnegative().max(READ_FILE_LIMITS.maxBytes),
  durationMs: z.number().int().nonnegative(),
});
export type ToolAuditInput = z.infer<typeof ToolAuditInputSchema>;
export const ToolAuditEntrySchema = ToolAuditInputSchema.extend({ id: z.uuid(), createdAt: z.iso.datetime() });
export type ToolAuditEntry = z.infer<typeof ToolAuditEntrySchema>;
