import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION, WorkerBootstrapSchema } from '../../packages/contracts/dist/index.js';
import type { RpcRequest, RpcResponse } from '../../packages/contracts/dist/index.js';
import { OWIP_POLICY, OwipDecoder, OwipWriteQueue, RpcSession, encodeOwipFrame } from '../../packages/worker-transport/dist/index.js';
import type { TransportClock } from '../../packages/worker-transport/dist/index.js';

class Clock implements TransportClock {
  now = 0;
  readonly timers = new Set<{ at: number; callback(): void }>();
  schedule(milliseconds: number, callback: () => void): () => void {
    const timer = { at: this.now + milliseconds, callback }; this.timers.add(timer);
    return () => { this.timers.delete(timer); };
  }
  advance(milliseconds: number): void {
    const end = this.now + milliseconds;
    for (;;) {
      const timer = [...this.timers].filter(timer => timer.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!timer) break;
      this.now = timer.at; this.timers.delete(timer); timer.callback();
    }
    this.now = end;
  }
}
async function flush(): Promise<void> { for (let index = 0; index < 16; index++) await Promise.resolve(); }
const identity = { expressRunId: randomUUID(), workerRunId: randomUUID() };
const challenge = 'a'.repeat(64);
function health(id = randomUUID()): RpcRequest {
  return { jsonrpc: '2.0', protocolVersion: PROTOCOL_VERSION, ...identity, role: 'express', id, requestId: id, method: 'health', params: {} };
}
function response(request: RpcRequest): RpcResponse {
  const envelope = { jsonrpc: '2.0' as const, protocolVersion: PROTOCOL_VERSION, ...identity,
    role: 'worker' as const, id: request.id, requestId: request.id };
  if (request.method === 'hello') return { ...envelope, result: { kind: 'hello', ...request.params, controlPlaneReady: false, agentReady: false } };
  if (request.method === 'shutdown') return { ...envelope, result: { kind: 'shutdown', stopped: true } };
  return { ...envelope, result: { kind: 'health', controlPlaneReady: false, agentReady: false } };
}
function fixture(role: 'express' | 'worker' = 'express') {
  const clock = new Clock(); const writes: Uint8Array[] = []; const failures: Error[] = []; let closed = 0;
  const session = new RpcSession({ identity, role, clock, transport: { async write(frame) { writes.push(frame); }, close() { closed++; } },
    onClose(error) { failures.push(error); } });
  return { session, clock, writes, failures, closed: () => closed };
}
async function ready() {
  const result = fixture(); const pending = result.session.startHandshake(challenge, randomUUID());
  await flush();
  const hello = WorkerBootstrapSchema.parse(new OwipDecoder().push(result.writes[0]!)[0]);
  result.session.receive(encodeOwipFrame(response(hello))); await pending; await flush();
  assert.equal(result.session.snapshot().state, 'ready');
  return result;
}

test('OWIP write quota includes active writes, separately reserves 16 KiB and cancels all writes on overflow', async () => {
  const clock = new Clock(); let closed = 0;
  const queue = new OwipWriteQueue({ write: () => new Promise(() => {}), close() { closed++; } }, clock);
  const results = Array.from({ length: 4 }, () => queue.send(new Uint8Array(262_144)).catch(error => error.message));
  results.push(queue.send(new Uint8Array(OWIP_POLICY.maxControlQueueBytes), true).catch(error => error.message));
  assert.equal(queue.snapshot().dataBytes, OWIP_POLICY.maxDataQueueBytes);
  assert.equal(queue.snapshot().controlBytes, OWIP_POLICY.maxControlQueueBytes);
  await assert.rejects(queue.send(new Uint8Array(9)), /OWIP_QUEUE_LIMIT/);
  assert.ok((await Promise.all(results)).every(value => value === 'OWIP_QUEUE_LIMIT'));
  assert.deepEqual(queue.snapshot(), { dataBytes: 0, controlBytes: 0, writing: false, closed: true });
  assert.equal(closed, 1); assert.equal(clock.timers.size, 0);
});

