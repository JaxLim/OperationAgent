import { useEffect, useRef, useState } from 'react';
import { CLAUDE_MODELS, DEFAULT_CLAUDE_MODEL } from '@operation-agent/contracts';
import type { ClaudeModel, ModelTestResult, ModelTestStatus } from '@operation-agent/contracts';
import { actions, useStore } from '../state';
import { IconAlert, IconCheck, IconLock, IconRetry, IconShield, IconSparkle, IconX } from './Icons';

const MODEL_INFO: Record<ClaudeModel, { name: string; tagline: string }> = {
  'claude-sonnet-5-5': { name: 'Sonnet 5.5', tagline: 'Balanced speed and depth for everyday coding' },
  'claude-opus-5-5': { name: 'Opus 5.5', tagline: 'Most capable, for long and difficult changes' },
  'claude-haiku-5-5': { name: 'Haiku 5.5', tagline: 'Fastest replies for quick questions' },
};
export function modelName(model: ClaudeModel): string { return `Claude ${MODEL_INFO[model].name}`; }

const KEY_ERRORS: Record<string, string> = {
  VALIDATION_ERROR: 'That does not look like an API key. Keys are 20–256 visible characters with no spaces.',
  SECURE_STORAGE_UNAVAILABLE: 'Secure OS storage is unavailable, so the key was not saved. Nothing was written.',
  SERVICE_UNAVAILABLE: 'The control plane could not reach secure storage. Nothing was written; try again.',
  DATABASE_UNAVAILABLE: 'The local database could not store the encrypted key. Nothing was written.',
};
const TEST_COPY: Record<ModelTestStatus, { tone: 'ok' | 'warn' | 'danger'; title: string; detail: string }> = {
  ok: { tone: 'ok', title: 'Connected', detail: 'Claude accepted the key and the selected model answered.' },
  auth_failed: { tone: 'danger', title: 'Key rejected', detail: 'Anthropic did not accept this key. Check it in the Console and replace it.' },
  rate_limited: { tone: 'warn', title: 'Rate limited', detail: 'The key works but is being throttled right now. Try again shortly.' },
  model_unavailable: { tone: 'warn', title: 'Model unavailable', detail: 'This key cannot use the selected model. Pick another model or check access.' },
  provider_error: { tone: 'warn', title: 'Provider error', detail: 'Anthropic returned an error. The service may be overloaded; try again later.' },
  unreachable: { tone: 'danger', title: 'Unreachable', detail: 'api.anthropic.com could not be reached from this device (network, proxy or timeout).' },
  not_configured: { tone: 'warn', title: 'No API key', detail: 'Add an API key first.' },
  credential_unavailable: { tone: 'danger', title: 'Stored key unreadable', detail: 'The saved key could not be decrypted on this account. Replace it.' },
};

function TestResult({ result }: { result: ModelTestResult }) {
  const copy = TEST_COPY[result.status];
  const facts = [result.httpStatus ? `HTTP ${result.httpStatus}` : null, result.latencyMs !== null ? `${result.latencyMs} ms` : null,
    MODEL_INFO[result.model].name].filter(Boolean).join(' · ');
  return (
    <div className={`test-result tone-result-${copy.tone}`} role="status" data-test-status={result.status}>
      <span className="test-result-icon">{copy.tone === 'ok' ? <IconCheck size={14} /> : copy.tone === 'warn' ? <IconAlert size={14} /> : <IconX size={14} />}</span>
      <span className="test-result-body">
        <strong>{copy.title}</strong>
        <span>{copy.detail}</span>
        <span className="test-result-facts mono">{facts}</span>
      </span>
    </div>
  );
}

/**
 * The key form never shows a stored key and never keeps a typed one: the input is cleared as soon as Main has it,
 * and the component state disappears with the dialog.
 */
