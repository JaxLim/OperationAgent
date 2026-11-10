import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION } from '@operation-agent/contracts';
import type { AgentToolName, RpcCapabilities, RpcRequest, RpcResponse, WorkerIdentity } from '@operation-agent/contracts';
import { RpcSession } from '@operation-agent/worker-transport';
import type { ByteTransport, TransportClock } from '@operation-agent/worker-transport';
import type { AgentWorkerLink, TaskRunner } from './runner.js';

// Express's end of an agent session. The session is built here so Worker → Express requests reach the Task Runner and
// nothing else, the agent capability is requested at the handshake, and the runner is detached the moment the session
// fails (a lost Worker interrupts its task; it is never reconnected).

export const AGENT_SESSION_CAPABILITIES: RpcCapabilities = ['health', 'shutdown', 'agent'];

export interface AgentSessionOptions {
  identity: WorkerIdentity;
  clock: TransportClock;
  transport: ByteTransport;
  runner: TaskRunner;
  onClose?: (error: Error) => void;
}
export interface AgentSession { session: RpcSession; link: AgentWorkerLink; handshake(challenge: string): Promise<void> }

export function createAgentSession(options: AgentSessionOptions): AgentSession {
  const { identity, runner } = options;
  const envelope = (id: string) => ({ jsonrpc: '2.0' as const, protocolVersion: PROTOCOL_VERSION, ...identity, id, requestId: id });
  const session: RpcSession = new RpcSession({ identity, role: 'express', clock: options.clock, transport: options.transport,
    onClose: error => { runner.detach(); options.onClose?.(error); },
    onRequest: request => { void serve(request).catch(() => session.close()); } });
  async function serve(request: RpcRequest): Promise<void> {
    const reply = await runner.handle(request).catch(() => null);
    const response = reply
      ? { ...envelope(request.id), role: 'express', result: reply } as RpcResponse
      : { ...envelope(request.id), role: 'express', error: { code: -32602, message: 'VALIDATION_ERROR', data: { retryable: false } } } as RpcResponse;
    await session.respond(response);
  }
  async function call(method: 'agent.run' | 'agent.cancel', params: unknown): Promise<RpcResponse> {
    const id = randomUUID();
    return session.request({ ...envelope(id), role: 'express', method, params } as RpcRequest);
  }
  const link: AgentWorkerLink = {
    async run(params: { taskId: string; tools: AgentToolName[]; maxTurns: number }) {
      const response = await call('agent.run', params);
      if (!('result' in response) || response.result.kind !== 'agent.run' || !response.result.accepted) throw new Error('AGENT_RUN_REFUSED');
    },
    async cancel(taskId: string) {
      const response = await call('agent.cancel', { taskId });
      return 'result' in response && response.result.kind === 'agent.cancel' && response.result.cancelled;
    },
  };
  return {
    session, link,
    async handshake(challenge: string) {
      await session.startHandshake(challenge, randomUUID(), AGENT_SESSION_CAPABILITIES);
      if (!session.agentEnabled) throw new Error('RPC_CAPABILITY_REJECTED');
      // The inherited channel has a read deadline on both ends; heartbeats keep an idle or long-waiting session alive
      // (a model turn may take minutes) and detect a Worker that stopped answering.
      session.startHeartbeat(randomUUID);
      runner.attach(link);
    },
  };
}
