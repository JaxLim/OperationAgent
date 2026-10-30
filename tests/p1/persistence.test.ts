import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../../apps/server/dist/persistence/store.js';

test('SQLite migrations are idempotent, batches roll back and committed records survive reopen', () => {
  const cache = resolve('.cache'); mkdirSync(cache, { recursive: true });
  const directory = mkdtempSync(resolve(cache, 'persistence-'));
  try {
    const id = randomUUID();
    const store = openStore(directory, randomUUID());
    assert.equal(store.recoveredRuns, 0);
    store.insertRecords([{ id, value: 'durable' }]);
    assert.throws(() => store.insertRecords([{ id: randomUUID(), value: 'must roll back' }, { id, value: 'duplicate' }]));
    assert.equal(store.listRecords().length, 1);
    store.close(true);
    const reopened = openStore(directory, randomUUID());
    assert.equal(reopened.recoveredRuns, 0);
    assert.deepEqual(reopened.listRecords().map(record => ({ id: record.id, value: record.value })), [{ id, value: 'durable' }]);
    reopened.close(false);
    const recovered = openStore(directory, randomUUID());
    assert.equal(recovered.recoveredRuns, 1);
    recovered.close(true);
  } finally {
    if (directory.startsWith(cache + sep)) rmSync(directory, { recursive: true, force: true });
  }
});

test('contract-valid leading NUL and UTF-16 boundary strings survive SQLite close and reopen', () => {
  const cache = resolve('.cache'); mkdirSync(cache, { recursive: true });
  const directory = mkdtempSync(resolve(cache, 'strings-'));
  const values = ['\u0000valid', '\u0000', '\u0000'.repeat(256), '😀'.repeat(128), '中'.repeat(256), 'a\u0000b'];
  const records = values.map(value => ({ id: randomUUID(), value }));
  const store = openStore(directory, randomUUID());
  try {
    store.insertRecords(records);
    assert.throws(() => store.insertRecords([{ id: randomUUID(), value: '😀'.repeat(129) }]));
    assert.throws(() => store.insertRecords([{ id: randomUUID(), value: '' }]));
    const persisted = store.listRecords();
    assert.deepEqual(new Map(persisted.map(row => [row.id, row.value])), new Map(records.map(row => [row.id, row.value])));
    store.close(true);
    const reopened = openStore(directory, randomUUID());
    try { assert.deepEqual(reopened.listRecords(), persisted); } finally { reopened.close(true); }
  } finally {
    store.close(false);
    if (directory.startsWith(cache + sep)) rmSync(directory, { recursive: true, force: true });
  }
});

test('failed SQL migrations roll back and altered migration history is rejected on reopen', () => {
  const cache = resolve('.cache'); mkdirSync(cache, { recursive: true });
  const directory = mkdtempSync(resolve(cache, 'migration-'));
  const migrations = resolve(directory, 'migrations'); mkdirSync(migrations);
  const sql = readFileSync('apps/server/migrations/001-control-plane.sql', 'utf8');
  const file = resolve(migrations, '001-control-plane.sql');
  const database = resolve(directory, 'data');
  try {
    writeFileSync(resolve(migrations, '002-string-length.sql'), readFileSync('apps/server/migrations/002-string-length.sql'));
    writeFileSync(resolve(migrations, '003-workbench.sql'), readFileSync('apps/server/migrations/003-workbench.sql'));
    writeFileSync(resolve(migrations, '004-task-events.sql'), readFileSync('apps/server/migrations/004-task-events.sql'));
    writeFileSync(file, sql + '\nCREATE TABLE rollback_probe(id INTEGER);\nINVALID SQL;', 'utf8');
    assert.throws(() => openStore(database, randomUUID(), migrations));
    writeFileSync(file, sql + '\nCREATE TABLE rollback_probe(id INTEGER);', 'utf8');
    const store = openStore(database, randomUUID(), migrations);
    assert.deepEqual(store.listRecords(), []);
    store.close(true);
    writeFileSync(file, sql + '\n-- altered migration', 'utf8');
    assert.throws(() => openStore(database, randomUUID(), migrations), /MIGRATION_CHECKSUM_MISMATCH/);
  } finally {
    if (directory.startsWith(cache + sep)) rmSync(directory, { recursive: true, force: true });
  }
});

test('001 databases upgrade without changing data, run history or the original migration checksum', () => {
  const cache = resolve('.cache'); mkdirSync(cache, { recursive: true });
  const directory = mkdtempSync(resolve(cache, 'upgrade-'));
  const path = resolve(directory, 'control-plane.sqlite');
  const sql = readFileSync('apps/server/migrations/001-control-plane.sql', 'utf8');
  const hash = createHash('sha256').update(sql).digest('hex');
  const id = randomUUID(), oldRun = randomUUID(), timestamp = '2026-10-25T00:00:00.000Z';
  const legacy = new DatabaseSync(path);
  legacy.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, sha256 TEXT NOT NULL) STRICT');
  legacy.exec(sql);
  legacy.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(1, hash);
  legacy.prepare('INSERT INTO smoke_records VALUES (?, ?, ?)').run(id, 'old\u0000data', timestamp);
  legacy.prepare('INSERT INTO control_plane_runs VALUES (?, ?, ?, ?)').run(oldRun, timestamp, timestamp, 'CLEAN');
  legacy.close();
  try {
    const store = openStore(directory, randomUUID());
    try {
      assert.equal(store.databaseVersion, 4); assert.equal(store.recoveredRuns, 0);
      assert.deepEqual(store.listRecords(), [{ id, value: 'old\u0000data', createdAt: timestamp }]);
      store.insertRecords([{ id: randomUUID(), value: '\u0000upgraded' }]);
    } finally { store.close(true); }
    const inspect = new DatabaseSync(path);
    try {
      assert.equal(inspect.prepare('SELECT sha256 FROM schema_migrations WHERE version = 1').get()?.sha256, hash);
      assert.equal(inspect.prepare('SELECT count(*) AS count FROM schema_migrations').get()?.count, 4);
      assert.equal(inspect.prepare('SELECT outcome FROM control_plane_runs WHERE id = ?').get(oldRun)?.outcome, 'CLEAN');
      inspect.prepare('UPDATE schema_migrations SET sha256 = ? WHERE version = 2').run('tampered');
    } finally { inspect.close(); }
    assert.throws(() => openStore(directory, randomUUID()), /MIGRATION_CHECKSUM_MISMATCH/);
  } finally { if (directory.startsWith(cache + sep)) rmSync(directory, { recursive: true, force: true }); }
});

