import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { READ_CHILD_MAX_REPLY_BYTES, READ_CHILD_PROTOCOL, READ_FILE_LIMITS, ReadChildReplySchema } from '@operation-agent/contracts';
import type { ReadFailureCode, ReadRefusalCode } from '@operation-agent/contracts';

// SEC-08 Read Adapter launcher: the only place Express creates a Read Adapter child. Each read is one short-lived Node
// process started from the official Node runtime with an explicit argv, an explicit minimal environment, no shell and no
// inherited execArgv, under the Node permission model limited to reading the workspace root. Its reply is bounded and
// schema-checked; it is killed at the deadline and a read only completes once its exit has been observed. If an exit
// can not be confirmed the adapter disables itself (fail closed) until the control plane restarts.

export const READ_CHILD_SCRIPT = fileURLToPath(new URL('./read-child.js', import.meta.url));
const EXIT_CONFIRM_MS = 2_000;
const MAX_STDERR_BYTES = 8_192;

type Rejected = { status: 'refused'; code: ReadRefusalCode } | { status: 'failed'; code: ReadFailureCode; retryable: boolean };
export type AdapterOutcome = { status: 'ok'; content: Buffer; size: number; truncated: boolean } | Rejected;
export interface ListedEntry { segments: string[]; type: 'file' | 'directory' | 'link' | 'other'; size: number | null }
export type ListOutcome = { status: 'listed'; entries: ListedEntry[]; truncated: boolean; unlisted: string[][] } | Rejected;
export interface ListRequest { depth: number; maxEntries: number; skip: readonly string[] }

export interface ReadAdapterOptions {
  /** Defaults to this process's runtime, which must be official Node (never Electron). */
  nodePath?: string;
  /** Tests substitute a misbehaving child here to exercise deadlines and caps; production always uses the fixed script. */
  childScript?: string;
  timeoutMs?: number;
  maxConcurrent?: number;
  maxQueued?: number;
}
export interface ReadAdapterSnapshot { available: boolean; active: number; queued: number; launched: number; killed: number; activePids: number[] }
export interface ReadAdapter {
  read(root: string, segments: readonly string[], maxBytes: number): Promise<AdapterOutcome>;
  /** Lists a directory below the root; an empty segment list is the root itself. */
  list(root: string, segments: readonly string[], request: ListRequest): Promise<ListOutcome>;
  snapshot(): ReadAdapterSnapshot;
}

/** The child's whole environment. Windows requires SystemRoot for a Node process to start; nothing else is passed. */
export function readChildEnvironment(): Record<string, string> {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  // Explicit empty values stop the Windows process launcher from copying its "required" variables (PATH, USERPROFILE,
  // TEMP and similar) from Express into the child.
  const env: Record<string, string> = process.platform === 'win32' ? { PATH: '', TEMP: '', TMP: '', USERPROFILE: '', HOMEDRIVE: '',
    HOMEPATH: '', LOGONSERVER: '', USERDOMAIN: '', USERNAME: '', SYSTEMDRIVE: '' } : {};
  if (systemRoot && /^[a-zA-Z]:\\\P{Cc}*$/u.test(systemRoot)) { env.SystemRoot = systemRoot; env.WINDIR = systemRoot; }
  return env;
}

export function readChildArguments(root: string, script: string): string[] {
  return ['--permission', `--allow-fs-read=${root}`, '--max-old-space-size=64', '--disallow-code-generation-from-strings',
    '--no-deprecation', '--no-warnings', script, root];
}

