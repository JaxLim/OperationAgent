import { spawn } from 'node:child_process';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { request } from 'node:http';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { CONTROL_ROUTES, PROTOCOL_VERSION, SidecarReadySchema, requestProof, responseProof } from '../../packages/contracts/dist/index.js';

export const root = resolve(import.meta.dirname, '../..');
export const stage = resolve(root, 'build/stage', `${{ win32: 'win', darwin: 'mac', linux: 'linux' }[process.platform]}-${process.arch}`, 'sidecar');
export const stagedNode = resolve(stage, process.platform === 'win32' ? 'node/node.exe' : 'node/bin/node');
const liveSidecars = new Map();
export async function closeDirectory(directory) {
  for (const [sidecar, path] of liveSidecars) if (path === directory) { await sidecar.close(); liveSidecars.delete(sidecar); }
}
export function environment() {
  return Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'TMPDIR', 'LANG'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
}
export async function until(check, timeout = 10_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value) return value; await delay(50); }
  throw new Error('CONDITION_TIMEOUT');
}
export function httpCall(port, bootstrap, method = 'GET', path = CONTROL_ROUTES.health, value, overrides = {}) {
  const body = value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value);
  const auth = { mainRunId: bootstrap.mainRunId, expressRunId: bootstrap.expressRunId, requestId: randomUUID(), timestamp: String(Date.now()), ...overrides.auth };
  const headers = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
    'x-oa-main-run': auth.mainRunId, 'x-oa-express-run': auth.expressRunId, 'x-oa-request-id': auth.requestId,
    'x-oa-timestamp': auth.timestamp, 'x-oa-protocol': PROTOCOL_VERSION,
    'x-oa-signature': createHmac('sha256', bootstrap.token).update(requestProof(auth, method, path, body)).digest('hex'), ...overrides.headers };
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, method, path, headers, timeout: 2000, agent: false }, res => {
      let result = ''; res.setEncoding('utf8'); res.on('data', chunk => { result += chunk; if (result.length > 65536) req.destroy(new Error('RESPONSE_LIMIT')); });
      res.on('end', () => {
        const expected = createHmac('sha256', bootstrap.token).update(responseProof(auth, res.statusCode, result)).digest('hex');
        const proof = res.headers['x-oa-proof'];
        const authenticated = typeof proof === 'string' && proof.length === expected.length && timingSafeEqual(Buffer.from(proof), Buffer.from(expected));
        resolve({ status: res.statusCode, body: JSON.parse(result), authenticated });
      });
    });
    req.on('timeout', () => req.destroy(new Error('HTTP_TIMEOUT'))); req.on('error', reject); req.end(body);
  });
}
export async function launchSidecar(dataDirectory, options = {}) {
  const bootstrap = { kind: 'bootstrap', protocolVersion: PROTOCOL_VERSION, mainRunId: randomUUID(), expressRunId: randomUUID(),
    parentPid: process.pid, token: randomBytes(32).toString('hex'), dataDirectory, ...options.bootstrap };
  const child = spawn(stagedNode, [resolve(stage, 'server/dist/entry.js')], { cwd: stage, env: environment(),
    windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let logs = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { logs = (logs + chunk).slice(-65536); });
  const exited = once(child, 'exit');
  const readyPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('SIDECAR_READY_TIMEOUT')), 10_000);
    child.once('message', message => { clearTimeout(timer); try { resolve(SidecarReadySchema.parse(message)); } catch (error) { reject(error); } });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('SIDECAR_EXIT_BEFORE_READY: ' + logs)); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
  });
  child.send(bootstrap);
  let ready;
  try { ready = await readyPromise; }
  catch (error) { child.kill('SIGKILL'); await exited.catch(() => {}); throw error; }
  const call = (method, path, body, overrides) => httpCall(ready.port, bootstrap, method, path, body, overrides);
  const heartbeat = options.heartbeat === false ? undefined : setInterval(() => { void call('GET', CONTROL_ROUTES.health).catch(() => {}); }, 1000);
  child.once('exit', () => clearInterval(heartbeat));
  const handle = { child, bootstrap, ready, call, exited, logs: () => logs,
    async close() {
      clearInterval(heartbeat);
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (child.connected) child.send({ kind: 'shutdown', mainRunId: bootstrap.mainRunId, expressRunId: bootstrap.expressRunId });
      const timer = setTimeout(() => child.kill('SIGKILL'), 6000);
      try { await exited; } finally { clearTimeout(timer); }
    },
  };
  liveSidecars.set(handle, dataDirectory);
  return handle;
}
