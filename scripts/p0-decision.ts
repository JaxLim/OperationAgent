import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const decisionPath = 'build/p0-decision.json';
export const approvalPath = 'docs/adr/approvals/ADR-WIN-001-r1.json';
export const decisionDocuments = ['docs/adr/ADR-WIN-001.md', 'docs/adr/ADR-WIN-001-normative.patch', 'docs/P0-REVIEW.md', 'docs/ACCEPTANCE.md'] as const;
export const evidenceDirectory = 'experiments/windows-worker-isolation/evidence/2026-10-24T04-52-17-103Z-5370b70e/';
export const evidenceNames = ['environment.json', 'lowbox-permissions.json', 'lowbox-hang.json', 'lowbox-parent-kill.json', 'lowbox-main-kill.json', 'lowbox-disconnect.json', 'lowbox-node-spawn.json', 'appcontainer-permissions.json'] as const;
export const decisionPolicy = {
  windowsCreation: 'express-native-direct-child', windowsTransport: 'win32-inherited-pipe-OWIP-1-jsonrpc-2.0',
  otherPlatforms: 'fork-node-ipc', p1Worker: 'isolated-fixture-only', productionWorkerGate: 'SEC-W01-before-P3',
  osIsolation: 'required-before-first-instruction', publicWindowsApisOnly: true, unsafeFallback: false,
  productionCapabilityState: 'unverified',
} as const;
export type DecisionReader = (path: string) => string | undefined;
export interface DecisionAssessment {
  packageSha256: string;
  approval: 'pending' | 'approved' | 'invalid';
  specifications: 'original' | 'updated' | 'invalid';
  evidenceVerified: boolean;
  errors: string[];
}
type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected decision object');
  return value as RecordValue;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Expected decision array');
  return value;
}
function json(value: string | undefined): RecordValue {
  if (value === undefined) throw new Error('Required decision file missing');
  return record(JSON.parse(value) as unknown);
}
export const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const hashPattern = /^[a-f0-9]{64}$/;
const sameKeys = (value: RecordValue, keys: readonly string[]): boolean => Object.keys(value).sort().join('|') === [...keys].sort().join('|');

