import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readJson } from '../../scripts/p0-check.ts';
import { validateAgentStage } from '../../scripts/agent-check.ts';
import { SEC_W01_ENV, SEC_W01_ENV_AFTER_CHANNEL, evaluateSecW01 } from '../../scripts/sec-w01-rules.ts';

const stage = () => readJson('build/agent-status.json');
const source = 'a'.repeat(40);
/** A complete, passing runner report: every rule satisfied, every network control reached. */
function report(): Record<string, unknown> {
  const denied = ['file.read.workspace', 'file.read.profile', 'file.read.temp', 'file.read.repo-git-config', 'file.list.profile', 'file.list.workspace',
    'file.list.users', 'file.write.workspace', 'file.write.profile', 'file.write.temp', 'file.write.runtime', 'proc.spawn', 'proc.kill-sibling',
    'native.dlopen-parent-addon', 'net.tcp4.public', 'net.tcp6.public', 'net.udp4.dns-public'];
  return { check: 'SEC_W01_WIN32_X64', source, exit: { cleanup: 'confirmed' },
    baseline: { appContainer: true, capabilityCount: 0, integrityRid: 0x1000, noChildProcessCreation: true, verifiedBeforeResume: true,
      inheritedHandles: 'rpc-pipe,nul-read,stderr-pipe' },
    prepared: { parentAddonExists: true, controls: { tcp4Public: 'REACHABLE', tcp6Public: 'REACHABLE', udp4Dns: 'REACHABLE', dns: 'REACHABLE',
      loopbackTcp4: 'REACHABLE', loopbackTcp6: 'REACHABLE', loopbackUdp4: 'REACHABLE' } },
    report: { envAtStart: SEC_W01_ENV, env: SEC_W01_ENV_AFTER_CHANNEL, results: { 'self.read-runtime': 'ALLOWED', 'native.exports': 'close,read,write',
      ...Object.fromEntries(denied.map(name => [name, 'DENIED'])), 'net.dns.lookup': 'ERROR:ENOTFOUND', 'net.tcp4.loopback': 'ERROR:ETIMEDOUT',
      'net.tcp6.loopback': 'ERROR:ETIMEDOUT', 'net.udp4.loopback': 'SENT' } },
    observed: { hits: { tcp4: 0, tcp6: 0, udp4: 0 }, siblingAlive: true } };
}
const evidence = (overrides: { integration?: unknown; report?: unknown } = {}) =>
  ({ 'win32-x64': { integration: { secW01: 'PASS', source }, report: report(), ...overrides } });
const qualified = () => ({ ...stage(), secW01: { ...(stage().secW01 as object), 'win32-x64': 'PASS' }, productionWorkerQualified: true,
  milestones: { ...(stage().milestones as object), M1: 'implemented' } });
const withReport = (change: (value: Record<string, unknown>) => void) => { const value = report(); change(value); return value; };
const results = (value: Record<string, unknown>) => (value.report as { results: Record<string, unknown> }).results;
const controls = (value: Record<string, unknown>) => (value.prepared as { controls: Record<string, unknown> }).controls;

test('the recorded M1–M4 authorization is valid and claims no Worker qualification yet', () => {
  assert.deepEqual(validateAgentStage(stage(), {}), []);
});

test('altered authorization, scope growth and unproven claims fail closed', () => {
  const milestones = stage().milestones as Record<string, unknown>;
  for (const change of [
    { authorizedMilestones: ['M1', 'M2', 'M3', 'M4', 'M5'] }, { authorization: { ...(stage().authorization as object), modelProvider: 'other' } },
    { authorization: { ...(stage().authorization as object), quotes: ['Yes, use Claude'] } },
    { secW01: { ...(stage().secW01 as object), 'win32-x64': 'PASS' } }, { productionWorkerQualified: true }, { agentReady: true },
    { milestones: { ...milestones, M1: 'implemented' } }, { milestones: { ...milestones, M5: 'not-started' } },
  ]) assert.notEqual(validateAgentStage({ ...stage(), ...change }, {}).length, 0, JSON.stringify(change).slice(0, 80));
});

test('a complete passing runner report with matching provenance can qualify the Windows Worker', () => {
  assert.deepEqual(evaluateSecW01(report()), []);
  assert.deepEqual(validateAgentStage(qualified(), evidence()), []);
  // Windows evidence never qualifies another platform, and readiness still needs the M2 agent loop.
  assert.notEqual(validateAgentStage({ ...qualified(), secW01: { ...(qualified().secW01 as object), 'linux-x64': 'PASS' } }, evidence()).length, 0);
  assert.notEqual(validateAgentStage({ ...qualified(), agentReady: true }, evidence()).length, 0);
});

test('a PASS verdict without a valid raw report, or from another run, cannot qualify the Worker', () => {
  // Reported by review: an integration PASS next to an empty or failing report must not be enough.
  assert.notEqual(validateAgentStage(qualified(), evidence({ integration: { secW01: 'PASS' }, report: { report: null } })).length, 0);
  assert.notEqual(validateAgentStage(qualified(), evidence({ report: withReport(value => { (value.observed as { siblingAlive: boolean }).siblingAlive = false; }) })).length, 0);
  assert.notEqual(validateAgentStage(qualified(), evidence({ integration: { secW01: 'FAILED', source } })).length, 0);
  assert.notEqual(validateAgentStage(qualified(), evidence({ integration: { secW01: 'PASS', source: 'b'.repeat(40) } })).length, 0);
  assert.notEqual(validateAgentStage(qualified(), {}).length, 0);
});

test('unreachable targets and failed host controls are inconclusive, never denials', () => {
  for (const change of [
    (value: Record<string, unknown>) => { results(value)['net.tcp6.public'] = 'UNREACHABLE:ENETUNREACH'; },
    (value: Record<string, unknown>) => { controls(value).tcp6Public = 'ERROR:ENETUNREACH'; },
    (value: Record<string, unknown>) => { controls(value).dns = 'TIMEOUT'; },
    (value: Record<string, unknown>) => { controls(value).loopbackTcp4 = 'TIMEOUT'; },
    (value: Record<string, unknown>) => { results(value)['net.udp4.dns-public'] = 'NO_RESPONSE'; },
    (value: Record<string, unknown>) => { results(value)['net.tcp4.public'] = 'TIMEOUT'; },
    (value: Record<string, unknown>) => { (value.observed as { hits: Record<string, number> }).hits.udp4 = 1; },
    (value: Record<string, unknown>) => { results(value)['file.read.profile'] = 'ALLOWED'; },
    (value: Record<string, unknown>) => { results(value)['native.exports'] = ''; },
    (value: Record<string, unknown>) => { (value.report as { envAtStart: string[] }).envAtStart = [...SEC_W01_ENV, 'GITHUB_TOKEN']; },
  ]) assert.notEqual(evaluateSecW01(withReport(change)).length, 0, change.toString().slice(0, 90));
});
