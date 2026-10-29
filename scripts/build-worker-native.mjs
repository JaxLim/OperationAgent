import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const lock = JSON.parse(await readFile(resolve(root, 'build/runtime-lock.json'), 'utf8'));
if (process.platform !== 'win32' || process.arch !== 'x64' || process.version !== `v${lock.node}`) throw new Error('LOCKED_WINDOWS_X64_RUNTIME_REQUIRED');
const downloads = resolve(root, '.cache/worker-native/downloads');
const output = resolve(root, 'packages/platform-worker/native-dist/win32-x64');
await mkdir(downloads, { recursive: true }); await mkdir(output, { recursive: true });
const sources = [];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function download(file, name, expected) {
  const path = resolve(downloads, name); let bytes;
  try { bytes = await readFile(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const url = `https://nodejs.org/dist/v${lock.node}/${file}`;
  if (!bytes) {
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`NODE_NATIVE_DOWNLOAD_FAILED: ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (expected && hash(bytes) !== expected) throw new Error('NODE_NATIVE_CHECKSUM_MISMATCH');
    await writeFile(path, bytes);
  }
  if (expected && hash(bytes) !== expected) throw new Error('NODE_NATIVE_CHECKSUM_MISMATCH');
  sources.push({ url, sha256: hash(bytes), verifiedAgainstOfficialManifest: Boolean(expected) });
  return bytes;
}
const sums = (await download('SHASUMS256.txt', 'SHASUMS256.txt')).toString('utf8');
for (const [file, name] of [[`node-v${lock.node}-headers.tar.gz`, 'headers.tar.gz'], ['win-x64/node.lib', 'node.lib']]) {
  const line = sums.split('\n').find(value => value.trim().endsWith(`  ${file}`));
  if (!line || !/^[a-f0-9]{64}/.test(line)) throw new Error('NODE_NATIVE_MANIFEST_MISSING');
  await download(file, name, line.slice(0, 64));
}
function command(exe, args, options = {}) {
  const result = spawnSync(exe, args, { cwd: root, windowsHide: true, shell: false, ...options });
  if (result.error || result.status !== 0) throw new Error(`NATIVE_BUILD_COMMAND_FAILED: ${exe}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`, { cause: result.error });
  return result;
}
command(resolve(process.env.SystemRoot, 'System32/tar.exe'), ['-xzf', resolve(downloads, 'headers.tar.gz'), '-C', downloads]);
const vswhere = 'C:/Program Files (x86)/Microsoft Visual Studio/Installer/vswhere.exe';
const installation = command(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { encoding: 'utf8' }).stdout.trim();
const msvcVersion = (await readFile(resolve(installation, 'VC/Auxiliary/Build/Microsoft.VCToolsVersion.default.txt'), 'utf8')).trim();
const msvc = resolve(installation, 'VC/Tools/MSVC', msvcVersion);
const sdk = 'C:/Program Files (x86)/Windows Kits/10';
const sdkVersion = (await readdir(resolve(sdk, 'Include'))).filter(name => /^10\.0\.\d+\.0$/.test(name)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1);
if (!sdkVersion) throw new Error('WINDOWS_SDK_UNAVAILABLE');
const include = [resolve(msvc, 'include'), ...['ucrt', 'shared', 'um', 'winrt'].map(name => resolve(sdk, 'Include', sdkVersion, name))];
const library = [resolve(msvc, 'lib/x64'), ...['ucrt', 'um'].map(name => resolve(sdk, 'Lib', sdkVersion, name, 'x64'))];
const compiler = resolve(msvc, 'bin/Hostx64/x64/cl.exe');
const evidence = { node: lock.node, abi: lock.nodeModuleAbi, compiler, msvcVersion, sdkVersion, sources, artifacts: {}, commands: [] };
for (const name of ['parent', 'channel']) {
  const args = ['/nologo', '/LD', '/MT', '/std:c++20', '/EHsc', '/W4', '/WX', '/O2', '/utf-8', '/D_WIN32_WINNT=0x0A00',
    `/DNODE_GYP_MODULE_NAME=oa_worker_${name}`, `/I${resolve(downloads, `node-v${lock.node}/include/node`)}`,
    `/Fo${resolve(output, `${name}.obj`)}`, `/Fd${resolve(output, `${name}.pdb`)}`, resolve(root, `packages/platform-worker/native/${name}.cc`),
    '/link', `/OUT:${resolve(output, `${name}.node`)}`, `/IMPLIB:${resolve(output, `${name}.lib`)}`,
    resolve(downloads, 'node.lib'), 'advapi32.lib', 'userenv.lib', 'bcrypt.lib'];
  const result = spawnSync(compiler, args, { cwd: output, windowsHide: true, shell: false,
    env: { ...process.env, INCLUDE: include.join(';'), LIB: library.join(';'), PATH: `${resolve(msvc, 'bin/Hostx64/x64')};${process.env.PATH}` } });
  const decoder = new TextDecoder('gb18030');
  const record = { name, args, status: result.status, stdout: decoder.decode(result.stdout ?? Buffer.alloc(0)), stderr: decoder.decode(result.stderr ?? Buffer.alloc(0)) };
  evidence.commands.push(record);
  await writeFile(resolve(output, 'build-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  process.stdout.write(record.stdout); process.stderr.write(record.stderr);
  if (result.error || result.status !== 0) throw new Error(`NATIVE_BUILD_FAILED: ${name}`, { cause: result.error });
  evidence.artifacts[`${name}.node`] = hash(await readFile(resolve(output, `${name}.node`)));
}
await writeFile(resolve(output, 'build-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify({ check: 'P1_WORKER_NATIVE_BUILD', passed: true, node: lock.node, nativeArtifacts: evidence.artifacts, isolatedFixture: 'NOT_RUN' }));
