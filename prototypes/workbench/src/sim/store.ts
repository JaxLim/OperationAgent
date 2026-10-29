import { useSyncExternalStore } from 'react';
import type { AppState, Settings, Task, TaskStatus } from './types';
import { PROJECTS, DEMO_PROJECT_ID } from './data/projects';
import { seedHistory } from './data/history';

const STORAGE_KEY = 'operation-agent.workbench-prototype.v1';
const STATE_VERSION = 3;

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  density: 'comfortable',
  speed: 1,
  autoOpenContext: true,
  approvalPolicy: 'ask-writes-and-commands',
  injectSandboxFailure: false,
  graceMs: 5000,
  showSequence: false,
};

export const ACTIVE_STATUSES: TaskStatus[] = ['planning', 'awaiting_plan', 'running', 'awaiting_approval', 'applying', 'verifying', 'stopping'];
export const RETRYABLE_STATUSES: TaskStatus[] = ['stopped', 'failed', 'changes_rejected', 'plan_declined', 'interrupted', 'completed_with_issues'];

export function isActive(task: Task | undefined): boolean {
  return !!task && ACTIVE_STATUSES.includes(task.status);
}

export function initialState(): AppState {
  return {
    version: STATE_VERSION,
    projects: PROJECTS,
    activeProjectId: DEMO_PROJECT_ID,
    tasks: seedHistory(),
    activeTaskId: null,
    overlay: {},
    settings: DEFAULT_SETTINGS,
    rightTab: 'files',
    rightOpen: true,
    selectedFile: 'src/invoice/total.ts',
    selectedArtifact: null,
  };
}

/**
 * Restores per-viewer state. A run that was in flight when the window closed is
 * never resumed: it becomes INTERRUPTED and the user must explicitly retry.
 */
function load(): AppState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return initialState();
    const parsed = JSON.parse(raw) as AppState;
    if (parsed.version !== STATE_VERSION) return initialState();
    const now = Date.now();
    return {
      ...parsed,
      projects: PROJECTS,
      settings: { ...DEFAULT_SETTINGS, ...parsed.settings },
      tasks: parsed.tasks.map(task => {
        if (!ACTIVE_STATUSES.includes(task.status)) return task;
        const approvals = Object.fromEntries(Object.entries(task.approvals).map(([id, approval]) =>
          [id, approval.state === 'pending' ? { ...approval, state: 'expired' as const } : approval]));
        const tools = Object.fromEntries(Object.entries(task.tools).map(([id, tool]) =>
          [id, tool.state === 'running' || tool.state === 'awaiting_approval' ? { ...tool, state: 'cancelled' as const, endedAt: now } : tool]));
        return {
          ...task, approvals, tools, status: 'interrupted' as const, updatedAt: now,
          items: [...task.items, {
            kind: 'notice' as const, id: `n-int-${now}`, at: now, tone: 'warn' as const,
            text: 'Run interrupted — the window was reloaded while the simulated agent was working.',
            detail: 'Interrupted runs are never resumed automatically. Pending approvals expired. Retry starts a new attempt.',
          }],
        };
      }),
    };
  } catch {
    return initialState();
  }
}

type Listener = () => void;

class Store {
  private state: AppState = load();
  private listeners = new Set<Listener>();
  private saveTimer: number | undefined;

  getState = (): AppState => this.state;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  update = (fn: (state: AppState) => AppState): void => {
    this.state = fn(this.state);
    for (const listener of this.listeners) listener();
    this.scheduleSave();
  };

  updateTask = (taskId: string, fn: (task: Task) => Task): void => {
    this.update(state => ({
      ...state,
      tasks: state.tasks.map(task => task.id === taskId ? { ...fn(task), updatedAt: Date.now() } : task),
    }));
  };

  task = (taskId: string): Task | undefined => this.state.tasks.find(task => task.id === taskId);

  reset = (): void => {
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* storage unavailable: in-memory reset still applies */ }
    const theme = this.state.settings;
    this.state = { ...initialState(), settings: theme };
    for (const listener of this.listeners) listener();
    this.scheduleSave();
  };

  private scheduleSave(): void {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state)); } catch { /* best effort only */ }
    }, 250);
  }
}

export const store = new Store();

export function useAppState<T>(selector: (state: AppState) => T): T {
  return useSyncExternalStore(store.subscribe, () => selector(store.getState()));
}
