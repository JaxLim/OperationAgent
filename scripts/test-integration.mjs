import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const target = `${process.platform}-${process.arch}`;
const output = resolve(root, 'artifacts/p1', target); mkdirSync(output, { recursive: true });
const startedAt = new Date().toISOString();
const source = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true, cwd: root }).stdout?.trim();
// ADR-WIN-001: the restricted fixture may create AppContainer profiles and grant runtime ACLs only on a
// disposable runner. Elsewhere it is BLOCKED and recorded as such, never skipped into a pass.
const windows = target === 'win32-x64';
const disposableRunner = windows && process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_OS === 'Windows';
const commands = [
  ['scripts/workspace.mjs', 'build'],
  ['scripts/stage-sidecar.mjs'],
  ['scripts/prepare-electron.mjs'],
  ['--test', '--test-concurrency=1', '--test-timeout=180000', 'tests/integration/sidecar.test.mjs', 'tests/integration/electron.test.mjs'],
  ...(windows ? [['scripts/build-worker-native.mjs'], ['scripts/build-worker-fixture.mjs'], ['--test', 'tests/worker-fixture/native-surface.test.mjs']] : []),
  ...(disposableRunner ? [['--test', '--test-concurrency=1', '--test-timeout=240000', 'tests/worker-fixture/isolated-fixture.test.mjs'],
    ['--test', '--test-concurrency=1', '--test-timeout=240000', 'tests/worker-fixture/sec-w01.test.mjs']] : []),
];
const workerFixture = () => {
  if (!windows) return 'NOT_RUN_NO_NATIVE_LAUNCHER';
  if (!disposableRunner) return 'BLOCKED_NOT_AUTHORIZED_ON_THIS_HOST';
  const row = results.find(entry => entry.command.includes('isolated-fixture'));
  return row ? (row.exitCode === 0 ? 'PASS' : 'FAILED') : 'NOT_REACHED';
};
// SEC-W01 is the production Worker gate; its own row decides it, never the P1 fixture result.
const secW01 = () => {
  if (!windows) return 'NOT_RUN_NO_NATIVE_LAUNCHER';
  if (!disposableRunner) return 'BLOCKED_NOT_AUTHORIZED_ON_THIS_HOST';
  const row = results.find(entry => entry.command.includes('sec-w01'));
  return row ? (row.exitCode === 0 ? 'PASS' : 'FAILED') : 'NOT_REACHED';
};
const results = [];
for (const args of commands) {
  console.log(`RUN node ${args.join(' ')}`);
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', windowsHide: true, shell: false, maxBuffer: 8 * 1024 * 1024 });
  const log = (result.stdout ?? '') + (result.stderr ?? '');
  process.stdout.write(log);
  const logFile = `${results.length + 1}.log`; writeFileSync(resolve(output, logFile), log, 'utf8');
  results.push({ command: `node ${args.join(' ')}`, exitCode: result.status, logFile, error: result.error?.message ?? null });
  const manifestPath = resolve(root, 'build/stage', `${{ win32: 'win', darwin: 'mac', linux: 'linux' }[process.platform]}-${process.arch}`, 'sidecar/manifest.json');
  let runtime = null;
  try { const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); runtime = { node: manifest.node, abi: manifest.abi, sqlite: manifest.sqlite, lockSha256: manifest.lockSha256 }; } catch { /* Failed staging is recorded below. */ }
  writeFileSync(resolve(output, 'integration.json'), JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), source, target,
    scope: ['P1.2', 'P1.3', 'P1.4', 'P1.5'], passed: results.length === commands.length && results.every(row => row.exitCode === 0),
    runtime, results, workerFixture: workerFixture(), serviceTreeSec17: workerFixture(), secW01: secW01(), installedSmoke: 'SEPARATE_STEP', agentReady: false }, null, 2) + '\n', 'utf8');
  if (result.error || result.status !== 0) process.exit(result.status ?? 1);
}
