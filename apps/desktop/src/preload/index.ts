import { contextBridge, ipcRenderer } from 'electron';
import { ControlHealthSchema, ControlOverviewSchema, ControlRunListSchema, DesktopStatusSchema, FoundationInfoSchema, IPC_CHANNELS,
  PROTOCOL_VERSION, ProjectAddResultSchema, ProjectListSchema, ProjectRefSchema, SmokeBatchSchema, SmokeRecordsSchema,
  TaskEventPageSchema, TaskEventsQuerySchema, TaskListSchema, TaskRefSchema, TaskSnapshotSchema, TaskStartInputSchema, TaskStartResultSchema,
  WorkbenchSettingsSchema } from '@operation-agent/contracts';
import type { DesktopApi } from '@operation-agent/contracts';

const info = FoundationInfoSchema.parse({ protocolVersion: PROTOCOL_VERSION, component: 'preload',
  instanceId: crypto.randomUUID(), phase: 'P1', controlPlaneReady: false, agentReady: false });
// Fixed operations only: inputs and replies are schema-checked on both sides of the bridge.
const api: DesktopApi = {
  getFoundationInfo: () => FoundationInfoSchema.parse(info),
  getControlPlaneHealth: async () => ControlHealthSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.health, {})),
  listSmokeRecords: async () => SmokeRecordsSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.listRecords, {})),
  writeSmokeRecords: async input => SmokeRecordsSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.writeRecords, SmokeBatchSchema.parse(input))),
  getDesktopStatus: async () => DesktopStatusSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.desktopStatus, {})),
  retryControlPlane: async () => DesktopStatusSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.retryControlPlane, {})),
  getOverview: async () => ControlOverviewSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.overview, {})),
  getSettings: async () => WorkbenchSettingsSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.getSettings, {})),
  saveSettings: async input => WorkbenchSettingsSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.saveSettings, WorkbenchSettingsSchema.parse(input))),
  listProjects: async () => ProjectListSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.listProjects, {})),
  addProject: async () => ProjectAddResultSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.addProject, {})),
  removeProject: async input => ProjectListSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.removeProject, ProjectRefSchema.parse(input))),
  listRuns: async () => ControlRunListSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.listRuns, {})),
  startTask: async input => TaskStartResultSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.startTask, TaskStartInputSchema.parse(input))),
  listTasks: async () => TaskListSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.listTasks, {})),
  getTask: async input => TaskSnapshotSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.getTask, TaskRefSchema.parse(input))),
  listTaskEvents: async input => TaskEventPageSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.listTaskEvents, TaskEventsQuerySchema.parse(input))),
};
contextBridge.exposeInMainWorld('operationAgent', Object.freeze(api));
