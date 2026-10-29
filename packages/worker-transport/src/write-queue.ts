import { OWIP_POLICY } from './framing.js';

// Implemented only by the trusted inherited-channel bootstrap. write resolves after all bytes were written,
// not after the peer accepted a business request. close must cancel pending native I/O.
export interface ByteTransport { write(frame: Uint8Array): Promise<void>; close(): void }
export interface TransportClock { schedule(milliseconds: number, callback: () => void): () => void }
interface WriteEntry { frame: Uint8Array; control: boolean; resolve(): void; reject(error: Error): void; cancel?: () => void }

export class OwipWriteQueue {
  private data: WriteEntry[] = [];
  private control: WriteEntry[] = [];
  private active: WriteEntry | undefined;
  private dataBytes = 0;
  private controlBytes = 0;
  private failure: Error | undefined;
  constructor(private readonly transport: ByteTransport, private readonly clock: TransportClock,
    private readonly onFailure: (error: Error) => void = () => {}) {}
  snapshot(): { dataBytes: number; controlBytes: number; writing: boolean; closed: boolean } {
    return { dataBytes: this.dataBytes, controlBytes: this.controlBytes, writing: !!this.active, closed: !!this.failure };
  }
  send(frame: Uint8Array, control = false): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    const total = control ? this.controlBytes : this.dataBytes;
    const limit = control ? OWIP_POLICY.maxControlQueueBytes : OWIP_POLICY.maxDataQueueBytes;
    if (frame.length < OWIP_POLICY.headerBytes + 1 || frame.length > OWIP_POLICY.headerBytes + OWIP_POLICY.maxPayloadBytes || total + frame.length > limit) {
      const error = new Error('OWIP_QUEUE_LIMIT'); this.close(error); return Promise.reject(error);
    }
    return new Promise<void>((resolve, reject) => {
      const entry: WriteEntry = { frame: frame.slice(), control, resolve, reject };
      if (control) { this.controlBytes += frame.length; this.control.push(entry); }
      else { this.dataBytes += frame.length; this.data.push(entry); }
      this.pump();
    });
  }
  close(error = new Error('OWIP_CLOSED')): void {
    if (this.failure) return;
    this.failure = error;
    const entries = [...this.data, ...this.control]; if (this.active) entries.push(this.active);
    this.data = []; this.control = []; this.active = undefined; this.dataBytes = 0; this.controlBytes = 0;
    for (const entry of entries) { entry.cancel?.(); entry.reject(error); }
    try { this.transport.close(); } finally { this.onFailure(error); }
  }
  private pump(): void {
    if (this.failure || this.active) return;
    const entry = this.control.shift() ?? this.data.shift();
    if (!entry) return;
    this.active = entry;
    entry.cancel = this.clock.schedule(OWIP_POLICY.requestMs, () => this.close(new Error('OWIP_WRITE_TIMEOUT')));
    void Promise.resolve().then(() => {
      if (this.failure) throw this.failure;
      return this.transport.write(entry.frame);
    }).then(() => {
      if (this.active !== entry || this.failure) return;
      entry.cancel?.(); this.active = undefined;
      if (entry.control) this.controlBytes -= entry.frame.length; else this.dataBytes -= entry.frame.length;
      entry.resolve(); this.pump();
    }, () => { if (!this.failure) this.close(new Error('OWIP_WRITE_FAILED')); });
  }
}
