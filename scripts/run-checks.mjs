import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const packageManager = process.env.npm_execpath;
if (!packageManager) throw new Error('Run this command through the pinned pnpm version.');
const engineeringOnly = process.argv[2] === '--engineering-only';
if (process.argv.length > (engineeringOnly ? 3 : 2)) throw new Error('UNKNOWN_CHECK_OPTION');
const target = `${process.platform}-${process.arch}`;
const output = resolve('artifacts/p1', target); mkdirSync(output, { recursive: true });
const source = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).stdout?.trim();
const sourceDirty = Boolean(spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8', windowsHide: true }).stdout?.trim());
const results = [];
const names = ['typecheck', 'lint', 'check:boundaries', 'test', 'build', 'verify:p0', 'verify:p1', 'verify:p2', ...(engineeringOnly ? [] : ['test:integration'])];
for (const name of names) {
  const result = spawnSync(process.execPath, [packageManager, 'run', name], {
    encoding: 'utf8', shell: false, windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  });
  const log = (result.stdout ?? '') + (result.stderr ?? ''); process.stdout.write(log);
  const logFile = `check-${name.replaceAll(':', '-')}.log`; writeFileSync(resolve(output, logFile), log, 'utf8');
  results.push({ command: `pnpm ${name}`, exitCode: result.status, logFile });
  writeFileSync(resolve(output, 'checks.json'), JSON.stringify({ finishedAt: new Date().toISOString(), source, sourceDirty, target,
    scope: engineeringOnly ? 'engineering-only' : 'P1', passed: results.length === names.length && results.every(row => row.exitCode === 0),
    processIntegration: engineeringOnly ? 'NOT_RUN' : results.find(row => row.command === 'pnpm test:integration')?.exitCode === 0 ? 'PASS' : 'NOT_PASSED',
    installedSmoke: 'SEPARATE_STEP (pnpm package && pnpm test:smoke)', workerFixture: 'SEE integration.json', results }, null, 2) + '\n', 'utf8');
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
