import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { LANGUAGES, THEME_IDS } from '@operation-agent/contracts';
import type { Language, ThemeId, WorkbenchSettings } from '@operation-agent/contracts';
import { LANGUAGE_NAMES, resolveLocale } from '../i18n';
import type { MessageKey } from '../i18n';
import { useT } from '../locale';
import type { Translate } from '../locale';
import { actions, useStore } from '../state';
import { THEME_NAMES, swatch } from '../themes';
import type { Variant } from '../themes';
import { Modal, Row, Segmented, Toggle, useModalClose } from './Modal';
import { ProvidersSection, WebSearchSection } from './Providers';
import { AgentsSection, McpSection } from './Agents';
import { SearchSelect } from './Select';
import { IconBell, IconChart, IconCheck, IconCloud, IconGlobe, IconInfo, IconLaptop, IconLock, IconPalette, IconPuzzle, IconRobot, IconSearch, IconShield,
  IconSliders, IconTerminal, IconWrench, IconX } from './Icons';

export type SectionId = 'appearance' | 'chat' | 'notifications' | 'usage' | 'providers' | 'search' | 'agents' | 'mcp' | 'advanced';
interface Section { id: SectionId; icon: ReactNode; wide?: true }
const GROUPS: readonly { label: MessageKey; sections: readonly Section[] }[] = [
  { label: 'nav.group.app', sections: [
    { id: 'appearance', icon: <IconPalette size={16} /> }, { id: 'chat', icon: <IconSliders size={16} /> },
    { id: 'notifications', icon: <IconBell size={16} /> }, { id: 'usage', icon: <IconChart size={16} /> }] },
  { label: 'nav.group.models', sections: [{ id: 'providers', icon: <IconCloud size={16} />, wide: true }, { id: 'search', icon: <IconGlobe size={16} />, wide: true }] },
  { label: 'nav.group.agents', sections: [{ id: 'agents', icon: <IconRobot size={16} />, wide: true }, { id: 'mcp', icon: <IconPuzzle size={16} /> }] },
  { label: 'nav.group.system', sections: [{ id: 'advanced', icon: <IconWrench size={16} /> }] },
];
const ALL = GROUPS.flatMap(group => group.sections);
const title = (t: Translate, id: SectionId): string => t(`section.${id}.title`);
// English keywords stay searchable in every language, so "theme" or "mcp" always finds its page.
const ENGLISH_KEYWORDS: Readonly<Record<SectionId, string>> = {
  appearance: 'appearance theme color mode light dark palette density language', chat: 'chat execution stop grace approval', notifications: 'voice notifications',
  usage: 'usage tokens quota storage', providers: 'providers model api key anthropic openai google gemini openrouter', search: 'web search exa tavily brave firecrawl',
  agents: 'agents subagent sub-agent', mcp: 'mcp server plugin skill', advanced: 'advanced about security diagnostics shortcuts',
};

function SaveIndicator() {
  const t = useT();
  const status = useStore(s => s.saveStatus);
  return (
    <span className={`save-indicator is-${status.state}`} role="status" aria-live="polite">
      {status.state === 'saving' && t('save.saving')}
      {status.state === 'saved' && <><IconCheck size={13} /> {t('save.saved')}</>}
      {status.state === 'failed' && <><IconX size={13} /> {t('save.failed')} · <span className="mono">{status.code}</span></>}
      {status.state === 'idle' && t('save.idle')}
    </span>
  );
}

