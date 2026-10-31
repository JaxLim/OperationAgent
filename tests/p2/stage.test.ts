import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readJson } from '../../scripts/p0-check.ts';
import { validateP2Stage } from '../../scripts/p2-check.ts';

const p2 = () => readJson('build/p2-status.json');
const p1 = () => readJson('build/p1-status.json');
const all = { 'P2.0': true, 'P2.1': true, 'P2.2': true, 'P2.3': true };

test('the recorded P2 authorization, scope and claims are valid and grant no production capability', () => {
  assert.deepEqual(validateP2Stage(p2(), p1(), all), []);
});

test('scope advancement, altered authorization and fabricated claims fail closed', () => {
  const implementation = p2().implementation as Record<string, unknown>;
  for (const change of [
    { stopAfter: 'P3a' }, { authorizedStages: ['P2.0', 'P2.1', 'P2.2', 'P2.3', 'P3a'] }, { authorization: null },
    { authorization: { ...(p2().authorization as object), quote: 'Authorize P2' } },
    { authorization: { ...(p2().authorization as object), date: '2026-10-29' } },
    { agentReady: true }, { productionWorkerQualified: true }, { p2TotalExit: 'PASS_WIN32_X64' },
    { implementation: { ...implementation, 'P2.2': 'in-progress' } }, { implementation: { ...implementation, 'P2.1': 'in-progress' } },
    { implementation: { ...implementation, 'P2.0': 'in-progress' } }, { implementation: { ...implementation, 'P2.4': 'not-started' } },
    { dependsOn: { file: 'build/p1-status.json', p1TotalExit: 'NOT_RUN' } }, { platformCapabilities: {} },
  ]) assert.notEqual(validateP2Stage({ ...p2(), ...change }, p1(), all).length, 0, JSON.stringify(change).slice(0, 80));
  const capabilities = p2().platformCapabilities as Record<string, Record<string, unknown>>;
  assert.notEqual(validateP2Stage({ ...p2(), platformCapabilities: { ...capabilities, 'win32-x64': { ...capabilities['win32-x64'], read: 'verified' } } },
    p1(), all).length, 0);
});

test('P2 requires the evidence-backed P1 exit and the files behind each completion claim', () => {
  assert.notEqual(validateP2Stage(p2(), { ...p1(), p1TotalExit: 'NOT_RUN' }, all).length, 0);
  assert.notEqual(validateP2Stage(p2(), p1(), { ...all, 'P2.0': false }).length, 0);
  assert.notEqual(validateP2Stage(p2(), p1(), { ...all, 'P2.1': false }).length, 0);
  assert.notEqual(validateP2Stage(p2(), p1(), { ...all, 'P2.2': false }).length, 0);
  assert.notEqual(validateP2Stage(p2(), p1(), { ...all, 'P2.3': false }).length, 0);
  const pending = { ...p2(), implementation: { 'P2.0': 'in-progress', 'P2.1': 'in-progress', 'P2.2': 'in-progress', 'P2.3': 'not-started' } };
  assert.deepEqual(validateP2Stage(pending, p1(), { 'P2.0': false, 'P2.1': false, 'P2.2': false, 'P2.3': false }), []);
});
