import { useMemo, useState } from 'react';
import { useStore } from '../state';
import { accent } from './format';
import { IconChevronDown, IconFolder, IconLock, IconPlus, IconSearch, IconSettings, IconTerminal } from './Icons';

interface Props { onOpenProjects: () => void; onOpenSettings: () => void; onOpenDiagnostics: () => void; onNewTask: () => void }

export function Sidebar({ onOpenProjects, onOpenSettings, onOpenDiagnostics, onNewTask }: Props) {
  const projects = useStore(s => s.projects);
  const activeId = useStore(s => s.settings?.activeProjectId ?? null);
  const submissions = useStore(s => s.submissions);
  const [query, setQuery] = useState('');
  const project = projects.find(item => item.id === activeId);
  const requests = useMemo(() => {
    const q = query.trim().toLowerCase();
    return submissions.filter(item => item.projectId === activeId && (!q || item.prompt.toLowerCase().includes(q))).reverse();
  }, [submissions, activeId, query]);

  return (
    <aside className="sidebar" aria-label="Projects and tasks">
      <button className="project-switch" onClick={onOpenProjects} title="Projects (Ctrl+O)">
        {project ? <span className="project-glyph" style={{ background: accent(project.id) }}>{project.name[0]!.toUpperCase()}</span>
          : <span className="project-glyph project-glyph-empty"><IconFolder size={14} /></span>}
        <span className="project-switch-text">
          <span className="project-switch-name">{project?.name ?? 'No project'}</span>
          <span className="project-switch-meta" title={project?.path}>{project ? <span className="ellipsis">{project.path}</span> : 'Add a folder to begin'}</span>
        </span>
        <IconChevronDown size={14} className="muted" />
      </button>

      <button className="btn btn-new-task" onClick={onNewTask} disabled={!project} title="New task (Ctrl+N)">
        <IconPlus size={15} /> New task <kbd>Ctrl N</kbd>
      </button>

      <label className="search">
        <IconSearch size={14} />
        <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search requests" aria-label="Search requests" disabled={!requests.length && !query} />
      </label>

      <nav className="task-list">
        <section>
          <h3 className="section-label">Tasks<span className="count">0</span></h3>
          <div className="task-list-empty sidebar-gate">
            <IconLock size={13} />
            <span>No tasks can run in this build. Execution unlocks only after the Worker isolation gate (SEC-W01) passes on this platform.</span>
          </div>
        </section>
        {requests.length > 0 && (
          <section>
            <h3 className="section-label">Refused this session<span className="count">{requests.length}</span></h3>
            {requests.map(item => (
              <div key={item.id} className="task-row is-static" title={item.prompt}>
                <span className="task-row-status tone-danger"><span className="dot" /></span>
                <span className="task-row-body">
                  <span className="task-row-title">{item.prompt}</span>
                  <span className="task-row-meta"><span className="tone-text-danger">Not started</span><span className="sep">·</span><span className="mono">{item.code}</span></span>
                </span>
              </div>
            ))}
          </section>
        )}
      </nav>

      <footer className="sidebar-footer">
        <button className="btn-ghost" onClick={onOpenSettings} title="Settings (Ctrl+,)"><IconSettings size={15} /> Settings</button>
        <button className="btn-ghost" onClick={onOpenDiagnostics} title="Diagnostics"><IconTerminal size={15} /> Diagnostics</button>
      </footer>
    </aside>
  );
}
