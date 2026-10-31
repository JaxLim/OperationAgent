import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { WORKBENCH_LIMITS } from '@operation-agent/contracts';
import type { Project } from '@operation-agent/contracts';
import { actions, useStore } from '../state';
import type { Submission } from '../state';
import { accent, relativeTime } from './format';
import { TaskDetail } from './TaskDetail';
import { IconAlert, IconFolder, IconLock, IconPlus, IconSend, IconShield, IconCheck, IconX } from './Icons';

export interface ComposerHandle { focus(): void }

const Composer = forwardRef<ComposerHandle, { project: Project; disabled: boolean }>(function Composer({ project, disabled }, handle) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(handle, () => ({ focus: () => ref.current?.focus() }), []);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(200, element.scrollHeight)}px`;
  }, [text]);
  const submit = async (): Promise<void> => {
    const prompt = text.trim();
    if (!prompt || sending || disabled) return;
    setSending(true);
    try { await actions.submitTask(project.id, prompt); setText(''); } finally { setSending(false); }
  };
  return (
    <div className="composer-wrap">
      <div className="composer">
        <textarea ref={ref} value={text} rows={1} maxLength={WORKBENCH_LIMITS.maxPromptChars} disabled={disabled}
          placeholder={disabled ? 'The control plane is not available.' : `Describe a task for ${project.name}…`}
          onChange={event => setText(event.target.value)} aria-label="Task request"
          onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }} />
        <div className="composer-bar">
          <span className="chip chip-quiet" title={project.path}><IconFolder size={12} />{project.name}</span>
          <span className="chip chip-gate" title="Task execution requires a Worker that passed its OS isolation gate"><IconLock size={12} />Agent unavailable</span>
          <span className="tool-spacer" />
          <button className="send-btn" onClick={() => void submit()} disabled={!text.trim() || sending || disabled} aria-label="Send" title="Send (Enter)">
            <IconSend size={16} />
          </button>
        </div>
      </div>
      <div className="composer-hint">Requests go to the real control plane, which refuses them before anything is scheduled. Prompts are not stored.</div>
    </div>
  );
});

function Refusal({ item }: { item: Submission }) {
  return (
    <article className="card refusal tone-border-danger">
      <div className="card-head">
        <span className="card-kicker tone-text-danger"><IconX size={13} /> Not started</span>
        <span className="badge badge-soft mono">{item.code}</span>
      </div>
      <p className="refusal-prompt">{item.prompt}</p>
      <p className="muted small">{item.outcome === 'refused'
        ? 'The control plane validated this request and refused it: no Worker on this platform has passed the isolation gate, so nothing was scheduled, executed or saved. There is no unisolated fallback.'
        : 'The request could not reach the control plane. Nothing was scheduled.'}</p>
      <div className="card-foot"><span className="card-foot-meta">{relativeTime(item.at)}</span></div>
    </article>
  );
}

const AVAILABLE = [
  ['Control plane', 'Authenticated Express sidecar, supervised with heartbeats and a bounded restart budget'],
  ['Persistence', 'SQLite with versioned migrations: settings, projects and run history survive restarts'],
  ['Projects', 'Remember project folders (path only — contents are never read in this build)'],
  ['Diagnostics', 'Live service state, run history and a database round-trip self-test'],
] as const;
const LOCKED = [
  ['Agent tasks', 'WORKER_ISOLATION_UNAVAILABLE'], ['File reading', 'READ_ADAPTER_UNAVAILABLE'], ['Shell & writes', 'SANDBOX_UNAVAILABLE'],
] as const;

export const Workspace = forwardRef<ComposerHandle>(function Workspace(_props, handle) {
  const projects = useStore(s => s.projects);
  const activeId = useStore(s => s.settings?.activeProjectId ?? null);
  const connection = useStore(s => s.connection);
  const loaded = useStore(s => s.loaded);
  const submissions = useStore(s => s.submissions);
  const project = projects.find(item => item.id === activeId);
  const mine = submissions.filter(item => item.projectId === activeId);
  const selected = useStore(s => s.tasks.find(task => task.id === s.selectedTaskId && task.projectId === activeId));

  if (!loaded) {
    return (
      <section className="center"><div className="scroll"><div className="column empty">
        <div className="empty-mark empty-mark-neutral"><IconShield size={22} /></div>
        <h1 className="empty-title">{connection === 'unavailable' ? 'Control plane unavailable' : 'Starting the control plane…'}</h1>
        <p className="empty-sub">{connection === 'unavailable' ? 'Use Retry in the banner above. Your data stays on this computer.' : 'Verifying the bundled runtime and opening the local database.'}</p>
      </div></div></section>
    );
  }
  if (!project) {
    return (
      <section className="center"><div className="scroll"><div className="column empty">
        <div className="empty-mark empty-mark-neutral"><IconFolder size={22} /></div>
        <h1 className="empty-title">Add a project to get started</h1>
        <p className="empty-sub">OperationAgent remembers project folders you choose. In this build it stores the path only and never reads, lists or changes files.</p>
        <button className="btn btn-primary" onClick={() => void actions.addProject()} disabled={connection !== 'ready'}><IconPlus size={14} /> Add project folder…</button>
        <Capabilities />
      </div></div></section>
    );
  }
  if (selected) return <TaskDetail task={selected} />;
  return (
    <section className="center">
      <div className="scroll">
        <div className="column">
          <div className="empty">
            <div className="empty-mark" style={{ background: accent(project.id) }}>{project.name[0]!.toUpperCase()}</div>
            <h1 className="empty-title">What should we work on in <span className="mono-ish">{project.name}</span>?</h1>
            <div className="project-facts"><span title={project.path}><IconFolder size={13} /><span className="ellipsis path-fact">{project.path}</span></span></div>
            {mine.length === 0 && <Capabilities />}
          </div>
          <div className="refusals">{mine.map(item => <Refusal key={item.id} item={item} />)}</div>
        </div>
      </div>
      <Composer ref={handle} project={project} disabled={connection !== 'ready'} />
    </section>
  );
});

function Capabilities() {
  return (
    <div className="capabilities">
      <div className="capability-col">
        <h3 className="section-label">Working in this build</h3>
        {AVAILABLE.map(([title, text]) => (
          <div key={title} className="capability"><IconCheck size={14} className="tone-text-ok" /><span><strong>{title}</strong><span className="muted">{text}</span></span></div>
        ))}
      </div>
      <div className="capability-col">
        <h3 className="section-label">Locked until security gates pass</h3>
        {LOCKED.map(([title, code]) => (
          <div key={title} className="capability"><IconLock size={14} className="muted" /><span><strong>{title}</strong><span className="mono muted">{code}</span></span></div>
        ))}
        <div className="capability capability-note"><IconAlert size={14} className="tone-text-warn" /><span className="muted">Locked features fail closed. They never fall back to running without isolation.</span></div>
      </div>
    </div>
  );
}
