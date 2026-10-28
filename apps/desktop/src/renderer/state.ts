import { useSyncExternalStore } from 'react';
import type { ControlOverview, ControlRun, DesktopApi, DesktopStatus, Project, WorkbenchSettings } from '@operation-agent/contracts';

declare global { interface Window { readonly operationAgent: DesktopApi } }

// The Renderer only mirrors views returned by Main/Express. It never decides capability or success itself.

export type Connection = 'connecting' | 'ready' | 'restarting' | 'unavailable';
export interface Submission { readonly id: string; readonly projectId: string; readonly prompt: string; readonly at: number;
  readonly outcome: 'refused' | 'failed'; readonly code: string }
export interface Notice { readonly id: number; readonly tone: 'ok' | 'warn' | 'danger'; readonly text: string }
export interface AppState {
  connection: Connection;
  desktop: DesktopStatus | null;
  overview: ControlOverview | null;
  settings: WorkbenchSettings | null;
  projects: Project[];
  runs: ControlRun[];
  submissions: Submission[];
  notices: Notice[];
  loaded: boolean;
}

let state: AppState = { connection: 'connecting', desktop: null, overview: null, settings: null, projects: [], runs: [],
  submissions: [], notices: [], loaded: false };
const listeners = new Set<() => void>();
function set(next: Partial<AppState>): void { state = { ...state, ...next }; for (const listener of listeners) listener(); }
export const store = {
  get: (): AppState => state,
  subscribe(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; },
};
export function useStore<T>(select: (value: AppState) => T): T {
  return useSyncExternalStore(store.subscribe, () => select(state));
}

const api = (): DesktopApi => window.operationAgent;
/** Extracts the fixed control-plane code Main forwards; anything else is reported generically. */
export function errorCode(error: unknown): string {
  const match = error instanceof Error ? /([A-Z][A-Z_]{3,})\s*$/.exec(error.message) : null;
  return match?.[1] ?? 'CONTROL_PLANE_REQUEST_FAILED';
}
let noticeId = 0;
export function notify(tone: Notice['tone'], text: string): void {
  const notice = { id: ++noticeId, tone, text };
  set({ notices: [...state.notices.slice(-2), notice] });
  setTimeout(() => set({ notices: state.notices.filter(item => item.id !== notice.id) }), 4_500);
}

async function loadDomain(): Promise<void> {
  const [settings, projects, runs, overview] = await Promise.all([api().getSettings(), api().listProjects(), api().listRuns(), api().getOverview()]);
  let active = settings;
  // Keep the remembered project valid; otherwise fall back to the first registered one.
  if (!projects.projects.some(project => project.id === settings.activeProjectId)) {
    const fallback = projects.projects[0]?.id ?? null;
    if (fallback !== settings.activeProjectId) active = await api().saveSettings({ ...settings, activeProjectId: fallback });
  }
  set({ settings: active, projects: projects.projects, runs: runs.runs, overview, loaded: true });
}

let lastRunId: string | null = null;
let polling = false;
async function poll(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    const desktop = await api().getDesktopStatus();
    const ready = desktop.service.state === 'ready';
    set({ desktop, connection: ready ? 'ready' : desktop.service.state === 'starting' ? (state.loaded ? 'restarting' : 'connecting') :
      desktop.service.state === 'stopped' && !state.loaded ? 'connecting' : 'unavailable' });
    if (!ready) return;
    // A new Express instance means a restart happened: reload everything it owns.
    if (desktop.service.expressRunId !== lastRunId || !state.loaded) { await loadDomain(); lastRunId = desktop.service.expressRunId; }
    else set({ overview: await api().getOverview() });
  } catch { if (state.connection === 'ready') set({ connection: 'unavailable' }); }
  finally { polling = false; }
}
export function startPolling(): void { void poll(); setInterval(() => { void poll(); }, 2_000); }

export const actions = {
  async retry(): Promise<void> {
    set({ connection: 'restarting' });
    try { set({ desktop: await api().retryControlPlane() }); } catch { notify('danger', 'Restart failed. The control plane is still unavailable.'); }
    await poll();
  },
  async saveSettings(patch: Partial<WorkbenchSettings>): Promise<void> {
    if (!state.settings) return;
    const previous = state.settings; const next = { ...previous, ...patch };
    set({ settings: next });
    try { set({ settings: await api().saveSettings(next) }); }
    catch (error) { set({ settings: previous }); notify('danger', `Settings were not saved (${errorCode(error)}).`); }
  },
  async selectProject(id: string): Promise<void> { await actions.saveSettings({ activeProjectId: id }); },
  async addProject(): Promise<void> {
    try {
      const result = await api().addProject();
      if (result.status === 'cancelled') return;
      set({ projects: (await api().listProjects()).projects });
      await actions.saveSettings({ activeProjectId: result.project.id });
      notify('ok', `Added ${result.project.name}. Only the folder path is stored; nothing inside it is read.`);
    } catch (error) {
      const code = errorCode(error);
      notify('danger', code === 'RECORD_CONFLICT' ? 'That folder is already registered.' : code === 'LIMIT_EXCEEDED' ? 'Project limit reached (50).' : `Could not add the project (${code}).`);
    }
  },
  async removeProject(id: string): Promise<void> {
    try {
      const list = await api().removeProject({ id });
      set({ projects: list.projects, submissions: state.submissions.filter(item => item.projectId !== id) });
      set({ settings: await api().getSettings() });
      if (state.settings && !state.settings.activeProjectId && list.projects[0]) await actions.selectProject(list.projects[0].id);
    } catch (error) { notify('danger', `Could not remove the project (${errorCode(error)}).`); }
  },
  async submitTask(projectId: string, prompt: string): Promise<void> {
    const at = Date.now(); const id = crypto.randomUUID();
    let outcome: Submission['outcome'] = 'refused'; let code: string;
    try { code = (await api().startTask({ projectId, prompt })).error; }
    catch (error) { outcome = 'failed'; code = errorCode(error); }
    set({ submissions: [...state.submissions, { id, projectId, prompt, at, outcome, code }].slice(-20) });
  },
  async refreshRuns(): Promise<void> {
    try { set({ runs: (await api().listRuns()).runs, overview: await api().getOverview() }); } catch { /* The status banner reports availability. */ }
  },
};
