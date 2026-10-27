import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, lstatSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SmokeBatchSchema, SmokeRecordsSchema } from '@operation-agent/contracts';
import type { SmokeBatch, SmokeRecord } from '@operation-agent/contracts';

const migrations = fileURLToPath(new URL('../../migrations/', import.meta.url));
export interface Store {
  readonly recoveredRuns: number;
  insertRecords(records: SmokeBatch['records']): SmokeRecord[];
  listRecords(): SmokeRecord[];
  close(clean: boolean): void;
}

export function openStore(directory: string, runId: string, migrationDirectory = migrations): Store {
  if (!isAbsolute(directory)) throw new Error('DATABASE_UNAVAILABLE');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const databasePath = resolve(directory, 'control-plane.sqlite');
  for (const path of [directory, databasePath, databasePath + '-wal', databasePath + '-shm']) {
    try { if (lstatSync(path).isSymbolicLink()) throw new Error('DATABASE_UNAVAILABLE'); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  }
  const db = new Database(databasePath, { timeout: 1_000 });
  try {
    // Keep the single-writer lease until close; a concurrent sidecar cannot reconcile a live run.
    db.pragma('locking_mode = EXCLUSIVE');
    db.pragma('journal_mode = WAL'); db.pragma('synchronous = FULL'); db.pragma('foreign_keys = ON');
    db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, sha256 TEXT NOT NULL) STRICT');
    const files = readdirSync(migrationDirectory).sort();
    if (files.length !== 1 || files[0] !== '001-control-plane.sql') throw new Error('MIGRATION_SET_INVALID');
    db.transaction(() => {
      const applied = db.prepare<[], { version: number; sha256: string }>('SELECT version, sha256 FROM schema_migrations ORDER BY version').all();
      if (applied.some(row => row.version !== 1)) throw new Error('MIGRATION_VERSION_UNKNOWN');
      const sql = readFileSync(resolve(migrationDirectory, files[0]!), 'utf8');
      const hash = createHash('sha256').update(sql).digest('hex');
      if (applied[0]) {
        if (applied[0].sha256 !== hash) throw new Error('MIGRATION_CHECKSUM_MISMATCH');
      } else {
        db.exec(sql);
        db.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(1, hash);
      }
    }).immediate();
    const recoveredRuns = db.transaction(() => {
      const interrupted = db.prepare("UPDATE control_plane_runs SET outcome = 'INTERRUPTED', ended_at = ? WHERE outcome = 'RUNNING'").run(new Date().toISOString()).changes;
      db.prepare("INSERT INTO control_plane_runs(id, started_at, outcome) VALUES (?, ?, 'RUNNING')").run(runId, new Date().toISOString());
      return interrupted;
    }).immediate();
    const select = db.prepare('SELECT id, value, created_at AS createdAt FROM smoke_records ORDER BY created_at, id LIMIT 100');
    return {
      recoveredRuns,
      listRecords: () => SmokeRecordsSchema.parse({ records: select.all() }).records,
      insertRecords(records) {
        const batch = SmokeBatchSchema.parse({ records });
        return db.transaction(() => {
          const insert = db.prepare('INSERT INTO smoke_records(id, value, created_at) VALUES (?, ?, ?)');
          const values = batch.records.map(record => ({ ...record, createdAt: new Date().toISOString() }));
          for (const record of values) insert.run(record.id, record.value, record.createdAt);
          return values;
        }).immediate();
      },
      close(clean) {
        if (!db.open) return;
        try { if (clean) db.prepare("UPDATE control_plane_runs SET outcome = 'CLEAN', ended_at = ? WHERE id = ?").run(new Date().toISOString(), runId); }
        finally { db.close(); }
      },
    };
  } catch (error) { db.close(); throw error; }
}
