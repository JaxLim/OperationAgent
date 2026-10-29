// P1.6 Windows x64 packaging: bundles Main into a dependency-free app directory, then builds the NSIS
// installer with the verified Node sidecar as an extra resource. The sidecar's better-sqlite3 stays on
// the pinned Node ABI; nothing is rebuilt for Electron because Electron never loads it.
import { build as viteBuild } from 'vite';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const lock = JSON.parse(await readFile(resolve(root, 'build/runtime-lock.json'), 'utf8'));
if (process.platform !== 'win32' || process.arch !== 'x64' || process.versions.node !== lock.node) throw new Error('LOCKED_WINDOWS_X64_RUNTIME_REQUIRED');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const desktop = JSON.parse(await readFile(resolve(root, 'apps/desktop/package.json'), 'utf8'));
const app = resolve(root, 'build/app');
if (!app.startsWith(resolve(root, 'build') + sep)) throw new Error('APP_PATH_ESCAPE');
const stage = resolve(root, 'build/stage/win-x64/sidecar');
const manifest = JSON.parse(await readFile(resolve(stage, 'manifest.json'), 'utf8'));
if (manifest.node !== lock.node || manifest.abi !== lock.nodeModuleAbi || manifest.agentReady !== false) throw new Error('STAGED_SIDECAR_INVALID');
// The staged sidecar must be built from this exact commit and lockfile.
const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).stdout.trim();
if (manifest.sourceCommit !== head || manifest.lockSha256 !== hash(await readFile(resolve(root, 'pnpm-lock.yaml')))) throw new Error('STAGED_SIDECAR_STALE: run stage:sidecar');

await rm(app, { recursive: true, force: true }); await mkdir(resolve(app, 'dist'), { recursive: true });
// Main: one ESM file; contracts and zod are inlined, only Electron and Node builtins stay external.
await viteBuild({ configFile: false, logLevel: 'warn', build: {
  outDir: resolve(app, 'dist/main'), emptyOutDir: true, target: 'node22', minify: false, ssr: true, copyPublicDir: false,
  rolldownOptions: { input: resolve(root, 'apps/desktop/src/main/index.ts'), external: ['electron', /^node:/],
    output: { format: 'es', entryFileNames: 'index.js', codeSplitting: false } },
} });
for (const part of ['renderer', 'preload']) await cp(resolve(root, 'apps/desktop/dist', part), resolve(app, 'dist', part), { recursive: true });
await writeFile(resolve(app, 'package.json'), JSON.stringify({ name: 'operation-agent', productName: 'OperationAgent', version: desktop.version,
  description: 'OperationAgent desktop workbench (Phase 1: control plane, persistence, projects; agent execution gated)',
  author: 'JaxLim', license: 'UNLICENSED', type: 'module', main: 'dist/main/index.js' }, null, 2) + '\n');

const { build } = await import('electron-builder');
// electron-builder detects the package manager from this field; npm finds no dependencies to collect.
// The P0 base config stays byte-frozen; the P1 Windows overlay adds installer, icon and fuse settings.
const base = JSON.parse(await readFile(resolve(root, 'build/electron-builder.config.json'), 'utf8'));
const overlay = JSON.parse(await readFile(resolve(root, 'build/electron-builder.windows.json'), 'utf8'));
const config = { ...base, ...overlay };
if (config.npmRebuild !== false || config.nodeGypRebuild !== false || config.publish !== null || config.electronVersion !== lock.electron) throw new Error('BUILDER_BASELINE_VIOLATED');
const output = resolve(root, config.directories.output);
await rm(output, { recursive: true, force: true });
const electronDist = resolve(root, 'apps/desktop/node_modules/electron/dist');
if ((await readFile(resolve(electronDist, 'version'), 'utf8')).trim().replace(/^v/, '') !== lock.electron) throw new Error('ELECTRON_DIST_MISMATCH: run prepare:electron');
const signing = Boolean(process.env.CSC_LINK || process.env.WIN_CSC_LINK);
// The bundled app has no dependencies: build it as its own npm project so electron-builder never walks
// the pnpm workspace. All configured paths are made absolute against the repository root.
const absolute = path => resolve(root, path);
const { Platform, Arch } = await import('electron-builder');
await build({ projectDir: app, targets: Platform.WINDOWS.createTarget('nsis', Arch.x64), publish: 'never', config: { ...config, electronDist,
  directories: { app, output, buildResources: absolute(config.directories.buildResources) },
  extraResources: config.extraResources.map(entry => ({ ...entry, from: absolute(entry.from) })),
  win: { ...config.win, icon: absolute(config.win.icon) },
  nsis: { ...config.nsis, installerIcon: absolute(config.nsis.installerIcon), uninstallerIcon: absolute(config.nsis.uninstallerIcon) } } });

const installerName = `OperationAgent-${desktop.version}-win-x64.exe`;
const installer = resolve(output, installerName);
const unpacked = resolve(output, 'win-unpacked');
for (const required of [installer, resolve(unpacked, 'OperationAgent.exe'), resolve(unpacked, 'resources/app.asar'), resolve(unpacked, 'resources/sidecar/manifest.json'),
  resolve(unpacked, 'resources/sidecar/node/node.exe')]) await stat(required);
// The packaged sidecar must be byte-identical to the verified stage.
const packaged = JSON.parse(await readFile(resolve(unpacked, 'resources/sidecar/manifest.json'), 'utf8'));
if (JSON.stringify(packaged) !== JSON.stringify(manifest)) throw new Error('PACKAGED_SIDECAR_MISMATCH');
for (const [name, expected] of Object.entries(manifest.files)) {
  if (hash(await readFile(resolve(unpacked, 'resources/sidecar', name))) !== expected) throw new Error('PACKAGED_SIDECAR_INTEGRITY: ' + name);
}
const evidence = { check: 'P1_WINDOWS_PACKAGE', passed: true, builtAt: new Date().toISOString(), source: head, version: desktop.version,
  installer: { file: installerName, bytes: (await stat(installer)).size, sha256: hash(await readFile(installer)) },
  electron: lock.electron, sidecar: { node: manifest.node, abi: manifest.abi, sqlite: manifest.sqlite, files: Object.keys(manifest.files).length },
  fuses: config.electronFuses, codeSigned: signing, signingNote: signing ? 'signed with CSC_LINK certificate' : 'unsigned: no certificate configured (set CSC_LINK/CSC_KEY_PASSWORD to sign)',
  unpackedFiles: (await readdir(unpacked)).length, agentReady: false };
const evidenceDirectory = resolve(root, 'artifacts/p1/win32-x64'); await mkdir(evidenceDirectory, { recursive: true });
await writeFile(resolve(evidenceDirectory, 'package.json'), JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify(evidence));