// Pure reader injection lets tests exercise approved fixtures without writing a real approval.
export function assessDecision(read: DecisionReader): DecisionAssessment {
  const result: DecisionAssessment = { packageSha256: '', approval: 'pending', specifications: 'invalid', evidenceVerified: false, errors: [] };
  const need = (condition: boolean, message: string): void => { if (!condition) result.errors.push(message); };
  try {
    const packageText = read(decisionPath); const decision = json(packageText);
    result.packageSha256 = digest(packageText!);
    need(decision.schemaVersion === 1 && decision.id === 'ADR-WIN-001' && decision.revision === 'r1', 'P0_DECISION_ID_OR_REVISION');
    need(decision.approvalFile === approvalPath, 'P0_APPROVAL_PATH');
    need(decision.evidenceCommit === 'c44d8c9d5c068c84e94053f3b624c0144694c3cb', 'P0_EVIDENCE_PROVENANCE');
    const policy = record(decision.policy);
    need(sameKeys(policy, Object.keys(decisionPolicy)) && Object.entries(decisionPolicy).every(([key, value]) => policy[key] === value), 'P0_DECISION_POLICY_CHANGED');
    const documents = record(decision.documents);
    need(sameKeys(documents, decisionDocuments), 'P0_DECISION_DOCUMENT_SET');
    for (const path of decisionDocuments) {
      const content = read(path);
      need(typeof documents[path] === 'string' && hashPattern.test(documents[path]), `P0_DOCUMENT_HASH_MISSING: ${path}`);
      need(content !== undefined && digest(content) === documents[path], `P0_DOCUMENT_HASH_MISMATCH: ${path}`);
    }
    const evidence = record(decision.evidence);
    const evidencePaths = evidenceNames.map(name => evidenceDirectory + name);
    need(sameKeys(evidence, evidencePaths), 'P0_EVIDENCE_SET');
    for (const path of evidencePaths) {
      const content = read(path);
      need(typeof evidence[path] === 'string' && hashPattern.test(evidence[path]), `P0_EVIDENCE_HASH_MISSING: ${path}`);
      need(content !== undefined && digest(content) === evidence[path], `P0_EVIDENCE_HASH_MISMATCH: ${path}`);
    }
    const evidenceErrorsBefore = result.errors.length;
    const permission = json(read(evidenceDirectory + 'lowbox-permissions.json'));
    const events = array(permission.events).map(record);
    const launch = record(events.find(event => event.kind === 'worker-launched')?.data);
    const before = record(launch.beforeResume);
    need(permission.mode === 'lowbox' && permission.scenario === 'permissions' && permission.failure === null, 'P0_FEASIBILITY_RUN_FAILED');
    need(launch.creatorPid === permission.hostPid && before.ppid === permission.hostPid && before.pid === permission.workerPid, 'P0_DIRECT_PARENT_NOT_PROVEN');
    need(launch.suspendedBeforeVerification === true && launch.jobAssignedAtCreation === true && before.appContainer === true && before.integrityRid === 4096 && before.capabilityCount === 0, 'P0_PRESTART_ISOLATION_NOT_PROVEN');
    const messages = events.filter(event => event.kind === 'worker-message').map(event => record(event.data));
    const hello = record(messages.find(message => message.id === 1)?.result);
    need(hello.challenge === 'challenge-1' && hello.pid === permission.workerPid && messages.every(message => message.runId === permission.runId), 'P0_LEGAL_RPC_NOT_PROVEN');
    const early = record(record(messages.find(message => message.method === 'ready')?.params).early);
    const later = record(messages.find(message => message.id === 2)?.result);
    for (const probe of [early, later]) {
      const identity = record(probe.identity); const files = array(probe.files).map(record);
      need(identity.appContainer === true && identity.ppid === permission.hostPid && probe.rpcAvailable === true && probe.nodePermissionEnabled === false, 'P0_OS_AND_RPC_NOT_SIMULTANEOUS');
      need(files.length === 4 && ['workspace', 'database', 'credentials', 'outside-workspace'].every(label => files.some(file => file.label === label)), 'P0_FILE_PROBE_SET');
      need(files.every(file => ['nativeRead', 'nativeWrite'].every(key => record(file[key]).allowed === false && record(file[key]).error === 5)), 'P0_FILE_DENIAL_NOT_PROVEN');
      need(record(probe.externalTcp).allowed === false && record(probe.externalTcp).error === 10013, 'P0_TCP_DENIAL_NOT_PROVEN');
    }
    for (const name of ['lowbox-hang.json', 'lowbox-parent-kill.json', 'lowbox-main-kill.json', 'lowbox-disconnect.json']) {
      const run = json(read(evidenceDirectory + name));
      need(run.workerAliveAfter === false && run.expressAliveAfter === false && run.failure === null && array(run.events).some(event => record(event).kind === 'scenario'), `P0_CLEANUP_NOT_PROVEN: ${name}`);
    }
    // Retain contrary evidence: these are deferred to their gates, never relabelled PASS.
    const spawn = json(read(evidenceDirectory + 'lowbox-node-spawn.json'));
    need(typeof spawn.failure === 'string' && spawn.failure.includes('NODE_SPAWN_PROBE_TIMEOUT_UNKNOWN'), 'P0_SPAWN_UNKNOWN_EVIDENCE_LOST');
    const publicCreate = json(read(evidenceDirectory + 'appcontainer-permissions.json'));
    need(publicCreate.workerPid === 0 && typeof publicCreate.failure === 'string' && publicCreate.failure.includes('win32=2'), 'P0_PUBLIC_CREATION_FAILURE_EVIDENCE_LOST');
    const environment = json(read(evidenceDirectory + 'environment.json'));
    need(environment.batch === '2026-10-24T04-52-17-103Z-5370b70e' && environment.node === 'v24.22.1' && environment.nodeAbi === '137' && environment.arch === 'x64', 'P0_EVIDENCE_ENVIRONMENT_CHANGED');
    const sources = record(environment.sourceHashes);
    need(sameKeys(sources, ['native/probe.cc', 'src/contracts.ts', 'src/native.ts', 'src/worker.ts', 'src/host.ts', 'src/run.ts', 'src/wire.ts', 'src/evaluate.ts', 'src/supervisor.ts', 'package.json', 'pnpm-lock.yaml', 'build.mjs']), 'P0_EVIDENCE_SOURCE_SET');
    for (const [name, hash] of Object.entries(sources)) {
      if (name.includes('\\') || name.includes(':') || name.startsWith('/') || name.split('/').includes('..')) throw new Error('P0_UNSAFE_EVIDENCE_SOURCE_PATH');
      const source = read('experiments/windows-worker-isolation/' + name);
      need(source !== undefined && digest(source) === hash, `P0_EVIDENCE_SOURCE_CHANGED: ${name}`);
    }
    const controls = record(environment.positiveControls); const controlFiles = array(controls.files).map(record);
    need(controlFiles.length === 4 && ['workspace', 'database', 'credentials', 'outside-workspace'].every(label => controlFiles.some(file => file.label === label)) &&
      controlFiles.every(file => ['read', 'write'].every(key => record(file[key]).allowed === true && record(file[key]).error === 0)), 'P0_FILE_CONTROLS_NOT_PROVEN');
    need(record(controls.externalTcp).allowed === false && record(controls.externalTcp).error === 10060, 'P0_NETWORK_CONTROL_LIMITATION_LOST');
    result.evidenceVerified = result.errors.length === evidenceErrorsBefore && !result.errors.some(error => error.startsWith('P0_EVIDENCE_'));
    const specifications = record(decision.specifications);
    need(sameKeys(specifications, ['ARCHITECTURE.md', 'AGENTS.md']), 'P0_SPECIFICATION_SET');
    const states = ['ARCHITECTURE.md', 'AGENTS.md'].map(path => {
      const expected = record(specifications[path]); const content = read(path);
      need(typeof expected.before === 'string' && hashPattern.test(expected.before) && typeof expected.after === 'string' && hashPattern.test(expected.after) && expected.before !== expected.after, `P0_SPECIFICATION_REVISIONS: ${path}`);
      const actual = content === undefined ? '' : digest(content);
      return actual === expected.after ? 'updated' : actual === expected.before ? 'original' : 'invalid';
    });
    result.specifications = states.every(state => state === 'updated') ? 'updated' : states.every(state => state === 'original') ? 'original' : 'invalid';
    need(result.specifications !== 'invalid', 'P0_SPECIFICATIONS_MIXED_OR_CHANGED');
    const approvalText = read(approvalPath);
    if (approvalText !== undefined) {
      const approval = json(approvalText); const source = record(approval.source);
      const valid = approval.id === 'ADR-WIN-001' && approval.revision === 'r1' && approval.outcome === 'approved' &&
        approval.decisionPackageSha256 === result.packageSha256 && approval.approvedBy === 'project-owner' &&
        Array.isArray(approval.approvedChanges) && approval.approvedChanges.join('|') === 'D1|D2|D3|D4|D5' &&
        typeof approval.approvedAt === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(approval.approvedAt) && Number.isFinite(Date.parse(approval.approvedAt)) &&
        source.kind === 'user-message' && typeof source.reference === 'string' && source.reference.startsWith('codex://threads/') &&
        typeof source.quote === 'string' && source.quote.trim().length > 0;
      result.approval = valid ? 'approved' : 'invalid';
      need(valid, 'P0_APPROVAL_INVALID_OR_STALE');
    }
    need(result.specifications !== 'updated' || result.approval === 'approved', 'P0_SPECIFICATIONS_UPDATED_WITHOUT_APPROVAL');
  } catch (error) {
    result.errors.push(`P0_DECISION_INVALID: ${error instanceof Error ? error.message : String(error)}`);
  }
  return result;
}

export function inspectDecision(root: string): DecisionAssessment {
  return assessDecision(path => {
    const file = resolve(root, path);
    return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
  });
}
