import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const lab = fileURLToPath(new URL('./', import.meta.url));
const root = resolve(lab, '../..');
const lock = JSON.parse(await readFile(resolve(root, 'build/runtime-lock.json'), 'utf8'));
if (process.platform !== 'win32' || process.arch !== 'x64' || process.version !== `v${lock.node}`) throw new Error('Requires locked Windows x64 Node runtime');
const downloads = resolve(lab, '_downloads');
await mkdir(downloads, { recursive: true });
await mkdir(resolve(lab, '_build/native'), { recursive: true });
await mkdir(resolve(lab, '_tmp'), { recursive: true });
const curl = resolve(process.env.SystemRoot, 'System32/curl.exe');
const sources = [];
async function download(url, name, expected) {
  const path = resolve(downloads, name);
  let bytes;
  try { bytes = await readFile(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!bytes) {
    const result = spawnSync(curl, ['--fail', '--location', '--silent', '--show-error', '--connect-timeout', '15', '--max-time', '90', '--retry', '1', '--output', path, url], { stdio: 'inherit', windowsHide: true, shell: false });
    if (result.error || result.status !== 0) throw new Error(`Download failed: ${url}`, { cause: result.error });
    bytes = await readFile(path);
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (expected && expected !== sha256) throw new Error(`Checksum mismatch: ${name}`);
  sources.push({ url, name, sha256, verifiedAgainstOfficialManifest: Boolean(expected) });
  return bytes;
}
const base = `https://nodejs.org/dist/v${lock.node}/`;
const sums = (await download(`${base}SHASUMS256.txt`, 'SHASUMS256.txt')).toString('utf8');
for (const [file, name] of [[`node-v${lock.node}-headers.tar.gz`, 'node-headers.tar.gz'], ['win-x64/node.lib', 'node.lib']]) {
  const line = sums.split('\n').find(line => line.trim().endsWith(`  ${file}`));
  if (!line) throw new Error(`Missing official checksum: ${file}`);
  await download(`${base}${file}`, name, line.split(/\s+/)[0]);
}
const extract = spawnSync(resolve(process.env.SystemRoot, 'System32/tar.exe'), ['-xzf', resolve(downloads, 'node-headers.tar.gz'), '-C', downloads], { stdio: 'inherit', windowsHide: true, shell: false });
if (extract.status !== 0) throw new Error('Node headers extraction failed');
await writeFile(resolve(downloads, 'sources.json'), JSON.stringify(sources, null, 2) + '\n');
console.log(JSON.stringify({ prepared: true, node: lock.node, sources }));
