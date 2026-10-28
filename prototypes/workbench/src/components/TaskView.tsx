import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { engine } from '../sim/engine';
import { store, useAppState, isActive, RETRYABLE_STATUSES } from '../sim/store';
import { DEMO_PROJECT_ID, DEMO_PROMPT } from '../sim/data/projects';
import type { Task } from '../sim/types';
import { Timeline, useNow } from './Timeline';
import { StatusPill, duration, relativeTime } from './format';
import { IconStop, IconRetry, IconSend, IconSparkle, IconGitBranch, IconFolder, IconFile, IconShield, IconFlask, IconArchive } from './Icons';

function TaskHeader({ task }: { task: Task }) {
  const active = isActive(task);
  const now = useNow(1000, active);
  const elapsed = (task.result?.durationMs ?? (active ? now - (task.startedAt ?? task.createdAt) : undefined));
  const retryable = RETRYABLE_STATUSES.includes(task.status) && !task.readOnlyHistory;
  return (
    <header className="task-header">
      <div className="task-header-main">
        <h1 className="task-title" title={task.prompt}>{task.title}</h1>
        <div className="task-meta">
          <StatusPill status={task.status} />
          {task.attempt > 1 && <span className="meta-item">Attempt {task.attempt}</span>}
          {elapsed !== undefined && <span className="meta-item">{duration(elapsed)}</span>}
          <span className="meta-item">{relativeTime(task.createdAt, now)}</span>
          {task.readOnlyHistory ? <span className="meta-item"><IconArchive size={12} /> History · read-only</span>
            : <span className="meta-item sim-tag" title="Every event in this task is produced by the offline simulation engine"><IconSparkle size={12} /> Simulated run</span>}
        </div>
      </div>
      <div className="task-actions">
        {active && (
          <button className="btn btn-stop" onClick={() => void engine.stop(task.id)} disabled={task.status === 'stopping'} title="Stop (Ctrl+.)">
            <IconStop size={14} /> {task.status === 'stopping' ? 'Stopping…' : 'Stop'}
          </button>
        )}
        {retryable && (
          <button className="btn" onClick={() => engine.retry(task.id)} title="Start a new attempt with the same request">
            <IconRetry size={14} /> Retry
          </button>
        )}
      </div>
    </header>
  );
}

