import { ControlHealthSchema } from '@operation-agent/contracts';
import type { DesktopApi } from '@operation-agent/contracts';

declare global { interface Window { readonly operationAgent: DesktopApi } }
const status = document.querySelector('#status');
async function refresh(): Promise<void> {
  try {
    const info = ControlHealthSchema.parse(await window.operationAgent.getControlPlaneHealth());
    if (status) status.textContent = `P1.3 控制面已连接 · 数据库 v${info.databaseVersion} · Agent 未启用`;
  } catch { if (status) status.textContent = '控制面暂不可用 · Agent 未启用'; }
}
void refresh();
setInterval(() => { void refresh(); }, 2000);
