import { useEffect, useState, type CSSProperties } from 'react';
import type { Project } from '@operation-agent/contracts';
import { actions, errorCode, useStore } from '../state';
import { Modal, Row, Segmented, Toggle } from './Modal';
import { accent, dateTime, duration, shortId } from './format';
import { IconCheck, IconFolder, IconInfo, IconLock, IconPlus, IconRetry, IconShield, IconX } from './Icons';
import { ModelSection } from './ModelSettings';

export function ProjectsDialog({ onClose }: { onClose: () => void }) {
  const projects = useStore(s => s.projects);
  const activeId = useStore(s => s.settings?.activeProjectId ?? null);
  const ready = useStore(s => s.connection === 'ready');
  const [confirm, setConfirm] = useState<Project | null>(null);
  return (
    <Modal title="Projects" onClose={onClose} width={560}>
      {projects.length === 0 && <div className="empty-note">No projects yet. Add a folder to remember it here.</div>}
      <ul className="project-list">
        {projects.map(project => (
          <li key={project.id} className="project-item">
            <button className={`project-option${project.id === activeId ? ' is-active' : ''}`} disabled={!ready}
              onClick={() => { void actions.selectProject(project.id); onClose(); }}>
              <span className="project-glyph lg" style={{ background: accent(project.id) }}>{project.name[0]!.toUpperCase()}</span>
              <span className="project-option-body">
                <span className="project-option-name">{project.name}</span>
                <span className="project-option-meta" title={project.path}><IconFolder size={12} /><span className="ellipsis">{project.path}</span></span>
                <span className="project-option-meta">Added {dateTime(project.createdAt)}</span>
              </span>
              {project.id === activeId && <IconCheck size={16} className="tone-text-ok" />}
            </button>
            <button className="icon-btn project-remove" aria-label={`Remove ${project.name}`} title="Remove from list" disabled={!ready}
              onClick={() => setConfirm(project)}><IconX size={14} /></button>
          </li>
        ))}
      </ul>
      <div className="picker-foot">
        <button className="btn" onClick={() => void actions.addProject()} disabled={!ready}><IconPlus size={14} /> Add folder…</button>
        <span className="muted small">Only the folder path is stored. Files inside are never read in this build.</span>
      </div>
      {confirm && (
        <Modal title={`Remove ${confirm.name}?`} onClose={() => setConfirm(null)} width={440} footer={<>
          <button className="btn btn-quiet" onClick={() => setConfirm(null)}>Cancel</button>
          <button className="btn btn-danger" autoFocus onClick={() => { void actions.removeProject(confirm.id); setConfirm(null); }}>Remove</button>
        </>}>
          <p className="muted">Removes the project from OperationAgent’s list. The folder and its files on disk are not touched.</p>
        </Modal>
      )}
    </Modal>
  );
}

