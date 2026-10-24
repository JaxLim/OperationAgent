// A single schema source for this isolated experiment, never a production contract.
import { z } from 'zod';

export const protocol = 'dec001/1' as const;
export const Mode = z.enum(['fork', 'fork-job', 'plain-native', 'restricted', 'appcontainer', 'lpac', 'lowbox']);
export const Identity = z.strictObject({
  pid: z.number().int().positive(), ppid: z.number().int().nonnegative(),
  appContainer: z.boolean(), restricted: z.boolean(), elevated: z.boolean(),
  integrityRid: z.number().int(), capabilityCount: z.number().int(), restrictedSidCount: z.number().int(),
  appContainerSid: z.string().max(256), childPolicyQuerySucceeded: z.boolean(), noChildProcessCreation: z.boolean(), inJob: z.boolean(),
});
export const Attempt = z.strictObject({ allowed: z.boolean(), error: z.number().int() });
export const NodeAttempt = z.strictObject({ allowed: z.boolean(), code: z.string().max(64) });
export const Boot = z.strictObject({
  protocol: z.literal(protocol), runId: z.uuid(), parentPid: z.number().int().positive(),
  mode: Mode, node: z.string().max(4096), addon: z.string().max(4096),
  targets: z.array(z.strictObject({ label: z.string().max(64), path: z.string().max(4096) })).min(3).max(12),
  loopbackPort: z.number().int().min(1).max(65535), leakHandle: z.number().nonnegative(),
  ignoreDisconnect: z.boolean(),
});
export type BootConfig = z.infer<typeof Boot>;
export const Probe = z.strictObject({
  identity: Identity,
  files: z.array(z.strictObject({ label: z.string(), nativeRead: Attempt, nativeWrite: Attempt, nodeRead: NodeAttempt, nodeWrite: NodeAttempt })).max(12),
  externalTcp: Attempt, loopbackTcp: Attempt,
  nativeSpawn: Attempt, breakawaySpawn: Attempt, nodeSpawn: NodeAttempt, parentAccess: Attempt,
  canaryHandle: z.strictObject({ resolved: z.boolean(), path: z.string().max(32768), error: z.number().int(), exceptionCode: z.number().int() }),
  nodePermissionEnabled: z.boolean(), rpcAvailable: z.boolean(),
});
export const Request = z.strictObject({
  jsonrpc: z.literal('2.0'), protocol: z.literal(protocol), runId: z.uuid(), id: z.number().int().positive(),
  method: z.enum(['hello', 'probe', 'hang', 'shutdown', 'node-spawn']), params: z.strictObject({ challenge: z.string().max(128) }),
});
export const Response = z.strictObject({
  jsonrpc: z.literal('2.0'), protocol: z.literal(protocol), runId: z.uuid(), id: z.number().int().nonnegative(),
  result: z.union([Probe, z.strictObject({ challenge: z.string().max(128), pid: z.number().int().positive() }), z.strictObject({ nodeSpawn: NodeAttempt })]).optional(),
  error: z.strictObject({ code: z.union([z.literal(-32600), z.literal(-32001)]), message: z.string().max(128), data: z.strictObject({ reason: z.enum(['VALIDATION_ERROR', 'STALE_RUN_ID']) }) }).optional(),
}).refine(value => Boolean(value.result) !== Boolean(value.error), 'Exactly one result or error is required');
export const Ready = z.strictObject({
  jsonrpc: z.literal('2.0'), protocol: z.literal(protocol), runId: z.uuid(), method: z.literal('ready'),
  params: z.strictObject({ early: Probe }),
});
export const WorkerMessage = z.union([Ready, Response]);
export type WorkerMessageValue = z.infer<typeof WorkerMessage>;
export const LaunchResult = z.strictObject({
  id: z.number().int().positive(), pid: z.number().int().positive(), beforeResume: Identity,
  creatorPid: z.number().int().positive(), suspendedBeforeVerification: z.boolean(), jobAssignedAtCreation: z.boolean(),
  leakHandle: z.number().nonnegative(), inheritedHandleCount: z.number().int(), rpcChannelCount: z.number().int(),
  profileCreated: z.boolean(), lpacRequested: z.boolean(),
});
export const HostConfig = z.strictObject({
  runId: z.uuid(), mode: Mode, runtime: z.string(), moniker: z.string(),
  targets: Boot.shape.targets, scenario: z.enum(['permissions', 'disconnect', 'hang', 'parent-kill', 'main-kill', 'node-spawn']),
});
const event = <K extends string, S extends z.ZodType>(kind: K, data: S) => z.strictObject({ kind: z.literal(kind), runId: z.uuid(), data });
export const HostEvent = z.discriminatedUnion('kind', [
  event('host-ready', z.strictObject({ identity: Identity, port: z.number().int().positive(), mode: Mode, expressVersion: z.literal('5.3.0') })),
  event('worker-launched', z.union([
    z.strictObject({ path: z.literal('stock-fork'), pid: z.number().int().positive(), parentPid: z.number().int().positive(), jobAssignedAfterCreate: z.boolean() }),
    LaunchResult.extend({ path: z.literal('native-startup-attributes') }),
  ])),
  event('worker-message', WorkerMessage),
  event('cleanup', z.strictObject({ reason: z.string().max(128), pid: z.number().int().nonnegative(), elapsedMs: z.number().nonnegative(), nativeResult: z.union([z.null(), z.strictObject({ killRequested: z.boolean() }), z.strictObject({ wait: z.number().int(), exitCode: z.number().int() })]), aliveImmediatelyAfter: z.boolean() })),
  event('failure', z.union([z.strictObject({ message: z.string().max(4096) }), z.strictObject({ workerExitCode: z.number().int(), step: z.number().int() })])),
  event('raw-frame', z.strictObject({ direction: z.enum(['worker-to-host', 'host-to-worker']), bytes: z.string().max(90000) })),
  event('scenario', z.union([
    z.strictObject({ action: z.literal('disconnect'), graceMs: z.literal(5000) }),
    z.strictObject({ action: z.literal('worker-hung'), pid: z.number().int().positive(), scenario: HostConfig.shape.scenario, graceMs: z.literal(5000) }),
  ])),
  event('diagnostic', z.strictObject({ text: z.string().max(4096) })),
]);
