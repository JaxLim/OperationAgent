import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
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

test('failed SQL migrations roll back and altered migration history is rejected on reopen', () => {
  const cache = resolve('.cache'); mkdirSync(cache, { recursive: true });
  const directory = mkdtempSync(resolve(cache, 'migration-'));
  const migrations = resolve(directory, 'migrations'); mkdirSync(migrations);
  const sql = readFileSync('apps/server/migrations/001-control-plane.sql', 'utf8');
  const file = resolve(migrations, '001-control-plane.sql');
  const database = resolve(directory, 'data');
  try {
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
