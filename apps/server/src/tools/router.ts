import { createHash } from 'node:crypto';
import { FindFilesArgsSchema, FindFilesResultSchema, ListDirectoryArgsSchema, ListDirectoryResultSchema, ReadFileArgsSchema, READ_FILE_LIMITS,
  ReadFileResultSchema, SearchTextArgsSchema, SearchTextResultSchema, ToolAuditInputSchema } from '@operation-agent/contracts';
import type { DirectoryEntry, FindFilesResult, ListDirectoryResult, Project, ReadFileResult, SearchMatch, SearchTextResult, ToolAuditEntry,
  ToolAuditInput } from '@operation-agent/contracts';
import { createReadAdapter } from './read-adapter.js';
import type { ReadAdapter } from './read-adapter.js';
import { LIST_SKIP_DIRECTORIES, SENSITIVE_FILE_POLICY, TREE_SKIP_SEQUENCES, insideSensitiveDirectory, normalizeFileNamePattern, normalizeListPath,
  normalizeReadPath, normalizeWindowsRoot } from './read-path.js';
import type { PathDecision } from './read-path.js';
import { TOOL_REGISTRY, currentPlatform } from './registry.js';
import type { PlatformKey, ToolId } from './registry.js';

// Tool Router (ARCHITECTURE §5.1): validate → platform gate → path policy → Read Adapter child → audit. It decides the
// route only; it never opens a workspace file itself. Every decision, allowed or not, is written to the audit table.

export interface ToolRouterStore {
  getProject(id: string): Project | null;
  recordToolAudit(entry: ToolAuditInput): ToolAuditEntry;
}
export interface ToolRouterOptions { store: ToolRouterStore; adapter?: ReadAdapter; platform?: PlatformKey }
export interface ReadFileCall { projectId: string; taskId?: string | null; toolCallId?: string | null; args: unknown }
export type ListDirectoryCall = ReadFileCall;
export interface ToolRouter {
  readFile(call: ReadFileCall): Promise<ReadFileResult>;
  listDirectory(call: ListDirectoryCall): Promise<ListDirectoryResult>;
  searchText(call: ReadFileCall): Promise<SearchTextResult>;
  findFiles(call: ReadFileCall): Promise<FindFilesResult>;
  readonly adapter: ReadAdapter;
}

type Refused = Extract<ReadFileResult, { status: 'refused' }>;
type Unavailable = Extract<ReadFileResult, { status: 'failed' }>;

