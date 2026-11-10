import { useSyncExternalStore } from 'react';
import { catchUpTaskEvents } from '@operation-agent/contracts';
import type { Agent, AgentSave, ClaudeModel, ControlOverview, ControlRun, CredentialSlot, DesktopApi, DesktopStatus, LinkedProvider, McpServer, McpServerSave,
  ModelSettingsView, ModelTestResult, Project, ProviderModelList, ProviderOverviewView, ProviderTestResult, TaskEvent, TaskMessageView, TaskSnapshot,
  TaskState, WorkbenchSettings } from '@operation-agent/contracts';
import { resolveLocale, translate } from './i18n';
import type { MessageKey, Vars } from './i18n';

declare global { interface Window { readonly operationAgent: DesktopApi } }

// The Renderer only mirrors views returned by Main/Express. It never decides capability or success itself.

export type Connection = 'connecting' | 'ready' | 'restarting' | 'unavailable';
export interface Submission { readonly id: string; readonly projectId: string; readonly prompt: string; readonly goal: string | null;
  readonly at: number; readonly outcome: 'refused' | 'failed'; readonly code: string }
/** Feedback for auto-saved preferences: what the control plane last confirmed, never assumed. */
export type SaveStatus = { state: 'idle' | 'saving' | 'saved' } | { state: 'failed'; code: string };
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
/** What the model is producing right now for one turn: transient stream deltas, replaced by the committed answer. */
export interface LiveTurn { readonly turn: number; readonly text: string; readonly thinking: string; readonly tools: readonly { id: string; name: string }[] }
/**
 * One task's conversation as this window shows it: the committed prompt and answers (from Express), and the stream
 * of the turn in progress. `gap` means some live deltas were missed; the committed answer is still complete.
 */
export interface ConversationView {
  readonly messages: readonly TaskMessageView[];
  readonly liveSeq: number;
  readonly live: LiveTurn | null;
  readonly gap: boolean;
  readonly stopping: boolean;
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
  conversations: Readonly<Record<string, ConversationView>>;
  selectedTaskId: string | null;
  /** Model choice and credential status as Express reports them; never key material. */
  model: ModelSettingsView | null;
  modelTest: { state: 'idle' | 'running' } | { state: 'done'; result: ModelTestResult } | { state: 'failed'; code: string };
  /** Linked providers and web-search keys as Express reports them: model choice and "configured", never key material. */
  providers: ProviderOverviewView | null;
  /** Stored agent profiles and MCP server definitions; null until first loaded. */
  agents: Agent[] | null;
  mcpServers: McpServer[] | null;
  saveStatus: SaveStatus;
}

let state: AppState = { connection: 'connecting', desktop: null, overview: null, settings: null, projects: [], runs: [],
  submissions: [], notices: [], loaded: false, tasks: [], taskViews: {}, conversations: {}, selectedTaskId: null, model: null, modelTest: { state: 'idle' },
  providers: null, agents: null, mcpServers: null, saveStatus: { state: 'idle' } };
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
/** Translates outside React (notices) in the language the settings currently ask for. */
export function tr(key: MessageKey, vars?: Vars): string {
  return translate(resolveLocale(state.settings?.language ?? 'system', state.desktop?.app.locale), key, vars);
}
export function composePrompt(prompt: string, goal: string | null): string { return goal ? `${prompt}\n\nGoal: ${goal}` : prompt; }
let noticeId = 0;
export function notify(tone: Notice['tone'], text: string): void {
  const notice = { id: ++noticeId, tone, text };
  set({ notices: [...state.notices.slice(-2), notice] });
  setTimeout(() => set({ notices: state.notices.filter(item => item.id !== notice.id) }), 4_500);
}

async function loadDomain(): Promise<void> {
  const [settings, projects, runs, overview, model, providers] = await Promise.all([api().getSettings(), api().listProjects(), api().listRuns(),
    api().getOverview(), api().getModelSettings(), api().getProviders()]);
  let active = settings;
  // Keep the remembered project valid; otherwise fall back to the first registered one.
  if (!projects.projects.some(project => project.id === settings.activeProjectId)) {
    const fallback = projects.projects[0]?.id ?? null;
    if (fallback !== settings.activeProjectId) active = await api().saveSettings({ ...settings, activeProjectId: fallback });
  }
  set({ settings: active, projects: projects.projects, runs: runs.runs, overview, model, providers, loaded: true });
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
  if (selected && selected.lastSeq !== (state.taskViews[selected.id]?.appliedSeq ?? -1)) { await syncTask(selected.id); await syncMessages(selected.id); }
}

