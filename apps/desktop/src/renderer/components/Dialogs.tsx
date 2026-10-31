import { useEffect, useState } from 'react';
import type { Project } from '@operation-agent/contracts';
import { actions, errorCode, useStore } from '../state';
import { Modal } from './Modal';
import { accent, dateTime, duration, shortId } from './format';
import { IconCheck, IconFolder, IconPlus, IconRetry, IconX } from './Icons';

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
          <button className="btn btn-danger" data-autofocus onClick={() => { void actions.removeProject(confirm.id); setConfirm(null); }}>Remove</button>
        </>}>
          <p className="muted">Removes the project from OperationAgent’s list. The folder and its files on disk are not touched.</p>
        </Modal>
      )}
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
