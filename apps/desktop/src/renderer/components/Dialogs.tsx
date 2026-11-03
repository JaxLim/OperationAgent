import { useEffect, useState } from 'react';
import type { Project } from '@operation-agent/contracts';
import { useLocale, useT } from '../locale';
import { actions, errorCode, useStore } from '../state';
import { Modal } from './Modal';
import { accent, dateTime, duration, shortId } from './format';
import { IconCheck, IconFolder, IconPlus, IconRetry, IconX } from './Icons';

export function ProjectsDialog({ onClose }: { onClose: () => void }) {
  const t = useT(); const locale = useLocale();
  const projects = useStore(s => s.projects);
  const activeId = useStore(s => s.settings?.activeProjectId ?? null);
  const ready = useStore(s => s.connection === 'ready');
  const [confirm, setConfirm] = useState<Project | null>(null);
  return (
    <Modal title={t('projects.title')} onClose={onClose} width={560}>
      {projects.length === 0 && <div className="empty-note">{t('projects.empty')}</div>}
      <ul className="project-list">
        {projects.map(project => (
          <li key={project.id} className="project-item">
            <button className={`project-option${project.id === activeId ? ' is-active' : ''}`} disabled={!ready}
              onClick={() => { void actions.selectProject(project.id); onClose(); }}>
              <span className="project-glyph lg" style={{ background: accent(project.id) }}>{project.name[0]!.toUpperCase()}</span>
              <span className="project-option-body">
                <span className="project-option-name">{project.name}</span>
                <span className="project-option-meta" title={project.path}><IconFolder size={12} /><span className="ellipsis">{project.path}</span></span>
                <span className="project-option-meta">{t('projects.added', { date: dateTime(project.createdAt, locale) })}</span>
              </span>
              {project.id === activeId && <IconCheck size={16} className="tone-text-ok" />}
            </button>
            <button className="icon-btn project-remove" aria-label={t('projects.remove', { name: project.name })} title={t('projects.removeTitle')} disabled={!ready}
              onClick={() => setConfirm(project)}><IconX size={14} /></button>
          </li>
        ))}
      </ul>
      <div className="picker-foot">
        <button className="btn" onClick={() => void actions.addProject()} disabled={!ready}><IconPlus size={14} /> {t('projects.addFolder')}</button>
        <span className="muted small">{t('projects.pathOnly')}</span>
      </div>
      {confirm && (
        <Modal title={t('projects.confirmTitle', { name: confirm.name })} onClose={() => setConfirm(null)} width={440} footer={<>
          <button className="btn btn-quiet" onClick={() => setConfirm(null)}>{t('common.cancel')}</button>
          <button className="btn btn-danger" data-autofocus onClick={() => { void actions.removeProject(confirm.id); setConfirm(null); }}>{t('common.remove')}</button>
        </>}>
          <p className="muted">{t('projects.confirmText')}</p>
        </Modal>
      )}
    </Modal>
  );
}

type SelfTest = { state: 'idle' | 'running' } | { state: 'passed'; ms: number; total: number } | { state: 'failed'; code: string };
export function DiagnosticsDialog({ onClose }: { onClose: () => void }) {
  const t = useT(); const locale = useLocale();
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
    <Modal title={t('diag.title')} onClose={onClose} width={720}>
      <div className="diag-grid">
        <div className="diag-item"><span className="muted small">{t('diag.service')}</span>
          <strong className={`mono ${connection === 'ready' ? 'tone-text-ok' : 'tone-text-danger'}`}>{desktop?.service.state ?? t('common.unknown')}</strong></div>
        <div className="diag-item"><span className="muted small">{t('panel.expressRun')}</span><strong className="mono">{shortId(desktop?.service.expressRunId)}</strong></div>
        <div className="diag-item"><span className="muted small">{t('panel.uptime')}</span><strong>{overview ? duration(overview.uptimeMs) : '—'}</strong></div>
        <div className="diag-item"><span className="muted small">{t('panel.schema')}</span><strong>{overview ? `v${overview.database.version}` : '—'}</strong></div>
      </div>
      <div className="diag-actions">
        <button className="btn" onClick={() => void selfTest()} disabled={connection !== 'ready' || test.state === 'running'}>
          <IconCheck size={14} /> {t('diag.selfTest')}
        </button>
        {test.state === 'passed' && <span className="tone-text-ok small">{t('diag.passed', { ms: test.ms })}</span>}
        {test.state === 'failed' && <span className="tone-text-danger small mono">{t('diag.failed', { code: test.code })}</span>}
        {test.state === 'running' && <span className="muted small">{t('diag.running')}</span>}
        <span className="tool-spacer" />
        <button className="btn btn-quiet" onClick={() => void actions.retry()} disabled={connection === 'ready' || connection === 'restarting'} title={t('diag.restartTitle')}>
          <IconRetry size={14} /> {t('diag.restart')}
        </button>
      </div>
      <h3 className="section-label">{t('diag.runs')}</h3>
      <table className="runs-table">
        <thead><tr><th>{t('diag.run')}</th><th>{t('diag.started')}</th><th>{t('diag.ended')}</th><th>{t('diag.outcome')}</th></tr></thead>
        <tbody>
          {runs.map(run => (
            <tr key={run.id}>
              <td className="mono">{shortId(run.id)}{run.id === desktop?.service.expressRunId && <span className="badge badge-soft">{t('diag.current')}</span>}</td>
              <td>{dateTime(run.startedAt, locale)}</td>
              <td>{run.endedAt ? dateTime(run.endedAt, locale) : '—'}</td>
              <td className={run.outcome === 'CLEAN' ? 'tone-text-ok' : run.outcome === 'INTERRUPTED' ? 'tone-text-warn' : 'tone-text-run'}>{t(`diag.outcome.${run.outcome}`)}</td>
            </tr>
          ))}
          {runs.length === 0 && <tr><td colSpan={4} className="muted">{t('diag.noRuns')}</td></tr>}
        </tbody>
      </table>
      <p className="muted small">{t('diag.note')}</p>
    </Modal>
  );
}
