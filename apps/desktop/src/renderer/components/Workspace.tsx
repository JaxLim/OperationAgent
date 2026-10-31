import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { CLAUDE_MODELS, DEFAULT_CLAUDE_MODEL, WORKBENCH_LIMITS } from '@operation-agent/contracts';
import type { Project } from '@operation-agent/contracts';
import { actions, composePrompt, useStore } from '../state';
import type { Submission } from '../state';
import { relativeTime } from './format';
import { TaskDetail } from './TaskDetail';
import { MODEL_INFO } from './ModelSettings';
import { MenuItem, MenuLabel, MenuSeparator, Popover } from './Menu';
import { IconAlert, IconCheck, IconChevronDown, IconFolder, IconFolderPlus, IconGauge, IconLaptop, IconLock, IconPaperclip, IconPlus, IconPuzzle, IconSend,
  IconShield, IconSparkle, IconTarget, IconX } from './Icons';

export interface ComposerHandle { focus(): void }
export type SettingsTarget = 'models' | 'chat' | 'plugins' | 'usage';

let focusOnMount = false;
/** Focuses the composer now, or when it next mounts (an open task replaces it). No animation-frame timing. */
export function requestComposerFocus(handle: ComposerHandle | null): void {
  if (handle) handle.focus(); else focusOnMount = true;
}

/** Unsent drafts per project. Memory only: prompts are never written to disk, so drafts end with the window. */
const drafts = new Map<string, { text: string; goal: string | null }>();
const MAX_GOAL = 300;

function ModelPicker({ onOpenSettings }: { onOpenSettings: (target: SettingsTarget) => void }) {
  const model = useStore(s => s.model);
  const ready = useStore(s => s.connection === 'ready');
  const chosen = model?.model ?? DEFAULT_CLAUDE_MODEL;
  return (
    <Popover label="Model" placement="top-end" className="popover-model" trigger={props => (
      <button {...props} className="composer-select" data-model-picker={chosen} disabled={!model} title="Model">
        <span>{MODEL_INFO[chosen].name}</span><IconChevronDown size={13} />
      </button>
    )}>
      {close => (
        <>
          <MenuLabel>Model · default for all chats</MenuLabel>
          {CLAUDE_MODELS.map(id => (
            <MenuItem key={id} checked={id === chosen} unavailable={!ready} label={<>{MODEL_INFO[id].name}{id === DEFAULT_CLAUDE_MODEL && <span className="menu-tag">Default</span>}</>}
              hint={MODEL_INFO[id].tagline} onSelect={() => { void actions.saveModelChoice(id); close(); }} />
          ))}
          <MenuSeparator />
          <div className="menu-note">
            <IconLock size={13} />
            <span>Reasoning effort and work modes are chosen by the agent runtime, which this build doesn’t include. They appear here once it ships.</span>
          </div>
          <MenuItem icon={<IconSparkle size={15} />} label="Models & API key…" onSelect={() => { close(); onOpenSettings('models'); }} />
        </>
      )}
    </Popover>
  );
}

function AddMenu({ onGoal, hasGoal, onOpenSettings }: { onGoal: () => void; hasGoal: boolean; onOpenSettings: (target: SettingsTarget) => void }) {
  return (
    <Popover label="Add to request" placement="top-start" className="popover-add" trigger={props => (
      <button {...props} className="composer-icon" aria-label="Add to request" title="Add to request"><IconPlus size={18} /></button>
    )}>
      {close => (
        <>
          <MenuLabel>Task</MenuLabel>
          <MenuItem icon={<IconTarget size={16} />} label={hasGoal ? 'Edit goal' : 'Set a goal'} hint="State what “done” means; sent with the request"
            onSelect={() => { close(); onGoal(); }} />
          <MenuSeparator />
          <MenuLabel>Attach</MenuLabel>
          <MenuItem icon={<IconPaperclip size={16} />} label="Files and folders" unavailable
            hint="Needs the Read Adapter gate (READ_ADAPTER_UNAVAILABLE)" />
          <MenuSeparator />
          <MenuLabel>Extend</MenuLabel>
          <MenuItem icon={<IconPuzzle size={16} />} label="Plugins and skills" unavailable hint="Not available in this build" />
          <MenuItem label="About plugins and skills…" onSelect={() => { close(); onOpenSettings('plugins'); }} />
        </>
      )}
    </Popover>
  );
}

