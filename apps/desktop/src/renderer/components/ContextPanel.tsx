import { useState } from 'react';
import type { ReactNode } from 'react';
import type { MessageKey } from '../i18n';
import { useT } from '../locale';
import { useStore } from '../state';
import { duration, shortId } from './format';
import { IconCheck, IconDiff, IconFile, IconFlask, IconInfo, IconLock, IconShield, IconX } from './Icons';

// Secondary views beside the chat. Only Status shows live data; the rest explain which gate keeps them empty.

type Tab = 'status' | 'files' | 'changes' | 'approvals' | 'results';
const LOCKED: Record<Exclude<Tab, 'status'>, { icon: ReactNode; title: MessageKey; code: string; text: MessageKey }> = {
  files: { icon: <IconFile size={18} />, title: 'panel.files.title', code: 'READ_ADAPTER_UNAVAILABLE', text: 'panel.files.text' },
  changes: { icon: <IconDiff size={18} />, title: 'panel.changes.title', code: 'SANDBOX_UNAVAILABLE', text: 'panel.changes.text' },
  approvals: { icon: <IconShield size={18} />, title: 'panel.approvals.title', code: 'SANDBOX_UNAVAILABLE', text: 'panel.approvals.text' },
  results: { icon: <IconFlask size={18} />, title: 'panel.results.title', code: 'WORKER_ISOLATION_UNAVAILABLE', text: 'panel.results.text' },
};

function Kv({ label, children, tone }: { label: string; children: ReactNode; tone?: 'ok' | 'warn' | 'danger' | 'muted' | undefined }) {
  return <div className="kv"><dt>{label}</dt><dd className={tone ? `tone-text-${tone}` : undefined}>{children}</dd></div>;
}

function StatusTab() {
  const t = useT();
  const desktop = useStore(s => s.desktop);
  const overview = useStore(s => s.overview);
  const connection = useStore(s => s.connection);
  const service = desktop?.service;
  const capability = (value: string): 'muted' | 'danger' => value === 'unavailable' ? 'danger' : 'muted';
  return (
    <div className="rp-scroll status-tab">
      <section className="status-card">
        <h3 className="status-title"><span className={`dot ${connection === 'ready' ? 'tone-ok' : connection === 'unavailable' ? 'tone-danger' : 'tone-wait dot-live'}`} />{t('panel.controlPlane')}</h3>
        <dl className="kv-list">
          <Kv label={t('panel.state')} tone={service?.state === 'ready' ? 'ok' : service?.state === 'budget-exhausted' || service?.state === 'unavailable' ? 'danger' : undefined}>
            <span className="mono">{service?.state ?? t('common.unknown')}</span></Kv>
          <Kv label={t('panel.expressRun')}><span className="mono">{shortId(service?.expressRunId)}</span></Kv>
          <Kv label={t('panel.uptime')}>{overview && connection === 'ready' ? duration(overview.uptimeMs) : '—'}</Kv>
          <Kv label={t('panel.restarts')}>{t('panel.restartsValue', { count: service?.restarts ?? 0 })}</Kv>
          <Kv label={t('panel.transport')}><span className="mono">127.0.0.1 · HMAC · inherited bootstrap</span></Kv>
        </dl>
      </section>
      <section className="status-card">
        <h3 className="status-title"><IconShield size={14} />{t('panel.worker')}</h3>
        <dl className="kv-list">
          <Kv label="agentReady" tone={overview?.agentReady ? 'ok' : 'danger'}><span className="mono">{String(overview?.agentReady ?? false)}</span></Kv>
          {overview?.worker.state === 'unavailable' || !overview ? <>
            <Kv label={t('panel.blockedBy')}><span className="mono">{overview?.worker.state === 'unavailable' ? overview.worker.reason : 'WORKER_RUNTIME_NOT_STAGED'}</span></Kv>
            <Kv label={t('panel.taskStart')}><span className="mono">WORKER_ISOLATION_UNAVAILABLE</span></Kv>
          </> : <Kv label={t('panel.workerState')}><span className="mono">{overview.worker.state} · {t('panel.launches', { count: overview.worker.launches })}</span></Kv>}
          <Kv label={t('panel.fixture')}><span className="mono">{overview?.worker.fixtureLaunch ?? 'disabled-in-release'}</span></Kv>
        </dl>
      </section>
      <section className="status-card">
        <h3 className="status-title"><IconInfo size={14} />{t('panel.capabilities', { platform: overview ? `${overview.runtime.platform}-${overview.runtime.arch}` : '—' })}</h3>
        <dl className="kv-list">
          {overview ? Object.entries(overview.capabilities).map(([name, value]) => <Kv key={name} label={name} tone={capability(value)}><span className="mono">{value}</span></Kv>)
            : <Kv label={t('panel.matrix')}>{t('panel.waiting')}</Kv>}
        </dl>
        <p className="muted small">{t('panel.capNote')}</p>
      </section>
      <section className="status-card">
        <h3 className="status-title"><IconCheck size={14} />{t('panel.database')}</h3>
        <dl className="kv-list">
          <Kv label={t('panel.schema')}>{overview ? `v${overview.database.version}` : '—'}</Kv>
          <Kv label={t('panel.projects')}>{overview?.database.projects ?? '—'}</Kv>
          <Kv label={t('panel.runs')}>{overview?.database.runs ?? '—'}</Kv>
          <Kv label={t('panel.recovered')} tone={overview?.database.recoveredRuns ? 'warn' : undefined}>{overview?.database.recoveredRuns ?? '—'}</Kv>
          <Kv label={t('panel.node')}><span className="mono">{overview ? `${overview.runtime.node} · ABI ${overview.runtime.abi}` : '—'}</span></Kv>
          <Kv label="SQLite"><span className="mono">{overview?.runtime.sqlite ?? '—'}</span></Kv>
          <Kv label={t('panel.app')}><span className="mono">{desktop ? `${desktop.app.version} · Electron ${desktop.app.electron}${desktop.app.packaged ? '' : ' · dev'}` : '—'}</span></Kv>
        </dl>
      </section>
    </div>
  );
}

