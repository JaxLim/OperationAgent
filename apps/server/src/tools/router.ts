import { createHash } from 'node:crypto';
import { ReadFileArgsSchema, READ_FILE_LIMITS, ReadFileResultSchema } from '@operation-agent/contracts';
import type { Project, ReadFileResult, ToolAuditEntry, ToolAuditInput } from '@operation-agent/contracts';
import { createReadAdapter } from './read-adapter.js';
import type { ReadAdapter } from './read-adapter.js';
import { normalizeReadPath, normalizeWindowsRoot } from './read-path.js';
import { TOOL_REGISTRY, currentPlatform } from './registry.js';
import type { PlatformKey } from './registry.js';

// Tool Router (ARCHITECTURE §5.1): validate → platform gate → path policy → Read Adapter child → audit. It decides the
// route only; it never opens a workspace file itself. Every decision, allowed or not, is written to the audit table.

export interface ToolRouterStore {
  getProject(id: string): Project | null;
  recordToolAudit(entry: ToolAuditInput): ToolAuditEntry;
}
export interface ToolRouterOptions { store: ToolRouterStore; adapter?: ReadAdapter; platform?: PlatformKey }
export interface ReadFileCall { projectId: string; taskId?: string | null; toolCallId?: string | null; args: unknown }
export interface ToolRouter {
  readFile(call: ReadFileCall): Promise<ReadFileResult>;
  readonly adapter: ReadAdapter;
}

export function createToolRouter(options: ToolRouterOptions): ToolRouter {
  const registration = TOOL_REGISTRY.read_file;
  const adapter = options.adapter ?? createReadAdapter({ timeoutMs: registration.timeoutMs });
  const platform = options.platform ?? currentPlatform();
  // ignoreBOM keeps a leading byte-order mark in `content`, so `bytes` and `sha256` describe exactly the returned text.
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

  return {
    adapter,
    async readFile(call) {
      const started = Date.now();
      const id = (value: string | null | undefined): string | null => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value) ? value : null;
      let path = '';
      const finish = (result: ReadFileResult): ReadFileResult => {
        const checked = ReadFileResultSchema.parse(result);
        options.store.recordToolAudit({ toolId: 'read_file', projectId: id(call.projectId), taskId: id(call.taskId), toolCallId: id(call.toolCallId), path,
          decision: checked.status === 'ok' ? 'allowed' : checked.status, code: checked.status === 'ok' ? null : checked.code,
          bytes: checked.status === 'ok' ? checked.bytes : 0, durationMs: Date.now() - started });
        return checked;
      };
      const args = ReadFileArgsSchema.safeParse(call.args);
      if (!args.success) return finish({ status: 'refused', code: 'INVALID_PATH' });
      if (!registration.readGatePlatforms.includes(platform)) return finish({ status: 'failed', code: 'READ_ADAPTER_UNAVAILABLE', retryable: false });
      const requested = normalizeReadPath(args.data.path);
      if (!requested.ok) { path = requested.path ?? ''; return finish({ status: 'refused', code: requested.code }); }
      path = requested.path;
      const project = id(call.projectId) ? options.store.getProject(call.projectId) : null;
      if (!project) return finish({ status: 'refused', code: 'WORKSPACE_UNAVAILABLE' });
      const root = normalizeWindowsRoot(project.path);
      if (!root.ok) return finish({ status: 'refused', code: root.code });
      const maxBytes = args.data.maxBytes ?? READ_FILE_LIMITS.defaultMaxBytes;
      const outcome = await adapter.read(root.root, requested.segments, maxBytes);
      if (outcome.status !== 'ok') return finish(outcome);
      let content: string;
      // The child already refused non-UTF-8 data; a reply that does not decode is an adapter failure, not content.
      try { content = decoder.decode(outcome.content); } catch { return finish({ status: 'failed', code: 'ADAPTER_FAILED', retryable: false }); }
      return finish({ status: 'ok', path, content, bytes: outcome.content.length, size: outcome.size, truncated: outcome.truncated,
        sha256: createHash('sha256').update(outcome.content).digest('hex') });
    },
  };
}
