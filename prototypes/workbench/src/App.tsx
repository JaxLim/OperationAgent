import { useCallback, useEffect, useState } from 'react';
import { store, useAppState, isActive } from './sim/store';
import { engine } from './sim/engine';
import { Sidebar } from './components/Sidebar';
import { TaskView, EmptyState } from './components/TaskView';
import { RightPanel } from './components/RightPanel';
import { ProjectPicker, SettingsDialog, ConfirmReset } from './components/Dialogs';
import { IconPanelRight, IconSettings, IconSparkle, IconLock, IconChevronRight, IconPanelLeft } from './components/Icons';

type Dialog = 'projects' | 'settings' | 'reset' | null;

function useTheme(): void {
  const theme = useAppState(s => s.settings.theme);
  const density = useAppState(s => s.settings.density);
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
    root.setAttribute('data-density', density);
  }, [theme, density]);
}

/** Ctrl+Enter resolves whichever gate is pending, in the order the agent asked. */
function approvePending(): void {
  const state = store.getState();
  const task = state.tasks.find(t => t.id === state.activeTaskId);
  if (!task) return;
  if (task.status === 'awaiting_plan') { engine.decidePlan(task.id, true); return; }
  const pending = Object.values(task.approvals).find(a => a.state === 'pending');
  if (!pending) return;
  if (pending.kind === 'command') engine.decideCommand(task.id, pending.id, true, 'once');
  else engine.decideChanges(task.id, true);
}

export function App() {
  useTheme();
  const tasks = useAppState(s => s.tasks);
  const activeTaskId = useAppState(s => s.activeTaskId);
  const rightOpen = useAppState(s => s.rightOpen);
  const projects = useAppState(s => s.projects);
  const activeProjectId = useAppState(s => s.activeProjectId);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [leftOpen, setLeftOpen] = useState(true);
  const task = tasks.find(t => t.id === activeTaskId && t.projectId === activeProjectId);
  const project = projects.find(p => p.id === activeProjectId)!;
  const running = tasks.find(isActive);
  const pendingCount = tasks.reduce((sum, t) => sum + Object.values(t.approvals).filter(a => a.state === 'pending').length + (t.status === 'awaiting_plan' ? 1 : 0), 0);

  const newTask = useCallback(() => store.update(s => ({ ...s, activeTaskId: null, rightTab: 'files' })), []);
  const closeDialog = useCallback(() => setDialog(null), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || dialog) return;
      const key = event.key.toLowerCase();
      if (key === 'n') { event.preventDefault(); newTask(); }
      else if (key === 'o') { event.preventDefault(); setDialog('projects'); }
      else if (key === ',') { event.preventDefault(); setDialog('settings'); }
      else if (key === '\\') { event.preventDefault(); store.update(s => ({ ...s, rightOpen: !s.rightOpen })); }
      else if (key === '.') { event.preventDefault(); const r = store.getState().tasks.find(isActive); if (r) void engine.stop(r.id); }
      else if (key === 'enter') { event.preventDefault(); approvePending(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialog, newTask]);

  useEffect(() => {
    document.title = pendingCount ? `(${pendingCount}) OperationAgent — prototype` : 'OperationAgent — prototype';
  }, [pendingCount]);

  return (
    <div className={`app${rightOpen ? '' : ' no-right'}${leftOpen ? '' : ' no-left'}`}>
      <header className="titlebar">
        <div className="titlebar-left">
          <button className="icon-btn" onClick={() => setLeftOpen(v => !v)} aria-label="Toggle sidebar" title="Toggle sidebar"><IconPanelLeft size={16} /></button>
          <span className="brand"><span className="brand-mark" aria-hidden="true" />OperationAgent</span>
          <span className="crumbs">
            <IconChevronRight size={12} className="muted" />
            <button className="crumb" onClick={() => setDialog('projects')}>{project.name}</button>
            {task && <><IconChevronRight size={12} className="muted" /><span className="crumb crumb-task">{task.title}</span></>}
          </span>
        </div>
        <div className="titlebar-center">
          <span className="sim-badge" title="All agent activity in this window is simulated. Nothing is executed and no real files are read or written.">
            <IconSparkle size={12} /> Prototype · simulated execution
          </span>
        </div>
        <div className="titlebar-right">
          {running && running.id !== task?.id && (
            <button className="running-chip" onClick={() => store.update(s => ({ ...s, activeProjectId: running.projectId, activeTaskId: running.id }))}>
              <span className="dot dot-live tone-run" /> 1 running
            </button>
          )}
          {pendingCount > 0 && <span className="pending-chip">{pendingCount} awaiting you</span>}
          <button className="icon-btn" onClick={() => setDialog('settings')} aria-label="Settings" title="Settings (Ctrl+,)"><IconSettings size={16} /></button>
          <button className={`icon-btn${rightOpen ? ' is-on' : ''}`} onClick={() => store.update(s => ({ ...s, rightOpen: !s.rightOpen }))} aria-label="Toggle context panel" title="Toggle context panel (Ctrl+\)"><IconPanelRight size={16} /></button>
        </div>
      </header>

      {leftOpen && <Sidebar onOpenProjects={() => setDialog('projects')} onOpenSettings={() => setDialog('settings')} onReset={() => setDialog('reset')} onNewTask={newTask} />}
      <main className="main">{task ? <TaskView key={task.id} task={task} /> : <EmptyState key={activeProjectId} />}</main>
      {rightOpen && <RightPanel task={task} />}

      <footer className="statusbar">
        <span className="sb-item"><span className="dot tone-sim" />Simulation engine · deterministic script · offline</span>
        <span className="sb-item"><IconLock size={11} />Real Worker disabled (agentReady=false)</span>
        <span className="sb-item"><IconLock size={11} />No processes · no disk writes · no network</span>
        <span className="tool-spacer" />
        <span className="sb-item">{running ? `${running.title.slice(0, 40)} — ${running.status.replace(/_/g, ' ')}` : 'Idle'}</span>
      </footer>

      {dialog === 'projects' && <ProjectPicker onClose={closeDialog} />}
      {dialog === 'settings' && <SettingsDialog onClose={closeDialog} />}
      {dialog === 'reset' && <ConfirmReset onClose={closeDialog} />}
    </div>
  );
}
