import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { object, readJson } from './p0-check.ts';
import { evaluateSecW01 } from './sec-w01-rules.ts';

const MILESTONES = ['M1', 'M2', 'M3', 'M4'];
const QUOTES = [
  'Complete P2.3, then autonomously plan and implement subsequent milestones toward a fully functional desktop Agent.',
  'Yes, use Claude',
  'Then proceed autonomously with M1–M4, prioritizing usable Agent functionality.',
];
const PLATFORMS = ['darwin-arm64', 'linux-x64', 'win32-x64'];
/** Committed CI evidence for a platform's SEC-W01 run (integration.json + raw sec-w01.json); absent means NOT_RUN. */
export interface SecW01Evidence { integration: unknown; report: unknown }

/** Every reason this evidence cannot prove PASS: the run's own verdict, the raw report's rules, and provenance. */
export function secW01EvidenceViolations(evidence: SecW01Evidence | undefined): string[] {
  if (!evidence) return ['EVIDENCE_MISSING'];
  const integration = object(evidence.integration);
  const violations = evaluateSecW01(evidence.report);
  if (integration.secW01 !== 'PASS') violations.push(`INTEGRATION_SEC_W01_${String(integration.secW01)}`);
  // The raw report must come from the very run whose integration record is committed alongside it.
  if (typeof integration.source !== 'string' || object(evidence.report).source !== integration.source) violations.push('PROVENANCE_MISMATCH');
  return violations;
}

/** Milestone scope and the user's authorization; SEC-W01 PASS and Worker qualification need committed evidence. */
export function validateAgentStage(value: unknown, evidence: Record<string, SecW01Evidence | undefined>): string[] {
  const errors: string[] = [];
  const need = (ok: boolean, message: string): void => { if (!ok) errors.push(message); };
  try {
    const stage = object(value);
    need(stage.schemaVersion === 1 && stage.phase === 'AGENT' && object(stage.dependsOn).file === 'build/p2-status.json', 'AGENT_STAGE_INVALID');
    need(JSON.stringify(stage.authorizedMilestones) === JSON.stringify(MILESTONES), 'AGENT_SCOPE_EXCEEDED');
    const authorization = object(stage.authorization);
    need(authorization.kind === 'user-message' && authorization.date === '2026-10-31' && JSON.stringify(authorization.quotes) === JSON.stringify(QUOTES) &&
      authorization.modelProvider === 'anthropic-claude', 'AGENT_AUTHORIZATION_MISSING');
    const milestones = object(stage.milestones);
    need(Object.keys(milestones).join('|') === MILESTONES.join('|') &&
      MILESTONES.every(name => ['implemented', 'in-progress', 'blocked', 'not-started'].includes(String(milestones[name]))), 'AGENT_MILESTONES_INVALID');
    const secW01 = object(stage.secW01);
    need(Object.keys(secW01).sort().join('|') === PLATFORMS.join('|'), 'AGENT_SEC_W01_MATRIX');
    for (const platform of PLATFORMS) {
      const claim = String(secW01[platform]); const proof = evidence[platform];
      need(['NOT_RUN', 'FAILED', 'PASS'].includes(claim), 'AGENT_SEC_W01_MATRIX');
      // PASS only with a committed runner report whose integration row passed; nothing else can be claimed.
      if (claim === 'PASS') for (const violation of secW01EvidenceViolations(proof)) errors.push(`AGENT_SEC_W01_UNPROVEN_${platform}:${violation}`);
    }
    // The Worker gate never opens on its own: it needs SEC-W01 PASS on Windows and M1 implemented.
    need(stage.productionWorkerQualified === false || (secW01['win32-x64'] === 'PASS' && milestones.M1 === 'implemented'), 'AGENT_FALSE_QUALIFICATION');
    need(milestones.M1 !== 'implemented' || secW01['win32-x64'] === 'PASS', 'AGENT_M1_UNPROVEN');
    need(stage.agentReady === false || (stage.productionWorkerQualified === true && milestones.M2 === 'implemented'), 'AGENT_FALSE_READINESS');
  } catch { errors.push('AGENT_MALFORMED_STAGE'); }
  return errors;
}

export function checkAgent(root: string): void {
  const stage = readJson(resolve(root, 'build/agent-status.json'));
  const evidence: Record<string, SecW01Evidence | undefined> = {};
  for (const platform of PLATFORMS) {
    const integration = resolve(root, `docs/evidence/m1/${platform}/integration.json`);
    const report = resolve(root, `docs/evidence/m1/${platform}/sec-w01.json`);
    if (existsSync(integration)) evidence[platform] = { integration: readJson(integration), report: existsSync(report) ? readJson(report) : null };
  }
  const errors = validateAgentStage(stage, evidence);
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(JSON.stringify({ check: 'AGENT_SCOPE', passed: true, milestones: stage.milestones, secW01: stage.secW01,
    agentReady: stage.agentReady, productionWorkerQualified: stage.productionWorkerQualified }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) checkAgent(resolve('.'));
