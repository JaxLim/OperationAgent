import { contextBridge } from 'electron';
import { FoundationInfoSchema, PROTOCOL_VERSION } from '@operation-agent/contracts';
import type { DesktopApi } from '@operation-agent/contracts';

const info = FoundationInfoSchema.parse({ protocolVersion: PROTOCOL_VERSION, component: 'preload',
  instanceId: crypto.randomUUID(), phase: 'P1.1', controlPlaneReady: false, agentReady: false });
const api: DesktopApi = { getFoundationInfo: () => FoundationInfoSchema.parse(info) };
contextBridge.exposeInMainWorld('operationAgent', Object.freeze(api));
