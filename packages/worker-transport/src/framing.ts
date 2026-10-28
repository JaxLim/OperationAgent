// ADR-WIN-001 OWIP/1. Pure bytes only: no ambient OS, Node or browser capabilities.
export const OWIP_POLICY = Object.freeze({ headerBytes: 8, maxPayloadBytes: 262_144,
  maxInFlight: 64, maxDataQueueBytes: 1_048_576, maxControlQueueBytes: 16_384,
  handshakeMs: 10_000, heartbeatMs: 1_000, missedHeartbeats: 3, requestMs: 5_000 });
const magic = [79, 65, 87, 49] as const;

function utf8Encode(text: string): Uint8Array {
  let size = 0;
  for (const character of text) {
    const point = character.codePointAt(0)!;
    size += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
    if (size > OWIP_POLICY.maxPayloadBytes) throw new Error('OWIP_FRAME_LIMIT');
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const character of text) {
    const point = character.codePointAt(0)!;
    if (point < 0x80) bytes[offset++] = point;
    else if (point < 0x800) { bytes[offset++] = 0xc0 | (point >> 6); bytes[offset++] = 0x80 | (point & 63); }
    else if (point < 0x10000) {
      bytes[offset++] = 0xe0 | (point >> 12); bytes[offset++] = 0x80 | ((point >> 6) & 63); bytes[offset++] = 0x80 | (point & 63);
    } else {
      bytes[offset++] = 0xf0 | (point >> 18); bytes[offset++] = 0x80 | ((point >> 12) & 63);
      bytes[offset++] = 0x80 | ((point >> 6) & 63); bytes[offset++] = 0x80 | (point & 63);
    }
  }
  return bytes;
}

function utf8Decode(bytes: Uint8Array): string {
  let text = '';
  for (let offset = 0; offset < bytes.length;) {
    const first = bytes[offset++]!;
    let point: number; let remaining: number; let minimum: number;
    if (first < 0x80) { point = first; remaining = 0; minimum = 0; }
    else if (first >= 0xc2 && first <= 0xdf) { point = first & 31; remaining = 1; minimum = 0x80; }
    else if (first >= 0xe0 && first <= 0xef) { point = first & 15; remaining = 2; minimum = 0x800; }
    else if (first >= 0xf0 && first <= 0xf4) { point = first & 7; remaining = 3; minimum = 0x10000; }
    else throw new Error('OWIP_UTF8_INVALID');
    if (offset + remaining > bytes.length) throw new Error('OWIP_UTF8_INVALID');
    for (let index = 0; index < remaining; index++) {
      const byte = bytes[offset++]!;
      if ((byte & 0xc0) !== 0x80) throw new Error('OWIP_UTF8_INVALID');
      point = (point << 6) | (byte & 63);
    }
    if (point < minimum || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) throw new Error('OWIP_UTF8_INVALID');
    text += String.fromCodePoint(point);
  }
  return text;
}

function objectMessage(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    'jsonrpc' in value && value.jsonrpc === '2.0';
}

// Schema and identity validation belong to RpcSession; the framing codec only accepts one JSON-RPC object.
export function encodeOwipFrame(message: unknown): Uint8Array {
  if (!objectMessage(message)) throw new Error('OWIP_JSON_INVALID');
  const payload = utf8Encode(JSON.stringify(message));
  const frame = new Uint8Array(OWIP_POLICY.headerBytes + payload.length);
  frame.set(magic); new DataView(frame.buffer).setUint32(4, payload.length, true); frame.set(payload, OWIP_POLICY.headerBytes);
  return frame;
}

export class OwipDecoder {
  private readonly header = new Uint8Array(OWIP_POLICY.headerBytes);
  private headerUsed = 0;
  private payload: Uint8Array | undefined;
  private payloadUsed = 0;
  private closed = false;
  get bufferedBytes(): number { return this.headerUsed + this.payloadUsed; }
  close(): void { this.closed = true; this.headerUsed = 0; this.payloadUsed = 0; this.payload = undefined; }
  push(chunk: Uint8Array): unknown[] {
    if (this.closed) throw new Error('OWIP_CLOSED');
    try {
      if (chunk.byteLength > OWIP_POLICY.maxDataQueueBytes) throw new Error('OWIP_RECEIVE_LIMIT');
      const messages: unknown[] = []; let offset = 0;
      while (offset < chunk.length) {
        if (!this.payload) {
          const count = Math.min(this.header.length - this.headerUsed, chunk.length - offset);
          this.header.set(chunk.subarray(offset, offset + count), this.headerUsed); this.headerUsed += count; offset += count;
          if (this.headerUsed !== this.header.length) continue;
          if (!magic.every((byte, index) => this.header[index] === byte)) throw new Error('OWIP_MAGIC_INVALID');
          const length = new DataView(this.header.buffer).getUint32(4, true);
          if (length < 1 || length > OWIP_POLICY.maxPayloadBytes) throw new Error('OWIP_FRAME_LIMIT');
          this.payload = new Uint8Array(length);
        }
        const count = Math.min(this.payload.length - this.payloadUsed, chunk.length - offset);
        this.payload.set(chunk.subarray(offset, offset + count), this.payloadUsed); this.payloadUsed += count; offset += count;
        if (this.payloadUsed === this.payload.length) {
          const text = utf8Decode(this.payload); let value: unknown;
          try { value = JSON.parse(text) as unknown; } catch { throw new Error('OWIP_JSON_INVALID'); }
          if (!objectMessage(value)) throw new Error('OWIP_JSON_INVALID');
          messages.push(value); this.headerUsed = 0; this.payloadUsed = 0; this.payload = undefined;
        }
      }
      return messages;
    } catch (error) { this.close(); throw error; }
  }
  end(): void {
    const truncated = this.bufferedBytes !== 0; this.close();
    if (truncated) throw new Error('OWIP_TRUNCATED');
  }
}
