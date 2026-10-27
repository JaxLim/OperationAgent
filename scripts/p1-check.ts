import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { object, readJson, validateBaseline } from './p0-check.ts';
import type { JsonObject } from './p0-check.ts';
import { frozenCommit, verifyFrozenFiles } from './p0-history.ts';
export { validateFrozenFiles } from './p0-history.ts';

export function validateStage(value: unknown): string[] {
  const errors: string[] = [];
  const need = (ok: boolean, message: string): void => { if (!ok) errors.push(message); };
  try {
    const stage = object(value);
    need(stage.schemaVersion === 1 && stage.phase === 'P1', 'P1_STAGE_INVALID');
    need(stage.frozenCommit === frozenCommit, 'P1_BASELINE_CHANGED');
    need(JSON.stringify(stage.authorizedStages) === JSON.stringify(['P1.0', 'P1.1', 'P1.2', 'P1.3']) && stage.stopAfter === 'P1.3', 'P1_SCOPE_EXCEEDED');
    const authorization = object(stage.authorization);
    need(authorization.kind === 'user-message' && authorization.date === '2026-10-25' &&
      authorization.quote === '正式授权继续 OperationAgent 项目开发，进入 P1.2 和 P1.3 阶段。', 'P1_AUTHORIZATION_MISSING');
    need(stage.agentReady === false && stage.productionWorkerQualified === false, 'P1_FALSE_QUALIFICATION');
    need(stage.integrationTests === 'P1.2_P1.3_ONLY' && stage.installedSmokeTests === 'NOT_RUN' && stage.p1TotalExit === 'NOT_RUN', 'P1_FALSE_INTEGRATION_PASS');
    const implementation = object(stage.implementation);
    need(Object.keys(implementation).join('|') === 'P1.0|P1.1|P1.2|P1.3' && implementation['P1.0'] === 'implemented' &&
      implementation['P1.1'] === 'implemented' && ['P1.2', 'P1.3'].every(stage => ['in-progress', 'implemented'].includes(String(implementation[stage]))), 'P1_IMPLEMENTATION_SCOPE');
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
  const errors = validateStage(read('build/p1-status.json'));
  // Root remains tooling-only; runtime dependencies belong to their owning packages.
  errors.push(...validateBaseline({ manifest: read('package.json'), runtime, status: read('build/p0-status.json'),
    typescript: read('tsconfig.base.json'), builder: read('build/electron-builder.config.json') }));
  if (process.versions.node !== runtime.node || process.versions.modules !== runtime.nodeModuleAbi) errors.push('P1_RUNTIME_MISMATCH');
  if (errors.length) throw new Error(errors.join('\n'));
  verifyFrozenFiles(root);
  console.log(JSON.stringify({ check: 'P1_SCOPE_AND_HISTORY', passed: true, stopAfter: 'P1.3', integrationScope: 'P1.2_P1.3_ONLY', p1TotalExit: 'NOT_RUN', productionWorkerQualified: false }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) checkP1(resolve('.'));
