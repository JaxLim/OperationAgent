import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const pnpmOnly = process.argv.length === 3 && process.argv[2] === '--pnpm-only';
if (process.argv.length > 2 && !pnpmOnly) {
  throw new Error('Usage: node scripts/bootstrap-windows.mjs [--pnpm-only]');
}
if (!pnpmOnly && (process.platform !== 'win32' || process.arch !== 'x64')) {
  throw new Error('The full developer bootstrap targets Windows x64 only. Use --pnpm-only with the pinned Node runtime on other platforms.');
}
const root = fileURLToPath(new URL('../', import.meta.url));
const lock = JSON.parse(await readFile(resolve(root, 'build/runtime-lock.json'), 'utf8'));
if (pnpmOnly && process.version !== `v${lock.node}`) {
  throw new Error(`The pnpm-only bootstrap requires Node ${lock.node}; received ${process.version}`);
}
const toolsRoot = resolve(root, '.tools');
if (!pnpmOnly) await mkdir(resolve(toolsRoot, 'node'), { recursive: true });
await mkdir(resolve(toolsRoot, 'pnpm'), { recursive: true });

function systemExecutable(name) {
  if (process.platform !== 'win32') return `/usr/bin/${name}`;
  if (!process.env.SystemRoot) throw new Error(`SystemRoot is required to locate ${name}`);
  return resolve(process.env.SystemRoot, `System32/${name}.exe`);
}

async function download(url, target, algorithm, expected) {
  const digest = bytes => createHash(algorithm).update(bytes).digest(algorithm === 'sha512' ? 'base64' : 'hex');
  try {
    const existing = await readFile(target);
    if (digest(existing) !== expected) throw new Error(`Existing file checksum mismatch: ${target}`);
    console.log(`Reused verified file: ${target}`);
    return;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  console.log(`Downloading verified artifact: ${url}`);
  let bytes;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`Download failed: ${response.status} ${url}`);
    bytes = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    console.warn(`Node fetch failed (${error.name}); retrying the same official URL with curl.`);
    const temporary = `${target}.${randomUUID()}.download`;
    try {
      const result = spawnSync(systemExecutable('curl'), ['--fail', '--location', '--silent', '--show-error', '--retry', '2', '--connect-timeout', '15', '--max-time', '240', '--output', temporary, url], { stdio: 'inherit', windowsHide: true, shell: false });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error('Official runtime download failed', { cause: error });
      bytes = await readFile(temporary);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  const actual = digest(bytes);
  if (actual !== expected) throw new Error(`Checksum mismatch: ${url}`);
  await writeFile(target, bytes, { flag: 'wx' });
  console.log(`Verified ${algorithm}: ${target}`);
}

if (!pnpmOnly) {
  await download(`https://nodejs.org/dist/v${lock.node}/${lock.windowsBootstrap.file}`, resolve(toolsRoot, 'node/node.exe'), 'sha256', lock.windowsBootstrap.sha256);
}
const archive = resolve(toolsRoot, 'pnpm.tgz');
await download(lock.pnpmArtifact.url, archive, 'sha512', lock.pnpmArtifact.integrity.replace('sha512-', ''));
const extract = spawnSync(systemExecutable('tar'), ['-xzf', archive, '-C', resolve(toolsRoot, 'pnpm'), '--strip-components=1'], { stdio: 'inherit', windowsHide: true, shell: false });
if (extract.error) throw extract.error;
if (extract.status !== 0) throw new Error('pnpm extraction failed');
const node = pnpmOnly ? process.execPath : resolve(toolsRoot, 'node/node.exe');
const version = spawnSync(node, [resolve(toolsRoot, 'pnpm/bin/pnpm.cjs'), '--version'], { encoding: 'utf8', windowsHide: true, shell: false });
if (version.error) throw version.error;
if (version.status !== 0 || version.stdout.trim() !== lock.pnpm) throw new Error('Extracted pnpm version does not match runtime-lock.json');
console.log('Workspace-local bootstrap complete. No global runtime or package manager was installed.');
