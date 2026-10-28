// This suite is safe on the development host: it never creates a profile or grants ACLs.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const native = resolve(import.meta.dirname, '../../packages/platform-worker/native-dist/win32-x64');
test('the parent addon exports only the fixed fixture launcher and refuses a non-runner host', async () => {
  const parent = require(resolve(native, 'parent.node'));
  assert.deepEqual(Object.getOwnPropertyNames(parent), ['launchFixture']);
  assert.throws(() => parent.launchFixture(), /ARGUMENT_COUNT/);
  assert.throws(() => parent.launchFixture('a\0b'), /EMBEDDED_NUL/);
  const previous = process.env.GITHUB_ACTIONS;
  try {
    delete process.env.GITHUB_ACTIONS;
    await assert.rejects(parent.launchFixture(resolve(import.meta.dirname)), /DISPOSABLE_WINDOWS_RUNNER_REQUIRED/);
  } finally {
    if (previous === undefined) delete process.env.GITHUB_ACTIONS; else process.env.GITHUB_ACTIONS = previous;
  }
});
test('the child addon fails closed without a parent-granted inherited pipe', () => {
  const previous = process.env.OA_INHERITED_CHANNEL;
  try {
    delete process.env.OA_INHERITED_CHANNEL;
    assert.throws(() => require(resolve(native, 'channel.node')), /INHERITED_CHANNEL_MISSING/);
    process.env.OA_INHERITED_CHANNEL = 'not-a-handle';
    assert.throws(() => require(resolve(native, 'channel.node')), /INHERITED_CHANNEL_INVALID/);
  } finally {
    if (previous === undefined) delete process.env.OA_INHERITED_CHANNEL; else process.env.OA_INHERITED_CHANNEL = previous;
  }
});
