import { useEffect, useRef, useState } from 'react';
import { CLAUDE_MODELS, DEFAULT_CLAUDE_MODEL } from '@operation-agent/contracts';
import type { ClaudeModel, CredentialStatus, ModelProvider, ModelTestStatus } from '@operation-agent/contracts';
import type { MessageKey } from '../i18n';
import { useT } from '../locale';
import { actions, useStore } from '../state';
import { IconAlert, IconCheck, IconLock, IconRetry, IconShield, IconX } from './Icons';
import { Modal } from './Modal';

export const MODEL_INFO: Record<ClaudeModel, { name: string; tagline: MessageKey }> = {
  'claude-sonnet-5-5': { name: 'Sonnet 5.5', tagline: 'model.sonnet' },
  'claude-opus-5-5': { name: 'Opus 5.5', tagline: 'model.opus' },
  'claude-haiku-5-5': { name: 'Haiku 5.5', tagline: 'model.haiku' },
};
export function modelName(model: ClaudeModel): string { return `Claude ${MODEL_INFO[model].name}`; }
export const PROVIDER_NAMES: Readonly<Record<ModelProvider, string>> = { anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google Gemini', openrouter: 'OpenRouter' };
export const PROVIDER_HOSTS: Readonly<Record<ModelProvider, string>> = {
  anthropic: 'api.anthropic.com', openai: 'api.openai.com', google: 'generativelanguage.googleapis.com', openrouter: 'openrouter.ai',
};

/** A plain monogram tile: providers are told apart by name, never by imitating their logos. */
export function ProviderMark({ label, tone, size = 'md' }: { label: string; tone: string; size?: 'md' | 'lg' }) {
  return <span className={`provider-tile provider-tile-${size} tile-${tone}`} aria-hidden="true">{label}</span>;
}

const KEY_ERRORS: Record<string, MessageKey> = {
  VALIDATION_ERROR: 'key.validation', SECURE_STORAGE_UNAVAILABLE: 'key.secureUnavailable', DATABASE_UNAVAILABLE: 'key.database',
};
const TEST_TONE: Record<ModelTestStatus, 'ok' | 'warn' | 'danger'> = {
  ok: 'ok', auth_failed: 'danger', rate_limited: 'warn', model_unavailable: 'warn', provider_error: 'warn', unreachable: 'danger',
  not_configured: 'warn', credential_unavailable: 'danger',
};

/** A normalised test outcome. Facts are what Express measured; no provider text is ever shown because none arrives. */
export function TestResult({ status, provider, httpStatus, latencyMs, model }: { status: ModelTestStatus; provider: ModelProvider; httpStatus: number | null;
  latencyMs: number | null; model: string | null }) {
  const t = useT();
  const tone = TEST_TONE[status];
  const vars = { provider: PROVIDER_NAMES[provider], host: PROVIDER_HOSTS[provider] };
  const facts = [httpStatus ? `HTTP ${httpStatus}` : null, latencyMs !== null ? `${latencyMs} ms` : null, model].filter(Boolean).join(' · ');
  return (
    <div className={`test-result tone-result-${tone}`} role="status" data-test-status={status}>
      <span className="test-result-icon">{tone === 'ok' ? <IconCheck size={14} /> : tone === 'warn' ? <IconAlert size={14} /> : <IconX size={14} />}</span>
      <span className="test-result-body">
        <strong>{t(`test.${status}.title`)}</strong>
        <span>{t(`test.${status}.detail`, vars)}</span>
        {facts && <span className="test-result-facts mono">{facts}</span>}
      </span>
    </div>
  );
}
export function TestFailed({ code }: { code: string }) {
  const t = useT();
  return (
    <div className="test-result tone-result-danger" role="status" data-test-status="failed">
      <span className="test-result-icon"><IconX size={14} /></span>
      <span className="test-result-body"><strong>{t('test.couldNotRun')}</strong><span className="mono">{code}</span></span>
    </div>
  );
}

/**
 * The key form never shows a stored key and never keeps a typed one: the input is cleared as soon as Main has it,
 * and the component state disappears with the view.
 */
export function KeyField({ provider, credential, secureStorage, disabled, placeholder, mask, onSave, onClear }: {
  provider: string; credential: CredentialStatus | null; secureStorage: 'available' | 'unavailable'; disabled: boolean; placeholder: string;
  /** Shown before the hint of a stored key, e.g. "sk-ant-". */
  mask: string; onSave: (apiKey: string) => Promise<string | null>; onClear: () => Promise<void>;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const configured = credential?.configured === true;
  const showForm = !configured || editing;
  useEffect(() => { if (editing) input.current?.focus(); }, [editing]);
  const save = async (): Promise<void> => {
    const submitted = value.trim();
    if (!submitted || busy) return;
    // Hand the key over and forget it at once, whatever the outcome: it never lingers in Renderer state or the DOM.
    setValue(''); setBusy(true); setError(null);
    const code = await onSave(submitted);
    setBusy(false);
    if (code) { setError(t(KEY_ERRORS[code] ?? 'key.unconfirmed')); return; }
    setEditing(false);
  };
  if (secureStorage === 'unavailable' && !configured) {
    return (
      <div className="key-blocked" role="alert">
        <IconLock size={15} />
        <span><strong>{t('key.blockedTitle')}</strong> {t('key.blockedText')}</span>
      </div>
    );
  }
  return (
    <div className="key-field">
      {!showForm && credential?.configured && (
        <div className="key-saved" data-key-state="configured">
          <span className="key-saved-glyph"><IconLock size={14} /></span>
          <span className="key-saved-text">
            <span className="mono key-mask" aria-label={t('key.storedMask')}>{mask}••••••••••••{credential.hint ?? '••••'}</span>
            <span className="muted small">{t('key.encryptedNote')}</span>
          </span>
          <button className="btn btn-pill btn-xs" onClick={() => { setEditing(true); setError(null); }} disabled={disabled}>{t('key.replace')}</button>
          <button className="btn btn-pill btn-xs btn-quiet btn-danger-text" onClick={() => setConfirmRemove(true)} disabled={disabled || busy}>{t('common.remove')}</button>
        </div>
      )}
      {showForm && (
        <form className="key-form" data-key-state={configured ? 'replacing' : 'empty'} onSubmit={event => { event.preventDefault(); void save(); }}>
          <div className={`key-input${error ? ' has-error' : ''}`}>
            <input ref={input} type="password" aria-label={t('key.label', { provider })} placeholder={placeholder} value={value} autoComplete="off" spellCheck={false}
              disabled={disabled || busy} onChange={event => { setValue(event.target.value); setError(null); }} />
          </div>
          <button type="submit" className="btn btn-pill btn-accent" disabled={disabled || busy || value.trim().length === 0}>
            {busy ? t('key.encrypting') : t('key.save')}
          </button>
          {configured && <button type="button" className="btn btn-pill btn-quiet" disabled={busy}
            onClick={() => { setEditing(false); setValue(''); setError(null); }}>{t('common.cancel')}</button>}
        </form>
      )}
      {error && <div className="field-error" role="alert">{error}</div>}
      {confirmRemove && (
        <Modal title={t('key.removeTitle', { provider })} onClose={() => setConfirmRemove(false)} width={440} footer={<>
          <button className="btn btn-quiet" onClick={() => setConfirmRemove(false)}>{t('common.cancel')}</button>
          <button className="btn btn-danger" data-autofocus onClick={() => { void onClear(); setConfirmRemove(false); }}>{t('key.removeConfirm')}</button>
        </>}>
          <p className="muted">{t('key.removeText')}</p>
        </Modal>
      )}
    </div>
  );
}

/** Anthropic keeps its own fixed model list and the M2 slice-1 operations. */
export function AnthropicDetail() {
  const t = useT();
  const model = useStore(s => s.model);
  const test = useStore(s => s.modelTest);
  const ready = useStore(s => s.connection === 'ready');
  useEffect(() => { void actions.refreshModel(); }, []);
  const chosen = model?.model ?? DEFAULT_CLAUDE_MODEL;
  const configured = model?.credential.configured === true;
  const disabled = !ready || !model;
  return (
    <>
      <h3 className="settings-group-title">{t('providers.model')}</h3>
      <div className="model-options" role="radiogroup" aria-label={t('providers.model')}>
        {CLAUDE_MODELS.map(id => (
          <button key={id} role="radio" aria-checked={id === chosen} className={`model-option${id === chosen ? ' is-active' : ''}`} disabled={disabled}
            data-model={id} onClick={() => void actions.saveModelChoice(id)}>
            <span className="model-option-head">
              <span className="model-option-name">{MODEL_INFO[id].name}</span>
              {id === DEFAULT_CLAUDE_MODEL && <span className="model-option-badge">{t('common.default')}</span>}
              <span className="model-option-check"><IconCheck size={13} /></span>
            </span>
            <span className="model-option-tagline">{t(MODEL_INFO[id].tagline)}</span>
            <span className="model-option-id mono">{id}</span>
          </button>
        ))}
      </div>

      <h3 className="settings-group-title">{t('providers.apiKey')}</h3>
      <KeyField provider="Anthropic" credential={model?.credential ?? null} secureStorage={model?.secureStorage ?? 'unavailable'} disabled={disabled}
        placeholder="sk-ant-…" mask="sk-ant-" onSave={apiKey => actions.setApiKey(apiKey)} onClear={() => actions.clearApiKey()} />

      <div className="test-row">
        <button className="btn btn-pill" onClick={() => void actions.testModel()} disabled={disabled || !configured || test.state === 'running'} data-action="test-connection">
          {test.state === 'running' ? <><IconRetry size={13} className="spinner" /> {t('test.testing')}</> : t('test.button')}
        </button>
        <span className="muted small">{t('test.hint')}</span>
      </div>
      {test.state === 'done' && <TestResult status={test.result.status} provider="anthropic" httpStatus={test.result.httpStatus} latencyMs={test.result.latencyMs}
        model={MODEL_INFO[test.result.model].name} />}
      {test.state === 'failed' && <TestFailed code={test.code} />}

      <div className="settings-note"><IconShield size={14} /> <span>{t('key.note', { provider: 'Anthropic' })}</span></div>
    </>
  );
}