test('OWIP prioritizes reserved control after the current write and owns immutable queued bytes', async () => {
  const clock = new Clock(); const writes: number[] = []; const release: (() => void)[] = [];
  const queue = new OwipWriteQueue({ write: frame => new Promise(resolve => { writes.push(frame[0]!); release.push(resolve); }), close() {} }, clock);
  const first = new Uint8Array(9); first[0] = 1;
  const second = first.slice(); second[0] = 2; const control = first.slice(); control[0] = 3;
  const promises = [queue.send(first), queue.send(second), queue.send(control, true)]; first[0] = 99;
  await flush(); assert.deepEqual(writes, [1]);
  release.shift()!(); await flush(); assert.deepEqual(writes, [1, 3]);
  release.shift()!(); await flush(); assert.deepEqual(writes, [1, 3, 2]);
  release.shift()!(); await Promise.all(promises);
  assert.equal(queue.snapshot().dataBytes, 0); assert.equal(queue.snapshot().controlBytes, 0);
  assert.equal(clock.timers.size, 0); queue.close();
});

test('OWIP stalled native write expires and never resolves as a peer acknowledgement', async () => {
  const clock = new Clock(); let closed = false;
  const queue = new OwipWriteQueue({ write: () => new Promise(() => {}), close() { closed = true; } }, clock);
  const pending = assert.rejects(queue.send(new Uint8Array(9)), /OWIP_WRITE_TIMEOUT/);
  clock.advance(OWIP_POLICY.requestMs - 1); assert.equal(closed, false);
  clock.advance(1); await pending; assert.equal(closed, true); assert.equal(clock.timers.size, 0);
});

test('OWIP rejects a control-only quota overflow without borrowing data capacity', async () => {
  const clock = new Clock();
  const queue = new OwipWriteQueue({ write: () => new Promise(() => {}), close() {} }, clock);
  const pending = queue.send(new Uint8Array(OWIP_POLICY.maxControlQueueBytes), true).catch(error => error.message);
  await assert.rejects(queue.send(new Uint8Array(9), true), /OWIP_QUEUE_LIMIT/);
  assert.equal(await pending, 'OWIP_QUEUE_LIMIT');
});

test('session performs a channel-only challenge handshake and authenticates every correlated response', async () => {
  const { session, clock, writes } = await ready();
  const request = health(); let settled = false;
  const pending = session.request(request).then(value => { settled = true; return value; });
  await flush(); assert.equal(writes.length, 2); assert.equal(settled, false);
  session.receive(encodeOwipFrame(response(request))); const result = await pending;
  assert.ok('result' in result && result.result.kind === 'health' && !result.result.agentReady);
  assert.equal(session.snapshot().outbound, 0); session.close(); assert.equal(clock.timers.size, 0);
});

test('worker can receive health immediately after the peer receives its hello acknowledgement', async () => {
  const clock = new Clock(); let worker: RpcSession; const requests: RpcRequest[] = [];
  const parent = new RpcSession({ identity, role: 'express', clock, transport: { async write(frame) { worker.receive(frame); }, close() {} } });
  worker = new RpcSession({ identity, role: 'worker', clock, transport: { async write(frame) { parent.receive(frame); }, close() {} },
    onRequest(request) { requests.push(request); void worker.respond(response(request)).catch(() => {}); } });
  await parent.startHandshake(challenge, randomUUID());
  await parent.request(health());
  assert.equal(requests.length, 1); assert.equal(parent.snapshot().state, 'ready');
  parent.close(); worker.close(); assert.equal(clock.timers.size, 0);
});

test('session rejects missing/changed challenges, invalid capabilities, versions, fields and peer identity', async () => {
  for (const mutate of [
    (message: RpcResponse) => ({ ...message, workerRunId: randomUUID() }),
    (message: RpcResponse) => ({ ...message, role: 'express' }),
    (message: RpcResponse) => ({ ...message, extra: true }),
    (message: RpcResponse) => ({ ...message, protocolVersion: '2.0.0' }),
    (message: RpcResponse) => ({ ...message, result: { kind: 'hello', minimumProtocolVersion: PROTOCOL_VERSION, capabilities: ['health', 'shutdown'],
      challenge: 'b'.repeat(64), controlPlaneReady: false, agentReady: false } }),
    (message: RpcResponse) => ({ ...message, result: { kind: 'hello', minimumProtocolVersion: PROTOCOL_VERSION, capabilities: ['health', 'shell'],
      challenge, controlPlaneReady: false, agentReady: false } }),
  ]) {
    const { session, writes, closed } = fixture();
    const pending = assert.rejects(session.startHandshake(challenge, randomUUID())); await flush();
    const hello = WorkerBootstrapSchema.parse(new OwipDecoder().push(writes[0]!)[0]);
    assert.throws(() => session.receive(encodeOwipFrame(mutate(response(hello)))));
    await pending; assert.equal(session.snapshot().state, 'closed'); assert.equal(closed(), 1);
  }
});