const EMPTY_CONVERSATION: ConversationView = { messages: [], liveSeq: 0, live: null, gap: false, stopping: false };
const ACTIVE: readonly TaskState[] = ['CREATED', 'QUEUED', 'RUNNING', 'STOPPING'];
const MAX_LIVE_CHARS = 200_000;
const putConversation = (taskId: string, patch: Partial<ConversationView>): void =>
  set({ conversations: { ...state.conversations, [taskId]: { ...(state.conversations[taskId] ?? EMPTY_CONVERSATION), ...patch } } });
const messageSync = new Set<string>();
/** Pulls committed messages after the ones already shown; a turn's live stream gives way to its committed answer. */
async function syncMessages(taskId: string): Promise<void> {
  if (messageSync.has(taskId)) return;
  messageSync.add(taskId);
  try {
    for (let page = 0; page < 20; page++) {
      const current = state.conversations[taskId] ?? EMPTY_CONVERSATION;
      const result = await api().listTaskMessages({ taskId, after: current.messages.length });
      const messages = [...current.messages, ...result.messages];
      const answered = Math.max(0, ...messages.filter(message => message.role === 'assistant').map(message => message.turn));
      const turns = (state.taskViews[taskId]?.events ?? []).flatMap(event => event.type === 'assistant_turn' ? [event.payload.turn] : []);
      const committed = Math.max(answered, ...turns, 0);
      putConversation(taskId, { messages, live: current.live && current.live.turn <= committed ? null : current.live });
      if (!result.hasMore) return;
    }
  } catch { /* The next poll retries; the committed log stays the source of truth. */ }
  finally { messageSync.delete(taskId); }
}
let liveBusy = false;
/** Reads stream deltas for the selected task while it runs; a new turn or a tool call also refreshes the committed views. */
async function pollLive(): Promise<void> {
  const taskId = state.selectedTaskId;
  const task = state.tasks.find(item => item.id === taskId);
  if (liveBusy || !taskId || !task || !ACTIVE.includes(task.state) || state.connection !== 'ready') return;
  liveBusy = true;
  try {
    const current = state.conversations[taskId] ?? EMPTY_CONVERSATION;
    const page = await api().readTaskLive({ taskId, afterSeq: current.liveSeq });
    let live = current.live; let refresh = page.done && page.deltas.length === 0;
    for (const { turn, delta } of page.deltas) {
      if (!live || turn > live.turn) { live = { turn, text: '', thinking: '', tools: [] }; refresh = true; }
      if (turn < live.turn) continue;
      if (delta.kind === 'text') live = { ...live, text: (live.text + delta.text).slice(-MAX_LIVE_CHARS) };
      else if (delta.kind === 'thinking') live = { ...live, thinking: (live.thinking + delta.text).slice(-MAX_LIVE_CHARS) };
      else { live = { ...live, tools: [...live.tools, { id: delta.id, name: delta.name }].slice(-64) }; refresh = true; }
    }
    putConversation(taskId, { live, liveSeq: page.nextSeq, gap: current.gap || page.gap });
    if (refresh) { await syncTask(taskId); await syncMessages(taskId); }
  } catch { /* Live deltas are best effort; the committed views are polled independently. */ }
  finally { liveBusy = false; }
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
export function startPolling(): void {
  void poll(); setInterval(() => { void poll(); }, 2_000);
  // Fast, cheap reads of the stream only while the selected task is active.
  setInterval(() => { void pollLive(); }, 350);
}

/** Bumped on every model or key change; a connection test result only lands if nothing changed while it ran. */
let modelRevision = 0;
export const actions = {
  selectTask(taskId: string | null): void {
    set({ selectedTaskId: taskId });
    if (taskId) void syncTask(taskId).then(() => syncMessages(taskId));
  },
  /** Asks Express to stop the task; the view then follows the committed state (STOPPED, or INTERRUPTED if unconfirmed). */
  async stopTask(taskId: string): Promise<void> {
    if (state.conversations[taskId]?.stopping) return;
    putConversation(taskId, { stopping: true });
    try {
      const snapshot = await api().stopTask({ taskId });
      set({ tasks: state.tasks.map(task => task.id === taskId ? snapshot : task) });
    } catch (error) { notify('danger', tr('notice.stopFailed', { code: errorCode(error) })); }
    finally { putConversation(taskId, { stopping: false }); await syncTask(taskId); await syncMessages(taskId); }
  },
  async resyncTask(taskId: string): Promise<void> {
    set({ taskViews: { ...state.taskViews, [taskId]: EMPTY_VIEW } });
    await syncTask(taskId);
  },
  async retry(): Promise<void> {
    set({ connection: 'restarting' });
    try { set({ desktop: await api().retryControlPlane() }); } catch { notify('danger', tr('notice.restartFailed')); }
    await poll();
  },
  async saveSettings(patch: Partial<WorkbenchSettings>): Promise<void> {
    if (!state.settings) return;
    const previous = state.settings; const next = { ...previous, ...patch };
    set({ settings: next, saveStatus: { state: 'saving' } });
    try { set({ settings: await api().saveSettings(next), saveStatus: { state: 'saved' } }); }
    catch (error) {
      const code = errorCode(error);
      set({ settings: previous, saveStatus: { state: 'failed', code } }); notify('danger', tr('notice.settingsNotSaved', { code }));
    }
  },
  resetSaveStatus(): void { if (state.saveStatus.state !== 'saving') set({ saveStatus: { state: 'idle' } }); },
  async selectProject(id: string): Promise<void> { set({ selectedTaskId: null }); await actions.saveSettings({ activeProjectId: id }); },
  async addProject(): Promise<void> {
    try {
      const result = await api().addProject();
      if (result.status === 'cancelled') return;
      set({ projects: (await api().listProjects()).projects });
      await actions.saveSettings({ activeProjectId: result.project.id });
      notify('ok', tr('notice.projectAdded', { name: result.project.name }));
    } catch (error) {
      const code = errorCode(error);
      notify('danger', code === 'RECORD_CONFLICT' ? tr('notice.folderRegistered') : code === 'LIMIT_EXCEEDED' ? tr('notice.projectLimit') : tr('notice.projectNotAdded', { code }));
    }
  },
  async removeProject(id: string): Promise<void> {
    try {
      const list = await api().removeProject({ id });
      set({ projects: list.projects, submissions: state.submissions.filter(item => item.projectId !== id) });
      set({ settings: await api().getSettings() });
      if (state.settings && !state.settings.activeProjectId && list.projects[0]) await actions.selectProject(list.projects[0].id);
    } catch (error) { notify('danger', tr('notice.projectNotRemoved', { code: errorCode(error) })); }
  },
  /** A goal travels inside the prompt text the control plane receives; it is kept apart here only to display it. */
  async submitTask(projectId: string, prompt: string, goal: string | null = null): Promise<void> {
    const at = Date.now(); const id = crypto.randomUUID();
    let outcome: Submission['outcome'] = 'refused'; let code: string;
    try {
      const result = await api().startTask({ projectId, prompt: composePrompt(prompt, goal) });
      if (result.accepted) {
        // The task now exists in Express; the task list and its view take over from here.
        await loadTasks();
        actions.selectTask(result.task.id);
        return;
      }
      code = result.error;
    } catch (error) { outcome = 'failed'; code = errorCode(error); }
    set({ submissions: [...state.submissions, { id, projectId, prompt, goal, at, outcome, code }].slice(-20) });
  },
  async refreshModel(): Promise<void> {
    try { set({ model: await api().getModelSettings() }); } catch { /* The status banner reports availability. */ }
  },
  async saveModelChoice(model: ClaudeModel): Promise<void> {
    const previous = state.model;
    if (!previous || previous.model === model) return;
    modelRevision++;
    set({ model: { ...previous, model }, modelTest: { state: 'idle' }, saveStatus: { state: 'saving' } });
    try { set({ model: await api().saveModelChoice({ model }), saveStatus: { state: 'saved' } }); }
    catch (error) {
      const code = errorCode(error);
      set({ model: previous, saveStatus: { state: 'failed', code } }); notify('danger', tr('notice.modelNotSaved', { code }));
    }
  },
  /**
   * Hands the key to Main once. It is not kept in this store; the caller clears its input. Returns the fixed error
   * code on failure so the form can explain it without ever echoing the value.
   */
  async setApiKey(apiKey: string): Promise<string | null> {
    modelRevision++; set({ modelTest: { state: 'idle' } });
    try { set({ model: await api().setApiKey({ apiKey }) }); return null; }
    catch (error) {
      // A timeout leaves the outcome unknown: show what Express actually holds instead of assuming nothing was saved.
      await actions.refreshModel();
      return errorCode(error);
    }
  },
  async clearApiKey(): Promise<void> {
    modelRevision++; set({ modelTest: { state: 'idle' } });
    try { set({ model: await api().clearApiKey(), modelTest: { state: 'idle' } }); notify('ok', tr('notice.keyRemoved')); }
    catch (error) { notify('danger', tr('notice.keyNotRemoved', { code: errorCode(error) })); }
  },
  async testModel(): Promise<void> {
    if (state.modelTest.state === 'running') return;
    const revision = modelRevision;
    set({ modelTest: { state: 'running' } });
    let next: AppState['modelTest'];
    try { next = { state: 'done', result: await api().testModelConnection() }; }
    catch (error) { next = { state: 'failed', code: errorCode(error) }; }
    // Discard a result for a model or key that changed while the test ran.
    if (revision === modelRevision) set({ modelTest: next });
  },
  async refreshProviders(): Promise<void> {
    try { set({ providers: await api().getProviders() }); } catch { /* The status banner reports availability. */ }
  },
  /** Like setApiKey: the key crosses once and is not kept; a failure returns its fixed code. */
  async setProviderKey(provider: CredentialSlot, apiKey: string): Promise<string | null> {
    try { set({ providers: await api().setProviderKey({ provider, apiKey }) }); return null; }
    catch (error) { await actions.refreshProviders(); return errorCode(error); }
  },
  async clearProviderKey(provider: CredentialSlot): Promise<void> {
    try { set({ providers: await api().clearProviderKey({ provider }) }); notify('ok', tr('notice.keyRemoved')); }
    catch (error) { notify('danger', tr('notice.keyNotRemoved', { code: errorCode(error) })); }
  },
  async saveProviderModel(provider: LinkedProvider, model: string): Promise<void> {
    set({ saveStatus: { state: 'saving' } });
    try { set({ providers: await api().saveProviderModel({ provider, model }), saveStatus: { state: 'saved' } }); }
    catch (error) {
      const code = errorCode(error);
      set({ saveStatus: { state: 'failed', code } }); notify('danger', tr('notice.modelNotSaved', { code }));
    }
  },
  /** Results stay with the caller: they describe one provider at one moment and are not shared state. */
  testProvider: (provider: LinkedProvider): Promise<ProviderTestResult> => api().testProvider({ provider }),
  listProviderModels: (provider: LinkedProvider): Promise<ProviderModelList> => api().listProviderModels({ provider }),
  async refreshAgents(): Promise<void> {
    try { set({ agents: (await api().listAgents()).agents }); } catch { /* The status banner reports availability. */ }
  },
  async saveAgent(input: AgentSave): Promise<string | null> {
    try { set({ agents: (await api().saveAgent(input)).agents }); return null; } catch (error) { return errorCode(error); }
  },
  async removeAgent(id: string): Promise<void> {
    try { set({ agents: (await api().removeAgent({ id })).agents }); notify('ok', tr('notice.removed')); }
    catch (error) { notify('danger', tr('notice.notRemoved', { code: errorCode(error) })); }
  },
  async refreshMcp(): Promise<void> {
    try { set({ mcpServers: (await api().listMcpServers()).servers }); } catch { /* The status banner reports availability. */ }
  },
  async saveMcpServer(input: McpServerSave): Promise<string | null> {
    try { set({ mcpServers: (await api().saveMcpServer(input)).servers }); return null; } catch (error) { return errorCode(error); }
  },
  async removeMcpServer(id: string): Promise<void> {
    try { set({ mcpServers: (await api().removeMcpServer({ id })).servers }); notify('ok', tr('notice.removed')); }
    catch (error) { notify('danger', tr('notice.notRemoved', { code: errorCode(error) })); }
  },
  async refreshRuns(): Promise<void> {
    try { set({ runs: (await api().listRuns()).runs, overview: await api().getOverview() }); } catch { /* The status banner reports availability. */ }
  },
};
