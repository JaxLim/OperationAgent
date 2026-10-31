import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { object, readJson } from './p0-check.ts';

const STAGES = ['P2.0', 'P2.1', 'P2.2', 'P2.3'];
// Files whose presence backs a completion claim; their tests run in `pnpm test` and CI.
export const STAGE_FILES = {
  'P2.0': ['packages/contracts/src/events/tool-output.ts', 'packages/contracts/src/events/task.ts', 'tests/p2/contracts.test.ts'],
  'P2.1': ['apps/server/migrations/004-task-events.sql', 'apps/server/src/persistence/tasks.ts', 'tests/p2/task-store.test.ts'],
} as const;
export type StagePresence = Record<keyof typeof STAGE_FILES, boolean>;

/** P2 scope, authorization and claims. P2.2–P2.3 cannot be claimed until their evidence checks exist. */
export function validateP2Stage(value: unknown, p1Stage: unknown, present: StagePresence): string[] {
  const errors: string[] = [];
  const need = (ok: boolean, message: string): void => { if (!ok) errors.push(message); };
  try {
    const stage = object(value);
    need(stage.schemaVersion === 1 && stage.phase === 'P2', 'P2_STAGE_INVALID');
    // P2 starts only from an evidence-backed P1 exit.
    const dependsOn = object(stage.dependsOn);
    need(dependsOn.file === 'build/p1-status.json' && dependsOn.p1TotalExit === 'PASS_WIN32_X64' &&
      object(p1Stage).p1TotalExit === 'PASS_WIN32_X64', 'P2_P1_EXIT_REQUIRED');
    need(JSON.stringify(stage.authorizedStages) === JSON.stringify(STAGES) && stage.stopAfter === 'P2.3', 'P2_SCOPE_EXCEEDED');
    const authorization = object(stage.authorization);
    need(authorization.kind === 'user-message' && authorization.date === '2026-10-30' && authorization.quote === 'Authorize P2.0–P2.3' &&
      authorization.question === 'Which P2 scope do you formally authorize, so I can record it and finish the merge?', 'P2_AUTHORIZATION_MISSING');
    need(stage.agentReady === false && stage.productionWorkerQualified === false, 'P2_FALSE_QUALIFICATION');
    const implementation = object(stage.implementation);
    need(Object.keys(implementation).join('|') === STAGES.join('|') &&
      STAGES.every(name => ['implemented', 'blocked', 'in-progress', 'not-started'].includes(String(implementation[name]))), 'P2_IMPLEMENTATION_SCOPE');
    need(implementation['P2.0'] !== 'implemented' || present['P2.0'], 'P2_IMPLEMENTATION_SCOPE');
    need(implementation['P2.1'] !== 'implemented' || (present['P2.1'] && implementation['P2.0'] === 'implemented'), 'P2_IMPLEMENTATION_SCOPE');
    need(['P2.2', 'P2.3'].every(name => implementation[name] !== 'implemented'), 'P2_IMPLEMENTATION_SCOPE');
    need(stage.p2TotalExit === 'NOT_RUN', 'P2_FALSE_EXIT');
    const capabilities = object(stage.platformCapabilities);
    need(Object.keys(capabilities).sort().join('|') === ['darwin-arm64', 'linux-x64', 'win32-x64'].join('|'), 'P2_CAPABILITY_MATRIX');
    for (const platform of Object.values(capabilities)) {
      const entry = object(platform);
      need(Object.keys(entry).sort().join('|') === ['gitRead', 'highRisk', 'read', 'ui', 'workerIsolation'].join('|') &&
        Object.values(entry).every(v => v === 'unverified'), 'P2_UNVERIFIED_CAPABILITIES_REQUIRED');
    }
  } catch { errors.push('P2_MALFORMED_STAGE'); }
  return errors;
}

export function checkP2(root: string): void {
  const stage = readJson(resolve(root, 'build/p2-status.json'));
  const present = (files: readonly string[]): boolean => files.every(file => existsSync(resolve(root, file)));
  const errors = validateP2Stage(stage, readJson(resolve(root, 'build/p1-status.json')),
    { 'P2.0': present(STAGE_FILES['P2.0']), 'P2.1': present(STAGE_FILES['P2.1']) });
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(JSON.stringify({ check: 'P2_SCOPE', passed: true, stopAfter: 'P2.3', implementation: stage.implementation,
    p2TotalExit: stage.p2TotalExit, agentReady: false, productionWorkerQualified: false }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) checkP2(resolve('.'));
