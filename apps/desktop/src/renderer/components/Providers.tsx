import { useEffect, useRef, useState } from 'react';
import { SEARCH_PROVIDERS } from '@operation-agent/contracts';
import type { CredentialStatus, HfLoginChallenge, HfLoginState, LinkedProvider, ModelProvider, ProviderModelList, ProviderTestResult, SearchProvider, WorkbenchSettings } from '@operation-agent/contracts';
import type { MessageKey } from '../i18n';
import { useT } from '../locale';
import { actions, errorCode, useStore } from '../state';
import { AnthropicDetail, KeyField, PROVIDER_HOSTS, PROVIDER_NAMES, ProviderMark, TestFailed, TestResult } from './ModelSettings';
import { Segmented } from './Modal';
import { IconCheck, IconChevronRight, IconInfo, IconLock, IconPlus, IconRetry, IconSearch, IconShield } from './Icons';

// Settings › Providers and Settings › Web search. Every status shown here is what Express reported; the Renderer
// never decides that a credential works.

type PendingId = 'chatgpt' | 'copilot';
interface Card { id: ModelProvider | PendingId; name: string; nameKey?: MessageKey; desc: MessageKey; mark: string; tone: string; recommended?: true }
const CARDS: readonly Card[] = [
  { id: 'anthropic', name: PROVIDER_NAMES.anthropic, desc: 'provider.anthropic.desc', mark: 'A', tone: 'clay', recommended: true },
  { id: 'openai', name: PROVIDER_NAMES.openai, desc: 'provider.openai.desc', mark: 'O', tone: 'ink', recommended: true },
  { id: 'openrouter', name: PROVIDER_NAMES.openrouter, desc: 'provider.openrouter.desc', mark: 'R', tone: 'slate', recommended: true },
  { id: 'google', name: PROVIDER_NAMES.google, desc: 'provider.google.desc', mark: 'G', tone: 'sky' },
  { id: 'custom', name: '', nameKey: 'provider.custom.name', desc: 'provider.custom.desc', mark: '+', tone: 'plain' },
  { id: 'huggingface', name: 'Hugging Face', desc: 'hf.description', mark: 'HF', tone: 'clay' },
];
const PENDING: readonly (Card & { id: PendingId; nameKey?: MessageKey })[] = [
  { id: 'chatgpt', name: '', nameKey: 'provider.chatgpt.name', desc: 'provider.chatgpt.desc', mark: 'C', tone: 'mint' },
  { id: 'copilot', name: '', nameKey: 'provider.copilot.name', desc: 'provider.copilot.desc', mark: 'GH', tone: 'violet' },

];
const MARKS = Object.fromEntries(CARDS.map(card => [card.id, { mark: card.mark, tone: card.tone }])) as Readonly<Record<ModelProvider, { mark: string; tone: string }>>;

function useProviderStatus(): (id: ModelProvider) => CredentialStatus | null {
  const model = useStore(s => s.model);
  const providers = useStore(s => s.providers);
  return id => id === 'anthropic' ? model?.credential ?? null : providers?.providers.find(item => item.provider === id)?.credential ?? null;
}

function StatusPill({ configured }: { configured: boolean }) {
  const t = useT();
  return <span className={`pill ${configured ? 'tone-ok' : 'tone-muted'}`} data-credential={configured ? 'configured' : 'missing'}><span className="dot" />{t(configured ? 'providers.keySaved' : 'providers.notSetUp')}</span>;
}

function ProviderCard({ card, name, configured, isDefault, locked, onOpen }: { card: Card; name: string; configured?: boolean; isDefault?: boolean; locked?: boolean;
  onOpen: () => void }) {
  const t = useT();
  return (
    <button className={`provider-card-btn${locked ? ' is-locked' : ''}${card.id === 'custom' ? ' is-dashed' : ''}`} onClick={onOpen} data-provider={card.id}>
      <span className="provider-card-top">
        <ProviderMark label={card.mark} tone={card.tone} />
        {card.recommended && !configured && <span className="provider-badge">{t('providers.recommended')}</span>}
        {configured && <span className="provider-badge is-ok"><IconCheck size={11} />{t(card.id === 'huggingface' ? 'hf.authorized' : 'providers.keySaved')}</span>}
        {locked && <span className="provider-badge"><IconLock size={11} />{t('providers.needsApproval')}</span>}
      </span>
      <span className="provider-card-name">{name}{isDefault && <span className="scope-tag scope-global">{t('common.default')}</span>}</span>
      <span className="provider-card-desc">{t(card.desc)}</span>
    </button>
  );
}

