import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error('This developer bootstrap targets Windows x64 only. CI installs the pinned runtime per platform.');
}
const root = fileURLToPath(new URL('../', import.meta.url));
const lock = JSON.parse(await readFile(resolve(root, 'build/runtime-lock.json'), 'utf8'));
const toolsRoot = resolve(root, '.tools');
await mkdir(resolve(toolsRoot, 'node'), { recursive: true });
await mkdir(resolve(toolsRoot, 'pnpm'), { recursive: true });

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
    if (!process.env.SystemRoot) throw new Error('SystemRoot is required for the Windows download fallback', { cause: error });
    const temporary = `${target}.${randomUUID()}.download`;
    try {
      const result = spawnSync(resolve(process.env.SystemRoot, 'System32/curl.exe'), ['--fail', '--location', '--silent', '--show-error', '--retry', '2', '--connect-timeout', '15', '--max-time', '240', '--output', temporary, url], { stdio: 'inherit', windowsHide: true, shell: false });
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

await download(`https://nodejs.org/dist/v${lock.node}/${lock.windowsBootstrap.file}`, resolve(toolsRoot, 'node/node.exe'), 'sha256', lock.windowsBootstrap.sha256);
const archive = resolve(toolsRoot, 'pnpm.tgz');
await download(lock.pnpmArtifact.url, archive, 'sha512', lock.pnpmArtifact.integrity.replace('sha512-', ''));
if (!process.env.SystemRoot) throw new Error('SystemRoot is required to locate the Windows tar executable');
const extract = spawnSync(resolve(process.env.SystemRoot, 'System32/tar.exe'), ['-xzf', archive, '-C', resolve(toolsRoot, 'pnpm'), '--strip-components=1'], { stdio: 'inherit', windowsHide: true, shell: false });
if (extract.error) throw extract.error;
if (extract.status !== 0) throw new Error('pnpm extraction failed');
console.log('Workspace-local bootstrap complete. No global runtime or package manager was installed.');
