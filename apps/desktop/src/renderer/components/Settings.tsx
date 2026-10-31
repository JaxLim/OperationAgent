import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import type { WorkbenchSettings } from '@operation-agent/contracts';
import { actions, useStore } from '../state';
import { Modal, Row, Segmented, Toggle, useModalClose } from './Modal';
import { ModelSection } from './ModelSettings';
import { IconBell, IconChart, IconCheck, IconInfo, IconLaptop, IconLock, IconPalette, IconPuzzle, IconSearch, IconShield, IconSliders, IconSparkle,
  IconTerminal, IconWrench, IconX } from './Icons';

export type SectionId = 'general' | 'models' | 'chat' | 'plugins' | 'usage' | 'voice' | 'advanced';
interface Section { id: SectionId; title: string; lead: string; icon: ReactNode; keywords: string }
const SECTIONS: readonly Section[] = [
  { id: 'general', title: 'General & Appearance', lead: 'How this workbench looks on this device.', icon: <IconPalette size={16} />,
    keywords: 'theme light dark system density compact comfortable panel context motion animation' },
  { id: 'models', title: 'Models & Credentials', lead: 'The Claude model new chats use, and the key the control plane sends to Anthropic.', icon: <IconSparkle size={16} />,
    keywords: 'claude opus sonnet haiku api key anthropic credential test connection provider' },
  { id: 'chat', title: 'Chat & Execution', lead: 'Defaults for how requests run, stop and get approved.', icon: <IconSliders size={16} />,
    keywords: 'stop grace period approval policy sandbox execution location computer effort reasoning mode drafts' },
  { id: 'plugins', title: 'Plugins & Skills', lead: 'Tools from MCP servers and reusable skills.', icon: <IconPuzzle size={16} />, keywords: 'mcp server plugin skill extension tool' },
  { id: 'usage', title: 'Usage', lead: 'Token use, provider quota and local storage — and which numbers are known.', icon: <IconChart size={16} />,
    keywords: 'tokens quota context limit storage database records billing' },
  { id: 'voice', title: 'Voice & Notifications', lead: 'Dictation and how the app gets your attention.', icon: <IconBell size={16} />,
    keywords: 'voice microphone dictation notifications alerts toast sound' },
  { id: 'advanced', title: 'Advanced & About', lead: 'Security status, diagnostics, versions and shortcuts.', icon: <IconWrench size={16} />,
    keywords: 'security sandbox worker isolation diagnostics version about keyboard shortcuts electron sqlite' },
];

function SaveIndicator() {
  const status = useStore(s => s.saveStatus);
  return (
    <span className={`save-indicator is-${status.state}`} role="status" aria-live="polite">
      {status.state === 'saving' && 'Saving…'}
      {status.state === 'saved' && <><IconCheck size={13} /> Saved</>}
      {status.state === 'failed' && <><IconX size={13} /> Not saved · <span className="mono">{status.code}</span></>}
      {status.state === 'idle' && 'Changes save automatically'}
    </span>
  );
}

function Availability({ children }: { children: ReactNode }) {
  return <span className="badge badge-soft"><IconLock size={11} /> {children}</span>;
}

const THEMES: { value: WorkbenchSettings['theme']; label: string }[] = [{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }];
function ThemePicker({ value }: { value: WorkbenchSettings['theme'] }) {
  return (
    <div className="theme-cards" role="radiogroup" aria-label="Theme">
      {THEMES.map(theme => (
        <button key={theme.value} role="radio" aria-checked={value === theme.value} className={`theme-card${value === theme.value ? ' is-active' : ''}`}
          onClick={() => void actions.saveSettings({ theme: theme.value })}>
          <span className={`theme-preview theme-preview-${theme.value}`} aria-hidden="true"><span /><span /><span /></span>
          <span className="theme-card-label">{theme.label}</span>
        </button>
      ))}
    </div>
  );
}

