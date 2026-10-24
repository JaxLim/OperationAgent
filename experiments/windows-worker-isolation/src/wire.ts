// Experimental Node 24/libuv Windows IPC framing. This is NOT a public stable API.
export class FrameDecoder {
  private bytes = Buffer.alloc(0);
  private text = '';
  private readonly utf8 = new TextDecoder('utf-8', { fatal: true });
  push(chunk: Buffer): unknown[] {
    if (this.bytes.length + chunk.length > 131072) throw new Error('IPC_BUFFER_LIMIT');
    this.bytes = Buffer.concat([this.bytes, chunk]);
    const messages: unknown[] = [];
    while (this.bytes.length >= 16) {
      const flags = this.bytes.readUInt32LE(0);
      const size = this.bytes.readUInt32LE(8);
      if (flags !== 1 || this.bytes.readUInt32LE(12) !== 0 || size > 65536) throw new Error('IPC_FRAME_REJECTED');
      if (this.bytes.length < size + 16) break;
      this.text += this.utf8.decode(this.bytes.subarray(16, size + 16), { stream: true });
      this.bytes = this.bytes.subarray(size + 16);
      if (Buffer.byteLength(this.text) > 65536) throw new Error('IPC_MESSAGE_LIMIT');
      for (;;) {
        const end = this.text.indexOf('\n'); if (end < 0) break;
        messages.push(JSON.parse(this.text.slice(0, end)) as unknown); this.text = this.text.slice(end + 1);
        if (messages.length > 8) throw new Error('IPC_BATCH_LIMIT');
      }
    }
    return messages;
  }
}
export function encode(message: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(message) + '\n');
  if (payload.length > 16368) throw new Error('IPC_SEND_LIMIT');
  const frame = Buffer.alloc(16 + payload.length); frame.writeUInt32LE(1, 0); frame.writeUInt32LE(payload.length, 8); payload.copy(frame, 16); return frame;
}