function DetailHeader({ id, name, configured, onBack }: { id: keyof typeof PROVIDER_HOSTS; name: string; configured: boolean; onBack: () => void }) {
  const t = useT();
  const settings = useStore(s => s.settings);
  const ready = useStore(s => s.connection === 'ready');
  const isDefault = settings?.defaultProvider === id;
  return (
    <>
      <button className="crumb" onClick={onBack}><IconChevronRight size={13} className="crumb-chev" />{t('providers.back')}</button>
      <div className="provider-head">
        <ProviderMark label={MARKS[id].mark} tone={MARKS[id].tone} size="lg" />
        <span className="provider-text">
          <strong>{name}</strong>
          <span className="muted small mono">{t('providers.endpoint')} · {PROVIDER_HOSTS[id]}</span>
        </span>
        <StatusPill configured={configured} />
        {isDefault ? <span className="pill tone-accent"><IconCheck size={12} />{t('providers.isDefault')}</span>
          : <button className="btn btn-pill btn-xs" disabled={!ready || !settings || !configured} data-action="use-default"
            onClick={() => void actions.saveSettings({ defaultProvider: id, customProviderId: null })}>{t('providers.useDefault')}</button>}
      </div>
    </>
  );
}

type Loaded<T> = { state: 'idle' | 'running' } | { state: 'done'; value: T } | { state: 'failed'; code: string };

function LinkedDetail({ provider }: { provider: LinkedProvider }) {
  const t = useT();
  const overview = useStore(s => s.providers);
  const ready = useStore(s => s.connection === 'ready');
  const status = overview?.providers.find(item => item.provider === provider);
  const configured = status?.credential.configured === true;
  const [test, setTest] = useState<Loaded<ProviderTestResult>>({ state: 'idle' });
  const [models, setModels] = useState<Loaded<ProviderModelList>>({ state: 'idle' });
  const [filter, setFilter] = useState('');
  // Results belong to one key: a changed or removed key clears them.
  const keyStamp = status?.credential.configured ? status.credential.updatedAt : 'none';
  useEffect(() => { setTest({ state: 'idle' }); setModels({ state: 'idle' }); }, [keyStamp]);
  const disabled = !ready || !overview;
  const run = async <T,>(set: (value: Loaded<T>) => void, call: () => Promise<T>): Promise<void> => {
    set({ state: 'running' });
    try { set({ state: 'done', value: await call() }); } catch (error) { set({ state: 'failed', code: errorCode(error) }); }
  };
  const list = models.state === 'done' ? models.value : null;
  const q = filter.trim().toLowerCase();
  const shown = list ? list.models.filter(id => !q || id.toLowerCase().includes(q)) : [];
  return (
    <>
      <h3 className="settings-group-title">{t('providers.apiKey')}</h3>
      <KeyField provider={PROVIDER_NAMES[provider]} credential={status?.credential ?? null} secureStorage={overview?.secureStorage ?? 'unavailable'} disabled={disabled}
        placeholder={provider === 'google' ? 'AIza…' : provider === 'openrouter' ? 'sk-or-…' : 'sk-…'} mask={provider === 'openrouter' ? 'sk-or-' : provider === 'google' ? '' : 'sk-'}
        onSave={apiKey => actions.setProviderKey(provider, apiKey)} onClear={() => actions.clearProviderKey(provider)} />

      <h3 className="settings-group-title">{t('providers.model')}
        <span className="tool-spacer" />
        <button className="btn btn-pill btn-xs" disabled={disabled || !configured || models.state === 'running'} data-action="load-models"
          onClick={() => void run(setModels, () => actions.listProviderModels(provider))}>
          {models.state === 'running' ? <><IconRetry size={12} className="spinner" /> {t('providers.loadingModels')}</> : t(list ? 'providers.refreshModels' : 'providers.loadModels')}
        </button>
      </h3>
      <div className="model-current">
        <span className="muted small">{t('providers.model')}</span>
        <span className="mono" data-selected-model={status?.model ?? ''}>{status?.model ?? t('providers.noModelSelected')}</span>
      </div>
      {!configured && <p className="muted small">{t('providers.needKey')}</p>}
      {models.state === 'failed' && <TestFailed code={models.code} />}
      {list && list.status !== 'ok' && <p className="field-error">{t('providers.loadFailed', { reason: t(`test.${list.status}.title`) })}</p>}
      {list && list.status === 'ok' && (
        <div className="model-picker">
          <label className="select-search">
            <IconSearch size={14} />
            <input value={filter} onChange={event => setFilter(event.target.value)} placeholder={t('providers.filterModels')} aria-label={t('providers.filterModels')} />
            <span className="muted small">{t('providers.modelCount', { count: list.models.length })}</span>
          </label>
          <div className="model-list" role="radiogroup" aria-label={t('providers.model')}>
            {shown.slice(0, 300).map(id => (
              <button key={id} role="radio" aria-checked={id === status?.model} className={`model-row${id === status?.model ? ' is-active' : ''}`} disabled={disabled}
                onClick={() => void actions.saveProviderModel(provider, id)}>
                <span className="mono ellipsis">{id}</span>{id === status?.model && <IconCheck size={14} />}
              </button>
            ))}
            {shown.length === 0 && <div className="select-empty">{t('providers.noModels')}</div>}
          </div>
        </div>
      )}

      <div className="test-row">
        <button className="btn btn-pill" disabled={disabled || !configured || test.state === 'running'} data-action="test-connection"
          onClick={() => void run(setTest, () => actions.testProvider(provider))}>
          {test.state === 'running' ? <><IconRetry size={13} className="spinner" /> {t('test.testing')}</> : t('test.button')}
        </button>
        <span className="muted small">{t('test.hint')}</span>
      </div>
      {test.state === 'done' && <TestResult status={test.value.status} provider={provider} httpStatus={test.value.httpStatus} latencyMs={test.value.latencyMs} model={test.value.model} />}
      {test.state === 'failed' && <TestFailed code={test.code} />}
      <div className="settings-note"><IconShield size={14} /> <span>{t('key.note', { provider: PROVIDER_NAMES[provider] })}</span></div>
    </>
  );
}

