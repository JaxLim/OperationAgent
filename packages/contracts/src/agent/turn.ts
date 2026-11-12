import { z } from 'zod';
import { ClaudeModelSchema } from '../api/model.js';
import { utf8ByteLength } from '../events/tool-output.js';

// M2 agent turns (ARCHITECTURE §6.1/§6.2). Express holds the authoritative conversation: the provider's content blocks
// verbatim (thinking signatures, fallback markers) and every tool result it produced. The Worker drives the loop but
// only ever sees this normalized view: text, tool calls (id, name, input) and the stop reason. It never sends
// conversation content back: it asks Express to continue, and Express builds the tool_result blocks from its own
// records, so a Worker cannot forge a tool result or alter what the model asked for.

export const AGENT_RUN_LIMITS = Object.freeze({
  maxPromptChars: 32_000,
  /** Model turns per task; each turn is one Messages API request. */
  maxTurns: 40,
  maxToolCallsPerTurn: 16,
  /** Output token ceiling for one turn (streamed, so long turns do not hit HTTP timeouts). */
  maxOutputTokens: 64_000,
  /** Wall clock for one turn, including provider retries. */
  turnTimeoutMs: 600_000,
  /** Assistant text a Worker sees per turn; the full text stays in Express. */
  maxViewTextChars: 16_000,
  maxToolInputBytes: 16_384,
  /** Serialized view ceiling, well inside one 256 KiB OWIP frame with its RPC envelope. */
  maxViewBytes: 196_608,
  /** Rough local bound on the conversation Express keeps in memory for one task. */
  maxConversationBytes: 16 * 1024 * 1024,
});

export const AgentToolNameSchema = z.enum(['read_file', 'list_directory', 'search_text', 'find_files']);
export type AgentToolName = z.infer<typeof AgentToolNameSchema>;

/** Why a turn ended, normalized from the provider's stop_reason. `refusal` is a policy decline (HTTP 200). */
export const TurnStopReasonSchema = z.enum(['end_turn', 'tool_use', 'max_tokens', 'refusal', 'pause_turn', 'stop_sequence', 'context_exhausted', 'other']);
export type TurnStopReason = z.infer<typeof TurnStopReasonSchema>;

/** Normalized provider failures. Provider bodies, headers and error text never leave the gateway. */
export const TurnFailureCodeSchema = z.enum(['not_configured', 'credential_unavailable', 'auth_failed', 'permission_denied', 'rate_limited',
  'overloaded', 'model_unavailable', 'invalid_request', 'context_too_long', 'provider_error', 'unreachable', 'timed_out', 'cancelled',
  'response_invalid']);
export type TurnFailureCode = z.infer<typeof TurnFailureCodeSchema>;
export const RETRYABLE_TURN_FAILURES: readonly TurnFailureCode[] = Object.freeze(['rate_limited', 'overloaded', 'provider_error', 'unreachable', 'timed_out']);

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const TurnUsageSchema = z.strictObject({ inputTokens: count, outputTokens: count, cacheReadTokens: count, cacheWriteTokens: count });
export type TurnUsage = z.infer<typeof TurnUsageSchema>;

/** A tool call exactly as the model requested it; `input` is untrusted model output and is validated before any use. */
export const ToolCallViewSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  name: z.string().min(1).max(128),
  input: z.record(z.string(), z.unknown()).refine(value => utf8ByteLength(JSON.stringify(value)) <= AGENT_RUN_LIMITS.maxToolInputBytes, 'TOOL_INPUT_TOO_LARGE'),
});
export type ToolCallView = z.infer<typeof ToolCallViewSchema>;

export const TurnViewSchema = z.strictObject({
  turn: z.number().int().min(1).max(AGENT_RUN_LIMITS.maxTurns),
  model: ClaudeModelSchema,
  stopReason: TurnStopReasonSchema,
  /** Text the model wrote this turn, truncated to `maxViewTextChars`; `textTruncated` says whether it was. */
  text: z.string().max(AGENT_RUN_LIMITS.maxViewTextChars),
  textTruncated: z.boolean(),
  toolCalls: z.array(ToolCallViewSchema).max(AGENT_RUN_LIMITS.maxToolCallsPerTurn),
  usage: TurnUsageSchema,
  /** True when a server-side fallback model finished this turn after the requested model declined. */
  fallback: z.boolean(),
}).refine(view => utf8ByteLength(JSON.stringify(view)) <= AGENT_RUN_LIMITS.maxViewBytes, 'VIEW_TOO_LARGE');
export type TurnView = z.infer<typeof TurnViewSchema>;

export const TurnOutcomeSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ok'), view: TurnViewSchema }),
  z.strictObject({ status: z.literal('failed'), code: TurnFailureCodeSchema, retryable: z.boolean(),
    /** Provider HTTP status when there was one; never the provider's body. */
    httpStatus: z.number().int().min(100).max(599).nullable() }),
]);
export type TurnOutcome = z.infer<typeof TurnOutcomeSchema>;

