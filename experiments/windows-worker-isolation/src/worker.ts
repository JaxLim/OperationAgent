// Deliberately hostile probes. These imports are forbidden in a real Agent Worker.
import { readFileSync, openSync, closeSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { Boot, Probe, Request, WorkerMessage, protocol } from './contracts.js';
import { loadNative } from './native.js';

console.error('DEC001_CHECKPOINT: worker modules imported');
const config = Boot.parse(JSON.parse(process.argv[2] ?? 'null') as unknown);
if (process.env.DEC001_LEAK_CANARY_HANDLE) config.leakHandle = Boot.shape.leakHandle.parse(Number(process.env.DEC001_LEAK_CANARY_HANDLE));
const native = loadNative(config.addon);
console.error('DEC001_CHECKPOINT: native addon loaded');
const nodeAttempt = (action: () => void) => {
  try { action(); return { allowed: true, code: '' }; }
  catch (error) { return { allowed: false, code: typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'UNKNOWN' }; }
};
function observed<T>(label: string, action: () => T): T {
  console.error(`DEC001_PROBE_BEGIN: ${label} ${Date.now()}`);
  const value = action(); console.error(`DEC001_PROBE_END: ${label} ${Date.now()}`); return value;
}
function probe() {
  return Probe.parse({
    identity: observed('identity', () => native.identity(0)),
    files: config.targets.map(target => ({ label: target.label,
      nativeRead: observed(`read-${target.label}`, () => native.probeFile(target.path, 'read')), nativeWrite: native.probeFile(target.path, 'write'),
      nodeRead: nodeAttempt(() => { readFileSync(target.path); }),
      nodeWrite: nodeAttempt(() => { const fd = openSync(target.path, 'r+'); closeSync(fd); }),
    })),
    externalTcp: observed('externalTcp', () => native.probeTcp('1.1.1.1', 443)), loopbackTcp: observed('loopbackTcp', () => native.probeTcp('127.0.0.1', config.loopbackPort)),
    nativeSpawn: observed('nativeSpawn', () => native.probeSpawn(config.node, false)), breakawaySpawn: observed('breakawaySpawn', () => native.probeSpawn(config.node, true)),
    nodeSpawn: { allowed: false, code: 'NOT_RUN_SEPARATE_SCENARIO' },
    parentAccess: observed('parentAccess', () => native.probeParent(config.parentPid)), canaryHandle: observed('canaryHandle', () => native.probeInheritedHandle(config.leakHandle)),
    nodePermissionEnabled: process.execArgv.some(arg => arg.startsWith('--permission')),
    rpcAvailable: typeof process.send === 'function' && process.connected,
  });
}
function send(raw: unknown) {
  const message = WorkerMessage.parse(raw);
  if (!process.send || !process.connected) throw new Error('No inherited Node IPC');
  process.send(message);
}
const early = probe();
process.on('message', (raw: unknown) => {
  const parsed = Request.safeParse(raw);
  if (!parsed.success) { send({ jsonrpc: '2.0', protocol, runId: config.runId, id: 0, error: { code: -32600, message: 'Rejected experimental RPC schema', data: { reason: 'VALIDATION_ERROR' } } }); return; }
  const request = parsed.data;
  if (request.runId !== config.runId) { send({ jsonrpc: '2.0', protocol, runId: config.runId, id: request.id, error: { code: -32001, message: 'Rejected stale experiment instance', data: { reason: 'STALE_RUN_ID' } } }); return; }
  const result = request.method === 'probe' ? probe() : request.method === 'node-spawn' ? {
    nodeSpawn: observed('nodeSpawn', () => nodeAttempt(() => { const r = spawnSync(config.node, ['--version'], { timeout: 2000, windowsHide: true, env: { SystemRoot: process.env.SystemRoot ?? '' } }); if (r.error) throw r.error; if (r.status !== 0) throw Object.assign(new Error('child status'), { code: `EXIT_${String(r.status)}` }); })),
  } : { challenge: request.params.challenge, pid: process.pid };
  send({ jsonrpc: '2.0', protocol, runId: config.runId, id: request.id, result });
  if (request.method === 'hang') { for (;;) { Math.imul(123, 456); } }
  if (request.method === 'shutdown') setTimeout(() => process.exit(0), 50);
});
process.on('disconnect', () => { if (!config.ignoreDisconnect) process.exit(0); });
setInterval(() => {}, 1000);
send({ jsonrpc: '2.0', protocol, runId: config.runId, method: 'ready', params: { early } });