test('a failed 002 upgrade rolls back the original table, data and migration history', () => {
  const cache = resolve('.cache'); mkdirSync(cache, { recursive: true });
  const directory = mkdtempSync(resolve(cache, 'upgrade-rollback-'));
  const path = resolve(directory, 'control-plane.sqlite');
  const migrations = resolve(directory, 'migrations'); mkdirSync(migrations);
  const first = readFileSync('apps/server/migrations/001-control-plane.sql', 'utf8');
  const second = readFileSync('apps/server/migrations/002-string-length.sql', 'utf8');
  writeFileSync(resolve(migrations, '001-control-plane.sql'), first);
  writeFileSync(resolve(migrations, '002-string-length.sql'), second + '\nINVALID SQL;');
  writeFileSync(resolve(migrations, '003-workbench.sql'), readFileSync('apps/server/migrations/003-workbench.sql'));
  writeFileSync(resolve(migrations, '004-task-events.sql'), readFileSync('apps/server/migrations/004-task-events.sql'));
  const legacy = new DatabaseSync(path);
  legacy.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, sha256 TEXT NOT NULL) STRICT'); legacy.exec(first);
  legacy.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(1, createHash('sha256').update(first).digest('hex'));
  legacy.prepare('INSERT INTO smoke_records VALUES (?, ?, ?)').run(randomUUID(), 'preserve', '2026-10-25T00:00:00.000Z');
  legacy.close();
  try {
    assert.throws(() => openStore(directory, randomUUID(), migrations), /syntax error/);
    const inspect = new DatabaseSync(path);
    try {
      assert.equal(inspect.prepare('SELECT value FROM smoke_records').get()?.value, 'preserve');
      assert.equal(inspect.prepare('SELECT count(*) AS count FROM schema_migrations').get()?.count, 1);
      assert.match(String(inspect.prepare("SELECT sql FROM sqlite_master WHERE name = 'smoke_records'").get()?.sql), /length\(value\)/);
      assert.equal(inspect.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name = 'smoke_records_v2'").get()?.count, 0);
    } finally { inspect.close(); }
    writeFileSync(resolve(migrations, '002-string-length.sql'), second);
    const upgraded = openStore(directory, randomUUID(), migrations);
    try { assert.equal(upgraded.listRecords()[0]?.value, 'preserve'); } finally { upgraded.close(true); }
  } finally { if (directory.startsWith(cache + sep)) rmSync(directory, { recursive: true, force: true }); }
});

test('workbench projects, settings and run history are transactional and survive reopen', async () => {
  const { openStore: open } = await import('../../apps/server/dist/persistence/store.js');
  const cache = resolve('.cache'); mkdirSync(cache, { recursive: true });
  const directory = mkdtempSync(resolve(cache, 'workbench-'));
  try {
    const store = open(directory, randomUUID());
    try {
    assert.equal(store.databaseVersion, 4);
    const project = store.addProject({ name: 'ledger', path: 'C:/work/ledger' });
    assert.throws(() => store.addProject({ name: 'dup', path: 'c:/WORK/ledger' }), (error: Error & { code?: string }) => String(error.code).startsWith('SQLITE_CONSTRAINT'));
    assert.throws(() => store.addProject({ name: 'relative', path: 'work/ledger' }));
    assert.throws(() => store.saveSettings({ ...store.getSettings(), activeProjectId: randomUUID() }), /NOT_FOUND/);
    store.saveSettings({ ...store.getSettings(), activeProjectId: project.id, density: 'compact' });
    for (let index = 1; index < 50; index++) store.addProject({ name: `p${index}`, path: `D:/p/${index}` });
    assert.throws(() => store.addProject({ name: 'over', path: 'D:/over' }), /LIMIT_EXCEEDED/);
    assert.equal(store.removeProject(project.id), true); assert.equal(store.getSettings().activeProjectId, null);
    assert.equal(store.removeProject(project.id), false);
    } finally { store.close(true); }
    const reopened = open(directory, randomUUID());
    assert.equal(reopened.getSettings().density, 'compact'); assert.equal(reopened.listProjects().length, 49);
    assert.deepEqual(reopened.listRuns().map(run => run.outcome), ['RUNNING', 'CLEAN']);
    reopened.close(true);
  } finally {
    if (directory.startsWith(cache + sep)) rmSync(directory, { recursive: true, force: true });
  }
});
