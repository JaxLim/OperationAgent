import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { object, readJson, requireP0Exit, validateBaseline } from '../../scripts/p0-check.ts';
import type { Baseline } from '../../scripts/p0-check.ts';

function baseline(): Baseline {
  return {
    manifest: readJson('package.json'),
    runtime: readJson('build/runtime-lock.json'),
    status: readJson('build/p0-status.json'),
    typescript: readJson('tsconfig.base.json'),
    builder: readJson('build/electron-builder.config.json'),
  };
}

test('P0 metadata quality may pass while architecture freeze is blocked', () => {
  const input = baseline();
  input.status.status = 'review-pending';
  assert.deepEqual(validateBaseline(input), []);
  assert.throws(() => requireP0Exit(input.status), /P0_NOT_FROZEN/);
});

test('application dependencies cannot silently enter P0', () => {
  const input = baseline();
  input.manifest.dependencies = { express: '5.3.0' };
  assert.ok(validateBaseline(input).some(x => x.includes('application dependencies')));
});

test('floating dependency versions and mismatched runtimes fail the gate', () => {
  const input = baseline();
  object(input.manifest.devDependencies).typescript = '^5.9.3';
  object(input.manifest.engines).node = '24.14.0';
  input.builder.electronVersion = '0.0.0';
  assert.equal(validateBaseline(input).length, 3);
});

test('strict mode and Renderer type separation cannot silently weaken', () => {
  const input = baseline();
  object(input.typescript.compilerOptions).strict = false;
  object(input.typescript.compilerOptions).types = ['node'];
  assert.equal(validateBaseline(input).length, 2);
});

test('Electron native rebuild cannot replace sidecar Node artifacts', () => {
  const input = baseline();
  input.builder.npmRebuild = true;
  assert.ok(validateBaseline(input).some(x => x.includes('rebuilt for Electron')));
});

test('untested platform capabilities cannot be advertised', () => {
  const input = baseline();
  object(object(input.status.platformCapabilities)['win32-x64']).workerIsolation = 'verified';
  assert.ok(validateBaseline(input).some(x => x.includes('cannot claim')));
});

test('unresolved decisions cannot be hidden behind a frozen label', () => {
  const input = baseline();
  input.status.status = 'frozen';
  input.status.blockers = ['TEST_UNRESOLVED'];
  assert.ok(validateBaseline(input).some(x => x.includes('unresolved blockers')));
  assert.throws(() => requireP0Exit(input.status), /P0_NOT_FROZEN/);
});

test('editing only the status and blocker list cannot authorize P1', () => {
  const input = baseline();
  input.status.status = 'frozen';
  input.status.blockers = [];
  assert.throws(() => requireP0Exit(input.status), /P0_DECISION_NOT_APPROVED/);
});

test('removing the platform capability matrix cannot evade P0 checks', () => {
  const input = baseline();
  input.status.platformCapabilities = {};
  assert.ok(validateBaseline(input).some(message => message.includes('Missing platform capability')));
});

test('missing platform checksums fail closed', () => {
  const input = baseline();
  object(object(input.runtime.artifacts)['darwin-arm64']).sha256 = '';
  assert.ok(validateBaseline(input).some(x => x.includes('Missing checksum')));
});

test('P1 command guard exits nonzero instead of producing a green fake test', () => {
  const result = spawnSync(process.execPath, [resolve('scripts/phase-required.mjs'), 'P1', 'integration'], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /NOT_IMPLEMENTED/);
});

test('non-object JSON configuration is rejected', () => {
  for (const input of [null, [], 'config', 42]) assert.throws(() => object(input), /Expected a JSON object/);
});