const SECTIONS = ['General', 'Model', 'Execution', 'Security', 'About'] as const;
type Section = (typeof SECTIONS)[number];
const SECTION_LEADS: Record<Section, string> = {
  General: 'Appearance and layout of this workbench.',
  Model: 'Claude, the model the agent will think with, and the key it uses.',
  Execution: 'How tool processes will be stopped and approved.',
  Security: 'What this build can and cannot do, as the control plane reports it.',
  About: 'Versions and keyboard shortcuts.',
};
export function SettingsDialog({ onClose, initialSection = 'General' }: { onClose: () => void; initialSection?: Section }) {
  const settings = useStore(s => s.settings);
  const desktop = useStore(s => s.desktop);
  const overview = useStore(s => s.overview);
  const [section, setSection] = useState<Section>(initialSection);
  const disabled = !settings;
  const index = SECTIONS.indexOf(section);
  return (
    <Modal title="Settings" onClose={onClose} width={880} className="modal-settings">
      <div className="settings">
        <nav className="settings-nav" aria-label="Settings sections" style={{ '--index': index } as CSSProperties}>
          <span className="settings-nav-indicator" aria-hidden="true" />
          {SECTIONS.map((name, i) => (
            <button key={name} className={name === section ? 'is-active' : ''} aria-current={name === section ? 'page' : undefined}
              data-section={name} onClick={() => setSection(name)}>
              <span className="settings-nav-index">{String(i + 1).padStart(2, '0')}</span>{name}
            </button>
          ))}
        </nav>
        <div className="settings-body" key={section} data-section={section}>
          <header className="settings-head">
            <span className="eyebrow">{String(index + 1).padStart(2, '0')} / {String(SECTIONS.length).padStart(2, '0')}</span>
            <h3 className="settings-title">{section}</h3>
            <p className="settings-sub">{SECTION_LEADS[section]}</p>
          </header>
          {disabled && <div className="settings-note"><IconInfo size={14} /> Settings load from the control plane once it is connected.</div>}
          {section === 'General' && settings && (
            <>
              <Row label="Theme" hint="Follows your OS by default. Saved in the local database.">
                <Segmented value={settings.theme} onChange={theme => void actions.saveSettings({ theme })}
                  options={[{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />
              </Row>
              <Row label="Density" hint="Compact tightens the sidebar and panels.">
                <Segmented value={settings.density} onChange={density => void actions.saveSettings({ density })}
                  options={[{ value: 'comfortable', label: 'Comfortable' }, { value: 'compact', label: 'Compact' }]} />
              </Row>
              <Row label="Show context panel" hint="The right-hand Status / Files / Changes / Results panel.">
                <Toggle label="Show context panel" checked={settings.contextPanel} onChange={contextPanel => void actions.saveSettings({ contextPanel })} />
              </Row>
            </>
          )}
          {section === 'Model' && <ModelSection />}
          {section === 'Execution' && settings && (
            <>
              <Row label="Stop grace period" hint="Time a cancelled tool process gets before forced cleanup. Allowed range 5–30 s; takes effect once tool execution exists.">
                <Segmented value={settings.stopGraceMs} onChange={stopGraceMs => void actions.saveSettings({ stopGraceMs })}
                  options={[{ value: 5000, label: '5 s' }, { value: 10000, label: '10 s' }, { value: 30000, label: '30 s' }]} />
              </Row>
              <Row label="Approval policy" hint="Command and write approvals arrive with tool execution (P3). Approval never lifts the sandbox.">
                <span className="badge badge-soft"><IconLock size={11} /> Not available yet</span>
              </Row>
              <div className="settings-note"><IconShield size={14} /> Raw <span className="mono">sh -c</span>, pipes, redirection, <span className="mono">git push --force</span> and <span className="mono">git reset --hard</span> will never be grantable at task level.</div>
            </>
          )}
          {section === 'Security' && (
            <>
              <p className="settings-lead">Live status reported by the control plane for this installation:</p>
              <ul className="security-list">
                <li><IconLock size={14} /><span><strong>Agent Worker</strong> — <span className="mono">agentReady = false</span>; task start returns <span className="mono">{overview?.worker.error ?? 'WORKER_ISOLATION_UNAVAILABLE'}</span></span></li>
                <li><IconLock size={14} /><span><strong>High-risk tools</strong> (bash, write_file) — <span className="mono">{overview?.tools.highRisk ?? 'SANDBOX_UNAVAILABLE'}</span></span></li>
                <li><IconLock size={14} /><span><strong>read_file / git read</strong> — <span className="mono">{overview?.tools.read ?? 'READ_ADAPTER_UNAVAILABLE'}</span></span></li>
                <li><IconInfo size={14} /><span><strong>Worker OS isolation</strong> — {overview?.capabilities.workerIsolation ?? 'unverified'}; the restricted test fixture is never launched by this build</span></li>
              </ul>
              <div className="settings-note"><IconShield size={14} /> The window has no Node access and no network (CSP <span className="mono">connect-src 'none'</span>). It talks only to fixed, schema-checked operations in the main process, which forwards them to the local control plane with per-request authentication.</div>
            </>
          )}
          {section === 'About' && (
            <>
              <p className="settings-lead"><strong>OperationAgent</strong> {desktop ? desktop.app.version : ''} · M2 build</p>
              <p className="muted">A desktop workbench for a security-gated coding agent. This build delivers the supervised control plane, local persistence, project management and Claude model settings. Agent execution stays disabled until its isolation gates pass.</p>
              <p className="muted small mono">Electron {desktop?.app.electron ?? '—'} · Sidecar Node {overview?.runtime.node ?? '—'} · SQLite {overview?.runtime.sqlite ?? '—'} · {desktop ? `${desktop.app.platform}-${desktop.app.arch}` : ''}</p>
              <div className="kbd-grid">
                <span><kbd>Ctrl N</kbd> New task</span><span><kbd>Ctrl O</kbd> Projects</span>
                <span><kbd>Ctrl ,</kbd> Settings</span><span><kbd>Ctrl \</kbd> Toggle context panel</span>
              </div>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

type SelfTest = { state: 'idle' | 'running' } | { state: 'passed'; ms: number; total: number } | { state: 'failed'; code: string };
export function DiagnosticsDialog({ onClose }: { onClose: () => void }) {
  const runs = useStore(s => s.runs);
  const desktop = useStore(s => s.desktop);
  const overview = useStore(s => s.overview);
  const connection = useStore(s => s.connection);
  const [test, setTest] = useState<SelfTest>({ state: 'idle' });
  useEffect(() => { void actions.refreshRuns(); }, []);
  const selfTest = async (): Promise<void> => {
    setTest({ state: 'running' });
    const started = performance.now(); const id = crypto.randomUUID();
    try {
      // Write through Main → Express → SQLite, then read back what was committed.
      await window.operationAgent.writeSmokeRecords({ records: [{ id, value: `self-test ${new Date().toISOString()}` }] });
      const records = await window.operationAgent.listSmokeRecords();
      if (!records.records.some(record => record.id === id) && records.records.length < 100) throw new Error('RECORD_NOT_FOUND');
      setTest({ state: 'passed', ms: Math.round(performance.now() - started), total: overview ? overview.database.records + 1 : records.records.length });
      void actions.refreshRuns();
    } catch (error) { setTest({ state: 'failed', code: errorCode(error) }); }
  };
  return (
    <Modal title="Diagnostics" onClose={onClose} width={720}>
      <div className="diag-grid">
        <div className="diag-item"><span className="muted small">Service</span><strong className={connection === 'ready' ? 'tone-text-ok' : 'tone-text-danger'}>{desktop?.service.state ?? 'unknown'}</strong></div>
        <div className="diag-item"><span className="muted small">Express run</span><strong className="mono">{shortId(desktop?.service.expressRunId)}</strong></div>
        <div className="diag-item"><span className="muted small">Uptime</span><strong>{overview ? duration(overview.uptimeMs) : '—'}</strong></div>
        <div className="diag-item"><span className="muted small">Schema</span><strong>{overview ? `v${overview.database.version}` : '—'}</strong></div>
      </div>
      <div className="diag-actions">
        <button className="btn" onClick={() => void selfTest()} disabled={connection !== 'ready' || test.state === 'running'}>
          <IconCheck size={14} /> Run database self-test
        </button>
        {test.state === 'passed' && <span className="tone-text-ok small">Write → commit → read back passed in {test.ms} ms</span>}
        {test.state === 'failed' && <span className="tone-text-danger small mono">Failed: {test.code}</span>}
        {test.state === 'running' && <span className="muted small">Running…</span>}
        <span className="tool-spacer" />
        <button className="btn btn-quiet" onClick={() => void actions.retry()} disabled={connection === 'ready' || connection === 'restarting'} title="Only available when the control plane is down">
          <IconRetry size={14} /> Restart control plane
        </button>
      </div>
      <h3 className="section-label">Control-plane runs</h3>
      <table className="runs-table">
        <thead><tr><th>Run</th><th>Started</th><th>Ended</th><th>Outcome</th></tr></thead>
        <tbody>
          {runs.map(run => (
            <tr key={run.id}>
              <td className="mono">{shortId(run.id)}{run.id === desktop?.service.expressRunId && <span className="badge badge-soft">current</span>}</td>
              <td>{dateTime(run.startedAt)}</td>
              <td>{run.endedAt ? dateTime(run.endedAt) : '—'}</td>
              <td className={run.outcome === 'CLEAN' ? 'tone-text-ok' : run.outcome === 'INTERRUPTED' ? 'tone-text-warn' : 'tone-text-run'}>{run.outcome.toLowerCase()}</td>
            </tr>
          ))}
          {runs.length === 0 && <tr><td colSpan={4} className="muted">No runs recorded.</td></tr>}
        </tbody>
      </table>
      <p className="muted small">An <em>interrupted</em> run ended without a clean shutdown (crash or forced exit); it is reconciled at the next start and never resumed automatically.</p>
    </Modal>
  );
}
