import type Database from 'better-sqlite3';
import { ClaudeModelSchema, CredentialHintSchema, CredentialStatusSchema, DEFAULT_CLAUDE_MODEL, MODEL_LIMITS, MODEL_PROVIDER } from '@operation-agent/contracts';
import type { ClaudeModel, CredentialStatus } from '@operation-agent/contracts';

// ARCHITECTURE §6.3: SQLite holds only safeStorage ciphertext and non-sensitive metadata. This module never sees
// plaintext; CredentialService encrypts through the Main Crypto Bridge before anything is written.

export const CREDENTIAL_SCHEME = 'electron-safestorage-v1';
export interface ModelStore {
  getModel(): ClaudeModel;
  saveModel(model: ClaudeModel): ClaudeModel;
  credentialStatus(): CredentialStatus;
  /** Replaces the stored ciphertext for the provider in one transaction. */
  saveCredential(ciphertext: string, hint: string | null): CredentialStatus;
  /** Ciphertext only, for a decrypt request through the bridge; null when nothing is stored. */
  readCiphertext(): string | null;
  clearCredential(): CredentialStatus;
}

export function createModelStore(db: Database.Database): ModelStore {
  const readModel = db.prepare<[string], { model: string }>('SELECT model FROM model_settings WHERE provider = ?');
  const readCredential = db.prepare<[string], { ciphertext: string; hint: string | null; updatedAt: string; scheme: string }>(
    'SELECT ciphertext, hint, updated_at AS updatedAt, scheme FROM model_credentials WHERE provider = ?');
  const status = (): CredentialStatus => {
    const row = readCredential.get(MODEL_PROVIDER);
    if (!row || row.scheme !== CREDENTIAL_SCHEME) return { configured: false };
    return CredentialStatusSchema.parse({ configured: true, hint: CredentialHintSchema.safeParse(row.hint).success ? row.hint : null, updatedAt: row.updatedAt });
  };
  const getModel = (): ClaudeModel => {
    // An unknown stored model (e.g. retired later) falls back to the default instead of being trusted.
    const parsed = ClaudeModelSchema.safeParse(readModel.get(MODEL_PROVIDER)?.model);
    return parsed.success ? parsed.data : DEFAULT_CLAUDE_MODEL;
  };
  return {
    getModel,
    saveModel(model) {
      const value = ClaudeModelSchema.parse(model);
      db.prepare(`INSERT INTO model_settings(provider, model, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(provider) DO UPDATE SET model = excluded.model, updated_at = excluded.updated_at`).run(MODEL_PROVIDER, value, new Date().toISOString());
      return getModel();
    },
    credentialStatus: status,
    saveCredential(ciphertext, hint) {
      if (ciphertext.length < 4 || ciphertext.length > MODEL_LIMITS.maxCiphertextChars) throw new Error('VALIDATION_ERROR');
      const safeHint = hint !== null && CredentialHintSchema.safeParse(hint).success ? hint : null;
      return db.transaction(() => {
        db.prepare(`INSERT INTO model_credentials(provider, scheme, ciphertext, hint, updated_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(provider) DO UPDATE SET scheme = excluded.scheme, ciphertext = excluded.ciphertext, hint = excluded.hint,
          updated_at = excluded.updated_at`).run(MODEL_PROVIDER, CREDENTIAL_SCHEME, ciphertext, safeHint, new Date().toISOString());
        return status();
      }).immediate();
    },
    readCiphertext() {
      const row = readCredential.get(MODEL_PROVIDER);
      return row && row.scheme === CREDENTIAL_SCHEME ? row.ciphertext : null;
    },
    clearCredential() {
      db.prepare('DELETE FROM model_credentials WHERE provider = ?').run(MODEL_PROVIDER);
      return status();
    },
  };
}
