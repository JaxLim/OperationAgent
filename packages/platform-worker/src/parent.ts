import { createRequire } from 'node:module';
import type { WorkerIdentity } from '@operation-agent/contracts';

export interface WorkerLaunchIdentity extends WorkerIdentity { readonly mode: 'isolated-fixture' }

/** Evidence gathered by the native launcher from the real suspended process before its first instruction. */
export interface FixtureBaseline {
  readonly pid: number; readonly parentPid: number; readonly integrityRid: number; readonly appContainer: true;
  readonly capabilityCount: 0; readonly jobAssignedAtCreation: true; readonly noChildProcessCreation: true;
  /** The RPC pipe plus NUL stdin/stdout handles; the pipe is the only channel. */
  readonly inheritedHandleCount: 3; readonly inheritedHandles: 'rpc-pipe,nul-read,nul-write';
  readonly verifiedBeforeResume: true; readonly profile: string;
}

/** The parent end of the one preconnected inherited pipe plus the owned process/Job. */
export interface LaunchedFixture {
  readonly baseline: FixtureBaseline;
  /** Resolves with received bytes; an empty result is end-of-stream. */
  read(maxBytes: number, deadlineMs: number): Promise<Uint8Array>;
  /** The native layer requires a Node Buffer; callers in Express pass one. */
  write(frame: Uint8Array, deadlineMs: number): Promise<number>;
  /** Terminates the Job if needed, confirms exit, restores the runtime ACL and deletes the profile. */
  close(): Promise<boolean>;
  /** Resolves with the exit code once the owned process handle is signalled. */
  wait(deadlineMs: number): Promise<number>;
}
interface ParentAddon { launchFixture(runtimeDirectory: string): Promise<LaunchedFixture> }

const artifact = '../native-dist/win32-x64/parent.node';
let addon: ParentAddon | undefined;

/**
 * Launch the fixed P1 fixture through public CreateProcessW + AppContainer + Job + HANDLE_LIST.
 * Only Windows x64 has a native launcher. A missing artifact, another platform or any native failure
 * rejects with WORKER_ISOLATION_UNAVAILABLE; there is no fork or unrestricted fallback.
 */
export async function launchIsolatedFixture(target: string, runtimeDirectory: string): Promise<LaunchedFixture> {
  if (target !== 'win32-x64') throw new Error('WORKER_ISOLATION_UNAVAILABLE: no native launcher for ' + target);
  try { addon ??= createRequire(import.meta.url)(artifact) as ParentAddon; }
  catch (error) { throw new Error('WORKER_ISOLATION_UNAVAILABLE: native launcher artifact missing', { cause: error }); }
  try { return await addon.launchFixture(runtimeDirectory); }
  catch (error) { throw new Error('WORKER_ISOLATION_UNAVAILABLE: ' + (error instanceof Error ? error.message : 'launch failed'), { cause: error }); }
}