function PendingDetail({ card, onBack }: { card: (typeof PENDING)[number]; onBack: () => void }) {
  const t = useT();
  return (
    <>
      <button className="crumb" onClick={onBack}><IconChevronRight size={13} className="crumb-chev" />{t('providers.back')}</button>
      <div className="provider-head">
        <ProviderMark label={card.mark} tone={card.tone} size="lg" />
        <span className="provider-text"><strong>{card.nameKey ? t(card.nameKey) : card.name}</strong><span className="muted small">{t(card.desc)}</span></span>
        <span className="pill tone-muted"><IconLock size={11} />{t('providers.needsApproval')}</span>
      </div>
      <div className="feature-empty">
        <span className="feature-empty-icon"><IconLock size={18} /></span>
        <strong>{t('providers.adrTitle')}</strong>
        <span className="muted">{t('providers.adrText')}</span>
        <span className="badge badge-soft mono">docs/adr/ADR-PROV-001.md</span>
      </div>
    </>
  );
}

function CustomDetail() {
  const t = useT();
  const overview = useStore(s => s.providers);
  const ready = useStore(s => s.connection === 'ready');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [allowLocal, setAllowLocal] = useState(false);
  const key = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async (call: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await call(); } catch (err) { setError(errorCode(err)); } finally { setBusy(false); }
  };
  const disabled = busy || !ready || !overview?.custom;
  return <>
    {overview?.custom?.map(item => <div key={item.id} className="model-current">
      <span><strong>{item.model}</strong><br/><span className="mono provider-url">{item.baseUrl}</span></span>
      <button className="btn" disabled={disabled} onClick={() => void run(() => actions.removeCustomProvider(item.id))}>{t('common.remove')}</button>
    </div>)}
    <form className="settings-group" onSubmit={event => {
      event.preventDefault();
      if (!key.current || disabled) return;
      const pending = actions.saveCustomProvider({ baseUrl: baseUrl.trim(), model: model.trim(), allowLocal, apiKey: key.current.value });
      key.current.value = '';
      void run(() => pending);
    }}>
      <label className="field"><span className="field-label">{t('custom.baseUrl')}</span>
        <input className="text-input mono" type="url" required value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder="https://api.example.com/v1" /></label>
      <label className="field field-inline"><input type="checkbox" checked={allowLocal} onChange={e => setAllowLocal(e.target.checked)} />{t('custom.allowLocal')}</label>
      <label className="field"><span className="field-label">{t('providers.model')}</span>
        <input className="text-input mono" required value={model} onChange={e => setModel(e.target.value)} /></label>
      <label className="field"><span className="field-label">{t('providers.apiKey')}</span>
        <input className="text-input mono" type="password" autoComplete="new-password" required ref={key} /></label>
      <div className="form-actions"><button className="btn btn-primary" disabled={disabled || overview?.secureStorage !== 'available'}>{t('custom.review')}</button></div>
    </form>
    {overview?.secureStorage === 'unavailable' && <p role="status">{t('key.blockedText')}</p>}
    {error && <TestFailed code={error} />}
  </>;
}

