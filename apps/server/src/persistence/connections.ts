import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { CustomProviderSchema } from '@operation-agent/contracts';
import type { CustomProvider } from '@operation-agent/contracts';

export interface StoredHfAccount {
  accountId: string; clientId: string; access: string; refresh: string | null; expiresAt: number; model: string | null;
}
export function createConnectionStore(db: Database.Database) {
  const customColumns = 'id, base_url AS baseUrl, allow_local AS allowLocal, model';
  const list = db.prepare<[], Omit<CustomProvider, 'allowLocal'> & { allowLocal: number }>(
    'SELECT ' + customColumns + ' FROM custom_providers ORDER BY base_url');
  const readKey = db.prepare<[string], { ciphertext: string }>('SELECT ciphertext FROM custom_providers WHERE id=?');
  const readAccount = db.prepare<[], StoredHfAccount>('SELECT account_id AS accountId, client_id AS clientId, access_ciphertext AS access, refresh_ciphertext AS refresh, expires_at AS expiresAt, model FROM hf_account');
  return {
    listCustom: () => list.all().map(row => CustomProviderSchema.parse({ ...row, allowLocal: Boolean(row.allowLocal) })),
    customKey: (id: string) => readKey.get(id)?.ciphertext ?? null,
    saveCustom: (profile: Omit<CustomProvider, 'id'>, ciphertext: string) => db.transaction(() => {
      if (!db.prepare('SELECT 1 FROM custom_providers WHERE base_url=?').get(profile.baseUrl) &&
        (db.prepare('SELECT count(*) AS n FROM custom_providers').get() as { n: number }).n >= 24) throw new Error('LIMIT_EXCEEDED');
      db.prepare(`INSERT INTO custom_providers VALUES (?, ?, ?, ?, ?) ON CONFLICT(base_url) DO UPDATE SET
        model=excluded.model, allow_local=excluded.allow_local, ciphertext=excluded.ciphertext`).run(
        randomUUID(), profile.baseUrl, Number(profile.allowLocal), profile.model, ciphertext);
    }).immediate(),
    removeCustom: (id: string) => db.prepare('DELETE FROM custom_providers WHERE id=?').run(id),
    hfAccount: () => readAccount.get(),
    saveHf: (row: StoredHfAccount) => db.prepare('INSERT OR REPLACE INTO hf_account VALUES (1, ?, ?, ?, ?, ?, ?)').run(
      row.accountId, row.clientId, row.access, row.refresh, row.expiresAt, row.model),
    refreshHf: (old: StoredHfAccount, access: string, refresh: string | null, expiresAt: number) =>
      db.prepare('UPDATE hf_account SET access_ciphertext=?,refresh_ciphertext=?,expires_at=? WHERE account_id=? AND access_ciphertext=?')
        .run(access, refresh, expiresAt, old.accountId, old.access).changes === 1,
    setHfModel: (model: string | null) => db.prepare('UPDATE hf_account SET model=?').run(model),
    disconnectHf: () => db.prepare('DELETE FROM hf_account').run(),
  };
}
