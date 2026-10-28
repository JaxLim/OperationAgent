import { RpcMessageSchema, WorkerIdentitySchema } from '@operation-agent/contracts';
import type { PeerRole, RpcMessage, RpcRequest, RpcResponse, WorkerIdentity } from '@operation-agent/contracts';

// Schema and instance binding only. No OS carrier, queue, handshake or authentication claim.
export function parseWorkerMessage(input: unknown, identity: WorkerIdentity, expectedRole: PeerRole): RpcMessage {
  const expected = WorkerIdentitySchema.parse(identity);
  const parsed = RpcMessageSchema.safeParse(input);
  if (!parsed.success) throw new Error('VALIDATION_ERROR');
  if (parsed.data.expressRunId !== expected.expressRunId || parsed.data.workerRunId !== expected.workerRunId ||
    parsed.data.role !== expectedRole) throw new Error('IDENTITY_MISMATCH');
  return parsed.data;
}

// An interface does not provide a transport implementation or Worker qualification.
export interface WorkerRpcClient { request(message: RpcRequest): Promise<RpcResponse> }