export function createReadAdapter(options: ReadAdapterOptions = {}): ReadAdapter {
  const timeoutMs = options.timeoutMs ?? READ_FILE_LIMITS.defaultTimeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < READ_FILE_LIMITS.minTimeoutMs || timeoutMs > READ_FILE_LIMITS.maxTimeoutMs) {
    throw new Error('TOOL_REGISTRATION_REJECTED');
  }
  const maxConcurrent = options.maxConcurrent ?? READ_FILE_LIMITS.maxConcurrent;
  const maxQueued = options.maxQueued ?? READ_FILE_LIMITS.maxQueued;
  const nodePath = options.nodePath ?? process.execPath;
  const script = options.childScript ?? READ_CHILD_SCRIPT;
  // Fail closed on a runtime that is not official Node: Electron's runtime does not implement this permission model.
  let available = process.versions.electron === undefined && process.release.name === 'node';
  let active = 0, launched = 0, killed = 0;
  const pids = new Set<number>();
  const queue: (() => void)[] = [];

  const acquire = (): Promise<boolean> => {
    if (active < maxConcurrent) { active++; return Promise.resolve(true); }
    if (queue.length >= maxQueued) return Promise.resolve(false);
    return new Promise(resolve => queue.push(() => { active++; resolve(true); }));
  };
  const release = (): void => { active--; queue.shift()?.(); };

  type ChildReply = Exclude<ReturnType<typeof ReadChildReplySchema.parse>, { status: 'refused' }>;
  /** One child, one request line, one validated reply; `accept` turns a non-refusal reply into the caller's outcome. */
  function launch<T>(root: string, request: Record<string, unknown>, accept: (reply: ChildReply) => T | Rejected): Promise<T | Rejected> {
    return new Promise(resolve => {
      let child: ReturnType<typeof spawn>;
      try {
        // cwd is the adapter's own directory: a removed workspace is then reported by the child as WORKSPACE_UNAVAILABLE.
        child = spawn(nodePath, readChildArguments(root, script), { cwd: dirname(script), env: readChildEnvironment(), shell: false, windowsHide: true,
          detached: false, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch { resolve({ status: 'failed', code: 'ADAPTER_FAILED', retryable: false }); return; }
      launched++;
      if (child.pid !== undefined) pids.add(child.pid);
      const stdout: Buffer[] = []; let stdoutBytes = 0; let stderrBytes = 0;
      let failure: ReadFailureCode | undefined;
      let spawnError = false;
      let settled = false;
      let confirmTimer: NodeJS.Timeout | undefined;
      const kill = (code: ReadFailureCode): void => {
        failure ??= code;
        if (child.exitCode === null && child.signalCode === null) { killed++; child.kill('SIGKILL'); }
        // After a kill the exit must still be observed; otherwise the child may be alive and the adapter shuts itself off.
        confirmTimer ??= setTimeout(() => {
          if (settled) return;
          settled = true; available = false;
          resolve({ status: 'failed', code: 'CLEANUP_UNCONFIRMED', retryable: false });
        }, EXIT_CONFIRM_MS);
      };
      const deadline = setTimeout(() => kill('TIMED_OUT'), timeoutMs);
      child.stdout!.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > READ_CHILD_MAX_REPLY_BYTES) { kill('ADAPTER_FAILED'); return; }
        stdout.push(chunk);
      });
      // stderr is drained (so the child can never block on it) and discarded: it is neither trusted nor persisted.
      child.stderr!.on('data', (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > MAX_STDERR_BYTES) kill('ADAPTER_FAILED'); });
      child.stdin!.on('error', () => {});
      child.on('error', () => { spawnError = true; kill('ADAPTER_FAILED'); });
      child.on('close', (exitCode: number | null) => {
        if (settled) return;
        settled = true; clearTimeout(deadline); clearTimeout(confirmTimer);
        if (child.pid !== undefined) pids.delete(child.pid);
        if (failure) { resolve({ status: 'failed', code: failure, retryable: failure === 'TIMED_OUT' }); return; }
        if (spawnError || exitCode !== 0) { resolve({ status: 'failed', code: 'ADAPTER_FAILED', retryable: false }); return; }
        const text = Buffer.concat(stdout).toString('utf8');
        // Exactly one line, then end of output.
        if (!text.endsWith('\n') || text.indexOf('\n') !== text.length - 1) { resolve({ status: 'failed', code: 'ADAPTER_FAILED', retryable: false }); return; }
        let parsed: ReturnType<typeof ReadChildReplySchema.safeParse>;
        try { parsed = ReadChildReplySchema.safeParse(JSON.parse(text)); } catch { resolve({ status: 'failed', code: 'ADAPTER_FAILED', retryable: false }); return; }
        if (!parsed.success) { resolve({ status: 'failed', code: 'ADAPTER_FAILED', retryable: false }); return; }
        const value = parsed.data;
        if (value.status === 'refused') { resolve({ status: 'refused', code: value.code }); return; }
        resolve(accept(value));
      });
      child.stdin!.end(JSON.stringify({ v: READ_CHILD_PROTOCOL, ...request }) + '\n');
    });
  }

  const MALFORMED: Rejected = { status: 'failed', code: 'ADAPTER_FAILED', retryable: false };
  async function guarded<T>(run: () => Promise<T | Rejected>): Promise<T | Rejected> {
    if (!available) return { status: 'failed', code: 'READ_ADAPTER_UNAVAILABLE', retryable: false };
    if (!(await acquire())) return { status: 'failed', code: 'BUSY', retryable: true };
    try {
      if (!available) return { status: 'failed', code: 'READ_ADAPTER_UNAVAILABLE', retryable: false };
      return await run();
    } finally { release(); }
  }

  return {
    read(root, segments, maxBytes) {
      return guarded(() => launch<AdapterOutcome>(root, { op: 'read', segments, maxBytes }, value => {
        if (value.status !== 'ok') return MALFORMED;
        const content = Buffer.from(value.content, 'base64');
        return content.length > maxBytes ? MALFORMED : { status: 'ok', content, size: value.size, truncated: value.truncated };
      }));
    },
    list(root, segments, request) {
      return guarded(() => launch<ListOutcome>(root, { op: 'list', segments, depth: request.depth, maxEntries: request.maxEntries,
        skip: [...request.skip] }, value => {
        if (value.status !== 'listed' || value.entries.length > request.maxEntries ||
          value.entries.some(entry => entry.segments.length > request.depth) || value.unlisted.some(segments => segments.length >= request.depth)) return MALFORMED;
        return { status: 'listed', entries: value.entries, truncated: value.truncated, unlisted: value.unlisted };
      }));
    },
    snapshot: () => ({ available, active, queued: queue.length, launched, killed, activePids: [...pids] }),
  };
}
