import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { object, readJson, requireP0Exit } from '../../scripts/p0-check.ts';
import { approvalPath, assessDecision, decisionDocuments, decisionPath, digest, evidenceDirectory, evidenceNames, inspectDecision } from '../../scripts/p0-decision.ts';
import type { JsonObject } from '../../scripts/p0-check.ts';

type Files = Map<string, string>;
const stringify = (value: unknown): string => JSON.stringify(value, null, 2) + '\n';
const parse = (files: Files, path: string): JsonObject => object(JSON.parse(files.get(path)!) as unknown);
const assess = (files: Files) => assessDecision(path => files.get(path));
const updatedText = (text: string): string => text + '\nTEST ONLY: virtual approved specification revision.\n';

// All approvals and changed specifications below exist only in memory.
// The test suite must never create a real approved receipt on disk.
function fixture(): Files {
  const paths = [decisionPath, ...decisionDocuments, 'ARCHITECTURE.md', 'AGENTS.md', ...evidenceNames.map(name => evidenceDirectory + name)];
  const files = new Map(paths.map(path => [path, readFileSync(path, 'utf8')]));
  const environment = parse(files, evidenceDirectory + 'environment.json');
  for (const name of Object.keys(object(environment.sourceHashes))) {
    const path = 'experiments/windows-worker-isolation/' + name;
    files.set(path, readFileSync(path, 'utf8'));
  }
  // Normalize the synthetic before/after pair even after the real ADR is accepted.
  const decision = parse(files, decisionPath);
  for (const path of ['ARCHITECTURE.md', 'AGENTS.md']) {
    const text = files.get(path)!;
    object(decision.specifications)[path] = { before: digest(text), after: digest(updatedText(text)) };
  }
  files.set(decisionPath, stringify(decision));
  return files;
}
function updateSpecifications(files: Files): void {
  for (const path of ['ARCHITECTURE.md', 'AGENTS.md']) files.set(path, updatedText(files.get(path)!));
}
function approveFixture(files: Files): void {
  files.set(approvalPath, stringify({ id: 'ADR-WIN-001', revision: 'r1', outcome: 'approved',
    decisionPackageSha256: digest(files.get(decisionPath)!), approvedBy: 'project-owner',
    approvedChanges: ['D1', 'D2', 'D3', 'D4', 'D5'], approvedAt: '2026-10-24T00:00:00.000Z',
    source: { kind: 'user-message', reference: 'codex://threads/test-only-not-a-real-approval', quote: 'TEST ONLY: synthetic approval, never written to disk.' },
  }));
}
function frozenStatus(): JsonObject {
  return { ...readJson('build/p0-status.json'), status: 'frozen', blockers: [] };
}
function mutateEvidence(files: Files, name: string, change: (value: JsonObject) => void): void {
  const path = evidenceDirectory + name; const value = parse(files, path);
  change(value); files.set(path, stringify(value));
  const decision = parse(files, decisionPath);
  object(decision.evidence)[path] = digest(files.get(path)!);
  files.set(decisionPath, stringify(decision));
}
function events(value: JsonObject): JsonObject[] {
  assert.ok(Array.isArray(value.events));
  return value.events.map(object);
}

test('the actual review package retains valid raw feasibility evidence', () => {
  const result = inspectDecision(process.cwd());
  assert.deepEqual(result.errors, []);
  assert.equal(result.evidenceVerified, true);
});

test('prepared evidence with a frozen status still requires explicit approval', () => {
  const result = assess(fixture());
  assert.deepEqual(result.errors, []);
  assert.equal(result.approval, 'pending');
  assert.equal(result.specifications, 'original');
  assert.throws(() => requireP0Exit(frozenStatus(), result), /P0_DECISION_NOT_APPROVED/);
});

test('approved decision with unapplied specifications cannot exit P0', () => {
  const files = fixture(); approveFixture(files);
  assert.throws(() => requireP0Exit(frozenStatus(), assess(files)), /P0_SPECIFICATIONS_NOT_UPDATED/);
});

test('specifications cannot be applied before approval', () => {
  const files = fixture(); updateSpecifications(files);
  assert.ok(assess(files).errors.includes('P0_SPECIFICATIONS_UPDATED_WITHOUT_APPROVAL'));
});

test('matching approval, specifications and evidence permit architecture exit only', () => {
  const files = fixture(); updateSpecifications(files); approveFixture(files);
  const result = assess(files);
  assert.deepEqual(result.errors, []);
  assert.doesNotThrow(() => requireP0Exit(frozenStatus(), result));
  for (const platform of Object.values(object(frozenStatus().platformCapabilities))) {
    assert.ok(Object.values(object(platform)).every(value => value === 'unverified'));
  }
});

test('a previous approval does not authorize changed decision package bytes', () => {
  const files = fixture(); approveFixture(files);
  files.set(decisionPath, files.get(decisionPath)! + ' ');
  assert.ok(assess(files).errors.includes('P0_APPROVAL_INVALID_OR_STALE'));
});

