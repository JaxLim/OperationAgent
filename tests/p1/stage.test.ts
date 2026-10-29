import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { readJson } from '../../scripts/p0-check.ts';
import { validateStage, validateFrozenFiles } from '../../scripts/p1-check.ts';
import type { StageEvidence } from '../../scripts/p1-check.ts';

const evidence = (): StageEvidence => {
  const ci = readJson('docs/evidence/p1/win32-x64/integration.json');
  const smoke = readJson('docs/evidence/p1/win32-x64/installed-smoke.json');
  return { workerFixture: String(ci.workerFixture), installedSmoke: smoke.passed === true, installedTarget: String(smoke.target) };
};

test('the P1 completion claims are backed by committed Windows x64 runner evidence and grant no production capability', () => {
  assert.equal(evidence().workerFixture, 'PASS'); assert.equal(evidence().installedSmoke, true);
  assert.deepEqual(validateStage(readJson('build/p1-status.json'), evidence()), []);
});

test('stage advancement, missing authorization and fabricated qualification fail closed', () => {
  for (const change of [
    { stopAfter: 'P2' }, { authorizedStages: ['P1.0', 'P1.1', 'P1.2', 'P1.3', 'P1.4', 'P1.5', 'P1.6', 'P1.7', 'P2'] },
    { authorization: null }, { productionWorkerQualified: true }, { agentReady: true },
    { integrationTests: 'PASS' }, { p1TotalExit: 'PASS' }, { installedSmokeTests: 'PASS' }, { workerFixture: 'PASS' }, { platformCapabilities: {} },
  ]) assert.notEqual(validateStage({ ...readJson('build/p1-status.json'), ...change }, evidence()).length, 0);
  const stage = readJson('build/p1-status.json');
  const capabilities = stage.platformCapabilities as Record<string, Record<string, unknown>>;
  assert.notEqual(validateStage({ ...stage, platformCapabilities: { ...capabilities, 'win32-x64': { ...capabilities['win32-x64'], workerIsolation: 'verified' } } }, evidence()).length, 0);
});

test('completion claims without evidence, or with failed evidence, are rejected', () => {
  const stage = readJson('build/p1-status.json');
  assert.notEqual(validateStage(stage).length, 0);
  assert.notEqual(validateStage(stage, { ...evidence(), workerFixture: 'FAILED' }).length, 0);
  assert.notEqual(validateStage(stage, { ...evidence(), workerFixture: 'BLOCKED_NOT_AUTHORIZED_ON_THIS_HOST' }).length, 0);
  assert.notEqual(validateStage(stage, { ...evidence(), installedSmoke: false }).length, 0);
  assert.notEqual(validateStage(stage, { ...evidence(), installedTarget: 'darwin-arm64' }).length, 0);
  // Without a passing fixture the only honest state is BLOCKED with P1.4/P1.5/P1.7 not implemented.
  const blocked = { ...stage, workerFixture: 'BLOCKED', p1TotalExit: 'NOT_RUN',
    implementation: { ...(stage.implementation as Record<string, unknown>), 'P1.4': 'blocked', 'P1.5': 'in-progress', 'P1.7': 'in-progress' } };
  assert.deepEqual(validateStage(blocked, { ...evidence(), workerFixture: 'FAILED' }), []);
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
