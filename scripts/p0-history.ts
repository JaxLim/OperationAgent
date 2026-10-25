import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

// Immutable provenance, not a movable branch or self-reported frozen flag.
export const frozenCommit = '04d07bea89b70265a6b1fb1d79272b710623775b';
export const frozenPaths = [
  'ARCHITECTURE.md', 'AGENTS.md', '.node-version', 'build/p0-decision.json',
  'build/p0-status.json', 'build/runtime-lock.json', 'build/electron-builder.config.json',
  'docs/P0-REVIEW.md', 'docs/ACCEPTANCE.md', 'docs/adr', 'experiments',
  'scripts/p0-check.ts', 'scripts/p0-decision.ts',
];

export function gitText(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
}

export function validateFrozenFiles(expected: ReadonlyMap<string, string>, actual: ReadonlyMap<string, string>): string[] {
  if (expected.size === 0) return ['P0_HISTORY_EMPTY'];
  return [...expected].filter(([path, value]) => actual.get(path) !== value).map(([path]) => `P0_HISTORY_CHANGED: ${path}`);
}

export function verifyFrozenFiles(root: string): void {
  gitText(root, ['merge-base', '--is-ancestor', frozenCommit, 'HEAD']);
  const files = gitText(root, ['ls-tree', '-r', '--name-only', frozenCommit, '--', ...frozenPaths]).trim().split('\n');
  const expected = new Map<string, string>(); const actual = new Map<string, string>();
  for (const file of files) {
    expected.set(file, gitText(root, ['show', `${frozenCommit}:${file}`]));
    try { actual.set(file, readFileSync(resolve(root, file), 'utf8')); } catch { /* Missing files fail below. */ }
  }
  const errors = validateFrozenFiles(expected, actual);
  if (errors.length) throw new Error(errors.join('\n'));
}

export function replayP0Exit(root: string): void {
  verifyFrozenFiles(root);
  const cache = resolve(root, '.cache'); mkdirSync(cache, { recursive: true });
  const snapshot = mkdtempSync(resolve(cache, 'p0-history-'));
  try {
    const files = gitText(root, ['ls-tree', '-r', '--name-only', frozenCommit]).trim().split('\n');
    for (const file of files) {
      const target = resolve(snapshot, file);
      if (!target.startsWith(snapshot + sep)) throw new Error('P0_HISTORY_PATH_ESCAPE');
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, gitText(root, ['show', `${frozenCommit}:${file}`]), 'utf8');
    }
    const result = spawnSync(process.execPath, [resolve(snapshot, 'scripts/p0-check.ts'), '--require-frozen'], {
      cwd: snapshot, encoding: 'utf8', windowsHide: true, timeout: 30_000,
    });
    if (result.error || result.status !== 0) throw new Error(`P0_HISTORY_REPLAY_FAILED: ${result.stderr}`, { cause: result.error });
    console.log(result.stdout.trim());
    console.log(JSON.stringify({ check: 'P0_HISTORICAL_EXIT', commit: frozenCommit, passed: true, productionWorkerQualified: false }));
  } finally {
    // Remove only the unique workspace-local snapshot created by this invocation.
    if (snapshot.startsWith(cache + sep)) rmSync(snapshot, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) replayP0Exit(resolve('.'));