test('missing or changed decision documents invalidate approval evidence', () => {
  for (const path of decisionDocuments) {
    const files = fixture(); updateSpecifications(files); approveFixture(files);
    files.delete(path);
    assert.ok(assess(files).errors.some(error => error.startsWith('P0_DOCUMENT_HASH_MISMATCH')));
    assert.throws(() => requireP0Exit(frozenStatus(), assess(files)), /P0_DECISION_EVIDENCE_INVALID/);
  }
});

test('missing, empty and tampered raw evidence cannot be replaced by a green summary', () => {
  for (const name of evidenceNames) {
    for (const replacement of [undefined, '', '{"passed":true}']) {
      const files = fixture(); const path = evidenceDirectory + name;
      if (replacement === undefined) files.delete(path); else files.set(path, replacement);
      assert.ok(assess(files).errors.length > 0, name);
      assert.equal(assess(files).evidenceVerified, false, name);
    }
  }
});

test('rehashed evidence must still prove real parentage and pre-instruction isolation', () => {
  for (const field of ['ppid', 'appContainer', 'integrityRid', 'capabilityCount']) {
    const files = fixture();
    mutateEvidence(files, 'lowbox-permissions.json', run => {
      const launch = object(events(run).find(event => event.kind === 'worker-launched')!.data);
      object(launch.beforeResume)[field] = field === 'appContainer' ? false : -1;
    });
    assert.equal(assess(files).evidenceVerified, false, field);
  }
});

test('OS-denied file access must coexist with the legitimate RPC channel', () => {
  const files = fixture();
  mutateEvidence(files, 'lowbox-permissions.json', run => {
    const ready = events(run).find(event => event.kind === 'worker-message' && object(event.data).method === 'ready')!;
    object(object(object(ready.data).params).early).rpcAvailable = false;
  });
  assert.ok(assess(files).errors.includes('P0_OS_AND_RPC_NOT_SIMULTANEOUS'));
});

test('surviving processes invalidate cleanup evidence even with matching hashes', () => {
  for (const name of ['lowbox-hang.json', 'lowbox-parent-kill.json', 'lowbox-main-kill.json', 'lowbox-disconnect.json']) {
    const files = fixture(); mutateEvidence(files, name, run => { run.workerAliveAfter = true; });
    assert.ok(assess(files).errors.some(error => error.startsWith('P0_CLEANUP_NOT_PROVEN')), name);
  }
});

test('known public-creation and Node-spawn failures must not be relabelled PASS', () => {
  for (const name of ['appcontainer-permissions.json', 'lowbox-node-spawn.json']) {
    const files = fixture(); mutateEvidence(files, name, run => { run.failure = null; });
    assert.equal(assess(files).evidenceVerified, false, name);
  }
});

test('changed prototype sources and unsafe evidence source paths fail closed', () => {
  const files = fixture(); files.set('experiments/windows-worker-isolation/src/worker.ts', '// changed');
  assert.ok(assess(files).errors.some(error => error.startsWith('P0_EVIDENCE_SOURCE_CHANGED')));
  const traversal = fixture();
  mutateEvidence(traversal, 'environment.json', run => { object(run.sourceHashes)['../outside'] = digest('x'); });
  assert.ok(assess(traversal).errors.some(error => error.includes('P0_UNSAFE_EVIDENCE_SOURCE_PATH')));
});

test('deleting source provenance or successful file controls cannot manufacture feasibility', () => {
  for (const field of ['sourceHashes', 'positiveControls']) {
    const files = fixture(); mutateEvidence(files, 'environment.json', run => { run[field] = {}; });
    assert.equal(assess(files).evidenceVerified, false, field);
  }
});

test('mixed or unreviewed specification versions cannot exit P0', () => {
  const files = fixture(); approveFixture(files);
  files.set('AGENTS.md', updatedText(files.get('AGENTS.md')!));
  assert.ok(assess(files).errors.includes('P0_SPECIFICATIONS_MIXED_OR_CHANGED'));
  files.set('ARCHITECTURE.md', 'unreviewed replacement');
  assert.equal(assess(files).specifications, 'invalid');
});

test('partial, rejected or unsourced approval receipts are invalid', () => {
  for (const change of [
    (approval: JsonObject) => { approval.approvedChanges = ['D1']; },
    (approval: JsonObject) => { approval.outcome = 'rejected'; },
    (approval: JsonObject) => { object(approval.source).quote = ''; },
    (approval: JsonObject) => { object(approval.source).reference = 'self-approved'; },
    (approval: JsonObject) => { approval.approvedAt = 'not-a-date'; },
  ]) {
    const files = fixture(); approveFixture(files);
    const approval = parse(files, approvalPath); change(approval); files.set(approvalPath, stringify(approval));
    assert.equal(assess(files).approval, 'invalid');
  }
});

test('unsafe fallback and postponed production isolation cannot hide in metadata', () => {
  for (const [key, value] of [['unsafeFallback', true], ['productionWorkerGate', 'P4'], ['osIsolation', 'optional']]) {
    const files = fixture(); const decision = parse(files, decisionPath);
    object(decision.policy)[String(key)] = value; files.set(decisionPath, stringify(decision));
    assert.ok(assess(files).errors.includes('P0_DECISION_POLICY_CHANGED'));
  }
});
