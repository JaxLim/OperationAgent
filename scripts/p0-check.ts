import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inspectDecision } from './p0-decision.ts';
import type { DecisionAssessment } from './p0-decision.ts';

export type JsonObject = Record<string, unknown>;

export function object(value: unknown): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected a JSON object');
  }
  return value as JsonObject;
}

export function readJson(path: string): JsonObject {
  return object(JSON.parse(readFileSync(path, 'utf8')) as unknown);
}

export interface Baseline {
  manifest: JsonObject;
  runtime: JsonObject;
  status: JsonObject;
  typescript: JsonObject;
  builder: JsonObject;
}

export function validateBaseline(input: Baseline): string[] {
  const errors: string[] = [];
  const require = (condition: boolean, message: string): void => {
    if (!condition) errors.push(message);
  };
  const { manifest, runtime, status, typescript, builder } = input;
  require(manifest.private === true, 'Root package must be private');
  require(manifest.packageManager === `pnpm@${String(runtime.pnpm)}`, 'pnpm pin mismatch');
  require(object(manifest.engines).node === runtime.node, 'Node pin mismatch');
  require(Object.keys(object(manifest.dependencies ?? {})).length === 0, 'No application dependencies in P0');
  for (const [name, version] of Object.entries(object(manifest.devDependencies))) {
    require(typeof version === 'string' && /^\d+\.\d+\.\d+$/.test(version), `Unpinned dependency: ${name}`);
  }
  const compiler = object(typescript.compilerOptions);
  for (const key of ['strict', 'noUncheckedIndexedAccess', 'exactOptionalPropertyTypes', 'forceConsistentCasingInFileNames']) {
    require(compiler[key] === true, `Required TypeScript option: ${key}`);
  }
  require(Array.isArray(compiler.types) && compiler.types.length === 0, 'Base types must not leak Node into Renderer');
  require(builder.electronVersion === runtime.electron, 'Electron pin mismatch');
  require(builder.npmRebuild === false && builder.nodeGypRebuild === false, 'Sidecar native modules must not be rebuilt for Electron');
  require(builder.publish === null, 'P0 must not publish application binaries');
  require(status.phase === 'P0' && status.p1Started === false, 'P0 scope exceeded');
  require(['review-pending', 'frozen'].includes(String(status.status)), 'Unknown P0 status');
  require(Array.isArray(status.blockers) && status.blockers.every(x => typeof x === 'string'), 'Blockers must be explicit identifiers');
  if (status.status === 'frozen') {
    require(Array.isArray(status.blockers) && status.blockers.length === 0, 'Cannot freeze unresolved blockers');
  }
  for (const [platform, capabilities] of Object.entries(object(status.platformCapabilities))) {
    for (const [capability, value] of Object.entries(object(capabilities))) {
      require(value === 'unverified', `P0 cannot claim ${platform}/${capability} verified`);
    }
  }
  for (const platform of ['win32-x64', 'darwin-arm64', 'linux-x64']) {
    const capabilities = object(status.platformCapabilities)[platform];
    require(capabilities !== undefined, `Missing platform capability matrix: ${platform}`);
    if (capabilities !== undefined) for (const capability of ['ui', 'read', 'gitRead', 'highRisk', 'workerIsolation']) {
      require(object(capabilities)[capability] === 'unverified', `Missing platform capability: ${platform}/${capability}`);
    }
  }
  const artifacts = object(runtime.artifacts);
  for (const target of ['win32-x64', 'win32-arm64', 'darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64']) {
    const artifact = object(artifacts[target]);
    require(typeof artifact.sha256 === 'string' && /^[a-f0-9]{64}$/.test(artifact.sha256), `Missing checksum: ${target}`);
    require(typeof artifact.file === 'string' && artifact.file.startsWith(`node-v${String(runtime.node)}-`) && !artifact.file.includes('..'), `Invalid runtime artifact: ${target}`);
  }
  return errors;
}

export function requireP0Exit(status: JsonObject, decision?: DecisionAssessment): void {
  if (status.status !== 'frozen' || !Array.isArray(status.blockers) || status.blockers.length !== 0) {
    throw new Error('P0_NOT_FROZEN: resolve the recorded architecture decision before P1');
  }
  if (!decision || decision.approval !== 'approved') throw new Error('P0_DECISION_NOT_APPROVED: explicit approval of the current decision package is required');
  if (decision.specifications !== 'updated') throw new Error('P0_SPECIFICATIONS_NOT_UPDATED: approved normative changes must be applied');
  if (!decision.evidenceVerified || decision.errors.length) throw new Error('P0_DECISION_EVIDENCE_INVALID: inspect decision package errors');
}

export function checkWorkspace(root: string, requireFrozen: boolean): void {
  const input: Baseline = {
    manifest: readJson(resolve(root, 'package.json')),
    runtime: readJson(resolve(root, 'build/runtime-lock.json')),
    status: readJson(resolve(root, 'build/p0-status.json')),
    typescript: readJson(resolve(root, 'tsconfig.base.json')),
    builder: readJson(resolve(root, 'build/electron-builder.config.json')),
  };
  const errors = validateBaseline(input);
  const decision = inspectDecision(root);
  errors.push(...decision.errors);
  if (process.versions.node !== input.runtime.node) errors.push(`Expected Node ${String(input.runtime.node)}, got ${process.versions.node}`);
  if (process.versions.modules !== input.runtime.nodeModuleAbi) errors.push('Node ABI mismatch');
  if (readFileSync(resolve(root, '.node-version'), 'utf8').trim() !== input.runtime.node) errors.push('.node-version mismatch');
  for (const name of ['ARCHITECTURE.md', 'AGENTS.md']) {
    const actual = createHash('sha256').update(readFileSync(resolve(root, name))).digest('hex');
    if (actual !== object(input.status.specificationHashes)[name]) errors.push(`Normative document changed: ${name}`);
  }
  for (const path of ['apps', 'packages']) {
    if (existsSync(resolve(root, path))) errors.push(`P0 must not create application skeleton: ${path}`);
  }
  if (errors.length > 0) throw new Error(errors.join('\n'));
  if (requireFrozen || input.status.status === 'frozen') requireP0Exit(input.status, decision);
  console.log(JSON.stringify({ check: 'P0_METADATA', passed: true, phaseStatus: input.status.status, blockers: input.status.blockers,
    decisionApproval: decision.approval, specificationRevision: decision.specifications, feasibilityEvidenceVerified: decision.evidenceVerified,
    decisionPackageSha256: decision.packageSha256, applicationTestsRun: false, productionWorkerQualified: false }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // Resolve from cwd so both source and compiled tooling verify the chosen checkout.
  const root = fileURLToPath(pathToFileURL(`${resolve('.').replaceAll('\\', '/')}/`));
  checkWorkspace(root, process.argv.includes('--require-frozen'));
}
