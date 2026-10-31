import { contextBridge, ipcRenderer } from 'electron';
import { ApiKeyInputSchema, ControlHealthSchema, ControlOverviewSchema, ControlRunListSchema, DesktopStatusSchema, FoundationInfoSchema, IPC_CHANNELS,
  PROTOCOL_VERSION, ProjectAddResultSchema, ProjectListSchema, ProjectRefSchema, SmokeBatchSchema, SmokeRecordsSchema,
  TaskEventPageSchema, TaskEventsQuerySchema, TaskListSchema, TaskRefSchema, TaskSnapshotSchema, TaskStartInputSchema, TaskStartResultSchema,
  WorkbenchSettingsSchema, ModelChoiceSchema, ModelSettingsViewSchema, ModelTestResultSchema } from '@operation-agent/contracts';
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
  getModelSettings: async () => ModelSettingsViewSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.getModelSettings, {})),
  saveModelChoice: async input => ModelSettingsViewSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.saveModelChoice, ModelChoiceSchema.parse(input))),
  // The key crosses once, inward. A local validation failure reports a fixed code, never the rejected value.
  setApiKey: async input => {
    const parsed = ApiKeyInputSchema.safeParse(input);
    if (!parsed.success) throw new Error('VALIDATION_ERROR');
    return ModelSettingsViewSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.setApiKey, parsed.data));
  },
  clearApiKey: async () => ModelSettingsViewSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.clearApiKey, {})),
  testModelConnection: async () => ModelTestResultSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.testModelConnection, {})),
};
contextBridge.exposeInMainWorld('operationAgent', Object.freeze(api));