/** Shows only what is known: the request size against the contract limit (reported), a token estimate, and what is not reported. */
function ContextMeter({ chars, onOpenSettings }: { chars: number; onOpenSettings: (target: SettingsTarget) => void }) {
  const max = WORKBENCH_LIMITS.maxPromptChars;
  const ratio = Math.min(1, chars / max);
  const tone = ratio > 0.9 ? 'danger' : ratio > 0.7 ? 'warn' : 'ok';
  const radius = 7; const circumference = 2 * Math.PI * radius;
  return (
    <Popover label="Request size and usage" role="dialog" placement="top-end" className="popover-meter" trigger={props => (
      <button {...props} className={`composer-meter tone-${tone}`} aria-label={`Request size ${chars} of ${max} characters`} title="Request size and usage">
        {ratio < 0.5 ? <IconGauge size={17} /> : (
          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
            <circle cx="9" cy="9" r={radius} className="meter-track" />
            <circle cx="9" cy="9" r={radius} className="meter-value" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - ratio)} />
          </svg>
        )}
      </button>
    )}>
      {() => (
        <div className="meter-panel">
          <div className="meter-row">
            <span className="meter-label">Request size</span><span className="data-tag data-reported">Reported</span>
            <span className="meter-value-text">{chars.toLocaleString()} / {max.toLocaleString()} characters</span>
            <span className="meter-bar"><span className={`tone-${tone}`} style={{ width: `${ratio * 100}%` }} /></span>
          </div>
          <div className="meter-row">
            <span className="meter-label">Draft tokens</span><span className="data-tag data-estimated">Estimated</span>
            <span className="meter-value-text">≈ {Math.ceil(chars / 4).toLocaleString()} tokens</span>
            <span className="meter-note">About 4 characters per token; Claude’s tokenizer may count differently.</span>
          </div>
          <div className="meter-row">
            <span className="meter-label">Context and token usage</span><span className="data-tag data-unavailable">Unavailable</span>
            <span className="meter-note">The agent makes no model calls in this build, so nothing is consumed or counted.</span>
          </div>
          <div className="meter-row">
            <span className="meter-label">Provider quota</span><span className="data-tag data-unavailable">Unavailable</span>
            <span className="meter-note">Anthropic doesn’t report plan quota to an API key.</span>
          </div>
          <button className="link meter-link" onClick={() => onOpenSettings('usage')}>Usage settings</button>
        </div>
      )}
    </Popover>
  );
}

function ProjectChip({ project }: { project: Project }) {
  const projects = useStore(s => s.projects);
  const ready = useStore(s => s.connection === 'ready');
  return (
    <Popover label="Project" placement="top-start" trigger={props => (
      <button {...props} className="meta-chip" title={project.path}><IconFolder size={14} /><span className="ellipsis">{project.name}</span><IconChevronDown size={12} /></button>
    )}>
      {close => (
        <>
          <MenuLabel>Projects</MenuLabel>
          {projects.map(item => (
            <MenuItem key={item.id} checked={item.id === project.id} unavailable={!ready} label={item.name} hint={item.path}
              onSelect={() => { void actions.selectProject(item.id); close(); }} />
          ))}
          <MenuSeparator />
          <MenuItem icon={<IconFolderPlus size={16} />} label="Add project folder…" unavailable={!ready} onSelect={() => { close(); void actions.addProject(); }} />
        </>
      )}
    </Popover>
  );
}

