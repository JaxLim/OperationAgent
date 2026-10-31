import { randomUUID } from 'node:crypto';
import { CryptoBridgeResponseSchema, MODEL_LIMITS } from '@operation-agent/contracts';
import type { CryptoBridgeRequest, ServiceTreeIdentity } from '@operation-agent/contracts';

/** Encrypts/decrypts through the Main Crypto Bridge. Failures throw SECURE_STORAGE_UNAVAILABLE or CRYPTO_FAILED only. */
export interface CryptoBridge {
  encrypt(plaintext: string): Promise<string>;
  decrypt(ciphertext: string): Promise<string>;
}
export interface IpcCryptoBridge extends CryptoBridge {
  /** Feeds a message from the inherited channel; returns false when it is not a reply this bridge is waiting for. */
  receive(message: unknown): boolean;
}

/** Without a Main (e.g. a store-only test) every request fails closed. */
export const UNAVAILABLE_BRIDGE: CryptoBridge = Object.freeze({
  encrypt: () => Promise.reject(new Error('SECURE_STORAGE_UNAVAILABLE')),
  decrypt: () => Promise.reject(new Error('SECURE_STORAGE_UNAVAILABLE')),
});

/**
 * Client end of the bridge over the inherited Node IPC channel to Main. Requests carry this service tree's identity;
 * replies must match an outstanding request id and the same identity. Bounded pending count and per-request timeout.
 */
export function createIpcCryptoBridge(identity: ServiceTreeIdentity, send: (message: CryptoBridgeRequest) => boolean): IpcCryptoBridge {
  const waiting = new Map<string, { resolve(value: string): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const call = (request: { operation: 'encrypt'; plaintext: string } | { operation: 'decrypt'; ciphertext: string }): Promise<string> =>
    new Promise((resolve, reject) => {
      if (waiting.size >= MODEL_LIMITS.maxCryptoPending) { reject(new Error('CRYPTO_FAILED')); return; }
      const requestId = randomUUID();
      const timer = setTimeout(() => { waiting.delete(requestId); reject(new Error('CRYPTO_FAILED')); }, MODEL_LIMITS.cryptoTimeoutMs);
      waiting.set(requestId, { resolve, reject, timer });
      let sent: boolean;
      try { sent = send({ kind: 'crypto-request', ...identity, requestId, ...request } as CryptoBridgeRequest); } catch { sent = false; }
      if (!sent) { clearTimeout(timer); waiting.delete(requestId); reject(new Error('CRYPTO_FAILED')); }
    });
  return {
    encrypt: plaintext => call({ operation: 'encrypt', plaintext }),
    decrypt: ciphertext => call({ operation: 'decrypt', ciphertext }),
    receive(message) {
      const parsed = CryptoBridgeResponseSchema.safeParse(message);
      if (!parsed.success || parsed.data.mainRunId !== identity.mainRunId || parsed.data.expressRunId !== identity.expressRunId) return false;
      const entry = waiting.get(parsed.data.requestId);
      if (!entry) return false;
      waiting.delete(parsed.data.requestId); clearTimeout(entry.timer);
      if (parsed.data.ok) entry.resolve(parsed.data.value); else entry.reject(new Error(parsed.data.error));
      return true;
    },
  };
}
