import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { BootstrapSchema, CONTROL_POLICY, PROTOCOL_VERSION, ShutdownSchema } from '@operation-agent/contracts';
import type { Bootstrap } from '@operation-agent/contracts';
import { createControlPlane } from './index.js';
import { openStore } from './persistence/store.js';
import type { Store } from './persistence/store.js';
import { createIpcCryptoBridge } from './credentials/bridge.js';
import type { IpcCryptoBridge } from './credentials/bridge.js';

let store: Store | undefined; let server: Server | undefined; let identity: Bootstrap | undefined;
let stopping = false; let lastContact = Date.now(); let bootstrapped = false; let bridge: IpcCryptoBridge | undefined;
const handshake = setTimeout(() => stop(false), CONTROL_POLICY.handshakeMs);
const lease = setInterval(() => { if (Date.now() - lastContact > CONTROL_POLICY.shutdownMs) stop(false); }, CONTROL_POLICY.heartbeatMs);
function stop(clean: boolean): void {
  if (stopping) return;
  stopping = true; clearTimeout(handshake); clearInterval(lease);
  const force = setTimeout(() => process.exit(1), CONTROL_POLICY.shutdownMs); force.unref();
  const finish = (): void => {
    try { store?.close(clean); } catch { process.exit(1); }
    process.exit(clean ? 0 : 1);
  };
  if (!server) finish();
  else { server.close(finish); server.closeAllConnections(); }
}

async function start(message: unknown): Promise<void> {
  const input = BootstrapSchema.parse(message);
  if (input.parentPid !== process.ppid || !process.connected || !process.send) throw new Error('IDENTITY_MISMATCH');
  // The staged server must actually run on the pinned independent Node, never Electron or PATH Node.
  const runtime = JSON.parse(readFileSync(new URL('../../manifest.json', import.meta.url), 'utf8')) as { node: string; abi: string; platform: string; arch: string };
  if (process.versions.electron || process.versions.node !== runtime.node || process.versions.modules !== runtime.abi ||
    process.platform !== runtime.platform || process.arch !== runtime.arch) throw new Error('RUNTIME_MISMATCH');
  identity = input;
  store = openStore(input.dataDirectory, input.expressRunId);
  // The Crypto Bridge rides the same inherited channel as the bootstrap; Main serves it only for this service tree.
  bridge = createIpcCryptoBridge({ mainRunId: input.mainRunId, expressRunId: input.expressRunId },
    message => process.connected && process.send ? process.send(message) : false);
  server = createServer({ maxHeaderSize: 8192 }, createControlPlane(input, store, () => {
    const address = server?.address(); return address && typeof address !== 'string' ? address.port : 0;
  }, () => { lastContact = Date.now(); }, { bridge }));
  server.maxConnections = 16; server.requestTimeout = 5_000; server.headersTimeout = 5_000; server.keepAliveTimeout = 1_000;
  server.on('error', () => stop(false));
  await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', resolve); });
  if (stopping || !process.connected) { stop(false); return; }
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('SERVICE_UNAVAILABLE');
  process.send({ kind: 'ready', protocolVersion: PROTOCOL_VERSION, mainRunId: input.mainRunId, expressRunId: input.expressRunId,
    pid: process.pid, parentPid: process.ppid, port: address.port, node: process.versions.node, abi: process.versions.modules });
  clearTimeout(handshake);
}

process.on('message', (message: unknown) => {
  if (!bootstrapped) {
    bootstrapped = true;
    void start(message).catch(() => { process.stderr.write('SIDECAR_START_FAILED\n'); stop(false); });
  } else if (bridge?.receive(message)) {
    // A Crypto Bridge reply for an outstanding request.
  } else {
    const parsed = ShutdownSchema.safeParse(message);
    if (!parsed.success || !identity || parsed.data.mainRunId !== identity.mainRunId || parsed.data.expressRunId !== identity.expressRunId) stop(false);
    else stop(true);
  }
});
process.on('disconnect', () => stop(false));
process.on('SIGTERM', () => stop(false));
process.on('SIGINT', () => stop(false));
process.on('uncaughtException', () => { process.stderr.write('SIDECAR_FAILED\n'); stop(false); });
process.on('unhandledRejection', () => { process.stderr.write('SIDECAR_FAILED\n'); stop(false); });
if (!process.connected) stop(false);
