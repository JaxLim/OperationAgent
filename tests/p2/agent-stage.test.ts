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

/** The runner evidence actually committed for Windows x64. */
const committed = () => ({ 'win32-x64': { integration: readJson('docs/evidence/m1/win32-x64/integration.json'),
  report: readJson('docs/evidence/m1/win32-x64/sec-w01.json') } });

test('the recorded authorization and Windows qualification are backed by the committed runner evidence', () => {
  assert.deepEqual(evaluateSecW01(committed()['win32-x64'].report), []);
  assert.deepEqual(validateAgentStage(stage(), committed()), []);
  // The same claims without the committed evidence are rejected.
  assert.notEqual(validateAgentStage(stage(), {}).length, 0);
});

test('altered authorization, scope growth and unproven claims fail closed', () => {
  const milestones = stage().milestones as Record<string, unknown>;
  for (const change of [
    { authorizedMilestones: ['M1', 'M2', 'M3', 'M4', 'M5'] }, { authorization: { ...(stage().authorization as object), modelProvider: 'other' } },
    { authorization: { ...(stage().authorization as object), quotes: ['Yes, use Claude'] } },
    { secW01: { ...(stage().secW01 as object), 'linux-x64': 'PASS' } }, { agentReady: true },
    { milestones: { ...milestones, M1: 'in-progress' } }, { milestones: { ...milestones, M5: 'not-started' } },
  ]) assert.notEqual(validateAgentStage({ ...stage(), ...change }, committed()).length, 0, JSON.stringify(change).slice(0, 80));
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

test('silent UDP egress counts only with an audited WFP drop of exactly that datagram', () => {
  const silent = (wfp: unknown[], wfpAudit = true) => withReport(value => {
    results(value)['net.udp4.dns-public'] = 'NO_RESPONSE';
    Object.assign(value.observed as object, { wfpAudit, wfp });
  });
  const drop = { id: 5152, direction: 'outbound', destination: '1.1.1.1', port: 53, protocol: 17 };
  assert.deepEqual(evaluateSecW01(silent([drop])), []);
  assert.deepEqual(evaluateSecW01(silent([{ ...drop, id: 5157 }])), []);
  for (const wfp of [[], [{ ...drop, direction: 'inbound' }], [{ ...drop, port: 443 }], [{ ...drop, protocol: 6 }], [{ ...drop, destination: '8.8.8.8' }],
    [{ ...drop, id: 5156 }]]) assert.notEqual(evaluateSecW01(silent(wfp)).length, 0, JSON.stringify(wfp));
  assert.notEqual(evaluateSecW01(silent([drop], false)).length, 0, 'events without an enabled audit are not evidence');
});

test('without an IPv6 internet path, IPv6 denial needs a routed target and an audited WFP connection block', () => {
  const routed = (change: (value: Record<string, unknown>) => void = () => {}) => withReport(value => {
    controls(value).tcp6Public = 'TIMEOUT';
    Object.assign(value.prepared as object, { ipv6Route: true });
    Object.assign(value.observed as object, { wfpAudit: true,
      wfp: [{ id: 5157, direction: 'outbound', destination: '2606:4700:4700::1111', port: 443, protocol: 6 }] });
    change(value);
  });
  assert.deepEqual(evaluateSecW01(routed()), []);
  for (const change of [
    (value: Record<string, unknown>) => { Object.assign(value.prepared as object, { ipv6Route: false }); },
    (value: Record<string, unknown>) => { controls(value).tcp6Public = 'ERROR:ENETUNREACH'; },
    (value: Record<string, unknown>) => { Object.assign(value.observed as object, { wfp: [] }); },
    (value: Record<string, unknown>) => { Object.assign(value.observed as object, { wfpAudit: false }); },
    (value: Record<string, unknown>) => { Object.assign(value.observed as object, { wfp: [{ id: 5157, direction: 'outbound', destination: '2606:4700:4700::1111', port: 80, protocol: 6 }] }); },
    (value: Record<string, unknown>) => { results(value)['net.tcp6.public'] = 'TIMEOUT'; },
    (value: Record<string, unknown>) => { results(value)['net.tcp6.public'] = 'UNREACHABLE:ENETUNREACH'; },
  ]) assert.notEqual(evaluateSecW01(routed(change)).length, 0, change.toString().slice(0, 90));
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
