import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startWorker } from '../../apps/agent-worker/dist/index.js';
import { requireWorkerLauncher } from '../../packages/platform-worker/dist/parent.js';
import { requireServiceTreeSupervisor } from '../../packages/platform-supervision/dist/index.js';

test('built entry points explicitly reject execution; this is not an OS isolation test', () => {
  assert.throws(startWorker, /WORKER_ISOLATION_UNAVAILABLE/);
  assert.throws(requireWorkerLauncher, /WORKER_ISOLATION_UNAVAILABLE/);
  assert.throws(requireServiceTreeSupervisor, /NOT_IMPLEMENTED/);
});
