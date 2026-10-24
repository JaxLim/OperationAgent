import assert from 'node:assert/strict';
import test from 'node:test';
import { combine, denied, evaluate } from './evaluate.js';

test('timeouts, sharing conflicts and absent observations cannot count as denied', () => {
  assert.equal(denied({ allowed: false, error: 10060 }, [10013]), 'UNKNOWN');
  assert.equal(denied({ allowed: false, error: 32 }, [5]), 'UNKNOWN');
  assert.equal(denied({ allowed: false, error: 5 }, [5]), 'PASS');
  assert.equal(denied({ allowed: true, error: 0 }, [5]), 'FAILED');
  assert.equal(combine([]), 'UNKNOWN');
  assert.equal(combine(['PASS', 'UNKNOWN']), 'UNKNOWN');
  assert.equal(combine(['PASS', 'FAILED']), 'FAILED');
});
test('a failed launch never passes RPC, cleanup or access isolation', () => {
  const matrix = evaluate({ mode: 'appcontainer', scenario: 'hang', runId: '83fdbec5-e55a-4690-a6b4-f5b91dafaf2e', supervisorPid: null,
    hostPid: 1, workerPid: 0, elapsedMs: 1, killCleanupMs: null, exit: { code: 0, signal: null }, failure: 'launch failed', stderr: '', workerAliveAfter: false, expressAliveAfter: false, events: [] });
  assert.equal(matrix.legalNodeIpcRpc, 'FAILED');
  assert.equal(matrix.cleanupScenario, 'UNKNOWN');
  assert.equal(matrix.protectedFileReadWrite, 'UNKNOWN');
});
