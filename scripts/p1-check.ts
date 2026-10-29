import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { object, readJson, validateBaseline } from './p0-check.ts';
import type { JsonObject } from './p0-check.ts';
import { frozenCommit, verifyFrozenFiles } from './p0-history.ts';
export { validateFrozenFiles } from './p0-history.ts';

/** Committed acceptance evidence that a completion claim must be backed by. */
export interface StageEvidence { workerFixture: string; installedSmoke: boolean; installedTarget: string }
const STAGES = ['P1.0', 'P1.1', 'P1.2', 'P1.3', 'P1.4', 'P1.5', 'P1.6', 'P1.7'];

export function validateStage(value: unknown, evidence: StageEvidence = { workerFixture: 'NOT_RUN', installedSmoke: false, installedTarget: '' }): string[] {
  const errors: string[] = [];
  const need = (ok: boolean, message: string): void => { if (!ok) errors.push(message); };
  try {
    const stage = object(value);
    need(stage.schemaVersion === 1 && stage.phase === 'P1', 'P1_STAGE_INVALID');
    need(stage.frozenCommit === frozenCommit, 'P1_BASELINE_CHANGED');
    need(JSON.stringify(stage.authorizedStages) === JSON.stringify(['P1.0', 'P1.1', 'P1.2', 'P1.3', 'P1.4', 'P1.5', 'P1.6', 'P1.7']) && stage.stopAfter === 'P1.7', 'P1_SCOPE_EXCEEDED');
    const authorization = object(stage.authorization);
    need(authorization.kind === 'user-message' && authorization.date === '2026-10-27' &&
      authorization.quote === '正式授权连续实施 P1.4、P1.5、P1.6、P1.7，前提是各阶段的前置依赖与退出门禁已经满足。', 'P1_AUTHORIZATION_MISSING');
    need(stage.agentReady === false && stage.productionWorkerQualified === false, 'P1_FALSE_QUALIFICATION');
    // Windows x64 is the only process/installer target. Every claim needs committed evidence; other
    // platforms can never inherit it.
    const fixturePass = evidence.workerFixture === 'PASS';
    const installedPass = evidence.installedSmoke && evidence.installedTarget === 'win32-x64';
    need(['P1_WIN32_X64', 'P1.2_P1.3_ONLY'].includes(String(stage.integrationTests)), 'P1_FALSE_INTEGRATION_PASS');
    need(stage.workerFixture === (fixturePass ? 'PASS_WIN32_X64_RUNNER' : 'BLOCKED'), 'P1_WORKER_FIXTURE_CLAIM');
    need(stage.installedSmokeTests === (installedPass ? 'PASS_WIN32_X64' : 'NOT_RUN'), 'P1_FALSE_INSTALLED_PASS');
    need(stage.p1TotalExit === (fixturePass && installedPass ? 'PASS_WIN32_X64' : 'NOT_RUN'), 'P1_FALSE_INTEGRATION_PASS');
    const implementation = object(stage.implementation);
    need(Object.keys(implementation).join('|') === STAGES.join('|') &&
      STAGES.every(name => ['implemented', 'blocked', 'in-progress', 'not-started'].includes(String(implementation[name]))) &&
      ['P1.0', 'P1.1', 'P1.2', 'P1.3'].every(name => implementation[name] === 'implemented'), 'P1_IMPLEMENTATION_SCOPE');
    // A stage counts as implemented only when its exit gate has evidence.
    need(implementation['P1.4'] !== 'implemented' || fixturePass, 'P1_IMPLEMENTATION_SCOPE');
    need(implementation['P1.5'] !== 'implemented' || fixturePass, 'P1_IMPLEMENTATION_SCOPE');
    need(implementation['P1.6'] !== 'implemented' || installedPass, 'P1_IMPLEMENTATION_SCOPE');
    need(implementation['P1.7'] !== 'implemented' || (fixturePass && installedPass), 'P1_IMPLEMENTATION_SCOPE');
    const capabilities = object(stage.platformCapabilities);
    need(Object.keys(capabilities).sort().join('|') === ['darwin-arm64', 'linux-x64', 'win32-x64'].join('|'), 'P1_CAPABILITY_MATRIX');
    for (const platform of Object.values(capabilities)) {
      const entry = object(platform);
      need(Object.keys(entry).sort().join('|') === ['gitRead', 'highRisk', 'read', 'ui', 'workerIsolation'].join('|') &&
        Object.values(entry).every(v => v === 'unverified'), 'P1_UNVERIFIED_CAPABILITIES_REQUIRED');
    }
  } catch { errors.push('P1_MALFORMED_STAGE'); }
  return errors;
}

export function checkP1(root: string): void {
  const read = (path: string): JsonObject => readJson(resolve(root, path));
  const runtime = read('build/runtime-lock.json');
  const ci = read('docs/evidence/p1/win32-x64/integration.json');
  const smoke = read('docs/evidence/p1/win32-x64/installed-smoke.json');
  const errors = validateStage(read('build/p1-status.json'), { workerFixture: String(ci.workerFixture),
    installedSmoke: smoke.passed === true && smoke.check === 'P1_INSTALLED_SMOKE_SEC18', installedTarget: String(smoke.target) });
  // Root remains tooling-only; runtime dependencies belong to their owning packages.
  errors.push(...validateBaseline({ manifest: read('package.json'), runtime, status: read('build/p0-status.json'),
    typescript: read('tsconfig.base.json'), builder: read('build/electron-builder.config.json') }));
  if (process.versions.node !== runtime.node || process.versions.modules !== runtime.nodeModuleAbi) errors.push('P1_RUNTIME_MISMATCH');
  if (errors.length) throw new Error(errors.join('\n'));
  verifyFrozenFiles(root);
  const stage = read('build/p1-status.json');
  console.log(JSON.stringify({ check: 'P1_SCOPE_AND_HISTORY', passed: true, stopAfter: 'P1.7', implementation: stage.implementation,
    workerFixture: stage.workerFixture, installedSmoke: stage.installedSmokeTests, p1TotalExit: stage.p1TotalExit, agentReady: false, productionWorkerQualified: false }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) checkP1(resolve('.'));
