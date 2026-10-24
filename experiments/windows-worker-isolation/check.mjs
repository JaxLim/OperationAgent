// Only experimental validation; never changes root P0 status or platform support.
import { mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const lab = fileURLToPath(new URL('./', import.meta.url));
const root = resolve(lab, '../..');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const directory = resolve(lab, 'evidence', `checks-${stamp}`);
await mkdir(directory, { recursive: true });
const checks = [
  { name: 'native-build', args: ['build.mjs'], cwd: lab, expected: 0 },
  { name: 'strict-types', args: [resolve(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'], cwd: lab, expected: 0 },
  { name: 'lint', args: [resolve(root, 'node_modules/eslint/bin/eslint.js'), '.', '--max-warnings', '0'], cwd: lab, expected: 0 },
  { name: 'protocol-and-evidence-tests', args: ['--test', '_build/js/wire.test.js', '_build/js/evaluate.test.js'], cwd: lab, expected: 0 },
  { name: 'root-p0-checks', args: ['.tools/pnpm/bin/pnpm.cjs', 'check'], cwd: root, expected: 0 },
  { name: 'root-p0-freeze-must-stay-blocked', args: ['scripts/p0-check.ts', '--require-frozen'], cwd: root, expected: 1 },
];
const records = [];
for (const check of checks) {
  const started = Date.now();
  const result = spawnSync(process.execPath, check.args, { cwd: check.cwd, env: { ...process.env, PATH: `${resolve(root, '.tools/node')};${process.env.PATH}`, TMP: resolve(lab, '_tmp'), TEMP: resolve(lab, '_tmp'), XDG_CACHE_HOME: resolve(root, '.cache'), XDG_DATA_HOME: resolve(root, '.cache/data'), XDG_STATE_HOME: resolve(root, '.cache/state'), PNPM_HOME: resolve(root, '.tools/pnpm-home'), npm_config_cache: resolve(root, '.cache/npm') }, encoding: 'utf8', timeout: 120000, windowsHide: true, shell: false, maxBuffer: 2 * 1024 * 1024 });
  const record = { ...check, command: [process.execPath, ...check.args], exitCode: result.status, signal: result.signal, elapsedMs: Date.now() - started, stdout: result.stdout, stderr: result.stderr, error: result.error?.message ?? null, passed: result.status === check.expected && !result.error };
  records.push(record);
  await writeFile(resolve(directory, `${check.name}.json`), JSON.stringify(record, null, 2) + '\n');
  console.log(JSON.stringify({ check: check.name, exitCode: result.status, expected: check.expected, passed: record.passed }));
  if (!record.passed) { console.error(result.stdout, result.stderr); break; }
}
const passed = records.length === checks.length && records.every(r => r.passed);
await writeFile(resolve(directory, 'summary.json'), JSON.stringify({ passed, productionSandbox: false, dec001Closed: false, checks: records.map(r => ({ name: r.name, passed: r.passed })) }, null, 2) + '\n');
console.log(JSON.stringify({ directory, passed }));
if (!passed) process.exitCode = 1;
