import { z } from 'zod';
import { PROTOCOL_VERSION } from '../version/index.js';
import { ServiceTreeIdentitySchema } from '../ipc/identity.js';

// Product-shell domain owned by Express: preferences, registered project metadata and run history.
// A project is only a remembered folder path. P1 never reads, lists or writes workspace files.

export const WORKBENCH_LIMITS = Object.freeze({ maxProjects: 50, maxRuns: 50, maxPromptChars: 8_000, maxPathChars: 1_024, maxNameChars: 80 });

export const WorkbenchSettingsSchema = z.strictObject({
  theme: z.enum(['system', 'light', 'dark']),
  density: z.enum(['comfortable', 'compact']),
  contextPanel: z.boolean(),
  // ADR-009: default 5 s, allowed 5–30 s; out-of-range values are rejected, never clamped.
  stopGraceMs: z.number().int().min(5_000).max(30_000),
  activeProjectId: z.uuid().nullable(),
});
export type WorkbenchSettings = z.infer<typeof WorkbenchSettingsSchema>;
export const DEFAULT_WORKBENCH_SETTINGS: WorkbenchSettings = Object.freeze({
  theme: 'system', density: 'comfortable', contextPanel: true, stopGraceMs: 5_000, activeProjectId: null,
});

const windowsAbsolute = /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/;
export const ProjectPathSchema = z.string().min(1).max(WORKBENCH_LIMITS.maxPathChars)
  .refine(value => (windowsAbsolute.test(value) || value.startsWith('/')) && !value.includes('\u0000'), 'ABSOLUTE_PATH_REQUIRED');
export const ProjectInputSchema = z.strictObject({ name: z.string().trim().min(1).max(WORKBENCH_LIMITS.maxNameChars), path: ProjectPathSchema });
export const ProjectSchema = ProjectInputSchema.extend({ id: z.uuid(), createdAt: z.iso.datetime() });
export type Project = z.infer<typeof ProjectSchema>;
export const ProjectListSchema = z.strictObject({ projects: z.array(ProjectSchema).max(WORKBENCH_LIMITS.maxProjects) });
export type ProjectList = z.infer<typeof ProjectListSchema>;
export const ProjectRefSchema = z.strictObject({ id: z.uuid() });
export type ProjectRef = z.infer<typeof ProjectRefSchema>;

export const ControlRunSchema = z.strictObject({ id: z.uuid(), startedAt: z.iso.datetime(), endedAt: z.iso.datetime().nullable(),
  outcome: z.enum(['RUNNING', 'CLEAN', 'INTERRUPTED']) });
export type ControlRun = z.infer<typeof ControlRunSchema>;
export const ControlRunListSchema = z.strictObject({ runs: z.array(ControlRunSchema).max(WORKBENCH_LIMITS.maxRuns) });
export type ControlRunList = z.infer<typeof ControlRunListSchema>;

export const TaskStartInputSchema = z.strictObject({ projectId: z.uuid(), prompt: z.string().trim().min(1).max(WORKBENCH_LIMITS.maxPromptChars) });
export type TaskStartInput = z.infer<typeof TaskStartInputSchema>;
/** P1 has no qualified Worker: every task start is refused before any execution is scheduled. */
export const TaskStartResultSchema = z.strictObject({ accepted: z.literal(false), error: z.literal('WORKER_ISOLATION_UNAVAILABLE') });
export type TaskStartResult = z.infer<typeof TaskStartResultSchema>;

export const CapabilityStatusSchema = z.enum(['unverified', 'unavailable']);
export const CapabilityMatrixSchema = z.strictObject({ ui: CapabilityStatusSchema, read: CapabilityStatusSchema, gitRead: CapabilityStatusSchema,
  highRisk: CapabilityStatusSchema, workerIsolation: CapabilityStatusSchema });
export type CapabilityMatrix = z.infer<typeof CapabilityMatrixSchema>;
export const ControlOverviewSchema = z.strictObject({
  protocolVersion: z.literal(PROTOCOL_VERSION), ...ServiceTreeIdentitySchema.shape,
  controlPlaneReady: z.literal(true), agentReady: z.literal(false),
  startedAt: z.iso.datetime(), uptimeMs: z.number().int().nonnegative(),
  runtime: z.strictObject({ node: z.string().max(32), abi: z.string().max(8), sqlite: z.string().max(32), platform: z.string().max(16), arch: z.string().max(16) }),
  database: z.strictObject({ version: z.literal(4), recoveredRuns: z.number().int().nonnegative(), projects: z.number().int().nonnegative(),
    runs: z.number().int().nonnegative(), records: z.number().int().nonnegative() }),
  worker: z.strictObject({ state: z.literal('unavailable'), error: z.literal('WORKER_ISOLATION_UNAVAILABLE'),
    reason: z.literal('SEC_W01_NOT_PASSED'), fixtureLaunch: z.literal('disabled-in-release') }),
  tools: z.strictObject({ read: z.literal('READ_ADAPTER_UNAVAILABLE'), highRisk: z.literal('SANDBOX_UNAVAILABLE') }),
  capabilities: CapabilityMatrixSchema,
});
export type ControlOverview = z.infer<typeof ControlOverviewSchema>;
