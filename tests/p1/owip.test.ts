import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROTOCOL_VERSION } from '../../packages/contracts/dist/index.js';
import { OWIP_POLICY, OwipDecoder, encodeOwipFrame } from '../../packages/worker-transport/dist/index.js';

const value = { jsonrpc: '2.0', method: 'hello', value: '管道 🦅\u0000' };
function raw(payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(8 + payload.length);
  frame.set([79, 65, 87, 49]); new DataView(frame.buffer).setUint32(4, payload.length, true); frame.set(payload, 8);
  return frame;
}
test('OWIP has the frozen little-endian header and accepts every split and concatenated frames', () => {
  const frame = encodeOwipFrame(value);
  assert.deepEqual([...frame.subarray(0, 4)], [79, 65, 87, 49]);
  assert.equal(new DataView(frame.buffer).getUint32(4, true), frame.length - 8);
  for (let offset = 0; offset <= frame.length; offset++) {
    const decoder = new OwipDecoder();
    assert.deepEqual([...decoder.push(frame.subarray(0, offset)), ...decoder.push(frame.subarray(offset))], [value]);
    decoder.end();
  }
  const both = new Uint8Array(frame.length * 2); both.set(frame); both.set(frame, frame.length);
  assert.deepEqual(new OwipDecoder().push(both), [value, value]);
  const bytewise = new OwipDecoder(); const messages: unknown[] = [];
  for (const byte of frame) messages.push(...bytewise.push(Uint8Array.of(byte)));
  assert.deepEqual(messages, [value]);
});
test('OWIP enforces exact 256 KiB payload bound before body allocation', () => {
  const prefix = JSON.stringify({ jsonrpc: '2.0', data: '' });
  const message = { jsonrpc: '2.0', data: 'a'.repeat(OWIP_POLICY.maxPayloadBytes - prefix.length) };
  assert.equal(encodeOwipFrame(message).length, OWIP_POLICY.maxPayloadBytes + 8);
  assert.throws(() => encodeOwipFrame({ ...message, data: message.data + 'a' }), /OWIP_FRAME_LIMIT/);
  for (const size of [0, OWIP_POLICY.maxPayloadBytes + 1, 0xffffffff]) {
    const header = raw(new Uint8Array()).subarray(0, 8); new DataView(header.buffer).setUint32(4, size, true);
    const decoder = new OwipDecoder(); assert.throws(() => decoder.push(header), /OWIP_FRAME_LIMIT/);
    assert.equal(decoder.bufferedBytes, 0); assert.throws(() => decoder.push(encodeOwipFrame(value)), /OWIP_CLOSED/);
  }
});
test('OWIP rejects non-strict UTF-8, invalid JSON, batches, primitives, wrong magic and truncation', () => {
  for (const bytes of [[0xc0, 0x80], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xe2, 0x82], [0x80]]) {
    assert.throws(() => new OwipDecoder().push(raw(Uint8Array.from(bytes))), /OWIP_UTF8_INVALID/);
  }
  for (const invalid of ['{', '[]', 'null', '"text"', '{"jsonrpc":"1.0"}']) {
    assert.throws(() => new OwipDecoder().push(raw(new TextEncoder().encode(invalid))), /OWIP_JSON_INVALID/);
  }
  const invalidMagic = encodeOwipFrame(value); invalidMagic[0] = 0;
  assert.throws(() => new OwipDecoder().push(invalidMagic), /OWIP_MAGIC_INVALID/);
  for (const length of [1, 7, 8, 9]) {
    const decoder = new OwipDecoder(); decoder.push(encodeOwipFrame(value).subarray(0, length));
    assert.throws(() => decoder.end(), /OWIP_TRUNCATED/);
  }
  assert.equal(PROTOCOL_VERSION, '1.0.0');
});
