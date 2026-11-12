import { READ_FILE_LIMITS } from '@operation-agent/contracts';

// Express Tool Registry (ARCHITECTURE §5.2). Static: each tool has one channel and one capability; nothing a Worker,
// a model or an MCP server sends can change a registration. Registration rejects deadlines outside the frozen range.

export type ToolId = 'read_file' | 'list_directory' | 'search_text' | 'find_files';
export type PlatformKey = `${NodeJS.Platform}-${string}`;
export interface ToolRegistration {
  readonly toolId: ToolId;
  readonly capability: 'read';
  readonly channel: 'read-adapter';
  readonly timeoutMs: number;
  /**
   * Platforms whose Read Gate (SEC-08) suite exists and runs in CI. Everywhere else the tool fails closed with
   * READ_ADAPTER_UNAVAILABLE. Being listed is not a release claim: the per-platform claim needs committed CI evidence.
   */
  readonly readGatePlatforms: readonly PlatformKey[];
}

export function registerTool(registration: ToolRegistration): Readonly<ToolRegistration> {
  const { timeoutMs } = registration;
  if (!Number.isInteger(timeoutMs) || timeoutMs < READ_FILE_LIMITS.minTimeoutMs || timeoutMs > READ_FILE_LIMITS.maxTimeoutMs) {
    throw new Error('TOOL_REGISTRATION_REJECTED');
  }
  return Object.freeze({ ...registration, readGatePlatforms: Object.freeze([...registration.readGatePlatforms]) });
}

const read = (toolId: ToolId, timeoutMs: number): Readonly<ToolRegistration> =>
  registerTool({ toolId, capability: 'read', channel: 'read-adapter', timeoutMs, readGatePlatforms: ['win32-x64'] });

/**
 * Every tool is a read through the Read Adapter child. The two that walk a tree (search_text, find_files) get a longer
 * deadline; the child stops itself well inside it (READ_FILE_LIMITS.searchBudgetMs) and returns what it has.
 */
export const TOOL_REGISTRY: Readonly<Record<ToolId, Readonly<ToolRegistration>>> = Object.freeze({
  read_file: read('read_file', READ_FILE_LIMITS.defaultTimeoutMs),
  list_directory: read('list_directory', READ_FILE_LIMITS.defaultTimeoutMs),
  search_text: read('search_text', READ_FILE_LIMITS.searchTimeoutMs),
  find_files: read('find_files', READ_FILE_LIMITS.searchTimeoutMs),
});

export const currentPlatform = (): PlatformKey => `${process.platform}-${process.arch}`;
