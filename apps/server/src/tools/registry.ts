import { READ_FILE_LIMITS } from '@operation-agent/contracts';

// Express Tool Registry (ARCHITECTURE §5.2). Static: each tool has one channel and one capability; nothing a Worker,
// a model or an MCP server sends can change a registration. Registration rejects deadlines outside the frozen range.

export type ToolId = 'read_file';
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

export const TOOL_REGISTRY: Readonly<Record<ToolId, Readonly<ToolRegistration>>> = Object.freeze({
  read_file: registerTool({ toolId: 'read_file', capability: 'read', channel: 'read-adapter', timeoutMs: READ_FILE_LIMITS.defaultTimeoutMs,
    readGatePlatforms: ['win32-x64'] }),
});

export const currentPlatform = (): PlatformKey => `${process.platform}-${process.arch}`;
