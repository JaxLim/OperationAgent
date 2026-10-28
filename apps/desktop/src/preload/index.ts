import { contextBridge, ipcRenderer } from 'electron';
import { FoundationInfoSchema, PROTOCOL_VERSION, ControlHealthSchema, SmokeRecordsSchema, SmokeBatchSchema, IPC_CHANNELS } from '@operation-agent/contracts';
import type { DesktopApi } from '@operation-agent/contracts';

const info = FoundationInfoSchema.parse({ protocolVersion: PROTOCOL_VERSION, component: 'preload',
  instanceId: crypto.randomUUID(), phase: 'P1.3', controlPlaneReady: false, agentReady: false });
const api: DesktopApi = {
  getFoundationInfo: () => FoundationInfoSchema.parse(info),
  getControlPlaneHealth: async () => ControlHealthSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.health, {})),
  listSmokeRecords: async () => SmokeRecordsSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.listRecords, {})),
  writeSmokeRecords: async input => SmokeRecordsSchema.parse(await ipcRenderer.invoke(IPC_CHANNELS.writeRecords, SmokeBatchSchema.parse(input))),
};
contextBridge.exposeInMainWorld('operationAgent', Object.freeze(api));