const Composer = forwardRef<ComposerHandle, { project: Project; disabled: boolean; docked: boolean; onOpenSettings: (target: SettingsTarget) => void }>(
  function Composer({ project, disabled, docked, onOpenSettings }, handle) {
    const saved = drafts.get(project.id);
    const [text, setText] = useState(saved?.text ?? '');
    const [goal, setGoal] = useState<string | null>(saved?.goal ?? null);
    const [goalDraft, setGoalDraft] = useState<string | null>(null);
    const [sending, setSending] = useState(false);
    const ref = useRef<HTMLTextAreaElement>(null);
    useImperativeHandle(handle, () => ({ focus: () => ref.current?.focus() }), []);
    useEffect(() => { if (focusOnMount) { focusOnMount = false; ref.current?.focus(); } }, []);
    useEffect(() => {
      if (sending) return;
      if (text || goal) drafts.set(project.id, { text, goal }); else drafts.delete(project.id);
    }, [project.id, text, goal, sending]);
    useLayoutEffect(() => {
      const element = ref.current;
      if (!element) return;
      const max = docked ? 220 : 280;
      element.style.height = 'auto';
      element.style.height = `${Math.min(max, element.scrollHeight)}px`;
      element.style.overflowY = element.scrollHeight > max ? 'auto' : 'hidden';
    }, [text, docked]);
    const composed = composePrompt(text.trim(), goal).length;
    const room = WORKBENCH_LIMITS.maxPromptChars - (goal ? goal.length + 8 : 0);
    const submit = async (): Promise<void> => {
      const prompt = text.trim();
      if (!prompt || sending || disabled) return;
      setSending(true);
      // The first request swaps the centered composer for the docked one, which mounts while the request is recorded:
      // drop the draft first so it starts empty, and let whichever composer is mounted afterwards take focus.
      focusOnMount = true;
      drafts.delete(project.id);
      try { await actions.submitTask(project.id, prompt, goal); setText(''); setGoal(null); } finally { setSending(false); ref.current?.focus(); }
    };
    const commitGoal = (): void => {
      const value = goalDraft?.trim() ?? '';
      if (value) setGoal(value.slice(0, MAX_GOAL));
      setGoalDraft(null); ref.current?.focus();
    };
    return (
      <div className={`composer-wrap${docked ? ' is-docked' : ''}`}>
        <div className={`composer${disabled ? ' is-disabled' : ''}`} onMouseDown={event => {
          if (event.target === event.currentTarget) { event.preventDefault(); ref.current?.focus(); }
        }}>
          {(goal || goalDraft !== null) && (
            <div className="composer-chips">
              {goalDraft !== null ? (
                <label className="goal-input">
                  <IconTarget size={14} />
                  <input autoFocus value={goalDraft} maxLength={MAX_GOAL} placeholder="What does done look like?" aria-label="Task goal"
                    onChange={event => setGoalDraft(event.target.value)} onBlur={commitGoal}
                    onKeyDown={event => {
                      if (event.key === 'Enter') { event.preventDefault(); commitGoal(); }
                      if (event.key === 'Escape') { event.preventDefault(); setGoalDraft(null); ref.current?.focus(); }
                    }} />
                </label>
              ) : goal && (
                <span className="input-chip" title={goal}>
                  <IconTarget size={13} /><span className="input-chip-kind">Goal</span><span className="ellipsis">{goal}</span>
                  <button onClick={() => { setGoal(null); ref.current?.focus(); }} aria-label="Remove goal"><IconX size={12} /></button>
                </span>
              )}
            </div>
          )}
          <textarea ref={ref} value={text} rows={docked ? 1 : 2} maxLength={room} disabled={disabled}
            placeholder={disabled ? 'The control plane is not available.' : docked ? 'Reply…' : `Describe a task for ${project.name}…`}
            onChange={event => setText(event.target.value)} aria-label="Task request"
            onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }} />
          <div className="composer-bar">
            <AddMenu hasGoal={goal !== null} onGoal={() => setGoalDraft(goal ?? '')} onOpenSettings={onOpenSettings} />
            <span className="tool-spacer" />
            <ContextMeter chars={composed} onOpenSettings={onOpenSettings} />
            <ModelPicker onOpenSettings={onOpenSettings} />
            <button className="send-btn" onClick={() => void submit()} disabled={!text.trim() || sending || disabled} aria-label="Send" title="Send (Enter)">
              <IconSend size={16} />
            </button>
          </div>
        </div>
        <div className="composer-meta">
          <span className="meta-chip is-static" title="Tasks would run on this computer. Remote and cloud execution are not supported."><IconLaptop size={14} />This computer</span>
          <ProjectChip project={project} />
          <span className="meta-chip is-static is-gate" title="Requests reach the control plane, which refuses them before anything is scheduled. Agent execution needs an isolated Worker (SEC-W01) and the agent loop.">
            <IconLock size={13} />Agent unavailable</span>
        </div>
      </div>
    );
  });

function Exchange({ item }: { item: Submission }) {
  return (
    <div className="exchange">
      <div className="msg-user">
        <div className="bubble">
          {item.prompt}
          {item.goal && <span className="bubble-goal"><IconTarget size={12} />{item.goal}</span>}
        </div>
      </div>
      <article className="msg-system refusal" data-outcome={item.outcome}>
        <div className="msg-system-head">
          <span className="msg-system-mark"><IconShield size={14} /></span>
          <strong>Not started</strong>
          <span className="badge badge-soft mono">{item.code}</span>
          <span className="tool-spacer" />
          <time className="muted small">{relativeTime(item.at)}</time>
        </div>
        <p className="msg-system-text">{item.outcome === 'refused'
          ? 'The control plane checked this request and refused it: this build has no agent loop, so nothing was scheduled, run or saved. There is no fallback that runs without isolation.'
          : 'The request could not reach the control plane. Nothing was scheduled.'}</p>
      </article>
    </div>
  );
}