export function ContextPanel({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [tab, setTab] = useState<Tab>('status');
  const tabs: { id: Tab; label: string; icon: ReactNode }[] = [
    { id: 'status', label: t('panel.tab.status'), icon: <IconInfo size={14} /> }, { id: 'files', label: t('panel.tab.files'), icon: <IconFile size={14} /> },
    { id: 'changes', label: t('panel.tab.changes'), icon: <IconDiff size={14} /> }, { id: 'approvals', label: t('panel.tab.approvals'), icon: <IconShield size={14} /> },
    { id: 'results', label: t('panel.tab.results'), icon: <IconFlask size={14} /> },
  ];
  const locked = tab === 'status' ? undefined : LOCKED[tab];
  return (
    <aside className="right-panel" aria-label={t('panel.label')}>
      <div className="rp-head">
        <div className="rp-tabs" role="tablist" aria-label={t('panel.views')}>
          {tabs.map(item => (
            <button key={item.id} role="tab" aria-selected={tab === item.id} className={`rp-tab${tab === item.id ? ' is-active' : ''}`} onClick={() => setTab(item.id)}
              title={item.id === 'status' ? item.label : t('panel.locked', { label: item.label })} aria-label={item.label}>
              {item.icon}<span className="rp-tab-label">{item.label}</span>
            </button>
          ))}
        </div>
        <button className="icon-btn icon-btn-sm rp-close" onClick={onClose} aria-label={t('panel.hide')} title={t('panel.hideTitle')}><IconX size={15} /></button>
      </div>
      <div className="rp-body" role="tabpanel">
        {locked ? (
          <div className="panel-empty">
            <div className="panel-empty-icon">{locked.icon}</div>
            <div className="panel-empty-title">{t(locked.title)}</div>
            <div className="panel-empty-text">{t(locked.text)}</div>
            <span className="badge badge-soft mono"><IconLock size={11} /> {locked.code}</span>
          </div>
        ) : <StatusTab />}
      </div>
    </aside>
  );
}
