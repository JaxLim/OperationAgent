import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const target = `${process.platform}-${process.arch}`;
const output = resolve(root, 'artifacts/p1', target); mkdirSync(output, { recursive: true });
const startedAt = new Date().toISOString();
const source = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true, cwd: root }).stdout?.trim();
const commands = [
  ['scripts/workspace.mjs', 'build'],
  ['scripts/stage-sidecar.mjs'],
  ['scripts/prepare-electron.mjs'],
  ['--test', '--test-concurrency=1', '--test-timeout=180000', 'tests/integration/sidecar.test.mjs', 'tests/integration/electron.test.mjs'],
];
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
    scope: ['P1.2', 'P1.3'], passed: results.length === commands.length && results.every(row => row.exitCode === 0),
    runtime, results, workerFixture: 'NOT_RUN', nativeServiceTree: 'NOT_RUN', installedSmoke: 'NOT_RUN', agentReady: false }, null, 2) + '\n', 'utf8');
  if (result.error || result.status !== 0) process.exit(result.status ?? 1);
}
