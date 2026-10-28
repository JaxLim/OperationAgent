import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, lstatSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { ControlRunListSchema, DEFAULT_WORKBENCH_SETTINGS, ProjectInputSchema, ProjectListSchema, ProjectSchema, SmokeBatchSchema,
  SmokeRecordsSchema, WORKBENCH_LIMITS, WorkbenchSettingsSchema } from '@operation-agent/contracts';
import type { ControlRun, Project, SmokeBatch, SmokeRecord, WorkbenchSettings } from '@operation-agent/contracts';

const migrations = fileURLToPath(new URL('../../migrations/', import.meta.url));
const migrationNames = ['001-control-plane.sql', '002-string-length.sql', '003-workbench.sql'];
export interface Store {
  readonly databaseVersion: number;
  readonly recoveredRuns: number;
  readonly sqliteVersion: string;
  insertRecords(records: SmokeBatch['records']): SmokeRecord[];
  listRecords(): SmokeRecord[];
  getSettings(): WorkbenchSettings;
  saveSettings(settings: WorkbenchSettings): WorkbenchSettings;
  listProjects(): Project[];
  /** Throws LIMIT_EXCEEDED or a SQLITE_CONSTRAINT error for an already registered path. */
  addProject(input: { name: string; path: string }): Project;
  /** Removing the active project also clears it from settings in the same transaction. */
  removeProject(id: string): boolean;
  listRuns(): ControlRun[];
  counts(): { projects: number; runs: number; records: number };
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
    // JavaScript/Zod length counts UTF-16 code units, including embedded NUL.
    db.function('oa_utf16_length', { deterministic: true }, (value: unknown) => typeof value === 'string' ? value.length : 0);
    // Keep the single-writer lease until close; a concurrent sidecar cannot reconcile a live run.
    db.pragma('locking_mode = EXCLUSIVE');
    db.pragma('journal_mode = WAL'); db.pragma('synchronous = FULL'); db.pragma('foreign_keys = ON');
    db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, sha256 TEXT NOT NULL) STRICT');
    const files = readdirSync(migrationDirectory).sort();
    if (JSON.stringify(files) !== JSON.stringify(migrationNames)) throw new Error('MIGRATION_SET_INVALID');
    db.transaction(() => {
      const applied = db.prepare<[], { version: number; sha256: string }>('SELECT version, sha256 FROM schema_migrations ORDER BY version').all();
      if (applied.length > migrationNames.length || applied.some((row, index) => row.version !== index + 1)) throw new Error('MIGRATION_VERSION_UNKNOWN');
      const sources = files.map(file => {
        const sql = readFileSync(resolve(migrationDirectory, file), 'utf8');
        return { sql, hash: createHash('sha256').update(sql).digest('hex') };
      });
      for (const [index, row] of applied.entries()) {
        if (row.sha256 !== sources[index]!.hash) throw new Error('MIGRATION_CHECKSUM_MISMATCH');
      }
      for (let index = applied.length; index < sources.length; index++) {
        db.exec(sources[index]!.sql);
        db.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(index + 1, sources[index]!.hash);
      }
    }).immediate();
    const recoveredRuns = db.transaction(() => {
      const interrupted = db.prepare("UPDATE control_plane_runs SET outcome = 'INTERRUPTED', ended_at = ? WHERE outcome = 'RUNNING'").run(new Date().toISOString()).changes;
      db.prepare("INSERT INTO control_plane_runs(id, started_at, outcome) VALUES (?, ?, 'RUNNING')").run(runId, new Date().toISOString());
      return interrupted;
    }).immediate();
    const select = db.prepare('SELECT id, value, created_at AS createdAt FROM smoke_records ORDER BY created_at, id LIMIT 100');
    const readSettings = db.prepare<[], { value: string }>("SELECT value FROM settings WHERE key = 'workbench'");
    const writeSettings = db.prepare("INSERT INTO settings(key, value, updated_at) VALUES ('workbench', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at");
    const selectProjects = db.prepare('SELECT id, name, path, created_at AS createdAt FROM projects ORDER BY created_at, id LIMIT ?');
    const count = (table: 'projects' | 'control_plane_runs' | 'smoke_records'): number =>
      (db.prepare(`SELECT count(*) AS total FROM ${table}`).get() as { total: number }).total;
    const settings = (): WorkbenchSettings => {
      const row = readSettings.get();
      if (!row) return { ...DEFAULT_WORKBENCH_SETTINGS };
      // Unknown or older shapes fall back to defaults instead of trusting stored JSON.
      const parsed = WorkbenchSettingsSchema.safeParse(JSON.parse(row.value));
      return parsed.success ? parsed.data : { ...DEFAULT_WORKBENCH_SETTINGS };
    };
    const sqliteVersion = (db.prepare('SELECT sqlite_version() AS version').get() as { version: string }).version;
    return {
      databaseVersion: migrationNames.length,
      recoveredRuns,
      sqliteVersion,
      getSettings: settings,
      saveSettings(input) {
        const next = WorkbenchSettingsSchema.parse(input);
        return db.transaction(() => {
          if (next.activeProjectId && !db.prepare('SELECT 1 FROM projects WHERE id = ?').get(next.activeProjectId)) throw new Error('NOT_FOUND');
          writeSettings.run(JSON.stringify(next), new Date().toISOString());
          return settings();
        }).immediate();
      },
      listProjects: () => ProjectListSchema.parse({ projects: selectProjects.all(WORKBENCH_LIMITS.maxProjects) }).projects,
      addProject(input) {
        const value = ProjectInputSchema.parse(input);
        return db.transaction(() => {
          if (count('projects') >= WORKBENCH_LIMITS.maxProjects) throw new Error('LIMIT_EXCEEDED');
          const project = ProjectSchema.parse({ id: randomUUID(), ...value, createdAt: new Date().toISOString() });
          db.prepare('INSERT INTO projects(id, name, path, created_at) VALUES (?, ?, ?, ?)').run(project.id, project.name, project.path, project.createdAt);
          return project;
        }).immediate();
      },
      removeProject(id) {
        return db.transaction(() => {
          const removed = db.prepare('DELETE FROM projects WHERE id = ?').run(id).changes === 1;
          const current = settings();
          if (removed && current.activeProjectId === id) writeSettings.run(JSON.stringify({ ...current, activeProjectId: null }), new Date().toISOString());
          return removed;
        }).immediate();
      },
      listRuns: () => ControlRunListSchema.parse({ runs: db.prepare(`SELECT id, started_at AS startedAt, ended_at AS endedAt, outcome
        FROM control_plane_runs ORDER BY started_at DESC, id LIMIT ?`).all(WORKBENCH_LIMITS.maxRuns) }).runs,
      counts: () => ({ projects: count('projects'), runs: count('control_plane_runs'), records: count('smoke_records') }),
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
