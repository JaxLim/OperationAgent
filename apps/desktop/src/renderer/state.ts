import { useSyncExternalStore } from 'react';
import { catchUpTaskEvents } from '@operation-agent/contracts';
import type { ClaudeModel, ControlOverview, ControlRun, DesktopApi, DesktopStatus, ModelSettingsView, ModelTestResult, Project, TaskEvent, TaskSnapshot, TaskState,
  WorkbenchSettings } from '@operation-agent/contracts';

declare global { interface Window { readonly operationAgent: DesktopApi } }

// The Renderer only mirrors views returned by Main/Express. It never decides capability or success itself.

export type Connection = 'connecting' | 'ready' | 'restarting' | 'unavailable';
export interface Submission { readonly id: string; readonly projectId: string; readonly prompt: string; readonly at: number;
  readonly outcome: 'refused' | 'failed'; readonly code: string }
export interface Notice { readonly id: number; readonly tone: 'ok' | 'warn' | 'danger'; readonly text: string }
/**
 * A task's committed log as this window has applied it. `appliedSeq`/`replayed` are the catch-up cursor; the
 * snapshot from Express stays the source of truth and any disagreement is shown, never resolved locally.
 */
export interface TaskView {
  readonly events: readonly TaskEvent[];
  readonly appliedSeq: number;
  readonly replayed: TaskState | null;
  readonly sync: 'syncing' | 'synced' | 'error';
  readonly error: string | null;
  /** When the last successful catch-up finished (diagnostic only). */
  readonly syncedAt: number;
}
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
  tasks: TaskSnapshot[];
  taskViews: Readonly<Record<string, TaskView>>;
  selectedTaskId: string | null;
  /** Model choice and credential status as Express reports them; never key material. */
  model: ModelSettingsView | null;
  modelTest: { state: 'idle' | 'running' } | { state: 'done'; result: ModelTestResult } | { state: 'failed'; code: string };
}

let state: AppState = { connection: 'connecting', desktop: null, overview: null, settings: null, projects: [], runs: [],
  submissions: [], notices: [], loaded: false, tasks: [], taskViews: {}, selectedTaskId: null, model: null, modelTest: { state: 'idle' } };
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
  const [settings, projects, runs, overview, model] = await Promise.all([api().getSettings(), api().listProjects(), api().listRuns(), api().getOverview(),
    api().getModelSettings()]);
  let active = settings;
  // Keep the remembered project valid; otherwise fall back to the first registered one.
  if (!projects.projects.some(project => project.id === settings.activeProjectId)) {
    const fallback = projects.projects[0]?.id ?? null;
    if (fallback !== settings.activeProjectId) active = await api().saveSettings({ ...settings, activeProjectId: fallback });
  }
  set({ settings: active, projects: projects.projects, runs: runs.runs, overview, model, loaded: true });
}

const EMPTY_VIEW: TaskView = { events: [], appliedSeq: 0, replayed: null, sync: 'syncing', error: null, syncedAt: 0 };
const syncing = new Set<string>();
/**
 * Snapshot first, then pull the events after this window's cursor (ARCHITECTURE §7.3 rule 5). Nothing depends on
 * the Express instance's memory, so a restart simply resumes from the cursor. A cursor the log no longer reaches,
 * or any inconsistent page, restarts from zero once; a second failure is shown as out of sync.
 */