function HfDetail() {
  const t = useT();
  const overview = useStore(s => s.providers);
  const ready = useStore(s => s.connection === 'ready');
  const hf = overview?.huggingface;
  const [clientId, setClientId] = useState('');
  const [model, setModel] = useState(hf?.model ?? '');
  const [challenge, setChallenge] = useState<HfLoginChallenge | null>(null);
  const [status, setStatus] = useState<HfLoginState['state'] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(false);
  const session = useRef<string | null>(null);
  const api = window.operationAgent;
  useEffect(() => { setModel(hf?.model ?? ''); }, [hf?.model]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const sessionId = session.current;
      session.current = null;
      if (sessionId) void api.cancelHfLogin({ sessionId }).catch(() => {});
    };
  }, [api]);
  const finish = (state: HfLoginState['state']) => {
    setStatus(state);
    if (state !== 'waiting') {
      session.current = null; setChallenge(null);
      if (state === 'authorized') void actions.refreshProviders();
    }
  };
  useEffect(() => {
    if (!challenge) return;
    const { sessionId } = challenge;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const reply = await api.pollHfLogin({ sessionId });
        if (!active || session.current !== sessionId) return;
        finish(reply.state);
        if (reply.state === 'waiting') schedule();
      } catch (err) {
        if (!active || session.current !== sessionId) return;
        setError(errorCode(err));
        if (Date.now() < challenge.expiresAt) schedule();
        else finish('expired');
      }
    };
    const schedule = () => { timer = setTimeout(() => void poll(), 5000); };
    schedule();
    return () => { active = false; clearTimeout(timer); };
  }, [api, challenge]);
  const run = async (call: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await call(); } catch (err) { if (mounted.current) setError(errorCode(err)); }
    finally { if (mounted.current) setBusy(false); }
  };
  const begin = async () => {
    setStatus(null);
    const result = await api.beginHfLogin({ clientId: clientId.trim() });
    if (!mounted.current) { await api.cancelHfLogin({ sessionId: result.sessionId }); return; }
    session.current = result.sessionId; setChallenge(result); setStatus('waiting');
  };
  const disabled = busy || !ready || !hf;
  return <>
    {hf?.configured ? <form onSubmit={e => { e.preventDefault(); void run(() => actions.configureHf(model.trim() || null, false)); }}>
      <p className="pill tone-ok">{t('hf.authorized')}</p>
      <label className="field"><span className="field-label">{t('providers.model')}</span>
        <input className="text-input mono" value={model} onChange={e => setModel(e.target.value)} placeholder="org/model" /></label>
      <div className="form-actions"><button className="btn btn-primary" disabled={disabled || (hf.model ?? '') === model.trim()}>{t('hf.saveModel')}</button>
        <button type="button" className="btn" disabled={disabled} onClick={() => void run(async () => { await actions.configureHf(null, true); setStatus(null); })}>{t('hf.disconnect')}</button></div>
    </form> : challenge ? <div className="settings-group">
      <p>{t('hf.codeHint')}</p><strong className="mono">{challenge.userCode}</strong>
      <p className="muted small">{t('hf.expires', { time: new Date(challenge.expiresAt).toLocaleTimeString() })}</p>
      <button className="btn" disabled={busy} onClick={() => void run(async () => {
        const result = await api.cancelHfLogin({ sessionId: challenge.sessionId });
        if (mounted.current && session.current === challenge.sessionId) finish(result.state);
      })}>{t('common.cancel')}</button>
    </div> : <form onSubmit={e => { e.preventDefault(); void run(begin); }}>
      <label className="field"><span className="field-label">{t('hf.clientId')}</span>
        <input className="text-input mono" required value={clientId} onChange={e => setClientId(e.target.value)} /></label>
      <div className="form-actions"><button className="btn btn-primary" disabled={disabled || overview?.secureStorage !== 'available'}>{t('hf.begin')}</button></div>
    </form>}
    {status && !(status === 'authorized' && hf?.configured) && <p role="status">{t(`hf.${status}`)}</p>}
    {overview?.secureStorage === 'unavailable' && <p role="status">{t('key.blockedText')}</p>}
    {error && <TestFailed code={error} />}
  </>;
}

