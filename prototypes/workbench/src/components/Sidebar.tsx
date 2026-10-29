import { useMemo, useState } from 'react';
import { store, useAppState, isActive } from '../sim/store';
import type { Task } from '../sim/types';
import { IconChevronDown, IconPlus, IconSearch, IconSettings, IconReset, IconGitBranch, Spinner } from './Icons';
import { STATUS_META, relativeTime } from './format';

interface Props {
  onOpenProjects: () => void;
  onOpenSettings: () => void;
  onReset: () => void;
  onNewTask: () => void;
}

function TaskRow({ task, active }: { task: Task; active: boolean }) {
  const meta = STATUS_META[task.status];
  const select = (): void => store.update(state => ({
    ...state, activeTaskId: task.id,
    rightTab: task.result ? 'results' : task.changes && !task.changes.decision ? 'changes' : state.rightTab,
    selectedArtifact: null,
  }));
  return (
    <button className={`task-row${active ? ' is-active' : ''}`} onClick={select} title={task.title}>
      <span className={`task-row-status tone-${meta.tone}`} aria-label={meta.label}>
        {meta.live ? <Spinner size={12} /> : <span className="dot" />}
      </span>
      <span className="task-row-body">
        <span className="task-row-title">{task.title}</span>
        <span className="task-row-meta">
          <span className={`tone-text-${meta.tone}`}>{meta.label}</span>
          <span className="sep">·</span>
          {relativeTime(task.updatedAt)}
          {task.attempt > 1 && <><span className="sep">·</span>attempt {task.attempt}</>}
        </span>
      </span>
    </button>
  );
}

export function Sidebar({ onOpenProjects, onOpenSettings, onReset, onNewTask }: Props) {
  const tasks = useAppState(s => s.tasks);
  const projects = useAppState(s => s.projects);
  const activeProjectId = useAppState(s => s.activeProjectId);
  const activeTaskId = useAppState(s => s.activeTaskId);
  const [query, setQuery] = useState('');
  const project = projects.find(p => p.id === activeProjectId)!;

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const mine = tasks
      .filter(task => task.projectId === activeProjectId)
      .filter(task => !q || task.title.toLowerCase().includes(q) || task.prompt.toLowerCase().includes(q))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    return [
      { label: 'In progress', items: mine.filter(task => isActive(task)) },
      { label: 'Today', items: mine.filter(task => !isActive(task) && task.updatedAt >= startOfDay.getTime()) },
      { label: 'Earlier', items: mine.filter(task => !isActive(task) && task.updatedAt < startOfDay.getTime()) },
    ].filter(group => group.items.length);
  }, [tasks, activeProjectId, query]);

  const otherActive = tasks.filter(task => task.projectId !== activeProjectId && isActive(task)).length;

  return (
    <aside className="sidebar" aria-label="Projects and tasks">
      <button className="project-switch" onClick={onOpenProjects} title="Open project (Ctrl+O)">
        <span className="project-glyph" style={{ background: project.accent }}>{project.name[0]!.toUpperCase()}</span>
        <span className="project-switch-text">
          <span className="project-switch-name">{project.name}</span>
          <span className="project-switch-meta"><IconGitBranch size={12} />{project.branch}</span>
        </span>
        <IconChevronDown size={14} className="muted" />
      </button>

      <button className="btn btn-new-task" onClick={onNewTask} title="New task (Ctrl+N)">
        <IconPlus size={15} /> New task <kbd>Ctrl N</kbd>
      </button>

      <label className="search">
        <IconSearch size={14} />
        <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search tasks" aria-label="Search tasks" />
      </label>

      <nav className="task-list">
        {groups.length === 0 && <div className="task-list-empty">{query ? 'No tasks match.' : 'No tasks in this project yet.'}</div>}
        {groups.map(group => (
          <section key={group.label}>
            <h3 className="section-label">{group.label}<span className="count">{group.items.length}</span></h3>
            {group.items.map(task => <TaskRow key={task.id} task={task} active={task.id === activeTaskId} />)}
          </section>
        ))}
        {otherActive > 0 && <div className="task-list-hint">{otherActive} running in other projects</div>}
      </nav>

      <footer className="sidebar-footer">
        <button className="btn-ghost" onClick={onOpenSettings} title="Settings (Ctrl+,)"><IconSettings size={15} /> Settings</button>
        <button className="btn-ghost" onClick={onReset} title="Reset the demo to its initial state"><IconReset size={15} /> Reset demo</button>
      </footer>
    </aside>
  );
}
