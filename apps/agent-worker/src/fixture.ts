import { PROTOCOL_VERSION, WorkerBootstrapSchema } from '@operation-agent/contracts';
import type { FixtureFault, RpcRequest, RpcResponse, WorkerIdentity } from '@operation-agent/contracts';
import { OwipDecoder, RpcSession, encodeOwipFrame } from '@operation-agent/worker-transport';
import type { TransportClock } from '@operation-agent/worker-transport';

// P1 fixed fixture: answers hello/health/shutdown and controlled faults only. No Agent Loop, model,
// tool, file, network or database capability exists here; the OS boundary is applied before this runs.

/** Structural copy of the inherited channel surface the trusted bootstrap injects. */
export interface FixtureChannel {
  read(maxBytes: number, deadlineMs: number): Promise<Uint8Array>;
  write(frame: Uint8Array, deadlineMs: number): Promise<number>;
  close(): Promise<boolean>;
}
export const FIXTURE_IO = Object.freeze({ readBytes: 65_536, readDeadlineMs: 30_000, writeDeadlineMs: 5_000 });

function concat(chunks: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0)); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}
function reply(identity: WorkerIdentity, request: RpcRequest, result: unknown): RpcResponse {
  return { jsonrpc: '2.0', protocolVersion: PROTOCOL_VERSION, ...identity, role: 'worker',
    id: request.id, requestId: request.id, result } as RpcResponse;
}

/** Returns when the channel ends; the process then exits because nothing else keeps it alive. */
export async function runFixture(channel: FixtureChannel, clock: TransportClock): Promise<void> {
  let stopped = false;
  const closeChannel = async (): Promise<void> => { stopped = true; await channel.close().catch(() => false); };
  const write = async (frame: Uint8Array): Promise<void> => {
    if (await channel.write(frame, FIXTURE_IO.writeDeadlineMs) !== frame.length) throw new Error('OWIP_SHORT_WRITE');
  };
  // The first frame on the inherited channel carries the instance identity and challenge.
  const probe = new OwipDecoder(); const received: Uint8Array[] = []; let first: unknown;
  while (first === undefined) {
    const chunk = await channel.read(FIXTURE_IO.readBytes, FIXTURE_IO.readDeadlineMs);
    if (!chunk.length) { await closeChannel(); return; }
    received.push(chunk); first = probe.push(chunk)[0];
  }
  const bootstrap = WorkerBootstrapSchema.safeParse(first);
  if (!bootstrap.success) { await closeChannel(); return; }
  const identity: WorkerIdentity = { expressRunId: bootstrap.data.expressRunId, workerRunId: bootstrap.data.workerRunId };
  const session: RpcSession = new RpcSession({ identity, role: 'worker', clock, transport: { write, close() { stopped = true; } },
    onClose() { void closeChannel(); },
    onRequest(request) { void handle(request).catch(() => { session.close(); }); } });
  async function handle(request: RpcRequest): Promise<void> {
    if (request.method === 'health') await session.respond(reply(identity, request, { kind: 'health', controlPlaneReady: false, agentReady: false }));
    else if (request.method === 'shutdown') {
      await session.respond(reply(identity, request, { kind: 'shutdown', stopped: true }));
      await closeChannel();
    } else if (request.method === 'fixture.fault') await fault(request, request.params.mode);
  }
  async function fault(request: RpcRequest, mode: FixtureFault): Promise<void> {
    const accepted = reply(identity, request, { kind: 'fixture.fault', accepted: true });
    switch (mode) {
      case 'exit': await closeChannel(); return;
      // A genuinely unresponsive runtime: nothing on this thread runs again.
      case 'hang': for (;;) { /* Spin until the parent terminates the Job. */ }
      case 'invalid-frame': await write(Uint8Array.of(0x58, 0x58, 0x58, 0x58, 1, 0, 0, 0, 0x7b)); return;
      case 'foreign-identity': {
        const forged = { ...accepted, workerRunId: identity.expressRunId };
        await write(encodeOwipFrame(forged)); return;
      }
      case 'duplicate-response':
        await session.respond(accepted); await write(encodeOwipFrame(accepted)); return;
    }
  }
  try {
    session.receive(concat(received));
    while (!stopped) {
      const chunk = await channel.read(FIXTURE_IO.readBytes, FIXTURE_IO.readDeadlineMs);
      if (!chunk.length) { session.disconnect(); break; }
      session.receive(chunk);
    }
  } catch { session.close(); }
  await closeChannel();
}
