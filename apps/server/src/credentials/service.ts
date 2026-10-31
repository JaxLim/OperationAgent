import { ApiKeySchema, credentialHint } from '@operation-agent/contracts';
import type { CredentialStatus } from '@operation-agent/contracts';
import type { ModelStore } from '../persistence/models.js';
import type { CryptoBridge } from './bridge.js';

// ARCHITECTURE §6.3 CredentialService: decides creation, replacement, deletion and use of the provider key. Plaintext
// exists only for the duration of one call: it is encrypted through the Main bridge before anything is stored, and a
// decrypted key is handed to exactly one callback. Nothing here logs, caches or puts a key into an error.

export type KeyUse<T> = { ok: true; value: T } | { ok: false; reason: 'not_configured' | 'credential_unavailable' };
export interface CredentialService {
  status(): CredentialStatus;
  /** Throws VALIDATION_ERROR, SECURE_STORAGE_UNAVAILABLE, SERVICE_UNAVAILABLE or DATABASE_UNAVAILABLE; nothing is stored on failure. */
  set(apiKey: string): Promise<CredentialStatus>;
  clear(): CredentialStatus;
  /** Decrypts the stored key for one use; the key is not retained after `use` settles. */
  withKey<T>(use: (apiKey: string) => Promise<T>): Promise<KeyUse<T>>;
}

export function createCredentialService(store: ModelStore, bridge: CryptoBridge): CredentialService {
  return {
    status: () => store.credentialStatus(),
    async set(apiKey) {
      if (!ApiKeySchema.safeParse(apiKey).success) throw new Error('VALIDATION_ERROR');
      // SEC-14: refuse rather than fall back to weaker protection. Only a fixed code is rethrown, without a cause.
      const encrypted = await bridge.encrypt(apiKey).then(value => ({ value }),
        (error: unknown) => ({ error: error instanceof Error && error.message === 'SECURE_STORAGE_UNAVAILABLE' ? 'SECURE_STORAGE_UNAVAILABLE' : 'SERVICE_UNAVAILABLE' }));
      if ('error' in encrypted) throw new Error(encrypted.error);
      const ciphertext = encrypted.value;
      // Defence in depth: a bridge that echoed the plaintext must never get it persisted.
      if (ciphertext === apiKey || ciphertext.includes(apiKey)) throw new Error('SECURE_STORAGE_UNAVAILABLE');
      let saved: CredentialStatus | null = null;
      try { saved = store.saveCredential(ciphertext, credentialHint(apiKey)); } catch { /* reported below as a fixed code */ }
      if (!saved) throw new Error('DATABASE_UNAVAILABLE');
      return saved;
    },
    clear: () => store.clearCredential(),
    async withKey(use) {
      const ciphertext = store.readCiphertext();
      if (!ciphertext) return { ok: false, reason: 'not_configured' };
      let apiKey: string;
      try { apiKey = await bridge.decrypt(ciphertext); } catch { return { ok: false, reason: 'credential_unavailable' }; }
      if (!ApiKeySchema.safeParse(apiKey).success) return { ok: false, reason: 'credential_unavailable' };
      return { ok: true, value: await use(apiKey) };
    },
  };
}
