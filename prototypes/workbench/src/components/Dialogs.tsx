import { useEffect, useRef, useState, type ReactNode } from 'react';
import { store, useAppState, isActive } from '../sim/store';
import { engine } from '../sim/engine';
import type { Settings } from '../sim/types';
import { IconX, IconFolder, IconGitBranch, IconCheck, IconLock, IconShield, IconSparkle, IconInfo } from './Icons';
import { relativeTime } from './format';

function Modal({ title, onClose, children, width = 560, footer }: { title: string; onClose: () => void; children: ReactNode; width?: number; footer?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => { window.removeEventListener('keydown', onKey, true); previous?.focus(); };
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} style={{ width }} ref={ref} tabIndex={-1}>
        <header className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><IconX size={16} /></button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}

export function ProjectPicker({ onClose }: { onClose: () => void }) {
  const projects = useAppState(s => s.projects);
  const activeProjectId = useAppState(s => s.activeProjectId);
  const tasks = useAppState(s => s.tasks);
  return (
    <Modal title="Open project" onClose={onClose} width={520}>
      <ul className="project-list">
        {projects.map(project => {
          const projectTasks = tasks.filter(task => task.projectId === project.id);
          const last = projectTasks.reduce((max, task) => Math.max(max, task.updatedAt), 0);
          const running = projectTasks.some(isActive);
          return (
            <li key={project.id}>
              <button className={`project-option${project.id === activeProjectId ? ' is-active' : ''}`} onClick={() => {
                store.update(s => ({ ...s, activeProjectId: project.id, activeTaskId: null, selectedFile: project.files.find(f => f.path.startsWith('src/'))?.path ?? project.files[0]!.path, rightTab: 'files' }));
                onClose();
              }}>
                <span className="project-glyph lg" style={{ background: project.accent }}>{project.name[0]!.toUpperCase()}</span>
                <span className="project-option-body">
                  <span className="project-option-name">{project.name}{project.id === 'ledger-api' && <span className="badge badge-soft">interactive demo</span>}</span>
                  <span className="project-option-desc">{project.description}</span>
                  <span className="project-option-meta"><IconFolder size={12} />{project.path}<span className="sep">·</span><IconGitBranch size={12} />{project.branch}
                    <span className="sep">·</span>{projectTasks.length} tasks{last > 0 && <> · {relativeTime(last)}</>}{running && <span className="tone-text-run"> · running</span>}</span>
                </span>
                {project.id === activeProjectId && <IconCheck size={16} className="tone-text-ok" />}
              </button>
            </li>
          );
        })}
      </ul>
      <div className="picker-foot">
        <button className="btn" disabled title="Disabled in the prototype: real folders are never opened or read"><IconFolder size={14} /> Choose folder…</button>
        <span className="muted small">Sample projects only. The prototype never opens, reads or writes real folders.</span>
      </div>
    </Modal>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="setting-row">
      <div className="setting-text">
        <div className="setting-label">{label}</div>
        {hint && <div className="setting-hint">{hint}</div>}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}

function Segmented<T extends string | number>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (value: T) => void }) {
  return (
    <div className="segmented">
      {options.map(option => (
        <button key={String(option.value)} className={option.value === value ? 'is-active' : ''} onClick={() => onChange(option.value)}>{option.label}</button>
      ))}
    </div>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }) {
  return (
    <label className="switch" aria-label={label}>
      <input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} />
      <span className="switch-track" />
    </label>
  );
}

