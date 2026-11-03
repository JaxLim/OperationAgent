import { useCallback, useEffect, useRef, useState } from 'react';
import { actions, useStore } from './state';
import { Sidebar } from './components/Sidebar';
import { Workspace, requestComposerFocus } from './components/Workspace';
import type { ComposerHandle } from './components/Workspace';
import { ContextPanel } from './components/ContextPanel';
import { DiagnosticsDialog, ProjectsDialog } from './components/Dialogs';
import { SettingsDialog } from './components/Settings';
import type { SectionId } from './components/Settings';
import { shortId } from './components/format';
import { IconAlert, IconCompose, IconPanelLeft, IconPanelRight, IconRetry } from './components/Icons';
import { applyPalette } from './themes';
import { useLocale, useT } from './locale';

type Dialog = { kind: 'projects' | 'diagnostics' } | { kind: 'settings'; section: SectionId } | null;

const DARK = '(prefers-color-scheme: dark)';
/** Whether dark mode is in effect: the saved mode, or the system's when it follows the system. */
function useDark(theme: 'system' | 'light' | 'dark'): boolean {
  const [systemDark, setSystemDark] = useState(() => window.matchMedia(DARK).matches);
  useEffect(() => {
    const query = window.matchMedia(DARK);
    const update = (): void => setSystemDark(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return theme === 'system' ? systemDark : theme === 'dark';
}

function useAppearance(): void {
  const theme = useStore(s => s.settings?.theme ?? 'system');
  const density = useStore(s => s.settings?.density ?? 'comfortable');
  const lightTheme = useStore(s => s.settings?.lightTheme ?? 'operation');
  const darkTheme = useStore(s => s.settings?.darkTheme ?? 'operation');
  const locale = useLocale();
  const dark = useDark(theme);
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', theme);
    root.setAttribute('data-density', density);
    applyPalette(root, dark ? darkTheme : lightTheme, dark ? 'dark' : 'light');
  }, [theme, density, dark, lightTheme, darkTheme]);
  useEffect(() => { document.documentElement.lang = locale; }, [locale]);
}

/** Sidebar visibility is a per-window convenience, so it lives in browser storage, never in the control plane. */
function useSidebar(): [boolean, () => void] {
  const [open, setOpen] = useState(() => { try { return localStorage.getItem('sidebar') !== 'closed'; } catch { return true; } });
  const toggle = useCallback(() => setOpen(value => {
    try { localStorage.setItem('sidebar', value ? 'closed' : 'open'); } catch { /* Storage is optional. */ }
    return !value;
  }), []);
  return [open, toggle];
}

const NARROW = '(max-width: 1180px)';
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW).matches);
  useEffect(() => {
    const query = window.matchMedia(NARROW);
    const update = (): void => setNarrow(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return narrow;
}

/** Quiet when healthy; says what is wrong when it is not. Detail lives in the Status panel and Diagnostics. */
function ConnectionIndicator({ onOpen }: { onOpen: () => void }) {
  const t = useT();
  const connection = useStore(s => s.connection);
  const label = t(({ connecting: 'conn.connecting', ready: 'conn.ready', restarting: 'conn.restarting', unavailable: 'conn.unavailable' } as const)[connection]);
  const tone = { connecting: 'tone-wait dot-live', ready: 'tone-ok', restarting: 'tone-wait dot-live', unavailable: 'tone-danger' }[connection];
  return (
    <button className={`conn-chip${connection === 'ready' ? ' is-quiet' : ''}`} onClick={onOpen} title={t('conn.title', { label })} aria-label={t('conn.title', { label })}>
      <span className={`dot ${tone}`} />{connection !== 'ready' && <span>{label}</span>}
    </button>
  );
}

function ServiceBanner() {
  const t = useT();
  const connection = useStore(s => s.connection);
  const state = useStore(s => s.desktop?.service.state);
  if (connection !== 'unavailable') return null;
  const exhausted = state === 'budget-exhausted';
  return (
    <div className="service-banner" role="alert">
      <IconAlert size={15} />
      <span><strong>{t(exhausted ? 'banner.exhaustedTitle' : 'banner.downTitle')}</strong>{' '}{t(exhausted ? 'banner.exhaustedText' : 'banner.downText')}</span>
      <button className="btn btn-xs" onClick={() => void actions.retry()}><IconRetry size={12} /> {t('common.retry')}</button>
    </div>
  );
}

function Notices() {
  const notices = useStore(s => s.notices);
  return <div className="toasts" aria-live="polite">{notices.map(notice => <div key={notice.id} className={`toast tone-notice-${notice.tone}`}>{notice.text}</div>)}</div>;
}

export function App() {
  useAppearance();
  const t = useT();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [leftOpen, toggleLeft] = useSidebar();
  const settings = useStore(s => s.settings);
  const projects = useStore(s => s.projects);
  const selectedTaskId = useStore(s => s.selectedTaskId);
  const loaded = useStore(s => s.loaded && s.model !== null);
  const composer = useRef<ComposerHandle>(null);
  const search = useRef<HTMLInputElement>(null);
  // Narrow windows float the side panel over the chat, so it opens only on request there and the saved preference is left alone.
  const narrow = useNarrow();
  const [overlay, setOverlay] = useState(false);
  useEffect(() => { setOverlay(false); }, [narrow]);
  const rightOpen = narrow ? overlay : settings?.contextPanel ?? true;
  const project = projects.find(item => item.id === settings?.activeProjectId);
  // A dialog that finishes closing only clears itself; another may have replaced it meanwhile.
  const closeDialog = useCallback((kind: NonNullable<Dialog>['kind']) => setDialog(current => current?.kind === kind ? null : current), []);
  const openSettings = useCallback((section: SectionId = 'appearance') => setDialog({ kind: 'settings', section }), []);
  const togglePanel = useCallback(() => {
    if (narrow) setOverlay(value => !value);
    else if (settings) void actions.saveSettings({ contextPanel: !settings.contextPanel });
  }, [settings, narrow]);
  // An open task replaces the composer: leave the task, then focus the composer now or as soon as it mounts again.
  const newTask = useCallback(() => { actions.selectTask(null); requestComposerFocus(composer.current); }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || dialog) return;
      const key = event.key.toLowerCase();
      if (key === 'n') { event.preventDefault(); newTask(); }
      else if (key === 'o') { event.preventDefault(); setDialog({ kind: 'projects' }); }
      else if (key === ',') { event.preventDefault(); openSettings(); }
      else if (key === '\\') { event.preventDefault(); togglePanel(); }
      else if (key === 'b') { event.preventDefault(); toggleLeft(); }
      else if (key === 'k') {
        event.preventDefault();
        if (!leftOpen) toggleLeft();
        setTimeout(() => search.current?.focus(), 0);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialog, togglePanel, newTask, openSettings, toggleLeft, leftOpen]);

  return (
    <div className={`app${rightOpen ? '' : ' no-right'}${leftOpen ? '' : ' no-left'}`} data-loaded={loaded}>
      {leftOpen && <Sidebar ref={search} onCollapse={toggleLeft} onNewTask={newTask} onOpenProjects={() => setDialog({ kind: 'projects' })}
        onOpenSettings={() => openSettings()} onOpenDiagnostics={() => setDialog({ kind: 'diagnostics' })} />}
      {leftOpen && <div className="sidebar-scrim" onClick={toggleLeft} aria-hidden="true" />}
      <main className="main">
        <header className="main-header">
          {!leftOpen && <>
            <button className="icon-btn" onClick={toggleLeft} aria-label={t('app.showSidebar')} title={t('app.showSidebarTitle')}><IconPanelLeft size={17} /></button>
            <button className="icon-btn" onClick={newTask} disabled={!project} aria-label={t('app.newChat')} title={t('app.newChatTitle')}><IconCompose size={17} /></button>
          </>}
          <div className="main-title">
            {selectedTaskId ? <><span className="muted">{project?.name}</span><span className="main-title-sep">/</span><span>{t('task.label')} <span className="mono">{shortId(selectedTaskId)}</span></span></>
              : project ? <button className="main-title-button" onClick={() => setDialog({ kind: 'projects' })} title={project.path}>{project.name}</button>
                : <span className="muted">OperationAgent</span>}
          </div>
          <span className="tool-spacer" />
          <ConnectionIndicator onOpen={() => setDialog({ kind: 'diagnostics' })} />
          <button className={`icon-btn${rightOpen ? ' is-on' : ''}`} onClick={togglePanel} disabled={!settings} aria-label={t('app.togglePanel')} aria-pressed={rightOpen}
            title={t('app.panelTitle')}><IconPanelRight size={17} /></button>
        </header>
        <ServiceBanner />
        <Workspace ref={composer} onOpenSettings={target => openSettings(target)} />
      </main>
      {rightOpen && <ContextPanel onClose={togglePanel} />}

      {dialog?.kind === 'projects' && <ProjectsDialog onClose={() => closeDialog('projects')} />}
      {dialog?.kind === 'settings' && <SettingsDialog key={dialog.section} initialSection={dialog.section} onClose={() => closeDialog('settings')}
        onOpenDiagnostics={() => setDialog({ kind: 'diagnostics' })} />}
      {dialog?.kind === 'diagnostics' && <DiagnosticsDialog onClose={() => closeDialog('diagnostics')} />}
      <Notices />
    </div>
  );
}