test('session rejects pre-handshake requests, repeated handshake and unsolicited or duplicate responses', async () => {
  const early = fixture('worker'); assert.throws(() => early.session.receive(encodeOwipFrame(health())), /RPC_NOT_READY/);
  const current = await ready();
  const request = health(); const pending = current.session.request(request);
  current.session.receive(encodeOwipFrame(response(request))); await pending;
  assert.throws(() => current.session.receive(encodeOwipFrame(response(request))), /RPC_UNCORRELATED_RESPONSE/);
  const unsolicited = await ready(); assert.throws(() => unsolicited.session.receive(encodeOwipFrame(response(health()))), /RPC_UNCORRELATED_RESPONSE/);
  const repeated = await ready(); await assert.rejects(repeated.session.startHandshake(challenge, randomUUID()), /RPC_HANDSHAKE_ORDER/);
});

test('session rejects a valid response for the wrong method before resolving the pending request', async () => {
  const { session } = await ready(); const request = health(); const pending = assert.rejects(session.request(request), /RPC_RESULT_MISMATCH/);
  const wrong = { ...response(request), result: { kind: 'shutdown', stopped: true } };
  assert.throws(() => session.receive(encodeOwipFrame(wrong)), /RPC_RESULT_MISMATCH/); await pending;
});

test('session caps each direction at 64 in-flight requests and releases them on failure', async () => {
  const parent = await ready(); const pending: Promise<unknown>[] = [];
  for (let index = 0; index < OWIP_POLICY.maxInFlight; index++) pending.push(parent.session.request(health()).catch(error => error.message));
  assert.equal(parent.session.snapshot().outbound, 64);
  await assert.rejects(parent.session.request(health()), /RPC_IN_FLIGHT_LIMIT/);
  assert.ok((await Promise.all(pending)).every(value => value === 'RPC_IN_FLIGHT_LIMIT')); assert.equal(parent.clock.timers.size, 0);
  const worker = fixture('worker'); const helloId = randomUUID();
  worker.session.receive(encodeOwipFrame(WorkerBootstrapSchema.parse({ ...health(helloId), method: 'hello',
    params: { minimumProtocolVersion: PROTOCOL_VERSION, capabilities: ['health', 'shutdown'], challenge } })));
  await flush();
  for (let index = 0; index < OWIP_POLICY.maxInFlight; index++) worker.session.receive(encodeOwipFrame(health()));
  assert.equal(worker.session.snapshot().inbound, 64);
  assert.throws(() => worker.session.receive(encodeOwipFrame(health())), /RPC_IN_FLIGHT_LIMIT/);
  assert.equal(worker.session.snapshot().inbound, 0); assert.equal(worker.clock.timers.size, 0);
});

test('session bounds handshake/request deadlines and disconnect rejects every pending call', async () => {
  const waiting = fixture('worker'); waiting.clock.advance(OWIP_POLICY.handshakeMs - 1);
  assert.equal(waiting.session.snapshot().state, 'new'); waiting.clock.advance(1);
  assert.equal(waiting.failures[0]?.message, 'RPC_HANDSHAKE_TIMEOUT');
  const active = await ready(); const timeout = assert.rejects(active.session.request(health()), /RPC_REQUEST_TIMEOUT/);
  await flush(); active.clock.advance(OWIP_POLICY.requestMs); await timeout; assert.equal(active.clock.timers.size, 0);
  const disconnected = await ready(); const pending = assert.rejects(disconnected.session.request(health()), /RPC_DISCONNECTED/);
  disconnected.session.disconnect(); await pending; assert.equal(disconnected.closed(), 1); assert.equal(disconnected.clock.timers.size, 0);
  const truncated = await ready(); truncated.session.receive(encodeOwipFrame(response(health())).subarray(0, 4)); truncated.session.disconnect();
  assert.equal(truncated.failures[0]?.message, 'OWIP_TRUNCATED');
});

test('session closes after three missed heartbeats and remains bounded when the peer never replies', async () => {
  const { session, clock, writes, failures } = await ready(); session.startHeartbeat(randomUUID);
  for (let index = 0; index < 6; index++) { clock.advance(OWIP_POLICY.heartbeatMs); await flush(); }
  assert.equal(session.snapshot().state, 'closed'); assert.equal(session.snapshot().missedHeartbeats, 3);
  assert.equal(failures[0]?.message, 'RPC_HEARTBEAT_FAILED'); assert.equal(clock.timers.size, 0);
  assert.equal(writes.length, 4);
});
