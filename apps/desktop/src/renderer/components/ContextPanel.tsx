import { useState } from 'react';
import type { ReactNode } from 'react';
import { useStore } from '../state';
import { duration, shortId } from './format';
import { IconCheck, IconDiff, IconFile, IconFlask, IconInfo, IconLock, IconShield } from './Icons';

type Tab = 'status' | 'files' | 'changes' | 'results';
const LOCKED: Record<Exclude<Tab, 'status'>, { icon: ReactNode; title: string; code: string; text: string }> = {
  files: { icon: <IconFile size={18} />, title: 'Files are not available', code: 'READ_ADAPTER_UNAVAILABLE',
    text: 'Reading project files requires the short-lived Read Adapter and its Read Gate (SEC-08). Express never reads workspace files itself.' },
  changes: { icon: <IconDiff size={18} />, title: 'No changes to review', code: 'SANDBOX_UNAVAILABLE',
    text: 'Writes and shell commands need an OS sandbox that passed this platform’s P3b gate. Until then they are refused, never run unsandboxed.' },
  results: { icon: <IconFlask size={18} />, title: 'No results yet', code: 'WORKER_ISOLATION_UNAVAILABLE',
    text: 'Results appear once an isolated Worker can run tasks. The Worker gate (SEC-W01) has not passed on this platform.' },
};

function Kv({ label, children, tone }: { label: string; children: ReactNode; tone?: 'ok' | 'warn' | 'danger' | 'muted' | undefined }) {
  return <div className="kv"><dt>{label}</dt><dd className={tone ? `tone-text-${tone}` : undefined}>{children}</dd></div>;
}

function StatusTab() {
  const desktop = useStore(s => s.desktop);
  const overview = useStore(s => s.overview);
  const connection = useStore(s => s.connection);
  const service = desktop?.service;
  const capability = (value: string): 'muted' | 'danger' => value === 'unavailable' ? 'danger' : 'muted';
  return (
    <div className="rp-scroll status-tab">
      <section className="status-card">
        <h3 className="status-title"><span className={`dot ${connection === 'ready' ? 'tone-ok' : connection === 'unavailable' ? 'tone-danger' : 'tone-wait dot-live'}`} />Control plane</h3>
        <dl className="kv-list">
          <Kv label="State" tone={service?.state === 'ready' ? 'ok' : service?.state === 'budget-exhausted' || service?.state === 'unavailable' ? 'danger' : undefined}>{service?.state ?? 'unknown'}</Kv>
          <Kv label="Express run"><span className="mono">{shortId(service?.expressRunId)}</span></Kv>
          <Kv label="Uptime">{overview && connection === 'ready' ? duration(overview.uptimeMs) : '—'}</Kv>
          <Kv label="Automatic restarts">{service?.restarts ?? 0} / 3 per minute</Kv>
          <Kv label="Transport"><span className="mono">127.0.0.1 · HMAC · inherited bootstrap</span></Kv>
        </dl>
      </section>
      <section className="status-card">
        <h3 className="status-title"><IconShield size={14} />Agent Worker</h3>
        <dl className="kv-list">
          <Kv label="agentReady" tone="danger"><span className="mono">false</span></Kv>
          <Kv label="Gate"><span className="mono">{overview?.worker.reason ?? 'SEC_W01_NOT_PASSED'}</span></Kv>
          <Kv label="Task start"><span className="mono">{overview?.worker.error ?? 'WORKER_ISOLATION_UNAVAILABLE'}</span></Kv>
          <Kv label="Fixture launch"><span className="mono">{overview?.worker.fixtureLaunch ?? 'disabled-in-release'}</span></Kv>
        </dl>
      </section>
      <section className="status-card">
        <h3 className="status-title"><IconInfo size={14} />Capabilities · {overview ? `${overview.runtime.platform}-${overview.runtime.arch}` : '—'}</h3>
        <dl className="kv-list">
          {overview ? Object.entries(overview.capabilities).map(([name, value]) => <Kv key={name} label={name} tone={capability(value)}><span className="mono">{value}</span></Kv>)
            : <Kv label="Matrix">waiting for control plane</Kv>}
        </dl>
        <p className="muted small">Nothing here is reported as verified until its gate passes in a real installed build. Unverified means disabled.</p>
      </section>
      <section className="status-card">
        <h3 className="status-title"><IconCheck size={14} />Database & runtime</h3>
        <dl className="kv-list">
          <Kv label="Schema">{overview ? `v${overview.database.version}` : '—'}</Kv>
          <Kv label="Projects">{overview?.database.projects ?? '—'}</Kv>
          <Kv label="Control-plane runs">{overview?.database.runs ?? '—'}</Kv>
          <Kv label="Recovered at start" tone={overview?.database.recoveredRuns ? 'warn' : undefined}>{overview?.database.recoveredRuns ?? '—'}</Kv>
          <Kv label="Sidecar Node"><span className="mono">{overview ? `${overview.runtime.node} · ABI ${overview.runtime.abi}` : '—'}</span></Kv>
          <Kv label="SQLite"><span className="mono">{overview?.runtime.sqlite ?? '—'}</span></Kv>
          <Kv label="App"><span className="mono">{desktop ? `${desktop.app.version} · Electron ${desktop.app.electron}${desktop.app.packaged ? '' : ' · dev'}` : '—'}</span></Kv>
        </dl>
      </section>
    </div>
  );
}

export function ContextPanel() {
  const [tab, setTab] = useState<Tab>('status');
  const tabs: { id: Tab; label: string; locked: boolean }[] = [
    { id: 'status', label: 'Status', locked: false }, { id: 'files', label: 'Files', locked: true },
    { id: 'changes', label: 'Changes', locked: true }, { id: 'results', label: 'Results', locked: true },
  ];
  const locked = tab === 'status' ? undefined : LOCKED[tab];
  return (
    <aside className="right-panel" aria-label="Context">
      <div className="rp-tabs" role="tablist">
        {tabs.map(item => (
          <button key={item.id} role="tab" aria-selected={tab === item.id} className={`rp-tab${tab === item.id ? ' is-active' : ''}`} onClick={() => setTab(item.id)}>
            {item.label}{item.locked && <IconLock size={11} className="muted" />}
          </button>
        ))}
      </div>
      <div className="rp-body">
        {locked ? (
          <div className="panel-empty">
            <div className="panel-empty-icon">{locked.icon}</div>
            <div className="panel-empty-title">{locked.title}</div>
            <div className="panel-empty-text">{locked.text}</div>
            <span className="badge badge-soft mono">{locked.code}</span>
          </div>
        ) : <StatusTab />}
      </div>
    </aside>
  );
}
