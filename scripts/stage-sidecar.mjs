import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, cp, readdir, realpath, rm, chmod, lstat, unlink, rename } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const lock = JSON.parse(await readFile(resolve(root, 'build/runtime-lock.json'), 'utf8'));
if (process.versions.node !== lock.node || process.versions.modules !== lock.nodeModuleAbi) throw new Error('PINNED_NODE_REQUIRED');
const target = `${process.platform}-${process.arch}`;
const builderOS = { win32: 'win', darwin: 'mac', linux: 'linux' }[process.platform];
if (!builderOS || !lock.artifacts[target]) throw new Error('UNSUPPORTED_TARGET');
const stagingRoot = resolve(root, 'build/stage');
const stage = resolve(stagingRoot, `${builderOS}-${process.arch}`, 'sidecar');
if (!stage.startsWith(stagingRoot + sep)) throw new Error('STAGE_ESCAPE');
await mkdir(stage, { recursive: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, shell: false, ...options });
  if (result.error || result.status !== 0) throw new Error(`STAGING_COMMAND_FAILED: ${result.stderr ?? result.error}`);
  return result.stdout.trim();
}
const system = name => process.platform === 'win32' ? resolve(process.env.SystemRoot, `System32/${name}.exe`) : `/usr/bin/${name}`;
const nodeRelative = process.platform === 'win32' ? 'node/node.exe' : 'node/bin/node';
let nodeSource;
if (target === 'win32-x64') {
  nodeSource = resolve(root, '.tools/node/node.exe');
  if (hash(await readFile(nodeSource)) !== lock.windowsBootstrap.sha256) throw new Error('NODE_CHECKSUM_MISMATCH');
} else {
  const artifact = lock.artifacts[target];
  const cache = resolve(root, '.cache/runtime', target); await mkdir(cache, { recursive: true });
  const archive = resolve(cache, artifact.file);
  let bytes;
  try { bytes = await readFile(archive); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    run(system('curl'), ['--fail', '--location', '--silent', '--show-error', '--retry', '2', '--max-time', '240',
      '--output', archive, `https://nodejs.org/dist/v${lock.node}/${artifact.file}`]);
    bytes = await readFile(archive);
  }
  if (hash(bytes) !== artifact.sha256) throw new Error('NODE_ARCHIVE_CHECKSUM_MISMATCH');
  run(system('tar'), ['-xf', archive, '-C', cache]);
  nodeSource = resolve(cache, artifact.file.replace(/\.(tar\.(gz|xz)|zip)$/, ''), process.platform === 'win32' ? 'node.exe' : 'bin/node');
}
await mkdir(resolve(stage, nodeRelative, '..'), { recursive: true });
await cp(nodeSource, resolve(stage, nodeRelative));
if (process.platform !== 'win32') await chmod(resolve(stage, nodeRelative), 0o755);
const server = resolve(stage, 'server');
if (!server.startsWith(stagingRoot + sep)) throw new Error('STAGE_ESCAPE');
await rm(server, { recursive: true, force: true });
run(process.execPath, [resolve(root, '.tools/pnpm/bin/pnpm.cjs'), '--filter', '@operation-agent/server', 'deploy', '--prod', '--legacy', '--config.node-linker=hoisted', server], { cwd: root });
// pnpm legacy deploy leaves a root-package self link to the source checkout. It is not a runtime dependency.
const selfLink = resolve(server, 'node_modules/.pnpm/node_modules/@operation-agent/server');
try {
  if (!(await lstat(selfLink)).isSymbolicLink() || await realpath(selfLink) !== await realpath(resolve(root, 'apps/server'))) throw new Error('UNEXPECTED_SELF_LINK');
  await unlink(selfLink);
} catch (error) { if (error.code !== 'ENOENT') throw error; }
// Check all remaining targets before dereferencing; the resulting closure is relocatable and has no junctions.
async function checkLinks(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) {
      if (!(await realpath(path)).startsWith(stage + sep)) throw new Error('STAGED_SYMLINK_ESCAPE');
    } else if (entry.isDirectory()) await checkLinks(path);
  }
}
await checkLinks(server);
const materialized = resolve(stage, 'server-materialized');
if (!materialized.startsWith(stagingRoot + sep)) throw new Error('STAGE_ESCAPE');
await rm(materialized, { recursive: true, force: true });
await cp(server, materialized, { recursive: true, dereference: true });
await rm(server, { recursive: true, force: true }); await rename(materialized, server);
const files = {};
async function inspect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const targetPath = await realpath(path);
      if (!targetPath.startsWith(stage + sep)) throw new Error('STAGED_SYMLINK_ESCAPE');
    } else if (entry.isDirectory()) await inspect(path);
    else if (entry.isFile()) files[relative(stage, path).replaceAll('\\', '/')] = hash(await readFile(path));
  }
}
await inspect(resolve(stage, 'server')); await inspect(resolve(stage, 'node'));
const node = resolve(stage, nodeRelative);
const probe = JSON.parse(run(node, ['--input-type=module', '-e',
  "import Database from 'better-sqlite3'; const db = new Database(':memory:'); const sqlite = db.prepare('select sqlite_version() as version').get(); db.close(); console.log(JSON.stringify({node:process.versions.node,abi:process.versions.modules,napi:process.versions.napi,platform:process.platform,arch:process.arch,sqlite:sqlite.version}));"], { cwd: server }));
if (probe.node !== lock.node || probe.abi !== lock.nodeModuleAbi || probe.platform !== process.platform || probe.arch !== process.arch) throw new Error('STAGED_ABI_MISMATCH');
const nativeFiles = Object.keys(files).filter(path => path.endsWith('.node'));
if (!nativeFiles.some(path => path.endsWith(`/prebuilds/${target}.node`))) throw new Error('NATIVE_TARGET_MISSING');
await writeFile(resolve(stage, 'manifest.json'), JSON.stringify({ schemaVersion: 1, protocolVersion: '1.0.0', ...probe,
  nativeFormat: 'Node-API prebuild (better-sqlite3 13.0.3)', sourceCommit: run('git', ['rev-parse', 'HEAD'], { cwd: root }),
  lockSha256: hash(await readFile(resolve(root, 'pnpm-lock.yaml'))), agentReady: false, files }, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ check: 'STAGED_NODE_SQLITE', passed: true, target, ...probe, nativeFiles: nativeFiles.length, installerTest: 'NOT_RUN' }));
