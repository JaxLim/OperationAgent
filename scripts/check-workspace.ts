import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ESLint } from 'eslint';
import { object, readJson } from './p0-check.ts';
import type { JsonObject } from './p0-check.ts';

export const packageDependencies: Record<string, Record<string, string>> = {
  contracts: { zod: '4.6.7' },
  'worker-transport': { '@operation-agent/contracts': 'workspace:*' },
  'platform-worker': { '@operation-agent/contracts': 'workspace:*' },
  'platform-supervision': { '@operation-agent/contracts': 'workspace:*' },
  server: { '@operation-agent/contracts': 'workspace:*', '@operation-agent/worker-transport': 'workspace:*',
    '@operation-agent/platform-worker': 'workspace:*', express: '5.3.0', 'better-sqlite3': '13.0.3' },
  'agent-worker': { '@operation-agent/contracts': 'workspace:*', '@operation-agent/worker-transport': 'workspace:*' },
  desktop: { '@operation-agent/contracts': 'workspace:*', '@operation-agent/platform-supervision': 'workspace:*' },
};
export const packagePaths = Object.keys(packageDependencies).map(name => `${['desktop', 'server', 'agent-worker'].includes(name) ? 'apps' : 'packages'}/${name}`);
const normalized = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => {
  if (item && typeof item === 'object' && !Array.isArray(item)) return Object.fromEntries(Object.entries(item).sort());
  return item;
});

export function validateManifest(name: string, manifest: JsonObject): string[] {
  const errors: string[] = [];
  const need = (ok: boolean, reason: string): void => { if (!ok) errors.push(`${name}: ${reason}`); };
  need(manifest.name === `@operation-agent/${name}` && manifest.private === true && manifest.type === 'module', 'package identity');
  need(normalized(manifest.dependencies) === normalized(packageDependencies[name]), 'dependency direction or pin');
  const dev = name === 'desktop' ? { electron: '45.0.0' } : name === 'server' ? { '@types/express': '5.0.6', '@types/better-sqlite3': '9.6.0' } : {};
  need(normalized(manifest.devDependencies ?? {}) === normalized(dev), 'development dependency boundary');
  for (const field of ['optionalDependencies', 'peerDependencies', 'imports']) need(manifest[field] === undefined, `unreviewed ${field}`);
  if (name === 'desktop') need(manifest.main === 'dist/main/index.js' && manifest.exports === undefined, 'desktop entry');
  else {
    const entry = (file: string): JsonObject => ({ types: `./dist/${file}.d.ts`, import: `./dist/${file}.js` });
    const exports = name === 'platform-worker' ? { './parent': entry('parent'), './child': entry('child') } : { '.': entry('index') };
    need(normalized(manifest.exports) === normalized(exports), 'package export escape');
  }
  return errors;
}

