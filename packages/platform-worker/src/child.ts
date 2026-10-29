// The trusted bootstrap receives one inherited channel; no path, handle or launch API.
// The bootstrap loads the fixed child artifact and injects this narrow surface into the Worker runtime.
export interface InheritedWorkerChannel {
  read(maxBytes: number, deadlineMs: number): Promise<Uint8Array>;
  write(frame: Uint8Array, deadlineMs: number): Promise<number>;
  close(): Promise<boolean>;
}