function ApiKeyField({ disabled }: { disabled: boolean }) {
  const credential = useStore(s => s.model?.credential ?? null);
  const storage = useStore(s => s.model?.secureStorage ?? 'unavailable');
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const configured = credential?.configured === true;
  const showForm = !configured || editing;
  useEffect(() => { if (editing) input.current?.focus(); }, [editing]);
  const save = async (): Promise<void> => {
    if (!value || busy) return;
    setBusy(true); setError(null);
    const code = await actions.setApiKey(value.trim());
    setBusy(false);
    if (code) { setError(KEY_ERRORS[code] ?? `The key was not saved (${code}).`); return; }
    setValue(''); setEditing(false);
  };
  if (storage === 'unavailable' && !configured) {
    return (
      <div className="key-blocked" role="alert">
        <IconLock size={15} />
        <span><strong>Secure storage unavailable.</strong> OperationAgent stores keys only through the operating system’s protected storage
          (Windows DPAPI via Electron safeStorage) and will not fall back to anything weaker. No key can be saved on this account right now.</span>
      </div>
    );
  }
  return (
    <div className="key-field">
      {!showForm && credential?.configured && (
        <div className="key-saved" data-key-state="configured">
          <span className="key-saved-glyph"><IconLock size={14} /></span>
          <span className="key-saved-text">
            <span className="mono key-mask" aria-label="Stored key, masked">sk-ant-••••••••••••{credential.hint ?? '••••'}</span>
            <span className="muted small">Encrypted on this device · never shown again</span>
          </span>
          <button className="btn btn-pill btn-xs" onClick={() => { setEditing(true); setError(null); }} disabled={disabled}>Replace</button>
          <button className="btn btn-pill btn-xs btn-quiet btn-danger-text" onClick={() => void actions.clearApiKey()} disabled={disabled}>Remove</button>
        </div>
      )}
      {showForm && (
        <form className="key-form" data-key-state={configured ? 'replacing' : 'empty'} onSubmit={event => { event.preventDefault(); void save(); }}>
          <div className={`key-input${error ? ' has-error' : ''}`}>
            <input ref={input} type="password" aria-label="Anthropic API key" placeholder="sk-ant-…" value={value} autoComplete="off" spellCheck={false}
              disabled={disabled || busy} onChange={event => { setValue(event.target.value); setError(null); }} />
          </div>
          <button type="submit" className="btn btn-pill btn-accent" disabled={disabled || busy || value.trim().length === 0}>
            {busy ? 'Encrypting…' : 'Save key'}
          </button>
          {configured && <button type="button" className="btn btn-pill btn-quiet" onClick={() => { setEditing(false); setValue(''); setError(null); }}>Cancel</button>}
        </form>
      )}
      {error && <div className="field-error" role="alert">{error}</div>}
    </div>
  );
}

export function ModelSection() {
  const model = useStore(s => s.model);
  const test = useStore(s => s.modelTest);
  const ready = useStore(s => s.connection === 'ready');
  useEffect(() => { void actions.refreshModel(); }, []);
  const chosen = model?.model ?? DEFAULT_CLAUDE_MODEL;
  const configured = model?.credential.configured === true;
  const disabled = !ready || !model;
  return (
    <div className="model-section">
      <div className="provider-card">
        <span className="provider-mark" aria-hidden="true"><IconSparkle size={18} /></span>
        <span className="provider-text">
          <span className="eyebrow">Provider</span>
          <strong>Anthropic Claude</strong>
          <span className="muted small">Messages API · api.anthropic.com</span>
        </span>
        <span className={`pill ${configured ? 'tone-ok' : 'tone-muted'}`} data-credential={configured ? 'configured' : 'missing'}>
          <span className="dot" />{configured ? 'Key configured' : 'No key'}
        </span>
      </div>

      <h3 className="eyebrow section-eyebrow">Model</h3>
      <div className="model-options" role="radiogroup" aria-label="Claude model">
        {CLAUDE_MODELS.map(id => (
          <button key={id} role="radio" aria-checked={id === chosen} className={`model-option${id === chosen ? ' is-active' : ''}`} disabled={disabled}
            data-model={id} onClick={() => void actions.saveModelChoice(id)}>
            <span className="model-option-head">
              <span className="model-option-name">{MODEL_INFO[id].name}</span>
              {id === DEFAULT_CLAUDE_MODEL && <span className="model-option-badge">Default</span>}
              <span className="model-option-check"><IconCheck size={13} /></span>
            </span>
            <span className="model-option-tagline">{MODEL_INFO[id].tagline}</span>
            <span className="model-option-id mono">{id}</span>
          </button>
        ))}
      </div>

      <h3 className="eyebrow section-eyebrow">API key</h3>
      <ApiKeyField disabled={disabled} />

      <div className="test-row">
        <button className="btn btn-pill" onClick={() => void actions.testModel()} disabled={disabled || !configured || test.state === 'running'} data-action="test-connection">
          {test.state === 'running' ? <><IconRetry size={13} className="spinner" /> Testing…</> : 'Test connection'}
        </button>
        <span className="muted small">Sends one tiny request (1 output token) to verify the key and model.</span>
      </div>
      {test.state === 'done' && <TestResult result={test.result} />}
      {test.state === 'failed' && (
        <div className="test-result tone-result-danger" role="status" data-test-status="failed">
          <span className="test-result-icon"><IconX size={14} /></span>
          <span className="test-result-body"><strong>Test could not run</strong><span className="mono">{test.code}</span></span>
        </div>
      )}

      <div className="settings-note"><IconShield size={14} /> <span>The key is encrypted by the operating system before it is stored and is used only by the local
        control plane for requests to Anthropic. The agent worker never receives it, and agent execution stays disabled until its isolation gate passes.</span></div>
    </div>
  );
}