export function validateProject(config: JsonObject, nodeTypes: boolean): string[] {
  const errors: string[] = [];
  const compiler = object(config.compilerOptions);
  const allowedOptions = ['composite', 'module', 'moduleResolution', 'lib', 'types', 'rootDir', 'outDir',
    'declaration', 'declarationMap', 'emitDeclarationOnly', 'tsBuildInfoFile'];
  for (const key of Object.keys(compiler)) if (!allowedOptions.includes(key)) errors.push(`unreviewed compiler override: ${key}`);
  if (config.extends !== '../../tsconfig.base.json') errors.push('unreviewed tsconfig base');
  if (compiler.composite !== true || compiler.declaration !== true) errors.push('project references required');
  if (normalized(compiler.types) !== normalized(nodeTypes ? ['node'] : [])) errors.push('ambient Node type leak');
  for (const key of ['paths', 'baseUrl', 'rootDirs', 'typeRoots', 'plugins']) if (compiler[key] !== undefined) errors.push(`module resolution bypass: ${key}`);
  for (const key of ['strict', 'noUncheckedIndexedAccess', 'exactOptionalPropertyTypes', 'forceConsistentCasingInFileNames', 'skipLibCheck', 'allowJs']) {
    if (compiler[key] !== undefined) errors.push(`base compiler option override: ${key}`);
  }
  return errors;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Source symlink rejected: ${path}`);
    return entry.isDirectory() ? sourceFiles(path) : [path];
  });
}

export async function checkWorkspaceGraph(root: string): Promise<void> {
  const errors: string[] = [];
  const expectedProjects: string[] = [];
  for (const parent of ['apps', 'packages']) {
    const actual = readdirSync(resolve(root, parent)).map(name => `${parent}/${name}`).sort();
    if (normalized(actual) !== normalized(packagePaths.filter(path => path.startsWith(parent + '/')).sort())) errors.push(`unexpected ${parent} packages`);
  }
  for (const path of packagePaths) {
    const name = path.split('/')[1]!;
    errors.push(...validateManifest(name, readJson(resolve(root, path, 'package.json'))));
    const configs = name === 'desktop' ? ['tsconfig.main.json', 'tsconfig.preload.json', 'tsconfig.renderer.json'] : ['tsconfig.json'];
    for (const configName of configs) {
      const config = readJson(resolve(root, path, configName));
      errors.push(...validateProject(config, name === 'server' || configName === 'tsconfig.main.json'));
      const role = configName.split('.')[1]; const compiler = object(config.compilerOptions);
      const isDesktop = name === 'desktop';
      if (normalized(compiler.lib) !== normalized(isDesktop ? ['ES2023', 'DOM'] : ['ES2023'])) errors.push(`${path}/${configName}: ambient library leak`);
      if (compiler.module !== (isDesktop && role !== 'main' ? 'ESNext' : 'NodeNext') ||
        compiler.moduleResolution !== (isDesktop && role !== 'main' ? 'Bundler' : 'NodeNext')) errors.push(`${path}/${configName}: module resolution policy`);
      const src = isDesktop ? `src/${role}` : 'src';
      const outDir = isDesktop ? (role === 'main' ? 'dist/main' : `dist/types/${role}`) : 'dist';
      if (compiler.outDir !== outDir) errors.push(`${path}/${configName}: output path escape`);
      if (compiler.rootDir !== src || normalized(config.include) !== normalized([`${src}/**/*.ts`]) || config.exclude !== undefined || config.files !== undefined) errors.push(`${path}/${configName}: incomplete source coverage`);
      const refs = (config.references as { path: string }[]).map(ref => ref.path).sort();
      let expectedRefs = Object.keys(packageDependencies[name]!).filter(dep => dep.startsWith('@operation-agent/')).map(dep => '../../packages/' + dep.split('/')[1]);
      if (path.startsWith('packages/')) expectedRefs = expectedRefs.map(ref => ref.replace('../../packages/', '../'));
      if (isDesktop && role !== 'main') expectedRefs = ['../../packages/contracts'];
      if (normalized(refs) !== normalized(expectedRefs.sort())) errors.push(`${path}/${configName}: reference direction`);
      expectedProjects.push(isDesktop ? path + '/' + configName : path);
    }
    for (const file of sourceFiles(resolve(root, path, 'src'))) {
      if (!file.endsWith('.ts')) errors.push(`unreviewed source kind: ${file}`);
      if (/\/\/\/\s*<reference/.test(readFileSync(file, 'utf8'))) errors.push(`ambient reference bypass: ${file}`);
    }
  }
  const rootConfig = readJson(resolve(root, 'tsconfig.json'));
  const roots = (rootConfig.references as { path: string }[]).map(ref => ref.path).sort();
  if (normalized(roots) !== normalized([...expectedProjects, 'tsconfig.tools.json'].sort())) errors.push('incomplete root reference graph');
  const results = await new ESLint({ cwd: root }).lintFiles(['apps/**/*.ts', 'packages/**/*.ts']);
  for (const result of results) for (const message of result.messages) if (message.severity === 2) errors.push(`${result.filePath}:${message.line}: ${message.message}`);
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(JSON.stringify({ check: 'PROCESS_DEPENDENCIES', passed: true, packages: packagePaths.length, osIsolationVerified: false }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await checkWorkspaceGraph(resolve('.'));
