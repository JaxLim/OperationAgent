import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startWorker } from '../../apps/agent-worker/dist/index.js';
import { launchIsolatedFixture } from '../../packages/platform-worker/dist/parent.js';

test('production Worker entry and non-Windows launchers fail closed; this is not an OS isolation test', async () => {
  assert.throws(startWorker, /WORKER_ISOLATION_UNAVAILABLE/);
  for (const target of ['linux-x64', 'darwin-arm64', 'win32-arm64']) {
    await assert.rejects(launchIsolatedFixture(target, '.'), /WORKER_ISOLATION_UNAVAILABLE: no native launcher/);
  }
});

test('the Windows launcher refuses the development host instead of creating a profile or granting ACLs', async () => {
  // Without the native artifact the launcher is unavailable; with it, only a disposable runner may create a profile.
  const outside = process.env.GITHUB_ACTIONS; delete process.env.GITHUB_ACTIONS;
  try {
    await assert.rejects(launchIsolatedFixture('win32-x64', 'C:/'), /WORKER_ISOLATION_UNAVAILABLE: (native launcher artifact missing|DISPOSABLE_WINDOWS_RUNNER_REQUIRED)/);
  } finally { if (outside !== undefined) process.env.GITHUB_ACTIONS = outside; }
});