export function ProvidersSection({ initialProvider = null }: { initialProvider?: Card['id'] | null }) {
  const t = useT();
  const settings = useStore(s => s.settings);
  const status = useProviderStatus();
  const overview = useStore(s => s.providers);
  const [open, setOpen] = useState<Card['id'] | null>(initialProvider);
  const [query, setQuery] = useState('');
  useEffect(() => { void actions.refreshProviders(); void actions.refreshModel(); }, []);
  const back = (): void => setOpen(null);
  if (open === 'anthropic' || open === 'openai' || open === 'google' || open === 'openrouter') {
    return (
      <div className="provider-detail" data-provider-detail={open}>
        <DetailHeader id={open} name={PROVIDER_NAMES[open]} configured={status(open)?.configured === true} onBack={back} />
        {open === 'anthropic' ? <AnthropicDetail /> : <LinkedDetail provider={open} />}
      </div>
    );
  }
  if (open === 'custom' || open === 'huggingface') return <div className="provider-detail" data-provider-detail={open}>
    <button className="crumb" onClick={back}><IconChevronRight size={13} className="crumb-chev" />{t('providers.back')}</button>
    <h3>{open === 'custom' ? t('provider.custom.name') : PROVIDER_NAMES.huggingface}</h3>
    {open === 'custom' ? <CustomDetail /> : <HfDetail />}
    <p className="settings-note">{t('providers.acceptance')}</p>
  </div>;
  const pending = PENDING.find(card => card.id === open);
  if (pending) return <div className="provider-detail"><PendingDetail card={pending} onBack={back} /></div>;
  const q = query.trim().toLowerCase();
  const nameOf = (card: Card & { nameKey?: MessageKey }): string => card.nameKey ? t(card.nameKey) : card.name;
  const matches = (card: Card & { nameKey?: MessageKey }): boolean => !q || `${nameOf(card)} ${t(card.desc)} ${card.id}`.toLowerCase().includes(q);
  const cards = CARDS.filter(matches);
  const locked = PENDING.filter(matches);
  return (
    <div className="providers">
      <label className="settings-search providers-search">
        <IconSearch size={15} />
        <input value={query} onChange={event => setQuery(event.target.value)} placeholder={t('providers.search')} aria-label={t('providers.search')} />
      </label>
      {cards.length > 0 && <h3 className="settings-group-title">{t('providers.popular')}</h3>}
      <div className="provider-grid">
        {cards.map(card => (
          <ProviderCard key={card.id} card={card} name={nameOf(card)} configured={card.id === 'custom' ? Boolean(overview?.custom?.length)
            : card.id === 'huggingface' ? overview?.huggingface?.configured === true : status(card.id as ModelProvider)?.configured === true}
            isDefault={settings?.defaultProvider === card.id} onOpen={() => setOpen(card.id)} />
        ))}
      </div>
      {locked.length > 0 && <h3 className="settings-group-title">{t('providers.more')}</h3>}
      <div className="provider-grid">
        {locked.map(card => <ProviderCard key={card.id} card={card} name={nameOf(card)} locked onOpen={() => setOpen(card.id)} />)}
      </div>
      {cards.length + locked.length === 0 && <div className="settings-nav-empty">{t('providers.noMatch', { query: query.trim() })}</div>}
    </div>
  );
}

