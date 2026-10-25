import { spawnSync } from 'node:child_process';

function run(args) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', windowsHide: true, shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(['node_modules/typescript/bin/tsc', '-b']);
if (process.argv[2] === 'typecheck') {
  if (!process.env.npm_execpath) throw new Error('Use the pinned pnpm');
  run([process.env.npm_execpath, '-r', '--workspace-concurrency=1', 'run', 'typecheck']);
} else if (process.argv[2] === 'build') {
  run(['scripts/build-desktop.mjs']);
  run(['scripts/check-artifacts.mjs']);
} else throw new Error('Unknown workspace operation');