function Availability({ children }: { children: ReactNode }) {
  return <span className="badge badge-soft"><IconLock size={11} /> {children}</span>;
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

function Swatch({ id, variant }: { id: ThemeId; variant: Variant }) {
  const colors = swatch(id, variant);
  return (
    <span className="theme-swatch" aria-hidden="true" style={{ background: colors.bg, boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${colors.text} 18%, transparent)` }}>
      <span style={{ background: colors.surface }} /><span style={{ background: colors.accent }} />
    </span>
  );
}

function ThemeSelect({ variant, value, disabled }: { variant: Variant; value: ThemeId; disabled: boolean }) {
  const t = useT();
  const label = t(variant === 'light' ? 'appearance.lightTheme' : 'appearance.darkTheme');
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <SearchSelect label={label} value={value} disabled={disabled} searchPlaceholder={t('appearance.searchThemes')} empty={t('appearance.noThemes')}
        options={THEME_IDS.map(id => ({ value: id, label: THEME_NAMES[id], icon: <Swatch id={id} variant={variant} />, keywords: id }))}
        onChange={id => void actions.saveSettings(variant === 'light' ? { lightTheme: id } : { darkTheme: id })} />
    </div>
  );
}

const MODES = ['system', 'light', 'dark'] as const;
function AppearanceSection({ settings }: { settings: WorkbenchSettings }) {
  const t = useT();
  const reduced = useReducedMotion();
  const ready = useStore(s => s.connection === 'ready');
  const systemLocale = resolveLocale('system', useStore(s => s.desktop?.app.locale));
  const languageLabel = (language: Language): string => language === 'system' ? t('lang.system', { name: LANGUAGE_NAMES[systemLocale] }) : LANGUAGE_NAMES[language];
  return (
    <>
      <div className="settings-group">
        <h3 className="settings-group-title">{t('appearance.colorMode')}</h3>
        <div className="mode-theme">
          <div className="radio-list" role="radiogroup" aria-label={t('appearance.colorMode')}>
            {MODES.map(mode => (
              <button key={mode} role="radio" aria-checked={settings.theme === mode} className={`radio-row${settings.theme === mode ? ' is-active' : ''}`}
                disabled={!ready} onClick={() => void actions.saveSettings({ theme: mode })}>
                <span className="radio-dot" /><span>{t(`mode.${mode}`)}</span>
              </button>
            ))}
            <p className="setting-hint">{t('appearance.modeHint')}</p>
          </div>
          <div className="theme-selects">
            <ThemeSelect variant="light" value={settings.lightTheme} disabled={!ready} />
            <ThemeSelect variant="dark" value={settings.darkTheme} disabled={!ready} />
          </div>
        </div>
      </div>
      <div className="settings-group">
        <h3 className="settings-group-title">{t('appearance.layout')}</h3>
        <Row label={t('appearance.density')} scope="device" hint={t('appearance.densityHint')}>
          <Segmented value={settings.density} onChange={density => void actions.saveSettings({ density })}
            options={[{ value: 'comfortable', label: t('density.comfortable') }, { value: 'compact', label: t('density.compact') }]} />
        </Row>
        <Row label={t('appearance.panel')} scope="device" hint={t('appearance.panelHint')}>
          <Toggle label={t('appearance.panel')} checked={settings.contextPanel} onChange={contextPanel => void actions.saveSettings({ contextPanel })} />
        </Row>
        <Row label={t('appearance.motion')} hint={t('appearance.motionHint')}>
          <span className="value-text">{t(reduced ? 'motion.reduced' : 'motion.full')}</span>
        </Row>
      </div>
      <div className="settings-group">
        <h3 className="settings-group-title">{t('appearance.localization')}</h3>
        <Row label={t('appearance.language')} scope="device" hint={t('appearance.languageHint')}>
          <SearchSelect label={t('appearance.language')} value={settings.language} disabled={!ready} searchPlaceholder={t('appearance.searchLanguages')}
            empty={t('appearance.noThemes')} onChange={language => void actions.saveSettings({ language })}
            options={LANGUAGES.map(language => ({ value: language, label: languageLabel(language), keywords: language === 'system' ? 'system auto' : language }))} />
        </Row>
      </div>
    </>
  );
}

function ChatSection({ settings }: { settings: WorkbenchSettings }) {
  const t = useT();
  return (
    <>
      <div className="settings-note"><IconInfo size={14} /><span>{t('chat.note')}</span></div>
      <Row label={t('chat.location')} hint={t('chat.locationHint')}>
        <span className="value-text"><IconLaptop size={14} /> {t('composer.thisComputer')}</span>
      </Row>
      <Row label={t('chat.grace')} scope="global" hint={t('chat.graceHint')}>
        <Segmented value={settings.stopGraceMs} onChange={stopGraceMs => void actions.saveSettings({ stopGraceMs })}
          options={[{ value: 5000, label: '5 s' }, { value: 10000, label: '10 s' }, { value: 30000, label: '30 s' }]} />
      </Row>
      <Row label={t('chat.approval')} hint={t('chat.approvalHint')}><Availability>{t('common.notAvailableYet')}</Availability></Row>
      <Row label={t('chat.effort')} hint={t('chat.effortHint')}><Availability>{t('common.notAvailableYet')}</Availability></Row>
      <Row label={t('chat.drafts')} hint={t('chat.draftsHint')}><span className="value-text">{t('chat.inMemory')}</span></Row>
      <div className="settings-note"><IconShield size={14} /><span>{t('chat.shellNote')}</span></div>
    </>
  );
}

function UsageSection() {
  const t = useT();
  const overview = useStore(s => s.overview);
  const ready = useStore(s => s.connection === 'ready');
  const tiles: readonly [MessageKey, string | number][] = [
    ['usage.projects', ready && overview ? overview.database.projects : '—'], ['usage.runs', ready && overview ? overview.database.runs : '—'],
    ['usage.records', ready && overview ? overview.database.records : '—'], ['usage.schema', ready && overview ? `v${overview.database.version}` : '—'],
  ];
  return (
    <>
      <div className="data-legend">
        <span><span className="data-tag data-reported">{t('data.reported')}</span> {t('usage.legendReported')}</span>
        <span><span className="data-tag data-estimated">{t('data.estimated')}</span> {t('usage.legendEstimated')}</span>
        <span><span className="data-tag data-unavailable">{t('data.unavailable')}</span> {t('usage.legendUnavailable')}</span>
      </div>
      <Row label={t('usage.tokens')} hint={t('usage.tokensHint')}><span className="data-tag data-unavailable">{t('data.unavailable')}</span></Row>
      <Row label={t('usage.quota')} hint={t('usage.quotaHint')}><span className="data-tag data-unavailable">{t('data.unavailable')}</span></Row>
      <Row label={t('usage.size')} hint={t('usage.sizeHint')}><span className="data-tag data-reported">{t('data.reported')}</span></Row>
      <h3 className="settings-group-title">{t('usage.storage')} <span className="data-tag data-reported">{t('data.reported')}</span></h3>
      <div className="stat-grid">
        {tiles.map(([label, value]) => <div key={label} className="stat-tile"><span className="stat-tile-value">{value}</span><span className="stat-tile-label">{t(label)}</span></div>)}
      </div>
    </>
  );
}

function NotificationsSection() {
  const t = useT();
  return (
    <>
      <Row label={t('voice.input')} hint={t('voice.inputHint')}><Availability>{t('common.notAvailable')}</Availability></Row>
      <Row label={t('voice.notices')} hint={t('voice.noticesHint')}><span className="value-text">{t('voice.alwaysOn')}</span></Row>
      <Row label={t('voice.system')} hint={t('voice.systemHint')}><Availability>{t('common.notAvailable')}</Availability></Row>
    </>
  );
}

function AdvancedSection({ onOpenDiagnostics }: { onOpenDiagnostics: () => void }) {
  const t = useT();
  const desktop = useStore(s => s.desktop);
  const overview = useStore(s => s.overview);
  const shortcuts: readonly [string, MessageKey][] = [['Ctrl N', 'kbd.newChat'], ['Ctrl K', 'kbd.search'], ['Ctrl O', 'kbd.projects'], ['Ctrl ,', 'kbd.settings'],
    ['Ctrl B', 'kbd.sidebar'], ['Ctrl \\', 'kbd.panel'], ['Enter', 'kbd.send'], ['Shift Enter', 'kbd.newline']];
  return (
    <>
      <h3 className="settings-group-title">{t('adv.security')}</h3>
      <ul className="security-list">
        <li><IconLock size={14} /><span><strong>{t('adv.worker')}</strong> — <span className="mono">agentReady = false</span>; {t('adv.taskStartReturns')}{' '}
          <span className="mono">{overview?.worker.error ?? 'WORKER_ISOLATION_UNAVAILABLE'}</span></span></li>
        <li><IconLock size={14} /><span><strong>{t('adv.highRisk')}</strong> (bash, write_file) — <span className="mono">{overview?.tools.highRisk ?? 'SANDBOX_UNAVAILABLE'}</span></span></li>
        <li><IconLock size={14} /><span><strong>read_file / git read</strong> — <span className="mono">{overview?.tools.read ?? 'READ_ADAPTER_UNAVAILABLE'}</span></span></li>
        <li><IconInfo size={14} /><span><strong>{t('adv.isolation')}</strong> — {t('adv.isolationText', { status: overview?.capabilities.workerIsolation ?? 'unverified' })}</span></li>
      </ul>
      <div className="settings-note"><IconShield size={14} /><span>{t('adv.windowNote')}</span></div>
      <Row label={t('adv.diagnostics')} hint={t('adv.diagnosticsHint')}>
        <button className="btn btn-pill btn-xs" onClick={onOpenDiagnostics}><IconTerminal size={13} /> {t('adv.openDiagnostics')}</button>
      </Row>
      <h3 className="settings-group-title">{t('adv.about')}</h3>
      <p className="settings-lead"><strong>OperationAgent</strong> {desktop ? desktop.app.version : ''} · {t('adv.build')}</p>
      <p className="muted">{t('adv.aboutText')}</p>
      <p className="muted small mono">Electron {desktop?.app.electron ?? '—'} · Sidecar Node {overview?.runtime.node ?? '—'} · SQLite {overview?.runtime.sqlite ?? '—'} · {desktop ? `${desktop.app.platform}-${desktop.app.arch}` : ''}</p>
      <h3 className="settings-group-title">{t('adv.shortcuts')}</h3>
      <div className="kbd-grid">{shortcuts.map(([keys, label]) => <span key={keys}><kbd>{keys}</kbd> {t(label)}</span>)}</div>
    </>
  );
}

export function SettingsDialog({ onClose, initialSection = 'appearance', onOpenDiagnostics }: { onClose: () => void; initialSection?: SectionId;
  onOpenDiagnostics: () => void }) {
  const t = useT();
  const settings = useStore(s => s.settings);
  const [active, setActive] = useState<SectionId>(initialSection);
  const [query, setQuery] = useState('');
  const nav = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => { actions.resetSaveStatus(); }, []);
  const q = query.trim().toLowerCase();
  const matches = (id: SectionId): boolean => !q || [title(t, id), t(`section.${id}.lead`), t(`section.${id}.keywords`), ENGLISH_KEYWORDS[id]].join(' ').toLowerCase().includes(q);
  const visible = ALL.filter(section => matches(section.id));
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
  const needsSettings = shown && ['appearance', 'chat', 'search'].includes(shown.id);
  return (
    <Modal title={t('settings.title')} onClose={onClose} width="calc(100vw - 32px)" className="modal-settings" hideHeader
      onEscape={() => { if (!query) return false; setQuery(''); return true; }}>
      <div className="settings">
        <aside className="settings-side">
          <label className="settings-search">
            <IconSearch size={15} />
            <input data-autofocus value={query} onChange={event => setQuery(event.target.value)} placeholder={t('settings.search')} aria-label={t('settings.search')}
              onKeyDown={event => {
                if ((event.key === 'ArrowDown' || event.key === 'Enter') && shown) { event.preventDefault(); setActive(shown.id); focusNav(shown.id); }
              }} />
          </label>
          <nav className="settings-nav" aria-label={t('settings.sections')} ref={nav} onKeyDown={onNavKey}>
            {GROUPS.map(group => {
              const items = group.sections.filter(section => matches(section.id));
              if (!items.length) return null;
              return (
                <div key={group.label} className="settings-nav-group">
                  <div className="settings-nav-label">{t(group.label)}</div>
                  {items.map(section => (
                    <button key={section.id} className={section.id === shown?.id ? 'is-active' : ''} aria-current={section.id === shown?.id ? 'page' : undefined}
                      tabIndex={section.id === shown?.id ? 0 : -1} data-section={section.id} onClick={() => setActive(section.id)}>
                      {section.icon}<span>{title(t, section.id)}</span>
                    </button>
                  ))}
                </div>
              );
            })}
            {visible.length === 0 && <div className="settings-nav-empty">{t('settings.noMatch', { query: query.trim() })}</div>}
          </nav>
        </aside>
        <div className="settings-main">
          <div className="settings-topbar">
            <SaveIndicator />
            <CloseButton />
          </div>
          {shown && (
            <div className={`settings-body${shown.wide ? ' is-wide' : ''}`} ref={body} key={shown.id} data-section={shown.id}>
              <header className="settings-head">
                <h3 className="settings-title">{title(t, shown.id)}</h3>
                <p className="settings-sub">{t(`section.${shown.id}.lead`)}</p>
              </header>
              {!settings && needsSettings && <div className="settings-note"><IconInfo size={14} /> {t('settings.waiting')}</div>}
              {shown.id === 'appearance' && settings && <AppearanceSection settings={settings} />}
              {shown.id === 'chat' && settings && <ChatSection settings={settings} />}
              {shown.id === 'notifications' && <NotificationsSection />}
              {shown.id === 'usage' && <UsageSection />}
              {shown.id === 'providers' && <ProvidersSection />}
              {shown.id === 'search' && settings && <WebSearchSection settings={settings} />}
              {shown.id === 'agents' && <AgentsSection />}
              {shown.id === 'mcp' && <McpSection />}
              {shown.id === 'advanced' && <AdvancedSection onOpenDiagnostics={onOpenDiagnostics} />}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

function CloseButton() {
  const t = useT();
  const close = useModalClose();
  return <button className="icon-btn" onClick={close} aria-label={t('settings.close')} title={t('settings.closeTitle')}><IconX size={17} /></button>;
}
