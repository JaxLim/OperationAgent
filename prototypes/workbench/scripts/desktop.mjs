// Opens the built prototype in a locked-down Electron window, reusing the Electron
// binary the main repository already verified (apps/desktop). Fails with a clear
// message instead of downloading anything.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const here = fileURLToPath(new URL('..', import.meta.url));
const repo = resolve(here, '..', '..');

if (!existsSync(resolve(here, 'dist', 'index.html'))) {
  console.error('Prototype is not built. Run the build first (see prototypes/workbench/README.md).');
  process.exit(1);
}

let electron;
try {
  electron = createRequire(resolve(repo, 'apps', 'desktop', 'package.json'))('electron');
} catch {
  electron = undefined;
}
if (typeof electron !== 'string' || !existsSync(electron)) {
  console.error('Electron is not prepared in apps/desktop. Run `pnpm prepare:electron` at the repository root,');
  console.error('or use the browser preview instead (see prototypes/workbench/README.md).');
  process.exit(1);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;
const child = spawn(electron, [resolve(here, 'electron', 'main.cjs')], { stdio: 'inherit', env, windowsHide: false, shell: false });
child.on('exit', code => process.exit(code ?? 0));