function useReducedMotion(): boolean {
  const query = useMemo(() => window.matchMedia('(prefers-reduced-motion: reduce)'), []);
  const [reduced, setReduced] = useState(query.matches);
  useEffect(() => {
    const update = (): void => setReduced(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, [query]);
  return reduced;
}

function GeneralSection({ settings }: { settings: WorkbenchSettings }) {
  const reduced = useReducedMotion();
  return (
    <>
      <div className="setting-block">
        <div className="setting-label">Theme<span className="scope-tag scope-device">This app</span></div>
        <div className="setting-hint">System follows Windows. Light and dark also restyle the window’s caption buttons.</div>
        <ThemePicker value={settings.theme} />
      </div>
      <Row label="Density" scope="device" hint="Compact tightens rows in the sidebar, panels and settings.">
        <Segmented value={settings.density} onChange={density => void actions.saveSettings({ density })}
          options={[{ value: 'comfortable', label: 'Comfortable' }, { value: 'compact', label: 'Compact' }]} />
      </Row>
      <Row label="Show side panel" scope="device" hint="Files, changes, approvals, results and system status beside the chat. Toggle any time with Ctrl+\.">
        <Toggle label="Show side panel" checked={settings.contextPanel} onChange={contextPanel => void actions.saveSettings({ contextPanel })} />
      </Row>
      <Row label="Motion" hint="Follows the Windows “Show animations” setting. When it is off, springs and slides are replaced by instant changes.">
        <span className="value-text">{reduced ? 'Reduced' : 'Full'}</span>
      </Row>
    </>
  );
}

function ChatSection({ settings }: { settings: WorkbenchSettings }) {
  return (
    <>
      <div className="settings-note"><IconInfo size={14} /><span>These are global defaults. This build has no per-chat overrides: changing the model from the composer changes the default too.</span></div>
      <Row label="Execution location" hint="Requests would run on this computer, inside an OS sandbox. Remote and cloud execution are not supported.">
        <span className="value-text"><IconLaptop size={14} /> This computer</span>
      </Row>
      <Row label="Stop grace period" scope="global" hint="How long a cancelled tool process gets before forced cleanup. Allowed range 5–30 s; applies once tool execution exists.">
        <Segmented value={settings.stopGraceMs} onChange={stopGraceMs => void actions.saveSettings({ stopGraceMs })}
          options={[{ value: 5000, label: '5 s' }, { value: 10000, label: '10 s' }, { value: 30000, label: '30 s' }]} />
      </Row>
      <Row label="Approval policy" hint="Command and write approvals arrive with tool execution. An approval never lifts the sandbox.">
        <Availability>Not available yet</Availability>
      </Row>
      <Row label="Reasoning effort and work mode" hint="Chosen per request by the agent runtime, which this build doesn’t include.">
        <Availability>Not available yet</Availability>
      </Row>
      <Row label="Drafts" hint="Unsent text and goals are kept per project in memory until the window closes. Prompts are never written to disk.">
        <span className="value-text">In memory</span>
      </Row>
      <div className="settings-note"><IconShield size={14} /><span>Raw <span className="mono">sh -c</span>, pipes, redirection, <span className="mono">git push --force</span> and <span className="mono">git reset --hard</span> will never be grantable at task level.</span></div>
    </>
  );
}

function PluginsSection() {
  return (
    <>
      <div className="feature-empty">
        <span className="feature-empty-icon"><IconPuzzle size={20} /></span>
        <strong>No plugins or skills in this build</strong>
        <span className="muted">MCP servers — local or remote — will connect only through the control plane’s MCP Host, never directly from the agent or this window. That host isn’t part of this build, so nothing can be installed or enabled yet.</span>
      </div>
      <Row label="MCP servers" hint="Tools exposed by Model Context Protocol servers."><Availability>Not available</Availability></Row>
      <Row label="Skills" hint="Reusable instructions the agent can load for a task."><Availability>Not available</Availability></Row>
    </>
  );
}

function UsageSection() {
  const overview = useStore(s => s.overview);
  const ready = useStore(s => s.connection === 'ready');
  return (
    <>
      <div className="data-legend">
        <span><span className="data-tag data-reported">Reported</span> measured by the control plane</span>
        <span><span className="data-tag data-estimated">Estimated</span> approximated in this window</span>
        <span><span className="data-tag data-unavailable">Unavailable</span> not known — never guessed</span>
      </div>
      <Row label="Token usage" hint="The agent makes no model calls in this build. A connection test sends one tiny request that isn’t metered here.">
        <span className="data-tag data-unavailable">Unavailable</span>
      </Row>
      <Row label="Provider quota" hint="Anthropic doesn’t report plan limits or balance to an API key. Check the Anthropic Console.">
        <span className="data-tag data-unavailable">Unavailable</span>
      </Row>
      <Row label="Request size" hint="The composer meter shows characters against the 8,000-character request limit (reported) and a rough token count (estimated).">
        <span className="data-tag data-reported">Reported</span>
      </Row>
      <h3 className="eyebrow section-eyebrow">Local storage <span className="data-tag data-reported">Reported</span></h3>
      <div className="stat-grid">
        <div className="stat-tile"><span className="stat-tile-value">{ready && overview ? overview.database.projects : '—'}</span><span className="stat-tile-label">Projects</span></div>
        <div className="stat-tile"><span className="stat-tile-value">{ready && overview ? overview.database.runs : '—'}</span><span className="stat-tile-label">Control-plane runs</span></div>
        <div className="stat-tile"><span className="stat-tile-value">{ready && overview ? overview.database.records : '—'}</span><span className="stat-tile-label">Self-test records</span></div>
        <div className="stat-tile"><span className="stat-tile-value">{ready && overview ? `v${overview.database.version}` : '—'}</span><span className="stat-tile-label">Schema</span></div>
      </div>
    </>
  );
}

function VoiceSection() {
  return (
    <>
      <Row label="Voice input" hint="Dictation isn’t part of this build. The window is denied microphone access."><Availability>Not available</Availability></Row>
      <Row label="In-app notices" hint="Short messages for saves, errors and project changes, shown at the bottom right.">
        <span className="value-text">Always on</span>
      </Row>
      <Row label="System notifications" hint="Windows notifications arrive with long-running tasks, which this build can’t start."><Availability>Not available</Availability></Row>
    </>
  );
}

function AdvancedSection({ onOpenDiagnostics }: { onOpenDiagnostics: () => void }) {
  const desktop = useStore(s => s.desktop);
  const overview = useStore(s => s.overview);
  return (
    <>
      <h3 className="eyebrow section-eyebrow first">Security status</h3>
      <ul className="security-list">
        <li><IconLock size={14} /><span><strong>Agent Worker</strong> — <span className="mono">agentReady = false</span>; task start returns <span className="mono">{overview?.worker.error ?? 'WORKER_ISOLATION_UNAVAILABLE'}</span></span></li>
        <li><IconLock size={14} /><span><strong>High-risk tools</strong> (bash, write_file) — <span className="mono">{overview?.tools.highRisk ?? 'SANDBOX_UNAVAILABLE'}</span></span></li>
        <li><IconLock size={14} /><span><strong>read_file / git read</strong> — <span className="mono">{overview?.tools.read ?? 'READ_ADAPTER_UNAVAILABLE'}</span></span></li>
        <li><IconInfo size={14} /><span><strong>Worker OS isolation</strong> — {overview?.capabilities.workerIsolation ?? 'unverified'}; the restricted test fixture is never launched by this build</span></li>
      </ul>
      <div className="settings-note"><IconShield size={14} /><span>This window has no Node access and no network (CSP <span className="mono">connect-src 'none'</span>). It calls only fixed, schema-checked operations in the main process, which forwards them to the local control plane with per-request authentication.</span></div>
      <Row label="Diagnostics" hint="Service state, control-plane run history and a database round-trip self-test.">
        <button className="btn btn-pill btn-xs" onClick={onOpenDiagnostics}><IconTerminal size={13} /> Open diagnostics</button>
      </Row>
      <h3 className="eyebrow section-eyebrow">About</h3>
      <p className="settings-lead"><strong>OperationAgent</strong> {desktop ? desktop.app.version : ''} · M2 build</p>
      <p className="muted">A desktop workbench for a security-gated coding agent. This build delivers the supervised control plane, local persistence, project management and Claude model settings. Agent execution ships with the agent loop, and on each platform only after that platform’s isolation gates pass.</p>
      <p className="muted small mono">Electron {desktop?.app.electron ?? '—'} · Sidecar Node {overview?.runtime.node ?? '—'} · SQLite {overview?.runtime.sqlite ?? '—'} · {desktop ? `${desktop.app.platform}-${desktop.app.arch}` : ''}</p>
      <h3 className="eyebrow section-eyebrow">Keyboard shortcuts</h3>
      <div className="kbd-grid">
        <span><kbd>Ctrl N</kbd> New chat</span><span><kbd>Ctrl K</kbd> Search</span>
        <span><kbd>Ctrl O</kbd> Projects</span><span><kbd>Ctrl ,</kbd> Settings</span>
        <span><kbd>Ctrl B</kbd> Toggle sidebar</span><span><kbd>Ctrl \</kbd> Toggle side panel</span>
        <span><kbd>Enter</kbd> Send</span><span><kbd>Shift Enter</kbd> New line</span>
      </div>
    </>
  );
}

export function SettingsDialog({ onClose, initialSection = 'general', onOpenDiagnostics }: { onClose: () => void; initialSection?: SectionId;
  onOpenDiagnostics: () => void }) {
  const settings = useStore(s => s.settings);
  const [active, setActive] = useState<SectionId>(initialSection);
  const [query, setQuery] = useState('');
  const nav = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => { actions.resetSaveStatus(); }, []);
  const q = query.trim().toLowerCase();
  const visible = SECTIONS.filter(section => !q || `${section.title} ${section.keywords} ${section.lead}`.toLowerCase().includes(q));
  const shown = visible.find(section => section.id === active) ?? visible[0];
  useEffect(() => { body.current?.scrollTo({ top: 0 }); }, [shown?.id]);
  const focusNav = (id: SectionId): void => { nav.current?.querySelector<HTMLElement>(`[data-section="${id}"]`)?.focus(); };
  const onNavKey = (event: KeyboardEvent<HTMLElement>): void => {
    const at = visible.findIndex(section => section.id === shown?.id);
    const next = event.key === 'ArrowDown' ? at + 1 : event.key === 'ArrowUp' ? at - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? visible.length - 1 : null;
    if (next === null || !visible.length) return;
    event.preventDefault();
    const target = visible[(next + visible.length) % visible.length]!;
    setActive(target.id); focusNav(target.id);
  };
  return (
    <Modal title="Settings" onClose={onClose} width="min(1080px, calc(100vw - 48px))" className="modal-settings" hideHeader
      onEscape={() => { if (!query) return false; setQuery(''); return true; }}>
      <div className="settings">
        <aside className="settings-side">
          <h2 className="settings-heading">Settings</h2>
          <label className="settings-search">
            <IconSearch size={15} />
            <input data-autofocus value={query} onChange={event => setQuery(event.target.value)} placeholder="Search settings" aria-label="Search settings"
              onKeyDown={event => {
                if ((event.key === 'ArrowDown' || event.key === 'Enter') && shown) { event.preventDefault(); setActive(shown.id); focusNav(shown.id); }
              }} />
          </label>
          <nav className="settings-nav" aria-label="Settings sections" ref={nav} onKeyDown={onNavKey}>
            {visible.map(section => (
              <button key={section.id} className={section.id === shown?.id ? 'is-active' : ''} aria-current={section.id === shown?.id ? 'page' : undefined}
                tabIndex={section.id === shown?.id ? 0 : -1} data-section={section.id} onClick={() => setActive(section.id)}>
                {section.icon}<span>{section.title}</span>
              </button>
            ))}
            {visible.length === 0 && <div className="settings-nav-empty">No settings match “{query.trim()}”.</div>}
          </nav>
        </aside>
        <div className="settings-main">
          <div className="settings-topbar">
            <SaveIndicator />
            <CloseButton />
          </div>
          {shown && (
            <div className="settings-body" ref={body} key={shown.id} data-section={shown.id}>
              <header className="settings-head">
                <h3 className="settings-title">{shown.title}</h3>
                <p className="settings-sub">{shown.lead}</p>
              </header>
              {!settings && shown.id !== 'models' && <div className="settings-note"><IconInfo size={14} /> Settings load from the control plane once it is connected.</div>}
              {shown.id === 'general' && settings && <GeneralSection settings={settings} />}
              {shown.id === 'models' && <ModelSection />}
              {shown.id === 'chat' && settings && <ChatSection settings={settings} />}
              {shown.id === 'plugins' && <PluginsSection />}
              {shown.id === 'usage' && <UsageSection />}
              {shown.id === 'voice' && <VoiceSection />}
              {shown.id === 'advanced' && <AdvancedSection onOpenDiagnostics={onOpenDiagnostics} />}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

function CloseButton() {
  const close = useModalClose();
  return <button className="icon-btn" onClick={close} aria-label="Close settings" title="Close (Esc)"><IconX size={17} /></button>;
}
