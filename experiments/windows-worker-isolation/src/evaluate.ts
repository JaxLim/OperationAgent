import { z } from 'zod';
import { HostEvent, HostConfig, Probe, Mode } from './contracts.js';

export type Status = 'PASS' | 'FAILED' | 'UNKNOWN';
export const CaseRecord = z.strictObject({
  mode: Mode, scenario: HostConfig.shape.scenario, runId: z.uuid(), supervisorPid: z.number().nullable(),
  hostPid: z.number().int().positive(), workerPid: z.number().int().nonnegative(),
  elapsedMs: z.number(), killCleanupMs: z.number().nullable(),
  exit: z.strictObject({ code: z.number().nullable(), signal: z.string().nullable() }),
  failure: z.string().nullable(), stderr: z.string(), workerAliveAfter: z.boolean(), expressAliveAfter: z.boolean(),
  events: z.array(HostEvent).max(2000),
});
export function denied(attempt: { allowed: boolean; error: number }, codes: number[]): Status {
  return attempt.allowed ? 'FAILED' : codes.includes(attempt.error) ? 'PASS' : 'UNKNOWN';
}
export function combine(statuses: Status[]): Status {
  if (statuses.includes('FAILED')) return 'FAILED';
  return statuses.length > 0 && statuses.every(s => s === 'PASS') ? 'PASS' : 'UNKNOWN';
}
export function evaluate(raw: unknown): Record<string, Status> {
  const record = CaseRecord.parse(raw);
  const messages = record.events.filter(e => e.kind === 'worker-message').map(e => e.data);
  const ready = messages.find(m => 'method' in m);
  const later = messages.find(m => 'id' in m && m.id === 2);
  const parsed = later && 'result' in later ? Probe.safeParse(later.result) : undefined;
  const probes = ready && 'params' in ready && parsed?.success ? [ready.params.early, parsed.data] : [];
  const launchEvent = record.events.find(e => e.kind === 'worker-launched');
  const launch = launchEvent?.data;
  const native = launch && launch.path === 'native-startup-attributes' ? launch : undefined;
  const answer = messages.find(m => 'id' in m && m.id === 1);
  const stale = messages.find(m => 'id' in m && m.id === 3);
  const badSchema = messages.find(m => 'id' in m && m.id === 0);
  const result: Record<string, Status> = {
    stockForkApi: record.mode.startsWith('fork') ? 'PASS' : 'FAILED',
    directExpressParent: probes.length ? combine(probes.map(p => p.identity.ppid === record.hostPid ? 'PASS' : 'FAILED')) : 'UNKNOWN',
    osRestrictedBeforeFirstInstruction: native ? native.suspendedBeforeVerification && native.beforeResume.appContainer && native.beforeResume.integrityRid === 4096 && native.beforeResume.capabilityCount === 0 && native.creatorPid === record.hostPid && native.beforeResume.ppid === record.hostPid ? 'PASS' : 'FAILED' : record.mode.startsWith('fork') ? 'FAILED' : 'UNKNOWN',
    legalNodeIpcRpc: answer && 'result' in answer && answer.result && 'challenge' in answer.result && answer.result.challenge === 'challenge-1' && answer.result.pid === record.workerPid && probes.length === 2 && probes.every(p => p.rpcAvailable) ? 'PASS' : record.failure ? 'FAILED' : 'UNKNOWN',
    staleInstanceRejected: stale && 'error' in stale && stale.error?.code === -32001 ? 'PASS' : 'UNKNOWN',
    invalidSchemaRejected: badSchema && 'error' in badSchema && badSchema.error?.code === -32600 ? 'PASS' : 'UNKNOWN',
    protectedFileReadWrite: combine(probes.flatMap(p => p.files.flatMap(f => [denied(f.nativeRead, [5]), denied(f.nativeWrite, [5]), f.nodeRead.allowed || f.nodeWrite.allowed ? 'FAILED' : ['EPERM', 'EACCES'].includes(f.nodeRead.code) && ['EPERM', 'EACCES'].includes(f.nodeWrite.code) ? 'PASS' : 'UNKNOWN']))),
    externalTcpDenied: combine(probes.map(p => denied(p.externalTcp, [10013]))),
    loopbackTcpDenied: combine(probes.map(p => denied(p.loopbackTcp, [10013]))),
    nativeChildCreationDenied: combine(probes.flatMap(p => [denied(p.nativeSpawn, [5, 367]), denied(p.breakawaySpawn, [5, 367])])),
    dangerousParentHandleDenied: combine(probes.map(p => denied(p.parentAccess, [5]))),
    credentialHandleNotInherited: native ? combine(probes.map(p => p.canaryHandle.resolved ? 'FAILED' : p.canaryHandle.error === 6 ? 'PASS' : 'UNKNOWN')) : 'UNKNOWN',
    nodeSpawnApi: 'UNKNOWN',
    cleanupScenario: 'UNKNOWN',
    installedApplication: 'UNKNOWN', startupRaceStress: 'UNKNOWN', restartBudget: 'UNKNOWN', otherWindowsBuildsAndArchitectures: 'UNKNOWN', macosLinux: 'UNKNOWN',
  };
  if (record.scenario === 'node-spawn') {
    const response = messages.find(m => 'id' in m && m.id === 5);
    if (response && 'result' in response && response.result && 'nodeSpawn' in response.result) {
      const value = response.result.nodeSpawn;
      result.nodeSpawnApi = value.allowed ? 'FAILED' : ['EPERM', 'EACCES'].includes(value.code) ? 'PASS' : 'UNKNOWN';
    }
  }
  const scenarioReached = record.events.some(e => e.kind === 'scenario');
  const clean = !record.workerAliveAfter && !record.expressAliveAfter;
  const cleanup = record.events.find(e => e.kind === 'cleanup');
  if (scenarioReached) {
    const withinDeadline = record.killCleanupMs !== null ? record.killCleanupMs < 5000 : cleanup?.data.nativeResult && 'wait' in cleanup.data.nativeResult && cleanup.data.nativeResult.wait === 0;
    result.cleanupScenario = clean && withinDeadline ? 'PASS' : 'FAILED';
  }
  return result;
}
