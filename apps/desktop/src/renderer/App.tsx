import { useCallback, useEffect, useRef, useState } from 'react';
import { actions, useStore } from './state';
import { Sidebar } from './components/Sidebar';
import { Workspace } from './components/Workspace';
import type { ComposerHandle } from './components/Workspace';
import { ContextPanel } from './components/ContextPanel';
import { DiagnosticsDialog, ProjectsDialog, SettingsDialog } from './components/Dialogs';
import { IconAlert, IconChevronRight, IconLock, IconPanelLeft, IconPanelRight, IconRetry, IconSettings } from './components/Icons';

type Dialog = 'projects' | 'settings' | 'diagnostics' | null;

function useAppearance(): void {
  const theme = useStore(s => s.settings?.theme ?? 'system');
  const density = useStore(s => s.settings?.density ?? 'comfortable');
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', theme);
    root.setAttribute('data-density', density);
  }, [theme, density]);
}

function ConnectionChip({ onOpen }: { onOpen: () => void }) {
  const connection = useStore(s => s.connection);
  const label = { connecting: 'Connecting…', ready: 'Control plane connected', restarting: 'Reconnecting…', unavailable: 'Control plane unavailable' }[connection];
  const tone = { connecting: 'tone-wait dot-live', ready: 'tone-ok', restarting: 'tone-wait dot-live', unavailable: 'tone-danger' }[connection];
  return <button className="conn-chip" onClick={onOpen} title="Open diagnostics"><span className={`dot ${tone}`} />{label}</button>;
}

function ServiceBanner() {
  const connection = useStore(s => s.connection);
  const state = useStore(s => s.desktop?.service.state);
  if (connection !== 'unavailable') return null;
  const exhausted = state === 'budget-exhausted';
  return (
    <div className="service-banner" role="alert">
      <IconAlert size={15} />
      <span><strong>{exhausted ? 'The control plane kept crashing and was stopped.' : 'The control plane is not running.'}</strong>{' '}
        {exhausted ? 'Automatic restarts are limited to 3 per minute. Projects and settings are safe in the local database.' : 'Nothing can be saved until it is back.'}</span>
      <button className="btn btn-xs" onClick={() => void actions.retry()}><IconRetry size={12} /> Retry</button>
    </div>
  );
}

function Notices() {
  const notices = useStore(s => s.notices);
  return <div className="toasts" aria-live="polite">{notices.map(notice => <div key={notice.id} className={`toast tone-notice-${notice.tone}`}>{notice.text}</div>)}</div>;
}

export function App() {
  useAppearance();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [leftOpen, setLeftOpen] = useState(true);
  const settings = useStore(s => s.settings);
  const projects = useStore(s => s.projects);
  const desktop = useStore(s => s.desktop);
  const overview = useStore(s => s.overview);
  const connection = useStore(s => s.connection);
  const composer = useRef<ComposerHandle>(null);
  const rightOpen = settings?.contextPanel ?? true;
  const project = projects.find(item => item.id === settings?.activeProjectId);
  const close = useCallback(() => setDialog(null), []);
  const togglePanel = useCallback(() => { if (settings) void actions.saveSettings({ contextPanel: !settings.contextPanel }); }, [settings]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || dialog) return;
      const key = event.key.toLowerCase();
      if (key === 'n') { event.preventDefault(); composer.current?.focus(); }
      else if (key === 'o') { event.preventDefault(); setDialog('projects'); }
      else if (key === ',') { event.preventDefault(); setDialog('settings'); }
      else if (key === '\\') { event.preventDefault(); togglePanel(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialog, togglePanel]);

  return (
    <div className={`app${rightOpen ? '' : ' no-right'}${leftOpen ? '' : ' no-left'}`}>
      <header className="titlebar">
        <div className="titlebar-left">
          <button className="icon-btn" onClick={() => setLeftOpen(value => !value)} aria-label="Toggle sidebar" title="Toggle sidebar"><IconPanelLeft size={16} /></button>
          <span className="brand"><span className="brand-mark" aria-hidden="true" />OperationAgent</span>
          <span className="crumbs">
            <IconChevronRight size={12} className="muted" />
            <button className="crumb" onClick={() => setDialog('projects')}>{project?.name ?? 'No project'}</button>
          </span>
        </div>
        <div className="titlebar-center"><ConnectionChip onOpen={() => setDialog('diagnostics')} /></div>
        <div className="titlebar-right">
          <button className="icon-btn" onClick={() => setDialog('settings')} aria-label="Settings" title="Settings (Ctrl+,)"><IconSettings size={16} /></button>
          <button className={`icon-btn${rightOpen ? ' is-on' : ''}`} onClick={togglePanel} disabled={!settings} aria-label="Toggle context panel" title="Toggle context panel (Ctrl+\)"><IconPanelRight size={16} /></button>
        </div>
      </header>

      {leftOpen && <Sidebar onOpenProjects={() => setDialog('projects')} onOpenSettings={() => setDialog('settings')}
        onOpenDiagnostics={() => setDialog('diagnostics')} onNewTask={() => composer.current?.focus()} />}
      <main className="main"><ServiceBanner /><Workspace ref={composer} /></main>
      {rightOpen && <ContextPanel />}

      <footer className="statusbar">
        <span className="sb-item"><span className={`dot ${connection === 'ready' ? 'tone-ok' : connection === 'unavailable' ? 'tone-danger' : 'tone-wait'}`} />
          Control plane · {desktop?.service.state ?? 'starting'}{overview && connection === 'ready' ? ` · DB v${overview.database.version}` : ''}</span>
        <span className="sb-item"><IconLock size={11} />Agent unavailable · WORKER_ISOLATION_UNAVAILABLE</span>
        <span className="sb-item"><IconLock size={11} />Tools disabled · no sandbox</span>
        <span className="tool-spacer" />
        <span className="sb-item">{desktop ? `v${desktop.app.version}` : ''}</span>
      </footer>

      {dialog === 'projects' && <ProjectsDialog onClose={close} />}
      {dialog === 'settings' && <SettingsDialog onClose={close} />}
      {dialog === 'diagnostics' && <DiagnosticsDialog onClose={close} />}
      <Notices />
    </div>
  );
}