const SEARCH_INFO: Readonly<Record<SearchProvider, { name: string; desc: MessageKey; mark: string; tone: string }>> = {
  exa: { name: 'Exa', desc: 'search.exa', mark: 'E', tone: 'sky' },
  tavily: { name: 'Tavily', desc: 'search.tavily', mark: 'T', tone: 'mint' },
  brave: { name: 'Brave Search', desc: 'search.brave', mark: 'B', tone: 'clay' },
  firecrawl: { name: 'Firecrawl', desc: 'search.firecrawl', mark: 'F', tone: 'violet' },
};

export function WebSearchSection({ settings, initialProvider = null }: { settings: WorkbenchSettings; initialProvider?: SearchProvider | null }) {
  const t = useT();
  const overview = useStore(s => s.providers);
  const ready = useStore(s => s.connection === 'ready');
  const [open, setOpen] = useState<SearchProvider | null>(initialProvider);
  useEffect(() => { void actions.refreshProviders(); }, []);
  const credential = (id: SearchProvider): CredentialStatus | null => overview?.search.find(item => item.provider === id)?.credential ?? null;
  const mode = settings.webSearchMode;
  return (
    <>
      <div className="settings-group">
        <h3 className="settings-group-title">{t('search.mode')}</h3>
        <Segmented value={mode} disabled={!ready} onChange={webSearchMode => void actions.saveSettings({ webSearchMode })}
          options={[{ value: 'default', label: t('search.mode.default') }, { value: 'any', label: t('search.mode.any') }, { value: 'off', label: t('search.mode.off') }]} />
        <p className="setting-hint">{t(`search.modeHint.${mode}`)}</p>
      </div>
      <div className="settings-group">
        <h3 className="settings-group-title">{t('search.providers')}</h3>
        <div className="provider-grid">
          {SEARCH_PROVIDERS.map(id => {
            const info = SEARCH_INFO[id];
            const configured = credential(id)?.configured === true;
            return (
              <button key={id} className={`provider-card-btn${open === id ? ' is-open' : ''}${mode === 'off' ? ' is-muted' : ''}`} onClick={() => setOpen(open === id ? null : id)}
                data-search-provider={id} aria-expanded={open === id}>
                <span className="provider-card-top">
                  <ProviderMark label={info.mark} tone={info.tone} />
                  {configured ? <span className="provider-badge is-ok"><IconCheck size={11} />{t('search.keySaved')}</span>
                    : <span className="provider-badge"><IconPlus size={11} />{t('search.needsKey')}</span>}
                </span>
                <span className="provider-card-name">{info.name}{settings.webSearchProvider === id && <span className="scope-tag scope-global">{t('common.default')}</span>}</span>
                <span className="provider-card-desc">{t(info.desc)}</span>
              </button>
            );
          })}
        </div>
        {open && (
          <div className="inline-detail" data-search-detail={open}>
            <div className="inline-detail-head">
              <strong>{SEARCH_INFO[open].name}</strong>
              <span className="tool-spacer" />
              {settings.webSearchProvider === open ? <span className="pill tone-accent"><IconCheck size={12} />{t('common.default')}</span>
                : <button className="btn btn-pill btn-xs" disabled={!ready} onClick={() => void actions.saveSettings({ webSearchProvider: open })}>{t('search.makeDefault')}</button>}
            </div>
            <KeyField provider={SEARCH_INFO[open].name} credential={credential(open)} secureStorage={overview?.secureStorage ?? 'unavailable'} disabled={!ready || !overview}
              placeholder="••••••••" mask="" onSave={apiKey => actions.setProviderKey(open, apiKey)} onClear={() => actions.clearProviderKey(open)} />
          </div>
        )}
      </div>
      <div className="settings-note"><IconInfo size={14} /><span>{t('search.note')}</span></div>
    </>
  );
}

export type IntegrationTarget =
  | { section: 'providers'; provider: Card['id'] }
  | { section: 'search'; provider: SearchProvider }
  | { section: 'mcp'; server: string }
  | { section: 'skills' };

