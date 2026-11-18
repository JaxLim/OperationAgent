import { contextBridge, ipcRenderer } from 'electron';
import { GitHubSkillCatalogSchema, GitHubSkillPreviewRequestSchema, GitHubSkillSourceSchema, ProjectSkillPreviewRequestSchema,
  ProjectSkillPreviewSchema, ProjectSkillsSchema, SetProjectSkillSchema } from '@operation-agent/contracts';
import { CustomProviderInputSchema, CustomProviderRefSchema, HfConfigSchema, HfLoginChallengeSchema, HfLoginInputSchema,
  HfLoginStateSchema, HfSessionSchema, UsagePageSchema, UsageQuerySchema } from '@operation-agent/contracts';
import { ApiKeyInputSchema, ControlHealthSchema, ControlOverviewSchema, ControlRunListSchema, DesktopStatusSchema, FoundationInfoSchema, IPC_CHANNELS,
  PROTOCOL_VERSION, ProjectAddResultSchema, ProjectListSchema, ProjectRefSchema, SmokeBatchSchema, SmokeRecordsSchema,
  TaskEventPageSchema, TaskEventsQuerySchema, TaskHistorySearchInputSchema, TaskHistorySearchSchema, TaskLivePageSchema, TaskLiveQuerySchema,
  TaskMessagePageSchema, TaskMessagesQuerySchema, TaskListSchema, TaskRefSchema, TaskSnapshotSchema, TaskStartInputSchema, TaskStartResultSchema,
  WorkbenchSettingsSchema, ModelChoiceSchema, ModelSettingsViewSchema, ModelTestResultSchema, ProviderKeyInputSchema, ProviderOverviewViewSchema,
  ProviderRefSchema, LinkedProviderRefSchema, ProviderTestResultSchema, ProviderModelListSchema, ProviderModelChoiceSchema, AgentListSchema, AgentSaveSchema,
  AgentRefSchema, McpServerListSchema, McpServerSaveSchema, McpServerRefSchema } from '@operation-agent/contracts';
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
  searchTaskHistory: async input =>
    TaskHistorySearchSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.searchTaskHistory, TaskHistorySearchInputSchema.parse(input))),
  getTask: async input => TaskSnapshotSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.getTask, TaskRefSchema.parse(input))),
  listTaskMessages: async input => TaskMessagePageSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.listTaskMessages, TaskMessagesQuerySchema.parse(input))),
  readTaskLive: async input => TaskLivePageSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.readTaskLive, TaskLiveQuerySchema.parse(input))),
  stopTask: async input => TaskSnapshotSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.stopTask, TaskRefSchema.parse(input))),
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
  getProviders: async () => ProviderOverviewViewSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.getProviders, {})),
  listUsage: async input => UsagePageSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.listUsage, UsageQuerySchema.parse(input))),
  saveCustomProvider: async input => {
    const parsed = CustomProviderInputSchema.safeParse(input);
    if (!parsed.success) throw new Error('VALIDATION_ERROR');
    return ProviderOverviewViewSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.saveCustomProvider, parsed.data));
  },
  removeCustomProvider: async input => ProviderOverviewViewSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.removeCustomProvider, CustomProviderRefSchema.parse(input))),
  beginHfLogin: async input => HfLoginChallengeSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.beginHfLogin, HfLoginInputSchema.parse(input))),
  pollHfLogin: async input => HfLoginStateSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.pollHfLogin, HfSessionSchema.parse(input))),
  cancelHfLogin: async input => HfLoginStateSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.cancelHfLogin, HfSessionSchema.parse(input))),
  configureHf: async input => ProviderOverviewViewSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.configureHf, HfConfigSchema.parse(input))),
  setProviderKey: async input => {
    const parsed = ProviderKeyInputSchema.safeParse(input);
    if (!parsed.success) throw new Error('VALIDATION_ERROR');
    return ProviderOverviewViewSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.setProviderKey, parsed.data));
  },
  clearProviderKey: async input => ProviderOverviewViewSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.clearProviderKey, ProviderRefSchema.parse(input))),
  testProvider: async input => ProviderTestResultSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.testProvider, LinkedProviderRefSchema.parse(input))),
  listProviderModels: async input => ProviderModelListSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.listProviderModels, LinkedProviderRefSchema.parse(input))),
  saveProviderModel: async input =>
    ProviderOverviewViewSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.saveProviderModel, ProviderModelChoiceSchema.parse(input))),
  listAgents: async () => AgentListSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.listAgents, {})),
  listProjectSkills: async input =>
    ProjectSkillsSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.listProjectSkills, ProjectRefSchema.parse(input))),
  previewProjectSkill: async input =>
    ProjectSkillPreviewSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.previewProjectSkill, ProjectSkillPreviewRequestSchema.parse(input))),
  listGitHubSkills: async input => GitHubSkillCatalogSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.listGitHubSkills, GitHubSkillSourceSchema.parse(input))),
  previewGitHubSkill: async input =>
    ProjectSkillPreviewSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.previewGitHubSkill, GitHubSkillPreviewRequestSchema.parse(input))),
  setProjectSkill: async input => { await ipcRenderer.invoke(IPC_CHANNELS.setProjectSkill, SetProjectSkillSchema.parse(input)); },
  saveAgent: async input => AgentListSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.saveAgent, AgentSaveSchema.parse(input))),
  removeAgent: async input => AgentListSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.removeAgent, AgentRefSchema.parse(input))),
  listMcpServers: async () => McpServerListSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.listMcpServers, {})),
  saveMcpServer: async input => McpServerListSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.saveMcpServer, McpServerSaveSchema.parse(input))),
  removeMcpServer: async input => McpServerListSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.removeMcpServer, McpServerRefSchema.parse(input))),
};
contextBridge.exposeInMainWorld('operationAgent', Object.freeze(api));