async function syncTask(taskId: string): Promise<void> {
  if (syncing.has(taskId)) return;
  syncing.add(taskId);
  const put = (view: TaskView): void => set({ taskViews: { ...state.taskViews, [taskId]: view } });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const cached = attempt === 0 ? state.taskViews[taskId] ?? EMPTY_VIEW : EMPTY_VIEW;
      put({ ...cached, sync: 'syncing', error: null });
      let snapshot: TaskSnapshot;
      try { snapshot = await api().getTask({ taskId }); }
      catch (error) { put({ ...cached, sync: 'error', error: errorCode(error) }); return; }
      set({ tasks: state.tasks.map(task => task.id === taskId ? snapshot : task) });
      if (cached.appliedSeq > snapshot.lastSeq) continue;
      let result: Awaited<ReturnType<typeof catchUpTaskEvents>>;
      try { result = await catchUpTaskEvents(taskId, cached.appliedSeq, cached.replayed, afterSeq => api().listTaskEvents({ taskId, afterSeq })); }
      catch (error) { if (errorCode(error) === 'CURSOR_AHEAD') continue; put({ ...cached, sync: 'error', error: errorCode(error) }); return; }
      if (!result.ok) { if (attempt === 0) continue; put({ ...cached, sync: 'error', error: result.error }); return; }
      const events = [...cached.events, ...result.events];
      // The replay must land on the committed snapshot; more events may have been committed meanwhile, never fewer.
      const consistent = result.lastSeq > snapshot.lastSeq || result.state === snapshot.state;
      put({ events, appliedSeq: result.lastSeq, replayed: result.state, sync: consistent ? 'synced' : 'error', error: consistent ? null : 'STATE_MISMATCH',
        syncedAt: Date.now() });
      return;
    }
    put({ ...EMPTY_VIEW, sync: 'error', error: 'CURSOR_AHEAD' });
  } finally { syncing.delete(taskId); }
}
async function loadTasks(): Promise<void> {
  const { tasks } = await api().listTasks();
  set({ tasks });
  const selected = tasks.find(task => task.id === state.selectedTaskId);
  if (selected && selected.lastSeq !== (state.taskViews[selected.id]?.appliedSeq ?? -1)) await syncTask(selected.id);
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
    if (desktop.service.expressRunId !== lastRunId || !state.loaded) {
      await loadDomain(); lastRunId = desktop.service.expressRunId;
      // A new instance re-reads committed state; the selected task resumes from its cursor.
      const selected = state.selectedTaskId;
      if (selected && state.taskViews[selected]) set({ taskViews: { ...state.taskViews, [selected]: { ...state.taskViews[selected]!, sync: 'syncing' } } });
      await loadTasks();
      if (selected && state.taskViews[selected]?.sync === 'syncing') await syncTask(selected);
    } else {
      const overview = await api().getOverview();
      set({ overview });
      // Express is the source of truth: re-read its data whenever the shown list has drifted from it.
      if (overview.database.projects !== state.projects.length) await loadDomain();
      await loadTasks();
    }
  } catch { if (state.connection === 'ready') set({ connection: 'unavailable' }); }
  finally { polling = false; }
}
export function startPolling(): void { void poll(); setInterval(() => { void poll(); }, 2_000); }

export const actions = {
  selectTask(taskId: string | null): void {
    set({ selectedTaskId: taskId });
    if (taskId) void syncTask(taskId);
  },
  async resyncTask(taskId: string): Promise<void> {
    set({ taskViews: { ...state.taskViews, [taskId]: EMPTY_VIEW } });
    await syncTask(taskId);
  },
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
  async selectProject(id: string): Promise<void> { set({ selectedTaskId: null }); await actions.saveSettings({ activeProjectId: id }); },
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
  async refreshModel(): Promise<void> {
    try { set({ model: await api().getModelSettings() }); } catch { /* The status banner reports availability. */ }
  },
  async saveModelChoice(model: ClaudeModel): Promise<void> {
    const previous = state.model;
    if (!previous || previous.model === model) return;
    set({ model: { ...previous, model }, modelTest: { state: 'idle' } });
    try { set({ model: await api().saveModelChoice({ model }) }); }
    catch (error) { set({ model: previous }); notify('danger', `Model was not saved (${errorCode(error)}).`); }
  },
  /**
   * Hands the key to Main once. It is not kept in this store; the caller clears its input. Returns the fixed error
   * code on failure so the form can explain it without ever echoing the value.
   */
  async setApiKey(apiKey: string): Promise<string | null> {
    try { set({ model: await api().setApiKey({ apiKey }), modelTest: { state: 'idle' } }); return null; }
    catch (error) { return errorCode(error); }
  },
  async clearApiKey(): Promise<void> {
    try { set({ model: await api().clearApiKey(), modelTest: { state: 'idle' } }); notify('ok', 'API key removed from this device.'); }
    catch (error) { notify('danger', `The key was not removed (${errorCode(error)}).`); }
  },
  async testModel(): Promise<void> {
    if (state.modelTest.state === 'running') return;
    set({ modelTest: { state: 'running' } });
    try { set({ modelTest: { state: 'done', result: await api().testModelConnection() } }); }
    catch (error) { set({ modelTest: { state: 'failed', code: errorCode(error) } }); }
  },
  async refreshRuns(): Promise<void> {
    try { set({ runs: (await api().listRuns()).runs, overview: await api().getOverview() }); } catch { /* The status banner reports availability. */ }
  },
};
