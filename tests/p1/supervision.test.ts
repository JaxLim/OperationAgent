import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RestartBudget, SUPERVISION_POLICY, stopInTwoPhases, validateGraceMs } from '../../packages/platform-supervision/dist/index.js';

test('restart budget backs off exponentially and exhaustion is sticky inside the window', () => {
  const budget = new RestartBudget();
  assert.deepEqual([0, 10, 20].map(now => budget.request(now)), [
    { allowed: true, delayMs: 250, restarts: 1 }, { allowed: true, delayMs: 500, restarts: 2 }, { allowed: true, delayMs: 1000, restarts: 3 }]);
  assert.equal(budget.request(30).allowed, false); assert.equal(budget.isExhausted, true);
  assert.equal(budget.request(SUPERVISION_POLICY.restartWindowMs * 10).allowed, false);
  budget.reset(); assert.equal(budget.request(0).allowed, true);
});

test('restarts outside the sliding window are forgotten', () => {
  const budget = new RestartBudget(2, 1000, 0);
  assert.equal(budget.request(0).allowed, true); assert.equal(budget.request(500).allowed, true);
  assert.equal(budget.request(1001).allowed, true); assert.equal(budget.restarts, 2);
});

test('grace periods outside 5–30 s are rejected at registration, not clamped', () => {
  for (const value of [5000, 30000, 12345]) assert.equal(validateGraceMs(value), value);
  for (const value of [4999, 30001, 0, -1, 5000.5, Number.NaN]) assert.throws(() => validateGraceMs(value), /GRACE_PERIOD_OUT_OF_RANGE/);
});

test('two-phase stop escalates only when graceful exit is not observed and never reports unconfirmed cleanup', async () => {
  const calls: string[] = [];
  const graceful = await stopInTwoPhases({ graceful: async () => { calls.push('graceful'); },
    exited: async () => { calls.push('exited'); }, force: async () => { calls.push('force'); } });
  assert.deepEqual(graceful, { phase: 'graceful', confirmed: true }); assert.deepEqual(calls, ['graceful', 'exited']);
  let forced = false;
  const escalated = await stopInTwoPhases({ graceful: async () => { throw new Error('hung'); },
    exited: async () => { if (!forced) throw new Error('alive'); }, force: async () => { forced = true; } });
  assert.deepEqual(escalated, { phase: 'forced', confirmed: true });
  await assert.rejects(stopInTwoPhases({ graceful: async () => {}, exited: async () => { throw new Error('alive'); }, force: async () => {} }), /CLEANUP_UNCONFIRMED/);
  await assert.rejects(stopInTwoPhases({ graceful: async () => {}, exited: async () => {}, force: async () => {} }, 31_000), /GRACE_PERIOD_OUT_OF_RANGE/);
});
