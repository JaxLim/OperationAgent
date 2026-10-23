import { spawnSync } from 'node:child_process';

const packageManager = process.env.npm_execpath;
if (!packageManager) throw new Error('Run this command through the pinned pnpm version.');
for (const name of ['typecheck', 'lint', 'test', 'build', 'verify:p0']) {
  const result = spawnSync(process.execPath, [packageManager, 'run', name], {
    stdio: 'inherit', shell: false, windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