export function IntegrationsSection({ onOpen }: { onOpen: (target: IntegrationTarget) => void }) {
  const t = useT();
  const providerStatus = useProviderStatus();
  const overview = useStore(s => s.providers);
  const mcp = useStore(s => s.mcpServers);
  const [query, setQuery] = useState('');
  const [configuredOnly, setConfiguredOnly] = useState(false);
  const [category, setCategory] = useState<IntegrationTarget['section'] | 'all'>('all');
  useEffect(() => { void actions.refreshProviders(); void actions.refreshModel(); void actions.refreshMcp(); }, []);

  const entries = CARDS.map(card => ({
    id: card.id, name: card.nameKey ? t(card.nameKey) : card.name, description: t(card.desc),
    mark: card.mark, tone: card.tone, configured: card.id === 'custom' ? Boolean(overview?.custom?.length)
      : card.id === 'huggingface' ? overview?.huggingface?.configured === true : providerStatus(card.id as ModelProvider)?.configured === true,
    target: { section: 'providers', provider: card.id } satisfies IntegrationTarget,
  }));
  const search = SEARCH_PROVIDERS.map(provider => ({
    ...SEARCH_INFO[provider], id: provider, description: t(SEARCH_INFO[provider].desc),
    configured: overview?.search.some(item => item.provider === provider && item.credential.configured) === true,
    target: { section: 'search', provider } satisfies IntegrationTarget,
  }));
  const servers = (mcp ?? []).map(server => ({
    id: server.id, name: server.name, description: t('integrations.mcpSaved'),
    mark: 'M', tone: 'slate', configured: true, target: { section: 'mcp', server: server.id } satisfies IntegrationTarget,
  }));
  const addServer = {
    id: 'mcp-new', name: t('mcp.add'), description: t('integrations.mcpAdd'),
    mark: '+', tone: 'plain', configured: false, target: { section: 'mcp', server: 'new' } satisfies IntegrationTarget,
  };
  const skills = { id: 'github-skills', name: t('skills.githubTab'), description: t('catalog.lead'), mark: 'GH', tone: 'ink',
    configured: false, target: { section: 'skills' } satisfies IntegrationTarget };
  const groups = [{ id: 'skills', entries: [skills] }, { id: 'providers', entries }, { id: 'search', entries: search },
    { id: 'mcp', entries: [...servers, addServer] }] as const;
  const q = query.trim().toLowerCase();
  const shown = groups.filter(group => category === 'all' || category === group.id).map(group => ({ ...group,
    entries: group.entries.filter(item => (!configuredOnly || item.configured) && `${item.name} ${item.description}`.toLowerCase().includes(q)),
  })).filter(group => group.entries.length);
  return <div className="integration-catalog">
    <label className="settings-search skill-search"><IconSearch size={15} />
      <input value={query} maxLength={128} onChange={event => setQuery(event.target.value)} placeholder={t('integrations.search')}
        aria-label={t('integrations.search')} />
    </label>
    <div className="skill-toolbar">
      <div className="library-filters">
        <button className="library-filter" aria-pressed={category === 'all'} onClick={() => setCategory('all')}>{t('integrations.all')}</button>
        {groups.map(group => <button className="library-filter" key={group.id} aria-pressed={category === group.id}
          onClick={() => setCategory(group.id)}>{t(`section.${group.id}.title`)}</button>)}
      </div>
      <button className="library-filter" aria-pressed={configuredOnly}
        onClick={() => setConfiguredOnly(value => !value)}>{t('integrations.configuredOnly')}</button>
    </div>
    {shown.map(group => <section key={group.id}>
      <h4 className="settings-group-title">{t(`section.${group.id}.title`)}</h4>
      <div className="integration-grid">{group.entries.map(item => <button key={item.id} className="integration-entry"
        onClick={() => onOpen(item.target)} data-integration={item.id}>
        <ProviderMark label={item.mark} tone={item.tone} />
        <span><strong>{item.name}</strong><span className="muted small">{item.description}</span>
          {item.configured && item.target.section !== 'mcp' && <span className="small tone-text-ok">{t('integrations.configured')}</span>}
        </span>
        <IconChevronRight size={15} />
      </button>)}</div>
    </section>)}
    {shown.length === 0 && <p className="muted">{t('integrations.empty')}</p>}
  </div>;
}
