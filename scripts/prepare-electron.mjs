import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, realpath, stat, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const lock = JSON.parse(await readFile(resolve(root, 'build/runtime-lock.json'), 'utf8'));
const electron = await realpath(resolve(root, 'apps/desktop/node_modules/electron'));
const metadata = JSON.parse(await readFile(resolve(electron, 'package.json'), 'utf8'));
if (metadata.version !== lock.electron) throw new Error('ELECTRON_VERSION_MISMATCH');
const executable = process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron';
try {
  if ((await readFile(resolve(electron, 'dist/version'), 'utf8')).trim().replace(/^v/, '') === lock.electron &&
    (await readFile(resolve(electron, 'path.txt'), 'utf8')).trim() === executable && (await stat(resolve(electron, 'dist', executable))).isFile()) {
    console.log('Pinned Electron already installed'); process.exit(0);
  }
} catch { /* Install from the package-pinned official archive below. */ }
const filename = `electron-v${lock.electron}-${process.platform}-${process.arch}.zip`;
const checksums = JSON.parse(await readFile(resolve(electron, 'checksums.json'), 'utf8'));
if (!/^[a-f0-9]{64}$/.test(checksums[filename])) throw new Error('ELECTRON_CHECKSUM_MISSING');
const cache = resolve(root, '.cache/electron'); await mkdir(cache, { recursive: true });
const archive = resolve(cache, filename);
const system = name => process.platform === 'win32' ? resolve(process.env.SystemRoot, `System32/${name}.exe`) : `/usr/bin/${name}`;
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', windowsHide: true, shell: false });
  if (result.error || result.status !== 0) throw new Error('ELECTRON_PREPARATION_FAILED');
}
let verified = false;
try { verified = createHash('sha256').update(await readFile(archive)).digest('hex') === checksums[filename]; }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (!verified) {
  const temporary = archive + '.download';
  run(system('curl'), ['--fail', '--location', '--silent', '--show-error', '--retry', '2', '--max-time', '300', '--output', temporary,
    `https://github.com/electron/electron/releases/download/v${lock.electron}/${filename}`]);
  // Only verified complete archives are reused on later runs.
  if (createHash('sha256').update(await readFile(temporary)).digest('hex') !== checksums[filename]) throw new Error('ELECTRON_CHECKSUM_MISMATCH');
  await rename(temporary, archive);
}
if (createHash('sha256').update(await readFile(archive)).digest('hex') !== checksums[filename]) throw new Error('ELECTRON_CHECKSUM_MISMATCH');
const destination = resolve(electron, 'dist'); await mkdir(destination, { recursive: true });
if (process.platform === 'win32') run(system('tar'), ['-xf', archive, '-C', destination]);
else run(system('unzip'), ['-oq', archive, '-d', destination]);
await writeFile(resolve(electron, 'path.txt'), executable, 'utf8');
console.log(JSON.stringify({ check: 'ELECTRON_ARCHIVE_SHA256', version: lock.electron, passed: true, platform: process.platform, arch: process.arch }));
