// The future trusted bootstrap receives one inherited channel; no path, handle or launch API.
export interface InheritedWorkerChannel {
  send(frame: Uint8Array): Promise<void>;
  close(): Promise<void>;
}