/** Transient stream deltas for a live view. Never persisted; a reconnecting client may miss some. */
export const TurnDeltaSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('text'), text: z.string().min(1).max(16_384) }),
  z.strictObject({ kind: z.literal('thinking'), text: z.string().min(1).max(16_384) }),
  z.strictObject({ kind: z.literal('tool_call'), id: ToolCallViewSchema.shape.id, name: z.string().min(1).max(128) }),
]);
export type TurnDelta = z.infer<typeof TurnDeltaSchema>;

/**
 * Tool definitions Express sends to the model. Each JSON Schema mirrors the strict Zod argument schema in
 * tools/read-file.ts (a contract test keeps them in step); `strict` makes the provider emit schema-valid input, and
 * Express still re-validates every input with Zod because model output is untrusted.
 */
export const AGENT_TOOL_DEFINITIONS = Object.freeze({
  read_file: Object.freeze({
    name: 'read_file',
    description: 'Read a UTF-8 text file in the current project. `path` is relative to the project root and uses / separators. ' +
      'Returns at most `maxBytes` bytes (default 65536, up to 262144) and says when the file was truncated. To read only part of ' +
      'a file, give `startLine` (1-based) and optionally `lineCount` (default 200, up to 2000): prefer this after search_text has ' +
      'told you where to look, instead of reading a whole file. Binary files, files outside the project, links, and secrets such ' +
      'as .env files, keys and .git internals are refused.',
    input_schema: { type: 'object', additionalProperties: false, required: ['path'],
      properties: {
        path: { type: 'string', description: 'Project-relative file path, for example src/index.ts' },
        maxBytes: { type: 'integer', minimum: 1, maximum: 262_144, description: 'Upper bound on bytes returned' },
        startLine: { type: 'integer', minimum: 1, maximum: 10_000_000, description: 'First line to read (1-based)' },
        lineCount: { type: 'integer', minimum: 1, maximum: 2_000, description: 'How many lines to read from startLine' },
      } },
  }),
  search_text: Object.freeze({
    name: 'search_text',
    description: 'Search the text of files in the current project and get back the matching lines as path:line: text. `query` is a ' +
      'plain string unless `regex` is true (JavaScript regular expression, matched within one line). `path` limits the search to ' +
      'a directory or a single file (default: the whole project); `fileNames` limits it to files whose name matches a pattern such ' +
      'as *.ts. Returns up to `maxResults` matches (default 50, up to 200) and says when it stopped early. .git, node_modules, ' +
      'secrets, links, binary files and files over 1 MiB are not searched. Use this to find where something is defined or used, ' +
      'then read just those lines with read_file.',
    input_schema: { type: 'object', additionalProperties: false, required: ['query'],
      properties: {
        query: { type: 'string', description: 'Text to find on a single line; a regular expression when regex is true' },
        path: { type: 'string', description: 'Project-relative directory or file to search; omit for the whole project' },
        regex: { type: 'boolean', description: 'Treat query as a regular expression (default false)' },
        ignoreCase: { type: 'boolean', description: 'Match letters regardless of case (default false)' },
        fileNames: { type: 'string', description: 'File-name pattern with * and ? wildcards, for example *.ts or *.test.*' },
        maxResults: { type: 'integer', minimum: 1, maximum: 200, description: 'Upper bound on matches returned (default 50)' },
      } },
  }),
  find_files: Object.freeze({
    name: 'find_files',
    description: 'Find files and directories in the current project by name. `pattern` is a file-name pattern with * and ? ' +
      'wildcards, matched against the name only and ignoring case, for example *.test.ts, Dockerfile* or package.json; put the ' +
      'directory in `path` (default: the whole project), not in the pattern. Returns up to `maxResults` paths (default 200, up ' +
      'to 500). .git, node_modules and secret directories are not entered and links are never followed.',
    input_schema: { type: 'object', additionalProperties: false, required: ['pattern'],
      properties: {
        pattern: { type: 'string', description: 'File-name pattern, for example *.config.ts' },
        path: { type: 'string', description: 'Project-relative directory to look in; omit for the whole project' },
        maxResults: { type: 'integer', minimum: 1, maximum: 500, description: 'Upper bound on paths returned (default 200)' },
      } },
  }),
  list_directory: Object.freeze({
    name: 'list_directory',
    description: 'List the entries of a directory in the current project. `path` is relative to the project root (use "." for ' +
      'the root). `depth` 1 lists the directory itself; up to 4 also lists subdirectories, skipping .git and node_modules. Links ' +
      'are shown but never followed. Use this to find files before reading them.',
    input_schema: { type: 'object', additionalProperties: false, required: ['path'],
      properties: {
        path: { type: 'string', description: 'Project-relative directory path, or "." for the project root' },
        depth: { type: 'integer', minimum: 1, maximum: 4, description: 'How many directory levels to list (default 1)' },
      } },
  }),
} satisfies Record<AgentToolName, { name: AgentToolName; description: string; input_schema: Record<string, unknown> }>);
