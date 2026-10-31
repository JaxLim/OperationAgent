// Assembles the fixed P1 fixture runtime: pinned node.exe, the bundled trusted bootstrap and channel.node.
// It is a test artifact for the disposable Windows runner; release staging never includes it.
import { build } from 'vite';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const lock = JSON.parse(await readFile(resolve(root, 'build/runtime-lock.json'), 'utf8'));
if (process.platform !== 'win32' || process.arch !== 'x64' || process.version !== `v${lock.node}`) throw new Error('LOCKED_WINDOWS_X64_RUNTIME_REQUIRED');
const cache = resolve(root, '.cache');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const node = resolve(root, '.tools/node/node.exe');
if (hash(await readFile(node)) !== lock.windowsBootstrap.sha256) throw new Error('NODE_CHECKSUM_MISMATCH');

// The release-shaped fixture, and a separate SEC-W01 probe runtime that plays a compromised Worker. Both run
// only on a disposable runner; the probe source lives under tests/ and is never part of any release staging.
async function assemble(name, entry) {
  const output = resolve(cache, 'worker-fixture', name);
  if (!output.startsWith(cache + sep)) throw new Error('FIXTURE_PATH_ESCAPE');
  await rm(output, { recursive: true, force: true }); await mkdir(output, { recursive: true });
  await cp(node, resolve(output, 'node.exe'));
  await cp(resolve(root, 'packages/platform-worker/native-dist/win32-x64/channel.node'), resolve(output, 'channel.node'));
  await build({ configFile: false, logLevel: 'warn', build: {
    outDir: output, emptyOutDir: false, target: 'node24', minify: false, ssr: true, copyPublicDir: false,
    rolldownOptions: { input: entry, external: [/^node:/], output: { format: 'es', entryFileNames: 'bootstrap.mjs', codeSplitting: false } },
  } });
  // Package-scope lookups stop here instead of walking into ancestors the AppContainer cannot read.
  await writeFile(resolve(output, 'package.json'), JSON.stringify({ name: `operation-agent-worker-${name}`, private: true, type: 'module' }, null, 2) + '\n');
  const files = {};
  for (const file of ['node.exe', 'bootstrap.mjs', 'channel.node', 'package.json']) files[file] = hash(await readFile(resolve(output, file)));
  await writeFile(resolve(cache, `worker-fixture/${name}.json`), JSON.stringify({ node: lock.node, files }, null, 2) + '\n');
  return { output, files };
}
const fixture = await assemble('runtime', resolve(root, 'apps/agent-worker/bootstrap/fixture-bootstrap.mjs'));
const probe = await assemble('probe-runtime', resolve(root, 'tests/worker-fixture/probe-bootstrap.mjs'));
console.log(JSON.stringify({ check: 'P1_WORKER_FIXTURE_RUNTIME', passed: true, output: fixture.output, files: fixture.files, probe: probe.output }));
