import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { readJson } from '../../scripts/p0-check.ts';
import { validateStage, validateFrozenFiles } from '../../scripts/p1-check.ts';

test('P1.4 through P1.7 authorization preserves stage gates and denies production capabilities', () => {
  assert.deepEqual(validateStage(readJson('build/p1-status.json')), []);
});

test('stage advancement, missing authorization and fabricated qualification fail closed', () => {
  for (const change of [
    { stopAfter: 'P2' }, { authorizedStages: ['P1.0', 'P1.1', 'P1.2', 'P1.3', 'P1.4', 'P1.5', 'P1.6', 'P1.7', 'P2'] },
    { authorization: null }, { productionWorkerQualified: true }, { agentReady: true },
    { integrationTests: 'PASS' }, { p1TotalExit: 'PASS' }, { installedSmokeTests: 'PASS' }, { platformCapabilities: {} },
  ]) assert.notEqual(validateStage({ ...readJson('build/p1-status.json'), ...change }).length, 0);
});

test('continuous authorization does not mark unfinished stages implemented', () => {
  const stage = readJson('build/p1-status.json');
  const implementation = stage.implementation as Record<string, unknown>;
  for (const next of ['P1.4', 'P1.5', 'P1.6', 'P1.7']) {
    assert.notEqual(validateStage({ ...stage, implementation: { ...implementation, [next]: 'implemented' } }).length, 0);
  }
});

test('freeze verification detects changed, removed and missing historical evidence', () => {
  const original = new Map([['ARCHITECTURE.md', 'approved'], ['build/p0-status.json', 'frozen']]);
  assert.deepEqual(validateFrozenFiles(original, original), []);
  assert.notEqual(validateFrozenFiles(original, new Map([['ARCHITECTURE.md', 'edited']])).length, 0);
  assert.notEqual(validateFrozenFiles(new Map(), original).length, 0);
});

test('unchanged P0 checker still rejects the actual P1 application directories', () => {
  const result = spawnSync(process.execPath, ['scripts/p0-check.ts', '--require-frozen'], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /P0 must not create application skeleton: apps/);
  assert.match(result.stderr, /P0 must not create application skeleton: packages/);
});
