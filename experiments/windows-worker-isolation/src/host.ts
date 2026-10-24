import express from 'express';
import { z } from 'zod';
import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Boot, HostConfig, HostEvent, Identity, LaunchResult, Request, WorkerMessage, protocol } from './contracts.js';
import type { WorkerMessageValue } from './contracts.js';
import { loadNative } from './native.js';
import { encode, FrameDecoder } from './wire.js';

const config = HostConfig.parse(JSON.parse(process.argv[2] ?? 'null') as unknown);
const lab = fileURLToPath(new URL('../../', import.meta.url));
const native = loadNative(resolve(lab, '_build/native/probe.node'));
const app = express(); app.disable('x-powered-by'); app.get('/health', (_req, res) => res.json({ experimental: true }));
const server = app.listen(0, '127.0.0.1');
await new Promise<void>(resolve => server.once('listening', resolve));
const address = server.address(); if (!address || typeof address === 'string') throw new Error('No loopback port');
function event(kind: string, data: unknown) {
  const value = HostEvent.parse({ kind, runId: config.runId, data });
  if (Buffer.byteLength(JSON.stringify(value)) > 100000) throw new Error('HOST_EVENT_LIMIT');
  if (process.send && process.connected) process.send(value);
}
event('host-ready', { identity: Identity.parse(native.identity(0)), port: address.port, mode: config.mode, expressVersion: '5.3.0' });
const environment: Record<string, string> = { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows', SystemDrive: process.env.SystemDrive ?? 'C:', TEMP: resolve(config.runtime, 'no-write-temp'), TMP: resolve(config.runtime, 'no-write-temp') };
const boot = Boot.parse({ protocol, runId: config.runId, parentPid: process.pid, mode: config.mode,
  node: resolve(config.runtime, 'node.exe'), addon: resolve(config.runtime, 'probe.node'), targets: config.targets,
  loopbackPort: address.port, leakHandle: 0, ignoreDisconnect: true });
let child: ChildProcess | undefined;
let nativeId: number | undefined;
let workerPid = 0;
let poll: ReturnType<typeof setInterval> | undefined;
let deadline: ReturnType<typeof setTimeout> | undefined;
let closing = false;
let send: (message: unknown) => void;
let step = 0;
function cleanup(reason: string) {
  if (closing) return; closing = true;
  if (poll) clearInterval(poll); if (deadline) clearTimeout(deadline);
  const start = performance.now();
  let result: unknown = null;
  if (nativeId !== undefined) result = native.close(nativeId);
  else if (child) result = { killRequested: child.kill('SIGKILL') };
  event('cleanup', { reason, pid: workerPid, elapsedMs: performance.now() - start, nativeResult: result, aliveImmediatelyAfter: workerPid ? native.isAlive(workerPid) : false });
  server.close(); setTimeout(() => process.exit(0), 100);
}
function request(method: 'hello' | 'probe' | 'hang' | 'shutdown' | 'node-spawn', id: number, runId = config.runId) {
  return Request.parse({ jsonrpc: '2.0', protocol, runId, id, method, params: { challenge: `challenge-${id}` } });
}
function received(raw: unknown) {
  const message: WorkerMessageValue = WorkerMessage.parse(raw);
  if (message.runId !== config.runId) throw new Error('Unexpected Worker instance');
  event('worker-message', message);
  if ('method' in message) {
    if (step !== 0) throw new Error('Duplicate ready'); step = 1; send(request('hello', 1)); return;
  }
  if (message.id === 1 && step === 1) { step = 2; send(request('probe', 2)); return; }
  if (message.id === 2 && step === 2) { step = 3; send(request('hello', 3, randomUUID())); return; }
  if (message.id === 3 && step === 3) { step = 4; send({ ...request('hello', 4), unexpected: true }); return; }
  if (message.id === 0 && step === 4) {
    step = 5;
    if (config.scenario === 'permissions') { cleanup('permissions-finished'); return; }
    if (config.scenario === 'node-spawn') {
      send(request('node-spawn', 5));
      deadline = setTimeout(() => { event('failure', { message: 'NODE_SPAWN_PROBE_TIMEOUT_UNKNOWN' }); cleanup('node-spawn-deadline'); }, 5000); return;
    }
    if (config.scenario === 'disconnect') {
      event('scenario', { action: 'disconnect', graceMs: 5000 });
      if (nativeId !== undefined && !child) native.disconnect(nativeId); else child?.disconnect();
      deadline = setTimeout(() => cleanup('ipc-disconnect-deadline'), 5000); return;
    }
    send(request('hang', 5)); return;
  }
  if (message.id === 5 && step === 5) {
    if (config.scenario === 'node-spawn') { cleanup('node-spawn-finished'); return; }
    step = 6;
    event('scenario', { action: 'worker-hung', pid: workerPid, scenario: config.scenario, graceMs: 5000 });
    if (config.scenario === 'hang') deadline = setTimeout(() => cleanup('heartbeat-deadline'), 5000);
  }
}
try {
  if (config.mode === 'fork' || config.mode === 'fork-job') {
    child = fork(resolve(config.runtime, 'worker.js'), [JSON.stringify(boot)], { execPath: boot.node, execArgv: [], cwd: config.runtime, env: environment, serialization: 'json', stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
    if (!child.pid) throw new Error('fork returned no pid'); workerPid = child.pid;
    if (config.mode === 'fork-job') nativeId = native.assignJob(workerPid);
    event('worker-launched', { path: 'stock-fork', pid: workerPid, parentPid: process.pid, jobAssignedAfterCreate: nativeId !== undefined });
    child.on('message', received); child.on('error', error => { event('failure', { message: error.message }); cleanup('fork-error'); });
    child.stderr?.on('data', (data: Buffer) => event('diagnostic', { text: data.toString('utf8').slice(0, 4096) }));
    send = message => { if (!child?.send) throw new Error('Missing Node IPC'); child.send(z.record(z.string(), z.json()).parse(message)); };
  } else {
    const launched = LaunchResult.parse(native.launch({ exe: boot.node, cwd: config.runtime, mode: config.mode, moniker: config.moniker,
      // Avoid Node realpath probing drive-root ancestors outside the granted runtime.
      // The harness creates this runtime; there are no untrusted module search paths.
      leakPath: config.targets.find(t => t.label === 'credentials')!.path, args: ['--preserve-symlinks', '--preserve-symlinks-main', '--input-type=module', '--eval', `process.stderr.write('DEC001_CHECKPOINT: eval started\\n'); await import(${JSON.stringify(pathToFileURL(resolve(config.runtime, 'worker.js')).href)});`, 'worker-bootstrap', JSON.stringify(boot)], env: environment }));
    nativeId = launched.id; workerPid = launched.pid; event('worker-launched', { path: 'native-startup-attributes', ...launched });
    send = message => { const bytes = encode(message); event('raw-frame', { direction: 'host-to-worker', bytes: bytes.toString('base64') }); native.write(launched.id, bytes); };
    const decoder = new FrameDecoder();
    poll = setInterval(() => {
      if (closing) return;
      try {
        const result = native.read(launched.id);
        if (result.output.length) event('diagnostic', { text: result.output.toString('utf8').slice(0, 4096) });
        if (result.data.length) {
          event('raw-frame', { direction: 'worker-to-host', bytes: result.data.toString('base64') });
          for (const message of decoder.push(result.data)) received(message);
        }
        if (result.exitCode !== 259 && !closing) { event('failure', { workerExitCode: result.exitCode, step }); cleanup('worker-exited'); }
      } catch (error) { event('failure', { message: error instanceof Error ? error.message : String(error) }); cleanup('native-channel-error'); }
    }, 10);
  }
} catch (error) {
  event('failure', { message: error instanceof Error ? error.message : String(error) }); cleanup('launch-failed');
}
const hardDeadline = setTimeout(() => { event('failure', { message: 'EXPERIMENT_HARD_DEADLINE' }); cleanup('experiment-hard-deadline'); }, 90000);
hardDeadline.unref();
process.on('disconnect', () => cleanup('supervisor-disconnected'));
