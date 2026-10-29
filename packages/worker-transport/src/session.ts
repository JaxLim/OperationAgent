import { PROTOCOL_VERSION, RpcMessageSchema, WorkerBootstrapSchema, WorkerIdentitySchema } from '@operation-agent/contracts';
import type { PeerRole, RpcMessage, RpcRequest, RpcResponse, WorkerIdentity } from '@operation-agent/contracts';
import { OWIP_POLICY, OwipDecoder, encodeOwipFrame } from './framing.js';
import { OwipWriteQueue } from './write-queue.js';
import type { ByteTransport, TransportClock } from './write-queue.js';

interface Pending { request: RpcRequest; resolve(response: RpcResponse): void; reject(error: Error): void; cancel(): void }
interface Incoming { request: RpcRequest; cancel(): void; responding: boolean }
export interface RpcSessionOptions {
  identity: WorkerIdentity;
  role: PeerRole;
  transport: ByteTransport;
  clock: TransportClock;
  onRequest?: (request: RpcRequest) => void;
  onClose?: (error: Error) => void;
}

// This session proves protocol membership on an already trusted inherited carrier, not OS isolation.
// The launcher must bind identity to the actual created process handle before passing the carrier here.
export class RpcSession {
  private readonly identity: WorkerIdentity;
  private readonly peer: PeerRole;
  private readonly decoder = new OwipDecoder();
  private readonly writer: OwipWriteQueue;
  private readonly outbound = new Map<string, Pending>();
  private readonly inbound = new Map<string, Incoming>();
  private state: 'new' | 'handshaking' | 'ready' | 'closing' | 'closed' = 'new';
  private failure: Error | undefined;
  private cancelHandshake: () => void;
  private cancelHeartbeat: (() => void) | undefined;
  private missedHeartbeats = 0;
  constructor(private readonly options: RpcSessionOptions) {
    this.identity = WorkerIdentitySchema.parse(options.identity);
    this.peer = options.role === 'express' ? 'worker' : 'express';
    this.writer = new OwipWriteQueue(options.transport, options.clock, error => this.fail(error));
    this.cancelHandshake = options.clock.schedule(OWIP_POLICY.handshakeMs, () => this.fail(new Error('RPC_HANDSHAKE_TIMEOUT')));
  }
  snapshot(): { state: string; outbound: number; inbound: number; bufferedBytes: number; dataBytes: number; controlBytes: number; missedHeartbeats: number } {
    const queue = this.writer.snapshot();
    return { state: this.state, outbound: this.outbound.size, inbound: this.inbound.size, bufferedBytes: this.decoder.bufferedBytes,
      dataBytes: queue.dataBytes, controlBytes: queue.controlBytes, missedHeartbeats: this.missedHeartbeats };
  }
  startHandshake(challenge: string, requestId: string): Promise<RpcResponse> {
    return this.request(WorkerBootstrapSchema.parse({ jsonrpc: '2.0', protocolVersion: PROTOCOL_VERSION, ...this.identity,
      role: 'express', requestId, id: requestId, method: 'hello', params: {
        minimumProtocolVersion: PROTOCOL_VERSION, capabilities: ['health', 'shutdown'], challenge,
      } }));
  }
  request(message: RpcRequest): Promise<RpcResponse> { return this.sendRequest(message, OWIP_POLICY.requestMs, true); }
  private parse(input: unknown, role: PeerRole): RpcMessage {
    const message = RpcMessageSchema.safeParse(input);
    if (!message.success) throw new Error('VALIDATION_ERROR');
    if (message.data.role !== role || message.data.expressRunId !== this.identity.expressRunId ||
      message.data.workerRunId !== this.identity.workerRunId) throw new Error('IDENTITY_MISMATCH');
    return message.data;
  }
  private sendRequest(input: RpcRequest, timeoutMs: number, fatalTimeout: boolean): Promise<RpcResponse> {
    try {
      if (this.failure) throw this.failure;
      const message = this.parse(input, this.options.role);
      if (!('method' in message)) throw new Error('RPC_REQUEST_REQUIRED');
      if (message.method === 'hello') {
        if (this.state !== 'new' || this.options.role !== 'express') throw new Error('RPC_HANDSHAKE_ORDER');
        this.state = 'handshaking'; timeoutMs = OWIP_POLICY.handshakeMs;
      } else if (this.state !== 'ready') throw new Error('RPC_NOT_READY');
      if (this.outbound.size >= OWIP_POLICY.maxInFlight) throw new Error('RPC_IN_FLIGHT_LIMIT');
      if (this.outbound.has(message.id)) throw new Error('RPC_DUPLICATE_REQUEST');
      if (message.method === 'shutdown') { this.state = 'closing'; this.cancelHeartbeat?.(); }
      return new Promise<RpcResponse>((resolve, reject) => {
        const cancel = this.options.clock.schedule(timeoutMs, () => {
          this.outbound.delete(message.id);
          const error = new Error('RPC_REQUEST_TIMEOUT'); reject(error);
          if (fatalTimeout) this.fail(error);
        });
        this.outbound.set(message.id, { request: message, resolve, reject, cancel });
        void this.writer.send(encodeOwipFrame(message), message.method === 'shutdown').catch(error => {
          this.fail(error instanceof Error ? error : new Error('OWIP_WRITE_FAILED'));
        });
      });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error('RPC_INVALID'); this.fail(failure); return Promise.reject(failure);
    }
  }
  receive(chunk: Uint8Array): void {
    if (this.failure) throw this.failure;
    try { for (const value of this.decoder.push(chunk)) this.consume(this.parse(value, this.peer)); }
    catch (error) { const failure = error instanceof Error ? error : new Error('RPC_INVALID'); this.fail(failure); throw failure; }
  }
  private consume(message: RpcMessage): void {
    if (this.failure) throw this.failure;
    if ('method' in message) {
      if (message.method === 'hello') {
        if (this.state !== 'new' || this.options.role !== 'worker') throw new Error('RPC_HANDSHAKE_ORDER');
        WorkerBootstrapSchema.parse(message); this.state = 'handshaking';
      } else if (this.state !== 'ready') throw new Error('RPC_NOT_READY');
      if (this.inbound.size >= OWIP_POLICY.maxInFlight) throw new Error('RPC_IN_FLIGHT_LIMIT');
      if (this.inbound.has(message.id)) throw new Error('RPC_DUPLICATE_REQUEST');
      const cancel = this.options.clock.schedule(OWIP_POLICY.requestMs, () => this.fail(new Error('RPC_HANDLER_TIMEOUT')));
      this.inbound.set(message.id, { request: message, cancel, responding: false });
      if (message.method === 'hello') {
        void this.respond({ jsonrpc: '2.0', protocolVersion: PROTOCOL_VERSION, ...this.identity,
          role: 'worker', requestId: message.id, id: message.id, result: { kind: 'hello', ...message.params,
            controlPlaneReady: false, agentReady: false } }).catch(() => {});
      } else {
        if (message.method === 'shutdown') { this.state = 'closing'; this.cancelHeartbeat?.(); }
        this.options.onRequest?.(message);
      }
      return;
    }
    const pending = this.outbound.get(message.id);
    if (!pending) throw new Error('RPC_UNCORRELATED_RESPONSE');
    this.validateResponse(message, pending.request);
    pending.cancel(); this.outbound.delete(message.id);
    if (pending.request.method === 'hello') { this.cancelHandshake(); this.state = 'ready'; }
    pending.resolve(message);
  }
  private validateResponse(response: RpcResponse, request: RpcRequest): void {
    if ('result' in response) {
      if (response.result.kind !== request.method) throw new Error('RPC_RESULT_MISMATCH');
      if (request.method === 'hello' && (response.result.kind !== 'hello' || response.result.challenge !== request.params.challenge)) {
        throw new Error('RPC_CHALLENGE_MISMATCH');
      }
    } else if (request.method === 'hello') throw new Error('RPC_HANDSHAKE_REJECTED');
  }
  // Resolves on transport write completion; a shutdown reply is not proof of process-tree cleanup.
  async respond(input: RpcResponse): Promise<void> {
    try {
      if (this.failure) throw this.failure;
      const response = this.parse(input, this.options.role);
      if ('method' in response) throw new Error('RPC_RESPONSE_REQUIRED');
      const incoming = this.inbound.get(response.id);
      if (!incoming || incoming.responding) throw new Error('RPC_UNCORRELATED_RESPONSE');
      this.validateResponse(response, incoming.request); incoming.responding = true;
      const frame = encodeOwipFrame(response);
      // The peer may send its first request as soon as it reads this acknowledgement, possibly before our
      // write completion is observed. A failed write still closes the whole session.
      if (incoming.request.method === 'hello') { this.cancelHandshake(); this.state = 'ready'; }
      await this.writer.send(frame, incoming.request.method === 'shutdown');
      if (this.failure) throw this.failure;
      incoming.cancel(); this.inbound.delete(response.id);
    } catch (error) { const failure = error instanceof Error ? error : new Error('RPC_INVALID'); this.fail(failure); throw failure; }
  }
  startHeartbeat(nextRequestId: () => string): void {
    if (this.options.role !== 'express' || this.state !== 'ready' || this.cancelHeartbeat) throw new Error('RPC_HEARTBEAT_STATE');
    let probing = false;
    const tick = (): void => {
      if (this.state !== 'ready') return;
      this.cancelHeartbeat = this.options.clock.schedule(OWIP_POLICY.heartbeatMs, tick);
      if (probing) return;
      probing = true;
      let id: string;
      try { id = nextRequestId(); } catch { this.fail(new Error('RPC_HEARTBEAT_FAILED')); return; }
      void this.sendRequest({ jsonrpc: '2.0', protocolVersion: PROTOCOL_VERSION, ...this.identity,
        role: 'express', id, requestId: id, method: 'health', params: {} }, OWIP_POLICY.heartbeatMs, false)
        .then(response => { this.missedHeartbeats = 'error' in response ? this.missedHeartbeats + 1 : 0; }, () => { this.missedHeartbeats++; })
        .finally(() => {
          probing = false;
          if (this.missedHeartbeats >= OWIP_POLICY.missedHeartbeats) this.fail(new Error('RPC_HEARTBEAT_FAILED'));
        });
    };
    this.cancelHeartbeat = this.options.clock.schedule(OWIP_POLICY.heartbeatMs, tick);
  }
  disconnect(): void {
    try { this.decoder.end(); this.fail(new Error('RPC_DISCONNECTED')); }
    catch { this.fail(new Error('OWIP_TRUNCATED')); }
  }
  close(): void { this.fail(new Error('RPC_CLOSED')); }
  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error; this.state = 'closed'; this.cancelHandshake?.(); this.cancelHeartbeat?.(); this.decoder.close();
    for (const pending of this.outbound.values()) { pending.cancel(); pending.reject(error); }
    for (const incoming of this.inbound.values()) incoming.cancel();
    this.outbound.clear(); this.inbound.clear(); this.writer.close(error); this.options.onClose?.(error);
  }
}
