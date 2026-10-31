// SEC-W01 (ADR-WIN-001): production Worker gate for Windows x64. A probe runtime plays a compromised Worker inside
// the real AppContainer + Job created by the production launcher path. Runs only on a disposable runner;
// elsewhere it fails as BLOCKED. Any ALLOWED or UNKNOWN outcome keeps the Worker unqualified.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const runtime = resolve(root, '.cache/worker-fixture/probe-runtime');
const runner = process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_OS === 'Windows' && process.platform === 'win32' && process.arch === 'x64';
const ENV_ALLOWLIST = ['LOCALAPPDATA', 'OA_INHERITED_CHANNEL', 'SystemRoot', 'TEMP', 'TMP', 'WINDIR'];

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
  const evidence = resolve(root, 'artifacts/p1/win32-x64'); mkdirSync(evidence, { recursive: true });
  writeFileSync(resolve(evidence, 'sec-w01.json'), JSON.stringify({ check: 'SEC_W01_WIN32_X64', source: process.env.GITHUB_SHA ?? null,
    finishedAt: new Date().toISOString(), baseline: started.baseline, prepared, report, observed, exit: { reason: exit.reason, cleanup: exit.cleanup } }, null, 2) + '\n');
  assert.ok(report, `probe report missing; stderr tail: ${exit.stderr.slice(-400)}`);
  const { results, env } = report;

  // The probe really ran inside the restricted Worker: same baseline as production, and it can use what it was granted.
  assert.equal(started.baseline.appContainer, true); assert.equal(started.baseline.capabilityCount, 0);
  assert.ok(started.baseline.integrityRid <= 0x1000); assert.equal(started.baseline.noChildProcessCreation, true);
  assert.equal(results['self.read-runtime'], 'ALLOWED', 'positive control: the granted runtime is readable');
  assert.equal(results['native.exports'], 'close,read,write', 'native boundary: only the inherited channel is exposed');
  assert.ok(prepared.parentAddonExists, 'the parent launcher addon exists, so its denial is meaningful');
  assert.deepEqual(env, ENV_ALLOWLIST, 'no credential, token or path variable is inherited');

  // Files, credentials, processes and native code: the OS must refuse every attempt.
  const exact = Object.keys(results).filter(name => /^(file|proc)\./.test(name) || name === 'native.dlopen-parent-addon');
  assert.ok(exact.length >= 14, `expected the full probe set, got ${exact.join(',')}`);
  for (const name of exact) assert.equal(results[name], 'DENIED', `${name}: ${results[name]}`);
  assert.equal(observed.siblingAlive, true, 'the sibling process survived the kill attempt');

  // Network: never a connection, reply or delivered datagram. Timeouts are UNKNOWN and fail the gate.
  const network = { 'net.tcp4.public': ['DENIED'], 'net.tcp6.public': ['DENIED'], 'net.tcp4.loopback': ['DENIED'], 'net.tcp6.loopback': ['DENIED'],
    'net.udp4.dns-public': ['DENIED'], // A local UDP send may complete while the datagram is dropped; the zero-hit check below proves nothing arrived.
    'net.udp4.loopback': ['DENIED', 'SENT'], 'net.dns.lookup': ['DENIED', 'ERROR:ENOTFOUND', 'ERROR:EAI_FAIL'] };
  for (const [name, accepted] of Object.entries(network)) assert.ok(accepted.includes(results[name]), `${name}: ${results[name]}`);
  assert.deepEqual(observed.hits, { tcp4: 0, tcp6: 0, udp4: 0 }, 'no loopback listener received anything from the Worker');
  assert.equal(exit.cleanup, 'confirmed');
});