const SECTIONS = ['General', 'Approvals', 'Simulation', 'Security', 'About'] as const;

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const settings = useAppState(s => s.settings);
  const [section, setSection] = useState<(typeof SECTIONS)[number]>('General');
  const set = <K extends keyof Settings>(key: K, value: Settings[K]): void => store.update(s => ({ ...s, settings: { ...s.settings, [key]: value } }));
  return (
    <Modal title="Settings" onClose={onClose} width={760}>
      <div className="settings">
        <nav className="settings-nav">
          {SECTIONS.map(name => <button key={name} className={name === section ? 'is-active' : ''} onClick={() => setSection(name)}>{name}</button>)}
        </nav>
        <div className="settings-body">
          {section === 'General' && (
            <>
              <Row label="Theme" hint="Follows your OS by default.">
                <Segmented value={settings.theme} onChange={v => set('theme', v)} options={[{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />
              </Row>
              <Row label="Density" hint="Compact tightens the timeline and sidebar.">
                <Segmented value={settings.density} onChange={v => set('density', v)} options={[{ value: 'comfortable', label: 'Comfortable' }, { value: 'compact', label: 'Compact' }]} />
              </Row>
              <Row label="Open context automatically" hint="Switch the right panel to Changes, Approvals or Results when the agent needs you.">
                <Toggle label="Open context automatically" checked={settings.autoOpenContext} onChange={v => set('autoOpenContext', v)} />
              </Row>
              <Row label="Show output sequence numbers" hint="Display the per-task delta sequence in tool output.">
                <Toggle label="Show output sequence numbers" checked={settings.showSequence} onChange={v => set('showSequence', v)} />
              </Row>
            </>
          )}
          {section === 'Approvals' && (
            <>
              <Row label="Approval policy" hint="Writes always require review. Approval never lifts the sandbox.">
                <Segmented value={settings.approvalPolicy} onChange={v => set('approvalPolicy', v)} options={[
                  { value: 'ask-writes-and-commands', label: 'Ask for commands' },
                  { value: 'ask-writes', label: 'Auto-approve sandboxed tests' },
                ]} />
              </Row>
              <Row label="Stop grace period" hint="Time a cancelled process gets to exit before forced cleanup. Allowed range 5–30 s.">
                <Segmented value={settings.graceMs} onChange={v => set('graceMs', v)} options={[{ value: 5000, label: '5 s' }, { value: 10000, label: '10 s' }, { value: 30000, label: '30 s' }]} />
              </Row>
              <div className="settings-note"><IconShield size={14} /> Raw <span className="mono">sh -c</span>, pipes, redirection, <span className="mono">git push --force</span> and <span className="mono">git reset --hard</span> can never be granted at task level.</div>
            </>
          )}
          {section === 'Simulation' && (
            <>
              <Row label="Playback speed" hint="Scales every simulated delay. Event order and content stay identical.">
                <Segmented value={settings.speed} onChange={v => set('speed', v)} options={[{ value: 0.5, label: '0.5×' }, { value: 1, label: '1×' }, { value: 2, label: '2×' }, { value: 4, label: '4×' }]} />
              </Row>
              <Row label="Simulate sandbox unavailable" hint="The test command fails with SANDBOX_UNAVAILABLE and the run fails closed — no unsandboxed fallback.">
                <Toggle label="Simulate sandbox unavailable" checked={settings.injectSandboxFailure} onChange={v => set('injectSandboxFailure', v)} />
              </Row>
              <div className="settings-note"><IconSparkle size={14} /> Every agent message, tool call, output line and test result is replayed from a fixed script. No model, process, network or file system is used.</div>
            </>
          )}
          {section === 'Security' && (
            <>
              <p className="settings-lead">Status of the <strong>real</strong> OperationAgent runtime in this repository, independent of the prototype:</p>
              <ul className="security-list">
                <li><IconLock size={14} /><span><strong>Production Worker</strong> disabled — <span className="mono">agentReady = false</span></span></li>
                <li><IconLock size={14} /><span><strong>High-risk tools</strong> (bash, write_file) — <span className="mono">SANDBOX_UNAVAILABLE</span> until P3b passes</span></li>
                <li><IconLock size={14} /><span><strong>read_file / git read</strong> — unverified (SEC-08 / SEC-22 not run)</span></li>
                <li><IconInfo size={14} /><span><strong>Worker OS isolation</strong> — unverified on all platforms</span></li>
              </ul>
              <div className="settings-note"><IconShield size={14} /> This prototype is a standalone web bundle: no preload bridge, no Node APIs, no network (CSP <span className="mono">connect-src 'none'</span>), and it is not wired to Express or the Worker.</div>
            </>
          )}
          {section === 'About' && (
            <>
              <p className="settings-lead"><strong>OperationAgent Workbench</strong> · UI prototype 0.1.0</p>
              <p className="muted">A design and interaction prototype for the agent workspace. It demonstrates the intended task flow — explore, plan, approve, execute, review, verify — using a deterministic offline simulation.</p>
              <p className="muted">State is kept in this browser profile only (local storage). Use <strong>Reset demo</strong> in the sidebar to start over.</p>
              <div className="kbd-grid">
                <span><kbd>Ctrl N</kbd> New task</span><span><kbd>Ctrl O</kbd> Open project</span>
                <span><kbd>Ctrl ↵</kbd> Approve pending</span><span><kbd>Ctrl .</kbd> Stop run</span>
                <span><kbd>Ctrl ,</kbd> Settings</span><span><kbd>Ctrl \</kbd> Toggle context panel</span>
              </div>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

export function ConfirmReset({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Reset the demo?" onClose={onClose} width={440} footer={
      <>
        <button className="btn btn-quiet" onClick={onClose}>Cancel</button>
        <button className="btn btn-danger" autoFocus onClick={() => { engine.abortAll(); store.reset(); onClose(); }}>Reset demo</button>
      </>
    }>
      <p className="muted">Abandons any simulated run, clears simulated tasks, the simulated workspace overlay and selections, and restores the seeded history. Your theme and preferences are kept.</p>
    </Modal>
  );
}
