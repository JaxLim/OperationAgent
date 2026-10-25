import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readJson } from '../../scripts/p0-check.ts';
import { validateStage, validateFrozenFiles } from '../../scripts/p1-check.ts';

test('P1.0 and P1.1 authorization permits a skeleton without granting production capabilities', () => {
  assert.deepEqual(validateStage(readJson('build/p1-status.json')), []);
});

test('stage advancement, missing authorization and fabricated qualification fail closed', () => {
  for (const change of [
    { stopAfter: 'P1.7' }, { authorizedStages: ['P1.0', 'P1.1', 'P1.2'] },
    { authorization: null }, { productionWorkerQualified: true }, { agentReady: true },
    { integrationTests: 'PASS' }, { platformCapabilities: {} },
  ]) assert.notEqual(validateStage({ ...readJson('build/p1-status.json'), ...change }).length, 0);
});

test('freeze verification detects changed, removed and missing historical evidence', () => {
  const original = new Map([['ARCHITECTURE.md', 'approved'], ['build/p0-status.json', 'frozen']]);
  assert.deepEqual(validateFrozenFiles(original, original), []);
  assert.notEqual(validateFrozenFiles(original, new Map([['ARCHITECTURE.md', 'edited']])).length, 0);
  assert.notEqual(validateFrozenFiles(new Map(), original).length, 0);
});
