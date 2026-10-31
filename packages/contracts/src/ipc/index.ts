import { z } from 'zod';
import { PROTOCOL_VERSION } from '../version/index.js';
import type { ControlHealth, SmokeBatch, SmokeRecords } from '../api/index.js';
import type { ControlOverview, ControlRunList, ProjectList, ProjectRef, TaskStartInput, TaskStartResult, WorkbenchSettings } from '../api/workbench.js';
import { ProjectSchema } from '../api/workbench.js';
import type { TaskEventPage, TaskEventsQuery, TaskList, TaskRef } from '../api/tasks.js';
import type { TaskSnapshot } from '../events/task.js';
export { ServiceTreeIdentitySchema } from './identity.js';
export type { ServiceTreeIdentity } from './identity.js';

// Local build metadata is separate from the authenticated asynchronous health API.
export const FoundationInfoSchema = z.strictObject({
  protocolVersion: z.literal(PROTOCOL_VERSION), component: z.literal('preload'), instanceId: z.uuid(),
  phase: z.literal('P1'), controlPlaneReady: z.literal(false), agentReady: z.literal(false),
});
export type FoundationInfo = z.infer<typeof FoundationInfoSchema>;
// Every channel is a fixed, typed operation. There is no generic request, path, exec or secret channel.
export const IPC_CHANNELS = Object.freeze({
  health: 'oa:control-health', listRecords: 'oa:smoke-list', writeRecords: 'oa:smoke-write',
  desktopStatus: 'oa:desktop-status', retryControlPlane: 'oa:control-retry', overview: 'oa:control-overview',
  getSettings: 'oa:settings-get', saveSettings: 'oa:settings-save', listProjects: 'oa:projects-list',
  addProject: 'oa:projects-add', removeProject: 'oa:projects-remove', listRuns: 'oa:runs-list', startTask: 'oa:tasks-start',
  listTasks: 'oa:tasks-list', getTask: 'oa:tasks-snapshot', listTaskEvents: 'oa:tasks-events',
});
export const EmptyInputSchema = z.strictObject({});

/** Main-local view of the supervised Express service tree; it carries no business state. */
export const DesktopStatusSchema = z.strictObject({
  app: z.strictObject({ name: z.literal('OperationAgent'), version: z.string().max(32), electron: z.string().max(32),
    platform: z.string().max(16), arch: z.string().max(16), packaged: z.boolean() }),
  service: z.strictObject({ state: z.enum(['stopped', 'starting', 'ready', 'unavailable', 'stopping', 'budget-exhausted']),
    restarts: z.number().int().nonnegative(), expressRunId: z.uuid().nullable() }),
});
export type DesktopStatus = z.infer<typeof DesktopStatusSchema>;
/** Main opens the native folder picker; the Renderer never supplies a path. */
export const ProjectAddResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('added'), project: ProjectSchema }),
  z.strictObject({ status: z.literal('cancelled') }),
]);
export type ProjectAddResult = z.infer<typeof ProjectAddResultSchema>;

export interface DesktopApi {
  getFoundationInfo(): FoundationInfo;
  getControlPlaneHealth(): Promise<ControlHealth>;
  listSmokeRecords(): Promise<SmokeRecords>;
  writeSmokeRecords(input: SmokeBatch): Promise<SmokeRecords>;
  getDesktopStatus(): Promise<DesktopStatus>;
  retryControlPlane(): Promise<DesktopStatus>;
  getOverview(): Promise<ControlOverview>;
  getSettings(): Promise<WorkbenchSettings>;
  saveSettings(input: WorkbenchSettings): Promise<WorkbenchSettings>;
  listProjects(): Promise<ProjectList>;
  addProject(): Promise<ProjectAddResult>;
  removeProject(input: ProjectRef): Promise<ProjectList>;
  listRuns(): Promise<ControlRunList>;
  startTask(input: TaskStartInput): Promise<TaskStartResult>;
  /** Read-only task views (P2.2): committed snapshots and cursor pages; nothing here starts or changes a task. */
  listTasks(): Promise<TaskList>;
  getTask(input: TaskRef): Promise<TaskSnapshot>;
  listTaskEvents(input: TaskEventsQuery): Promise<TaskEventPage>;
}