export function createToolRouter(options: ToolRouterOptions): ToolRouter {
  const adapter = options.adapter ?? createReadAdapter({ timeoutMs: TOOL_REGISTRY.read_file.timeoutMs, walkTimeoutMs: TOOL_REGISTRY.search_text.timeoutMs });
  const platform = options.platform ?? currentPlatform();
  // ignoreBOM keeps a leading byte-order mark in `content`, so `bytes` and `sha256` describe exactly the returned text.
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

  // Correlation ids that are not valid UUIDs are recorded as null rather than failing the audit write.
  const id = (value: string | null | undefined): string | null => ToolAuditInputSchema.shape.toolCallId.safeParse(value).success ? value ?? null : null;

  /** One audit row per decision. `amount` is bytes, entries or matches returned; a search query is never recorded. */
  const audit = (toolId: ToolId, call: ReadFileCall, path: string, started: number, result: { status: string; code?: string }, amount: number): void => {
    options.store.recordToolAudit({ toolId, projectId: id(call.projectId), taskId: id(call.taskId), toolCallId: id(call.toolCallId), path,
      decision: result.status === 'ok' ? 'allowed' : result.status as 'refused' | 'failed', code: result.status === 'ok' ? null : result.code ?? null,
      bytes: result.status === 'ok' ? amount : 0, durationMs: Date.now() - started });
  };
  /** The platform gate, then the project and its root: what every tool needs before a child may exist. */
  const workspace = (toolId: ToolId, call: ReadFileCall, requested: PathDecision): { root: string } | Refused | Unavailable => {
    if (!TOOL_REGISTRY[toolId].readGatePlatforms.includes(platform)) return { status: 'failed', code: 'READ_ADAPTER_UNAVAILABLE', retryable: false };
    if (!requested.ok) return { status: 'refused', code: requested.code };
    const project = id(call.projectId) ? options.store.getProject(call.projectId) : null;
    if (!project) return { status: 'refused', code: 'WORKSPACE_UNAVAILABLE' };
    const root = normalizeWindowsRoot(project.path);
    return root.ok ? { root: root.root } : { status: 'refused', code: root.code };
  };
  /** The path for the audit row: known once the platform gate has passed, even when the path itself is then refused. */
  const auditPath = (place: { root: string } | Refused | Unavailable, requested: PathDecision): string =>
    'status' in place && place.status === 'failed' ? '' : requested.path ?? '';
  const walk = { skip: LIST_SKIP_DIRECTORIES, skipSequences: TREE_SKIP_SEQUENCES };

  return {
    adapter,
    async listDirectory(call) {
      const started = Date.now();
      let path = '';
      const finish = (result: ListDirectoryResult): ListDirectoryResult => {
        const checked = ListDirectoryResultSchema.parse(result);
        audit('list_directory', call, path, started, checked, checked.status === 'ok' ? checked.entries.length : 0);
        return checked;
      };
      const args = ListDirectoryArgsSchema.safeParse(call.args);
      if (!args.success) return finish({ status: 'refused', code: 'INVALID_PATH' });
      const requested = normalizeListPath(args.data.path);
      const place = workspace('list_directory', call, requested);
      path = auditPath(place, requested);
      if (!('root' in place) || !requested.ok) return finish(place as Refused | Unavailable);
      const outcome = await adapter.list(place.root, requested.segments, { depth: args.data.depth ?? 1, maxEntries: READ_FILE_LIMITS.maxEntries,
        skip: LIST_SKIP_DIRECTORIES });
      if (outcome.status !== 'listed') return finish(outcome);
      const entries: DirectoryEntry[] = [];
      for (const entry of outcome.entries) {
        const segments = [...requested.segments, ...entry.segments];
        // Defence in depth: the child never enters a sensitive directory, and anything reported inside one is dropped.
        if (insideSensitiveDirectory(segments)) continue;
        const joined = segments.join('/');
        if (joined.length > READ_FILE_LIMITS.maxPathChars) continue;
        entries.push({ path: joined, type: entry.type, size: entry.size });
      }
      const unlisted = outcome.unlisted.map(segments => [...requested.segments, ...segments].join('/') || '.')
        .filter(item => item.length <= READ_FILE_LIMITS.maxPathChars);
      return finish({ status: 'ok', path, entries, truncated: outcome.truncated, unlisted });
    },
    async readFile(call) {
      const started = Date.now();
      let path = '';
      const finish = (result: ReadFileResult): ReadFileResult => {
        const checked = ReadFileResultSchema.parse(result);
        audit('read_file', call, path, started, checked, checked.status === 'ok' ? checked.bytes : 0);
        return checked;
      };
      const args = ReadFileArgsSchema.safeParse(call.args);
      if (!args.success) return finish({ status: 'refused', code: 'INVALID_PATH' });
      const requested = normalizeReadPath(args.data.path);
      const place = workspace('read_file', call, requested);
      path = auditPath(place, requested);
      if (!('root' in place) || !requested.ok) return finish(place as Refused | Unavailable);
      const maxBytes = args.data.maxBytes ?? READ_FILE_LIMITS.defaultMaxBytes;
      // Either field asks for a range: a start alone reads the default number of lines, a count alone starts at line 1.
      const lines = args.data.startLine === undefined && args.data.lineCount === undefined ? undefined
        : { start: args.data.startLine ?? 1, count: args.data.lineCount ?? READ_FILE_LIMITS.defaultLineCount };
      const outcome = await adapter.read(place.root, requested.segments, maxBytes, lines);
      if (outcome.status !== 'ok') return finish(outcome);
      let content: string;
      // The child already refused non-UTF-8 data; a reply that does not decode is an adapter failure, not content.
      try { content = decoder.decode(outcome.content); } catch { return finish({ status: 'failed', code: 'ADAPTER_FAILED', retryable: false }); }
      return finish({ status: 'ok', path, content, bytes: outcome.content.length, size: outcome.size, truncated: outcome.truncated,
        sha256: createHash('sha256').update(outcome.content).digest('hex'), ...(outcome.range ? { range: outcome.range } : {}) });
    },
    async searchText(call) {
      const started = Date.now();
      let path = '';
      const finish = (result: SearchTextResult): SearchTextResult => {
        const checked = SearchTextResultSchema.parse(result);
        audit('search_text', call, path, started, checked, checked.status === 'ok' ? checked.matches.length : 0);
        return checked;
      };
      const args = SearchTextArgsSchema.safeParse(call.args);
      if (!args.success) return finish({ status: 'refused', code: 'INVALID_QUERY' });
      const { query, regex = false, ignoreCase = false } = args.data;
      // A file is searched line by line, so a query that spans lines can never match; a pattern must at least compile.
      // Compiling is safe here; the pattern only ever runs in the child, under its deadline.
      let valid = !/[\n\r\0]/.test(query);
      if (valid && regex) { try { new RegExp(query, ignoreCase ? 'i' : ''); } catch { valid = false; } }
      const names = args.data.fileNames === undefined ? null : normalizeFileNamePattern(args.data.fileNames);
      if (!valid || (names && !names.ok)) return finish({ status: 'refused', code: 'INVALID_QUERY' });
      const requested = normalizeListPath(args.data.path ?? '.');
      const place = workspace('search_text', call, requested);
      path = auditPath(place, requested);
      if (!('root' in place) || !requested.ok) return finish(place as Refused | Unavailable);
      const outcome = await adapter.search(place.root, requested.segments, { ...walk, maxResults: args.data.maxResults ?? READ_FILE_LIMITS.defaultSearchResults,
        query, regex, ignoreCase, glob: names?.ok ? names.glob : null, sensitive: SENSITIVE_FILE_POLICY });
      if (outcome.status !== 'matched') return finish(outcome);
      const matches: SearchMatch[] = [];
      for (const match of outcome.matches) {
        // Defence in depth: the child never opens a sensitive file; a match is returned only if its path would itself be
        // readable through read_file.
        const file = normalizeReadPath([...requested.segments, ...match.segments].join('/'));
        if (file.ok) matches.push({ path: file.path, line: match.line, text: match.text });
      }
      return finish({ status: 'ok', path, matches, truncated: outcome.truncated, filesScanned: outcome.filesScanned, filesSkipped: outcome.filesSkipped });
    },
    async findFiles(call) {
      const started = Date.now();
      let path = '';
      const finish = (result: FindFilesResult): FindFilesResult => {
        const checked = FindFilesResultSchema.parse(result);
        audit('find_files', call, path, started, checked, checked.status === 'ok' ? checked.entries.length : 0);
        return checked;
      };
      const args = FindFilesArgsSchema.safeParse(call.args);
      const pattern = args.success ? normalizeFileNamePattern(args.data.pattern) : null;
      if (!args.success || !pattern?.ok) return finish({ status: 'refused', code: 'INVALID_QUERY' });
      const requested = normalizeListPath(args.data.path ?? '.');
      const place = workspace('find_files', call, requested);
      path = auditPath(place, requested);
      if (!('root' in place) || !requested.ok) return finish(place as Refused | Unavailable);
      const outcome = await adapter.find(place.root, requested.segments, { ...walk, maxResults: args.data.maxResults ?? READ_FILE_LIMITS.defaultFindResults,
        glob: pattern.glob });
      if (outcome.status !== 'found') return finish(outcome);
      const entries: DirectoryEntry[] = [];
      for (const entry of outcome.entries) {
        const segments = [...requested.segments, ...entry.segments];
        const joined = segments.join('/');
        if (insideSensitiveDirectory(segments) || joined.length > READ_FILE_LIMITS.maxPathChars) continue;
        entries.push({ path: joined, type: entry.type, size: entry.size });
      }
      return finish({ status: 'ok', path, entries, truncated: outcome.truncated });
    },
  };
}
