import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readJson } from '../../scripts/p0-check.ts';
import { validateAgentStage } from '../../scripts/agent-check.ts';

const stage = () => readJson('build/agent-status.json');
const passed = { 'win32-x64': { integration: 'PASS', report: true } };

test('the recorded M1–M4 authorization is valid and claims no Worker qualification yet', () => {
  assert.deepEqual(validateAgentStage(stage(), {}), []);
});

test('altered authorization, scope growth and unproven claims fail closed', () => {
  const secW01 = stage().secW01 as Record<string, unknown>;
  const milestones = stage().milestones as Record<string, unknown>;
  for (const change of [
    { authorizedMilestones: ['M1', 'M2', 'M3', 'M4', 'M5'] }, { authorization: { ...(stage().authorization as object), modelProvider: 'other' } },
    { authorization: { ...(stage().authorization as object), quotes: ['Yes, use Claude'] } },
    { secW01: { ...secW01, 'win32-x64': 'PASS' } }, { productionWorkerQualified: true }, { agentReady: true },
    { milestones: { ...milestones, M1: 'implemented' } }, { milestones: { ...milestones, M5: 'not-started' } },
  ]) assert.notEqual(validateAgentStage({ ...stage(), ...change }, {}).length, 0, JSON.stringify(change).slice(0, 80));
});

test('SEC-W01 PASS and Worker qualification need committed passing runner evidence', () => {
  const secW01 = { ...(stage().secW01 as Record<string, unknown>), 'win32-x64': 'PASS' };
  const qualified = { ...stage(), secW01, productionWorkerQualified: true, milestones: { ...(stage().milestones as object), M1: 'implemented' } };
  assert.deepEqual(validateAgentStage(qualified, passed), []);
  assert.notEqual(validateAgentStage(qualified, {}).length, 0);
  assert.notEqual(validateAgentStage(qualified, { 'win32-x64': { integration: 'FAILED', report: true } }).length, 0);
  assert.notEqual(validateAgentStage(qualified, { 'win32-x64': { integration: 'PASS', report: false } }).length, 0);
  // Windows evidence never qualifies another platform.
  assert.notEqual(validateAgentStage({ ...qualified, secW01: { ...secW01, 'linux-x64': 'PASS' } }, passed).length, 0);
  // Agent readiness additionally needs the M2 agent loop.
  assert.notEqual(validateAgentStage({ ...qualified, agentReady: true }, passed).length, 0);
});
