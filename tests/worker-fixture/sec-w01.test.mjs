// SEC-W01 (ADR-WIN-001): production Worker gate for Windows x64. A probe runtime plays a compromised Worker inside
// the real AppContainer + Job created by the production launcher path. Runs only on a disposable runner;
// elsewhere it fails as BLOCKED. Any ALLOWED, UNKNOWN or inconclusive outcome keeps the Worker unqualified.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { evaluateSecW01 } from '../../scripts/sec-w01-rules.ts';

const root = resolve(import.meta.dirname, '../..');
const runtime = resolve(root, '.cache/worker-fixture/probe-runtime');
const runner = process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_OS === 'Windows' && process.platform === 'win32' && process.arch === 'x64';
// The checked-out commit, the same source test:integration records, so committed evidence can be correlated.
const source = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).stdout?.trim() ?? null;

async function host(t) {
  const child = spawn(process.execPath, [resolve(import.meta.dirname, 'express-host.mjs'), runtime], { cwd: root, windowsHide: true,
    shell: false, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let logs = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { logs = (logs + chunk).slice(-32768); });
  const exited = once(child, 'exit'); const pending = new Map();
  child.on('message', message => { const handler = pending.get(message.id); if (handler) { pending.delete(message.id); handler(message); } });
  await new Promise((resolve, reject) => { child.once('message', resolve); child.once('exit', () => reject(new Error('HOST_EXIT: ' + logs))); });
  const call = (command, input) => new Promise((resolve, reject) => {
    const id = randomUUID(); const timer = setTimeout(() => { pending.delete(id); reject(new Error('HOST_TIMEOUT: ' + command + logs)); }, 60_000);
    pending.set(id, message => { clearTimeout(timer); if (message.error) reject(new Error(message.error)); else resolve(message.value); });
    child.send({ id, command, input });
  });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } });
  return { call };
}

test('SEC-W01 is BLOCKED unless running on a disposable Windows x64 runner', () => {
  assert.ok(runner, 'BLOCKED: SEC-W01 requires a disposable GitHub Actions Windows x64 runner (ADR-WIN-001 §3)');
});

test('SEC-W01: a compromised Worker cannot reach files, credentials, network, other processes or native code', { skip: runner ? false : 'BLOCKED', timeout: 180_000 }, async t => {
  const express = await host(t);
  const prepared = await express.call('prepare-probe');
  const started = await express.call('start');
  const exit = await express.call('stop');
  const observed = await express.call('observe-probe');
  const line = exit.stderr.split(/\r?\n/).find(entry => entry.startsWith('OA-PROBE '));
  const report = line ? JSON.parse(line.slice('OA-PROBE '.length)) : null;
  // Evidence first, so a failing run still leaves the full report for review.
  const evidence = { check: 'SEC_W01_WIN32_X64', source, finishedAt: new Date().toISOString(), baseline: started.baseline, prepared, report, observed,
    exit: { reason: exit.reason, cleanup: exit.cleanup } };
  const directory = resolve(root, 'artifacts/p1/win32-x64'); mkdirSync(directory, { recursive: true });
  writeFileSync(resolve(directory, 'sec-w01.json'), JSON.stringify(evidence, null, 2) + '\n');
  assert.ok(report, `probe report missing; stderr tail: ${exit.stderr.slice(-400)}`);
  // The same rules admit committed evidence in verify:agent; any violation, including an inconclusive network
  // outcome without a successful host control, keeps the Worker unqualified.
  assert.deepEqual(evaluateSecW01(evidence), []);
});
