import { PROTOCOL_VERSION, WorkerBootstrapSchema } from '@operation-agent/contracts';
import type { AgentFinishOutcome, AgentFinishReason, AgentToolName, RpcRequest, RpcResponse, ToolCallStatus, TurnOutcome,
  WorkerIdentity } from '@operation-agent/contracts';
import { OwipDecoder, RpcSession } from '@operation-agent/worker-transport';
import type { TransportClock } from '@operation-agent/worker-transport';
import { runAgentLoop } from './agent.js';
import type { AgentPort, AgentResult } from './agent.js';

// The production Worker runtime: answers health and shutdown like the P1 fixture, and additionally offers the `agent`
// capability. It serves exactly one inherited channel, runs at most one task at a time, and has no ambient capability:
// the trusted bootstrap injects the channel, a clock and an id generator, and nothing else.

export interface RuntimeChannel {
  read(maxBytes: number, deadlineMs: number): Promise<Uint8Array>;
  write(frame: Uint8Array, deadlineMs: number): Promise<number>;
  close(): Promise<boolean>;
}
export const RUNTIME_IO = Object.freeze({ readBytes: 65_536, readDeadlineMs: 30_000, writeDeadlineMs: 5_000 });
export interface RuntimeOptions { channel: RuntimeChannel; clock: TransportClock; newId: () => string;
  /** Observes finished loops (tests and diagnostics); never influences them. */
  onFinished?: (taskId: string, result: AgentResult) => void }

function concat(chunks: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0)); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

export async function runAgentRuntime(options: RuntimeOptions): Promise<void> {
  const { channel, clock, newId } = options;
  let stopped = false;
  const closeChannel = async (): Promise<void> => { stopped = true; await channel.close().catch(() => false); };
  const write = async (frame: Uint8Array): Promise<void> => {
    if (await channel.write(frame, RUNTIME_IO.writeDeadlineMs) !== frame.length) throw new Error('OWIP_SHORT_WRITE');
  };
  const probe = new OwipDecoder(); const received: Uint8Array[] = []; let first: unknown;
  while (first === undefined) {
    const chunk = await channel.read(RUNTIME_IO.readBytes, RUNTIME_IO.readDeadlineMs);
    if (!chunk.length) { await closeChannel(); return; }
    received.push(chunk); first = probe.push(chunk)[0];
  }
  const bootstrap = WorkerBootstrapSchema.safeParse(first);
  if (!bootstrap.success) { await closeChannel(); return; }
  const identity: WorkerIdentity = { expressRunId: bootstrap.data.expressRunId, workerRunId: bootstrap.data.workerRunId };
  const envelope = (id: string) => ({ jsonrpc: '2.0' as const, protocolVersion: PROTOCOL_VERSION, ...identity, id, requestId: id });
  const reply = (request: RpcRequest, result: unknown): RpcResponse => ({ ...envelope(request.id), role: 'worker', result } as RpcResponse);
  const refuse = (request: RpcRequest): RpcResponse => ({ ...envelope(request.id), role: 'worker',
    error: { code: -32602, message: 'VALIDATION_ERROR', data: { retryable: false } } } as RpcResponse);

  let running: { taskId: string; cancelled: boolean } | undefined;
  const session: RpcSession = new RpcSession({ identity, role: 'worker', clock, offer: ['health', 'shutdown', 'agent'],
    transport: { write, close() { stopped = true; } },
    onClose() { if (running) running.cancelled = true; void closeChannel(); },
    onRequest(request) { void handle(request).catch(() => { session.close(); }); } });

  // Worker → Express calls. Any reply that is not the expected result kind is a protocol error for the loop.
  async function call<K extends string>(method: string, params: unknown, kind: K): Promise<Extract<RpcResponse, { result: unknown }>['result'] & { kind: K }> {
    const id = newId();
    const response = await session.request({ ...envelope(id), role: 'worker', method, params } as RpcRequest);
    if (!('result' in response) || response.result.kind !== kind) throw new Error('RPC_UNEXPECTED_REPLY');
    return response.result as Extract<RpcResponse, { result: unknown }>['result'] & { kind: K };
  }
  const port: AgentPort = {
    async modelTurn(taskId, turn) { return (await call('model.turn', { taskId, turn }, 'model.turn') as { outcome: TurnOutcome }).outcome; },
    async toolCall(taskId, turn, toolCallId) {
      const result = await call('tool.call', { taskId, turn, toolCallId }, 'tool.call') as { status: ToolCallStatus; summary: string };
      return { status: result.status, summary: result.summary };
    },
    async finish(taskId: string, outcome: AgentFinishOutcome, reason: AgentFinishReason) { await call('agent.finish', { taskId, outcome, reason }, 'agent.finish'); },
  };

  async function handle(request: RpcRequest): Promise<void> {
    switch (request.method) {
      case 'health': await session.respond(reply(request, { kind: 'health', controlPlaneReady: false, agentReady: false })); return;
      case 'shutdown':
        if (running) running.cancelled = true;
        await session.respond(reply(request, { kind: 'shutdown', stopped: true }));
        await closeChannel(); return;
      case 'agent.run': {
        // One task at a time; a second run while one is active is refused rather than queued.
        if (running) { await session.respond(refuse(request)); return; }
        const task = { taskId: request.params.taskId, cancelled: false };
        running = task;
        await session.respond(reply(request, { kind: 'agent.run', accepted: true }));
        const tools = request.params.tools as AgentToolName[];
        void runAgentLoop({ taskId: task.taskId, tools, maxTurns: request.params.maxTurns, cancelled: () => task.cancelled }, port)
          .then(result => options.onFinished?.(task.taskId, result))
          .finally(() => { if (running === task) running = undefined; });
        return;
      }
      case 'agent.cancel': {
        const matched = running?.taskId === request.params.taskId;
        if (matched) running!.cancelled = true;
        await session.respond(reply(request, { kind: 'agent.cancel', cancelled: matched }));
        return;
      }
      default: await session.respond(refuse(request));
    }
  }

  try {
    session.receive(concat(received));
    while (!stopped) {
      const chunk = await channel.read(RUNTIME_IO.readBytes, RUNTIME_IO.readDeadlineMs);
      if (!chunk.length) { session.disconnect(); break; }
      session.receive(chunk);
    }
  } catch { session.close(); }
  await closeChannel();
}
