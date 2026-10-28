import { FoundationInfoSchema } from '@operation-agent/contracts';
import type { DesktopApi } from '@operation-agent/contracts';

declare global { interface Window { readonly operationAgent: DesktopApi } }
const status = document.querySelector('#status');
try {
  const info = FoundationInfoSchema.parse(window.operationAgent.getFoundationInfo());
  if (status) status.textContent = `${info.phase} 工程骨架 · Agent 未启用`;
} catch {
  if (status) status.textContent = '工程宿主不可用';
}
