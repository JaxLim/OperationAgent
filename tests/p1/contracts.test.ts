import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROTOCOL_VERSION, RpcRequestSchema, RpcResponseSchema } from '../../packages/contracts/dist/index.js';
import { parseWorkerMessage } from '../../packages/worker-transport/dist/index.js';

const identity = { expressRunId: '11111111-1111-4111-8111-111111111111', workerRunId: '22222222-2222-4222-8222-222222222222' };
const requestId = '33333333-3333-4333-8333-333333333333';
const hello = () => ({ jsonrpc: '2.0', protocolVersion: PROTOCOL_VERSION, ...identity, requestId, id: requestId,
  role: 'worker', method: 'hello', params: { minimumProtocolVersion: PROTOCOL_VERSION, capabilities: ['health', 'shutdown'] } });

test('strict v1 handshake validates the complete identity and correlation envelope', () => {
  assert.deepEqual(parseWorkerMessage(hello(), identity, 'worker'), hello());
});

test('unknown versions, identities, roles, methods and fields are rejected', () => {
  for (const change of [{ protocolVersion: '2.0.0' }, { workerRunId: '' }, { role: 'main' }, { role: 'express' },
    { method: 'tool.execute' }, { extra: true }, { id: '44444444-4444-4444-8444-444444444444' },
    { params: { minimumProtocolVersion: '0.0.1', capabilities: ['health'] } },
    { params: { minimumProtocolVersion: PROTOCOL_VERSION, capabilities: ['health', 'shell'] } }]) {
    assert.equal(RpcRequestSchema.safeParse({ ...hello(), ...change }).success, false);
  }
  assert.throws(() => parseWorkerMessage(hello(), { ...identity, expressRunId: requestId }, 'worker'), /IDENTITY_MISMATCH/);
  assert.throws(() => parseWorkerMessage(hello(), identity, 'express'), /IDENTITY_MISMATCH/);
  assert.throws(() => parseWorkerMessage([hello()], identity, 'worker'), /VALIDATION_ERROR/);
});

test('health and shutdown contracts do not grant readiness or business capabilities', () => {
  const base = { ...hello(), role: 'express', method: 'health', params: {} };
  assert.equal(RpcRequestSchema.safeParse(base).success, true);
  assert.equal(RpcRequestSchema.safeParse({ ...base, method: 'shutdown', params: { reason: 'normal' } }).success, true);
  const response = { jsonrpc: '2.0', protocolVersion: PROTOCOL_VERSION, ...identity, requestId, id: requestId, role: 'worker',
    result: { kind: 'health', controlPlaneReady: false, agentReady: false } };
  assert.equal(RpcResponseSchema.safeParse(response).success, true);
  assert.equal(RpcResponseSchema.safeParse({ ...response, result: { ...response.result, agentReady: true } }).success, false);
  assert.equal(RpcResponseSchema.safeParse({ ...response, error: { code: -32600, message: 'INVALID_REQUEST' } }).success, false);
});
