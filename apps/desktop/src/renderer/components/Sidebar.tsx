import { forwardRef, useMemo, useState } from 'react';
import type { Project, TaskSnapshot } from '@operation-agent/contracts';
import { actions, store, useStore } from '../state';
import type { Submission } from '../state';
import { TASK_STATE, relativeTime, shortId } from './format';
import { IconChevronRight, IconCompose, IconFolder, IconFolderPlus, IconMore, IconPanelLeft, IconSearch, IconSettings, IconTerminal, IconX } from './Icons';

interface Props { onCollapse: () => void; onNewTask: () => void; onOpenProjects: () => void; onOpenSettings: () => void; onOpenDiagnostics: () => void }

function matches(query: string, ...values: string[]): boolean { return !query || values.some(value => value.toLowerCase().includes(query)); }

function TaskRow({ task, active, project }: { task: TaskSnapshot; active: boolean; project: Project }) {
  const view = TASK_STATE[task.state] ?? { tone: 'muted' as const, label: task.state };
  const open = async (): Promise<void> => {
    if (store.get().settings?.activeProjectId !== project.id) await actions.selectProject(project.id);
    actions.selectTask(task.id);
  };
  return (
    <button className={`task-row${active ? ' is-active' : ''}`} data-task-id={task.id} onClick={() => void open()} title={`Task ${task.id}`}
      aria-current={active ? 'page' : undefined}>
      <span className={`task-row-status tone-${view.tone}`}><span className={`dot${view.live ? ' dot-live' : ''}`} /></span>
      <span className="task-row-title">Task <span className="mono">{shortId(task.id)}</span></span>
      <span className="task-row-meta"><span className={`tone-text-${view.tone}`}>{view.label}</span> · {relativeTime(Date.parse(task.updatedAt))}</span>
    </button>
  );
}

function RequestRow({ item }: { item: Submission }) {
  return (
    <div className="task-row is-static" title={`${item.prompt}\n\nNot started · ${item.code}`}>
      <span className="task-row-status tone-danger"><span className="dot" /></span>
      <span className="task-row-title">{item.prompt}</span>
      <span className="task-row-meta">Not started</span>
    </div>
  );
}

export const Sidebar = forwardRef<HTMLInputElement, Props>(function Sidebar({ onCollapse, onNewTask, onOpenProjects, onOpenSettings, onOpenDiagnostics }, searchRef) {
  const projects = useStore(s => s.projects);
  const activeId = useStore(s => s.settings?.activeProjectId ?? null);
  const submissions = useStore(s => s.submissions);
  const tasks = useStore(s => s.tasks);
  const selectedTaskId = useStore(s => s.selectedTaskId);
  const connection = useStore(s => s.connection);
  const [query, setQuery] = useState('');
  const [toggled, setToggled] = useState<Readonly<Record<string, boolean>>>({});
  const q = query.trim().toLowerCase();
  const groups = useMemo(() => projects.map(project => {
    const own = tasks.filter(task => task.projectId === project.id && matches(q, task.id, TASK_STATE[task.state]?.label ?? task.state));
    const requests = submissions.filter(item => item.projectId === project.id && matches(q, item.prompt)).reverse();
    return { project, tasks: own, requests, hit: matches(q, project.name, project.path) || own.length + requests.length > 0 };
  }).filter(group => group.hit), [projects, tasks, submissions, q]);
  const isOpen = (id: string): boolean => q ? true : toggled[id] ?? id === activeId;

  return (
    <aside className="sidebar" aria-label="Projects and chats">
      <div className="sidebar-top">
        <button className="icon-btn" onClick={onCollapse} aria-label="Hide sidebar" title="Hide sidebar (Ctrl+B)"><IconPanelLeft size={17} /></button>
        <span className="brand"><span className="brand-mark" aria-hidden="true" />OperationAgent</span>
      </div>

      <div className="sidebar-nav">
        <button className="nav-row" onClick={onNewTask} disabled={!activeId} title="New chat (Ctrl+N)">
          <IconCompose size={16} /><span>New chat</span><kbd>Ctrl N</kbd>
        </button>
        <label className="nav-row nav-search">
          <IconSearch size={16} />
          <input ref={searchRef} value={query} onChange={event => setQuery(event.target.value)} placeholder="Search" aria-label="Search projects and chats"
            onKeyDown={event => { if (event.key === 'Escape' && query) { event.stopPropagation(); setQuery(''); } }} />
          {query ? <button className="nav-clear" onClick={() => setQuery('')} aria-label="Clear search"><IconX size={12} /></button> : <kbd>Ctrl K</kbd>}
        </label>
      </div>

      <nav className="sidebar-scroll" aria-label="Projects">
        <div className="side-section-head">
          <span>Projects</span>
          <button className="icon-btn icon-btn-sm" onClick={() => void actions.addProject()} disabled={connection !== 'ready'} aria-label="Add project folder" title="Add project folder">
            <IconFolderPlus size={15} /></button>
          <button className="icon-btn icon-btn-sm" onClick={onOpenProjects} aria-label="Manage projects" title="Manage projects (Ctrl+O)"><IconMore size={15} /></button>
        </div>
        {groups.map(({ project, tasks: own, requests }) => {
          const open = isOpen(project.id);
          const active = project.id === activeId;
          return (
            <div key={project.id} className={`project-group${open ? ' is-open' : ''}`}>
              <div className={`project-row${active ? ' is-active' : ''}`}>
                <button className="project-row-caret" aria-label={open ? `Collapse ${project.name}` : `Expand ${project.name}`} aria-expanded={open}
                  onClick={() => setToggled(value => ({ ...value, [project.id]: !open }))}><IconChevronRight size={12} /></button>
                <button className="project-row-main" onClick={() => { if (!active) void actions.selectProject(project.id); setToggled(value => ({ ...value, [project.id]: true })); }}
                  title={project.path} aria-current={active && !selectedTaskId ? 'page' : undefined}>
                  <IconFolder size={15} /><span className="ellipsis">{project.name}</span>
                </button>
              </div>
              {open && (
                <div className="project-children">
                  {own.map(task => <TaskRow key={task.id} task={task} project={project} active={task.id === selectedTaskId} />)}
                  {requests.map(item => <RequestRow key={item.id} item={item} />)}
                  {own.length + requests.length === 0 && <div className="side-empty">{q ? 'No matching chats' : 'No chats yet'}</div>}
                </div>
              )}
            </div>
          );
        })}
        {projects.length === 0 && <div className="side-empty side-empty-lg">Add a project folder to start. Only its path is stored.</div>}
        {projects.length > 0 && groups.length === 0 && <div className="side-empty side-empty-lg">Nothing matches “{query.trim()}”.</div>}
      </nav>

      <footer className="sidebar-foot">
        <button className="nav-row" onClick={onOpenSettings} title="Settings (Ctrl+,)"><IconSettings size={16} /><span>Settings</span></button>
        <button className="icon-btn" onClick={onOpenDiagnostics} aria-label="Diagnostics" title="Diagnostics"><IconTerminal size={16} /></button>
      </footer>
    </aside>
  );
});