const AVAILABLE = [
  ['Control plane', 'Authenticated Express sidecar, supervised with heartbeats and a bounded restart budget'],
  ['Persistence', 'SQLite with versioned migrations: settings, projects and run history survive restarts'],
  ['Projects', 'Remember project folders (path only — contents are never read in this build)'],
  ['Claude settings', 'Model choice and an API key encrypted by the operating system'],
] as const;
const LOCKED = [
  ['Agent tasks', 'WORKER_ISOLATION_UNAVAILABLE'], ['File reading', 'READ_ADAPTER_UNAVAILABLE'], ['Shell & writes', 'SANDBOX_UNAVAILABLE'],
] as const;

function Capabilities({ open = false }: { open?: boolean }) {
  return (
    <details className="capabilities" open={open}>
      <summary><IconShield size={14} />What works in this build<IconChevronDown size={13} className="capabilities-chev" /></summary>
      <div className="capabilities-grid">
        <div>
          <h3 className="section-label">Working</h3>
          {AVAILABLE.map(([title, text]) => (
            <div key={title} className="capability"><IconCheck size={14} className="tone-text-ok" /><span><strong>{title}</strong><span className="muted">{text}</span></span></div>
          ))}
        </div>
        <div>
          <h3 className="section-label">Locked until security gates pass</h3>
          {LOCKED.map(([title, code]) => (
            <div key={title} className="capability"><IconLock size={14} className="muted" /><span><strong>{title}</strong><span className="mono muted">{code}</span></span></div>
          ))}
          <div className="capability"><IconAlert size={14} className="tone-text-warn" /><span className="muted">Locked features fail closed. They never fall back to running without isolation.</span></div>
        </div>
      </div>
    </details>
  );
}

export const Workspace = forwardRef<ComposerHandle, { onOpenSettings: (target: SettingsTarget) => void }>(function Workspace({ onOpenSettings }, handle) {
  const projects = useStore(s => s.projects);
  const activeId = useStore(s => s.settings?.activeProjectId ?? null);
  const connection = useStore(s => s.connection);
  const loaded = useStore(s => s.loaded);
  const submissions = useStore(s => s.submissions);
  const project = projects.find(item => item.id === activeId);
  const mine = submissions.filter(item => item.projectId === activeId);
  const selected = useStore(s => s.tasks.find(task => task.id === s.selectedTaskId && task.projectId === activeId));
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [mine.length]);

  if (!loaded) {
    return (
      <section className="center"><div className="hero">
        <div className="hero-mark"><IconShield size={22} /></div>
        <h1 className="hero-title">{connection === 'unavailable' ? 'Control plane unavailable' : 'Starting the control plane…'}</h1>
        <p className="hero-sub">{connection === 'unavailable' ? 'Use Retry in the banner above. Your data stays on this computer.' : 'Verifying the bundled runtime and opening the local database.'}</p>
      </div></section>
    );
  }
  if (!project) {
    return (
      <section className="center"><div className="hero">
        <div className="hero-mark"><IconFolder size={22} /></div>
        <h1 className="hero-title">Add a project to get started</h1>
        <p className="hero-sub">OperationAgent remembers project folders you choose. In this build it stores the path only and never reads, lists or changes files.</p>
        <button className="btn btn-primary btn-pill" onClick={() => void actions.addProject()} disabled={connection !== 'ready'}><IconPlus size={14} /> Add project folder…</button>
        <Capabilities />
      </div></section>
    );
  }
  if (selected) return <TaskDetail task={selected} />;
  if (mine.length === 0) {
    return (
      <section className="center is-empty">
        <div className="hero hero-compose">
          <h1 className="hero-title">What should we work on?</h1>
          <Composer key={project.id} ref={handle} project={project} disabled={connection !== 'ready'} docked={false} onOpenSettings={onOpenSettings} />
          <Capabilities />
        </div>
      </section>
    );
  }
  return (
    <section className="center">
      <div className="scroll">
        <div className="column thread" aria-label="Conversation">
          {mine.map(item => <Exchange key={item.id} item={item} />)}
          <div ref={end} />
        </div>
      </div>
      <Composer key={project.id} ref={handle} project={project} disabled={connection !== 'ready'} docked onOpenSettings={onOpenSettings} />
    </section>
  );
});