export function Composer({ task, seed, onSeedUsed }: { task?: Task; seed?: string; onSeedUsed?: () => void }) {
  const [text, setText] = useState('');
  const activeProjectId = useAppState(s => s.activeProjectId);
  const tasks = useAppState(s => s.tasks);
  const ref = useRef<HTMLTextAreaElement>(null);
  const running = tasks.find(t => isActive(t));
  const demoProject = activeProjectId === DEMO_PROJECT_ID;
  const blockedByRun = !!running && running.id !== task?.id;
  const thisRunning = task && isActive(task);

  useEffect(() => {
    if (seed) { setText(seed); onSeedUsed?.(); ref.current?.focus(); }
  }, [seed, onSeedUsed]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(200, el.scrollHeight)}px`;
  }, [text]);

  const submit = (): void => {
    const prompt = text.trim();
    if (!prompt || running || !demoProject) return;
    engine.createTask(prompt);
    setText('');
  };

  let placeholder = task ? 'Start a new task in ledger-api…' : 'Describe a bug, feature or question…';
  if (thisRunning) placeholder = 'The agent is working. Stop the run to start something new.';
  else if (blockedByRun) placeholder = 'Another simulated run is active.';
  else if (!demoProject) placeholder = 'The scripted simulation is only available in ledger-api.';

  return (
    <div className="composer-wrap">
      <div className={`composer${thisRunning ? ' is-running' : ''}`}>
        <textarea
          ref={ref}
          value={text}
          rows={1}
          placeholder={placeholder}
          disabled={!!running || !demoProject}
          onChange={event => setText(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); }
          }}
          aria-label="Task request"
        />
        <div className="composer-bar">
          <span className="chip chip-quiet"><IconFolder size={12} />{activeProjectId}</span>
          <span className="chip chip-quiet" title="The agent proposes a plan and waits for approval before acting"><IconShield size={12} />Plan first · ask before writes</span>
          <span className="chip chip-sim" title="Responses come from a deterministic script; no model is called"><IconSparkle size={12} />Offline simulator</span>
          <span className="tool-spacer" />
          {thisRunning ? (
            <button className="send-btn is-stop" onClick={() => void engine.stop(task.id)} disabled={task.status === 'stopping'} aria-label="Stop" title="Stop (Ctrl+.)">
              <IconStop size={15} />
            </button>
          ) : (
            <button className="send-btn" onClick={submit} disabled={!text.trim() || !!running || !demoProject} aria-label="Send" title="Send (Enter)">
              <IconSend size={16} />
            </button>
          )}
        </div>
      </div>
      {!demoProject && !running && (
        <div className="composer-hint">
          This sample project has history only.{' '}
          <button className="link" onClick={() => store.update(s => ({ ...s, activeProjectId: DEMO_PROJECT_ID, activeTaskId: null }))}>Switch to ledger-api</button> to run the scripted demo.
        </div>
      )}
      {demoProject && !running && !task && <div className="composer-hint">Simulation: any request here replays the scripted INC-4821 scenario. Nothing is executed.</div>}
    </div>
  );
}

export function TaskView({ task }: { task: Task }) {
  const showSeq = useAppState(s => s.settings.showSequence);
  const scroller = useRef<HTMLDivElement>(null);
  const column = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // Follow new output while the reader is at the bottom. Only user input (wheel, touch,
  // keys, pointer) can unstick; programmatic scrolls such as autofocus never do.
  const updateStick = (): void => {
    requestAnimationFrame(() => {
      const el = scroller.current;
      if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    });
  };

  useLayoutEffect(() => {
    stick.current = true;
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [task.id]);

  useEffect(() => {
    const el = scroller.current;
    const content = column.current;
    if (!el || !content) return;
    const observer = new ResizeObserver(() => { if (stick.current) el.scrollTop = el.scrollHeight; });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  return (
    <section className="center">
      <TaskHeader task={task} />
      <div className="scroll" ref={scroller} onWheel={updateStick} onTouchMove={updateStick} onKeyUp={updateStick} onPointerUp={updateStick}>
        <div className="column" ref={column}>
          <Timeline task={task} showSeq={showSeq} />
        </div>
      </div>
      <Composer task={task} />
    </section>
  );
}

export function EmptyState() {
  const projects = useAppState(s => s.projects);
  const activeProjectId = useAppState(s => s.activeProjectId);
  const overlay = useAppState(s => s.overlay);
  const [seed, setSeed] = useState<string | undefined>();
  const project = projects.find(p => p.id === activeProjectId)!;
  const demo = project.id === DEMO_PROJECT_ID;
  const modified = Object.keys(overlay[project.id] ?? {}).length;
  return (
    <section className="center">
      <div className="scroll">
        <div className="column empty">
          <div className="empty-mark" style={{ background: project.accent }}>{project.name[0]!.toUpperCase()}</div>
          <h1 className="empty-title">What should we work on in <span className="mono-ish">{project.name}</span>?</h1>
          <p className="empty-sub">{project.description}</p>
          <div className="project-facts">
            <span><IconFolder size={13} />{project.path}</span>
            <span><IconGitBranch size={13} />{project.branch}</span>
            <span><IconFile size={13} />{project.files.length} files · {project.language}</span>
            {modified > 0 && <span className="tone-text-warn">{modified} simulated edits</span>}
          </div>
          {demo ? (
            <div className="suggestions">
              <button className="suggestion is-primary" onClick={() => setSeed(DEMO_PROMPT)}>
                <span className="suggestion-icon"><IconFlask size={16} /></span>
                <span>
                  <span className="suggestion-title">Fix the one-cent invoice tax bug</span>
                  <span className="suggestion-text">INC-4821 · explore → plan → sandboxed test → reviewed diff → verify</span>
                </span>
                <span className="badge badge-soft">Guided demo</span>
              </button>
            </div>
          ) : (
            <div className="empty-note">This sample project only contains task history. Browse it in the sidebar, or switch to <strong>ledger-api</strong> for the interactive run.</div>
          )}
        </div>
      </div>
      <Composer seed={seed} onSeedUsed={() => setSeed(undefined)} />
    </section>
  );
}
