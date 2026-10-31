import { CryptoBridgeRequestSchema, MODEL_LIMITS } from '@operation-agent/contracts';
import type { CryptoBridgeError, CryptoBridgeResponse, ServiceTreeIdentity } from '@operation-agent/contracts';

// ARCHITECTURE §6.3 Crypto Bridge: the only Main code that touches a plaintext key. It encrypts or decrypts one value
// for the trusted Express instance and keeps nothing: no cache, no logging, no plaintext in errors. Model routing and
// provider rules stay in Express. Electron's safeStorage satisfies SecureStore structurally, so tests can use a fake.

export interface SecureStore {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(plainText: string): Promise<Buffer>;
  decryptStringAsync(encrypted: Buffer): Promise<{ shouldReEncrypt: boolean; result: string }>;
  /** Linux only; reports `basic_text` when no OS keyring protects the key. */
  getSelectedStorageBackend(): string;
}

/** SEC-14: no OS-backed key (or Linux's plain-text fallback) means no storage at all, never a weak substitute. */
export async function secureStorageAvailable(store: SecureStore, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  try {
    if (platform === 'linux' && ['basic_text', 'unknown'].includes(store.getSelectedStorageBackend())) return false;
    return await store.isAsyncEncryptionAvailable();
  } catch { return false; }
}

/**
 * Handles one request already received on the inherited channel of `identity`'s Express. Any malformed message,
 * foreign identity or failure becomes a fixed code (or no reply when nothing can be attributed); the input value is
 * never part of the result.
 */
export function createCryptoBridge(store: SecureStore, platform: NodeJS.Platform = process.platform) {
  let pending = 0;
  return async (identity: ServiceTreeIdentity, message: unknown): Promise<CryptoBridgeResponse | null> => {
    const parsed = CryptoBridgeRequestSchema.safeParse(message);
    if (!parsed.success || parsed.data.mainRunId !== identity.mainRunId || parsed.data.expressRunId !== identity.expressRunId) return null;
    const request = parsed.data;
    const reply = { kind: 'crypto-response', mainRunId: request.mainRunId, expressRunId: request.expressRunId, requestId: request.requestId } as const;
    const fail = (error: CryptoBridgeError): CryptoBridgeResponse => ({ ...reply, ok: false, error });
    if (pending >= MODEL_LIMITS.maxCryptoPending) return fail('CRYPTO_FAILED');
    pending++;
    try {
      if (!await secureStorageAvailable(store, platform)) return fail('SECURE_STORAGE_UNAVAILABLE');
      if (request.operation === 'encrypt') {
        const value = (await store.encryptStringAsync(request.plaintext)).toString('base64');
        return value.length > MODEL_LIMITS.maxCiphertextChars ? fail('CRYPTO_FAILED') : { ...reply, ok: true, value };
      }
      const { result } = await store.decryptStringAsync(Buffer.from(request.ciphertext, 'base64'));
      // Only a well-formed key may leave the bridge; anything else is treated as undecryptable.
      return result.length >= MODEL_LIMITS.minKeyChars && result.length <= MODEL_LIMITS.maxKeyChars ? { ...reply, ok: true, value: result } : fail('CRYPTO_FAILED');
    } catch { return fail('CRYPTO_FAILED'); }
    finally { pending--; }
  };
}
