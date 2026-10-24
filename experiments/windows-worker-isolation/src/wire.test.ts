import assert from 'node:assert/strict';
import test from 'node:test';
import { FrameDecoder, encode } from './wire.js';
import { Request, Response, protocol } from './contracts.js';

function frame(payload: Buffer): Buffer {
  const header = Buffer.alloc(16); header.writeUInt32LE(1); header.writeUInt32LE(payload.length, 8);
  return Buffer.concat([header, payload]);
}
test('reconstructs a message fragmented at every transport byte', () => {
  const value = { text: '中文路径 😀', id: 1 }; const decoder = new FrameDecoder();
  const messages: unknown[] = [];
  for (const byte of encode(value)) messages.push(...decoder.push(Buffer.from([byte])));
  assert.deepEqual(messages, [value]);
});
test('preserves UTF8 characters split across libuv data frames', () => {
  const value = { text: '中文' }; const bytes = Buffer.from(JSON.stringify(value) + '\n');
  const split = bytes.indexOf(Buffer.from('中')) + 1;
  const decoder = new FrameDecoder();
  assert.deepEqual(decoder.push(frame(bytes.subarray(0, split))), []);
  assert.deepEqual(decoder.push(frame(bytes.subarray(split))), [value]);
});
test('rejects invalid UTF8 instead of silently replacing bytes', () => {
  const invalid = Buffer.concat([Buffer.from('{"x":"'), Buffer.from([0xff]), Buffer.from('"}\n')]);
  assert.throws(() => new FrameDecoder().push(frame(invalid)));
});
test('rejects handle transfers, oversized messages and transport buffers', () => {
  const transfer = encode({}); transfer.writeUInt32LE(3);
  assert.throws(() => new FrameDecoder().push(transfer), /IPC_FRAME_REJECTED/);
  const huge = Buffer.alloc(16); huge.writeUInt32LE(1); huge.writeUInt32LE(65537, 8);
  assert.throws(() => new FrameDecoder().push(huge), /IPC_FRAME_REJECTED/);
  assert.throws(() => new FrameDecoder().push(Buffer.alloc(131073)), /IPC_BUFFER_LIMIT/);
  assert.throws(() => encode({ text: 'a'.repeat(16368) }), /IPC_SEND_LIMIT/);
});
test('rejects incorrect protocol, unknown fields, invalid IDs and ambiguous responses', () => {
  const request = { jsonrpc: '2.0', protocol, runId: '83fdbec5-e55a-4690-a6b4-f5b91dafaf2e', id: 1, method: 'hello', params: { challenge: 'test' } };
  assert.equal(Request.safeParse(request).success, true);
  for (const change of [{ protocol: 'dec001/2' }, { extra: true }, { id: 0 }, { method: 'exec' }, { params: { challenge: 'x', cmd: 'bad' } }]) {
    assert.equal(Request.safeParse({ ...request, ...change }).success, false);
  }
  assert.equal(Response.safeParse({ jsonrpc: '2.0', protocol, runId: request.runId, id: 1 }).success, false);
});
