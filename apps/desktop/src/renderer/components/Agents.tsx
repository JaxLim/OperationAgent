import { useEffect, useState } from 'react';
import { AGENT_LIMITS, AGENT_TOOLS, AgentSaveSchema, BUILT_IN_AGENTS, CLAUDE_MODELS, MODEL_PROVIDERS, McpServerSaveSchema } from '@operation-agent/contracts';
import type { Agent, AgentInput, AgentSave, AgentTool, McpServer, McpServerSave, ModelProvider } from '@operation-agent/contracts';
import type { MessageKey } from '../i18n';
import { useT } from '../locale';
import { actions, notify, useStore } from '../state';
import { PROVIDER_NAMES } from './ModelSettings';
import { Modal, Segmented, Toggle } from './Modal';
import { IconBox, IconInfo, IconLock, IconPlus, IconPuzzle, IconSearch, IconShield, IconSparkle, IconTerminal, IconX } from './Icons';

// Settings › Agents and Settings › MCP. Both edit stored configuration only: no agent loop runs these profiles and
// no MCP Host launches or contacts these servers in this build. Every save is re-validated by Express.

/** The gate that must pass before a tool can do anything; asking for a tool in a profile never lifts it. */
const TOOL_GATE: Readonly<Record<AgentTool, string>> = {
  read_file: 'READ_ADAPTER_UNAVAILABLE', git_read: 'READ_ADAPTER_UNAVAILABLE', web_search: 'AGENT_LOOP_NOT_IMPLEMENTED', mcp: 'MCP_HOST_UNAVAILABLE',
  write_file: 'SANDBOX_UNAVAILABLE', bash: 'SANDBOX_UNAVAILABLE',
};
const BUILT_IN_TEXT: Readonly<Record<string, MessageKey>> = { general: 'agent.general', plan: 'agent.plan', explore: 'agent.explore', review: 'agent.review' };
const EMPTY: AgentInput = { name: '', description: '', mode: 'subagent', model: null, prompt: '', tools: ['read_file', 'git_read'] };
type Selection = { kind: 'builtIn'; name: string } | { kind: 'custom'; id: string } | { kind: 'new' } | null;

function AgentForm({ initial, id, onDone }: { initial: AgentInput; id?: string; onDone: (saved: boolean) => void }) {
  const t = useT();
  const ready = useStore(s => s.connection === 'ready');
  const [draft, setDraft] = useState<AgentInput>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => { setDraft(initial); setError(null); }, [initial]);
  const patch = (value: Partial<AgentInput>): void => { setDraft(current => ({ ...current, ...value })); setError(null); };
  const toggleTool = (tool: AgentTool, on: boolean): void =>
    patch({ tools: on ? AGENT_TOOLS.filter(item => item === tool || draft.tools.includes(item)) : draft.tools.filter(item => item !== tool) });
  const save = async (): Promise<void> => {
    setBusy(true);
    const input: AgentSave = { ...draft, name: draft.name.trim(), description: draft.description.trim(), ...(id ? { id } : {}) };
    // Checked against the same contract Express uses, so a bad field is named here instead of failing in transit.
    const code = AgentSaveSchema.safeParse(input).success ? await actions.saveAgent(input) : 'VALIDATION_ERROR';
    setBusy(false);
    if (!code) { notify('ok', t('agents.saved')); onDone(true); return; }
    const known = ['RECORD_CONFLICT', 'LIMIT_EXCEEDED', 'VALIDATION_ERROR'] as const;
    setError((known as readonly string[]).includes(code) ? t(`agents.error.${code as (typeof known)[number]}`) : t('agents.error.generic', { code }));
  };
  const provider = draft.model?.provider ?? null;
  return (
    <form className="agent-form" onSubmit={event => { event.preventDefault(); void save(); }}>
      <label className="field">
        <span className="field-label">{t('agents.name')}</span>
        <input className="text-input mono" value={draft.name} maxLength={32} autoFocus={!id} spellCheck={false} placeholder="docs-writer"
          onChange={event => patch({ name: event.target.value.toLowerCase() })} />
        <span className="field-hint">{t('agents.nameHint')}</span>
      </label>
      <label className="field">
        <span className="field-label">{t('agents.description')}</span>
        <input className="text-input" value={draft.description} maxLength={AGENT_LIMITS.maxDescriptionChars} onChange={event => patch({ description: event.target.value })} />
      </label>
      <div className="field">
        <span className="field-label">{t('agents.mode')}</span>
        <Segmented value={draft.mode} onChange={mode => patch({ mode })}
          options={[{ value: 'primary', label: t('agents.mode.primary') }, { value: 'subagent', label: t('agents.mode.subagent') }]} />
        <span className="field-hint">{t('agents.modeHint')}</span>
      </div>
      <div className="field">
        <span className="field-label">{t('agents.model')}</span>
        <div className="field-row">
          <select className="text-input select-native" value={provider ?? ''} aria-label={t('agents.model')}
            onChange={event => {
              const next = event.target.value as ModelProvider | '';
              patch({ model: next ? { provider: next, model: next === 'anthropic' ? CLAUDE_MODELS[0] : draft.model?.model ?? '' } : null });
            }}>
            <option value="">{t('agents.inherit')}</option>
            {MODEL_PROVIDERS.map(id => <option key={id} value={id}>{PROVIDER_NAMES[id]}</option>)}
          </select>
          {draft.model && (draft.model.provider === 'anthropic' ? (
            <select className="text-input select-native mono" value={draft.model.model} aria-label={t('agents.modelId')}
              onChange={event => patch({ model: { provider: 'anthropic', model: event.target.value } })}>
              {CLAUDE_MODELS.map(id => <option key={id} value={id}>{id}</option>)}
            </select>
          ) : (
            <input className="text-input mono" value={draft.model.model} placeholder={t('agents.modelId')} aria-label={t('agents.modelId')} maxLength={128} spellCheck={false}
              onChange={event => patch({ model: { provider: draft.model!.provider, model: event.target.value.trim() } })} />
          ))}
        </div>
      </div>
      <div className="field">
        <span className="field-label">{t('agents.tools')}</span>
        <div className="tool-grid">
          {AGENT_TOOLS.map(tool => (
            <label key={tool} className={`tool-chip${draft.tools.includes(tool) ? ' is-on' : ''}`}>
              <input type="checkbox" checked={draft.tools.includes(tool)} onChange={event => toggleTool(tool, event.target.checked)} />
              <span className="tool-chip-label">{t(`tool.${tool}`)}</span>
              <span className="tool-chip-gate mono" title={TOOL_GATE[tool]}><IconLock size={10} /></span>
            </label>
          ))}
        </div>
        <span className="field-hint">{t('agents.toolsHint')}</span>
      </div>
      <label className="field">
        <span className="field-label">{t('agents.prompt')}</span>
        <textarea className="text-input text-area" rows={6} value={draft.prompt} maxLength={AGENT_LIMITS.maxPromptChars} onChange={event => patch({ prompt: event.target.value })} />
        <span className="field-hint">{t('agents.promptHint', { count: draft.prompt.length, max: AGENT_LIMITS.maxPromptChars })}</span>
      </label>
      {error && <div className="field-error" role="alert">{error}</div>}
      <div className="form-actions">
        {id && <button type="button" className="btn btn-pill btn-quiet btn-danger-text" disabled={!ready || busy} onClick={() => setConfirm(true)}>{t('agents.delete')}</button>}
        <span className="tool-spacer" />
        <button type="submit" className="btn btn-pill btn-accent" disabled={!ready || busy || draft.name.trim().length < 2 || (draft.model !== null && !draft.model.model)}>
          {t(id ? 'agents.save' : 'agents.create')}</button>
      </div>
      {confirm && id && (
        <Modal title={t('agents.deleteTitle', { name: draft.name })} onClose={() => setConfirm(false)} width={420} footer={<>
          <button className="btn btn-quiet" onClick={() => setConfirm(false)}>{t('common.cancel')}</button>
          <button className="btn btn-danger" data-autofocus onClick={() => { void actions.removeAgent(id); setConfirm(false); onDone(false); }}>{t('agents.delete')}</button>
        </>}><p className="muted">{t('agents.deleteText')}</p></Modal>
      )}
    </form>
  );
}

function BuiltInView({ agent }: { agent: AgentInput }) {
  const t = useT();
  return (
    <div className="agent-view">
      <div className="settings-note"><IconLock size={14} /><span>{t('agents.builtInNote')}</span></div>
      <dl className="agent-facts">
        <dt>{t('agents.mode')}</dt><dd>{t(agent.mode === 'primary' ? 'agents.mode.primary' : 'agents.mode.subagent')}</dd>
        <dt>{t('agents.model')}</dt><dd>{t('agents.inherit')}</dd>
        <dt>{t('agents.tools')}</dt>
        <dd className="tool-list">{agent.tools.map(tool => <span key={tool} className="badge badge-soft">{t(`tool.${tool}`)}</span>)}</dd>
      </dl>
    </div>
  );
}

export function AgentsSection() {
  const t = useT();
  const agents = useStore(s => s.agents);
  const [selected, setSelected] = useState<Selection>(null);
  const [query, setQuery] = useState('');
  useEffect(() => { void actions.refreshAgents(); }, []);
  const q = query.trim().toLowerCase();
  const match = (name: string, description: string): boolean => !q || `${name} ${description}`.toLowerCase().includes(q);
  const builtIns = BUILT_IN_AGENTS.filter(agent => match(agent.name, t(BUILT_IN_TEXT[agent.name]!)));
  const custom = (agents ?? []).filter(agent => match(agent.name, agent.description));
  const builtIn = selected?.kind === 'builtIn' ? BUILT_IN_AGENTS.find(agent => agent.name === selected.name) : undefined;
  const editing: Agent | undefined = selected?.kind === 'custom' ? agents?.find(agent => agent.id === selected.id) : undefined;
  const row = (key: string, name: string, description: string, mode: AgentInput['mode'], active: boolean, system: boolean, onClick: () => void) => (
    <button key={key} className={`agent-row${active ? ' is-active' : ''}`} onClick={onClick} aria-current={active || undefined}>
      <span className="agent-row-head">
        <span className="agent-row-name">{name}</span>
        <span className={`agent-mode-glyph mode-${mode}`} title={t(mode === 'primary' ? 'agents.mode.primary' : 'agents.mode.subagent')}>
          {mode === 'primary' ? <IconSparkle size={12} /> : <IconBox size={12} />}</span>
        {system && <span className="agent-row-tag">{t('agents.system')}</span>}
      </span>
      <span className="agent-row-desc">{description}</span>
    </button>
  );
  return (
    <div className="split-pane">
      <div className="split-list">
        <div className="split-list-head">
          <span className="muted small">{t('agents.total', { count: BUILT_IN_AGENTS.length + (agents?.length ?? 0) })}</span>
          <span className="tool-spacer" />
          <button className="icon-btn icon-btn-sm" onClick={() => setSelected({ kind: 'new' })} aria-label={t('agents.new')} title={t('agents.new')}><IconPlus size={15} /></button>
        </div>
        <label className="select-search split-search">
          <IconSearch size={14} />
          <input value={query} onChange={event => setQuery(event.target.value)} placeholder={t('common.search')} aria-label={t('common.search')} />
        </label>
        <div className="split-scroll">
          <div className="split-group-label">{t('agents.builtIn')}</div>
          {builtIns.map(agent => row(agent.name, agent.name, t(BUILT_IN_TEXT[agent.name]!), agent.mode, selected?.kind === 'builtIn' && selected.name === agent.name, true,
            () => setSelected({ kind: 'builtIn', name: agent.name })))}
          <div className="split-group-label">{t('agents.custom')}</div>
          {custom.map(agent => row(agent.id, agent.name, agent.description, agent.mode, selected?.kind === 'custom' && selected.id === agent.id, false,
            () => setSelected({ kind: 'custom', id: agent.id })))}
          {agents && agents.length === 0 && <div className="split-empty">{t('agents.noCustom')}</div>}
        </div>
      </div>
      <div className="split-detail">
        {builtIn && <><h3 className="split-title">{builtIn.name}</h3><p className="muted">{t(BUILT_IN_TEXT[builtIn.name]!)}</p><BuiltInView agent={builtIn} /></>}
        {editing && <><h3 className="split-title">{editing.name}</h3>
          <AgentForm key={editing.id} id={editing.id} initial={editing} onDone={saved => { if (!saved) setSelected(null); }} /></>}
        {selected?.kind === 'new' && <><h3 className="split-title">{t('agents.new')}</h3>
          <AgentForm initial={EMPTY} onDone={() => setSelected(null)} /></>}
        {!builtIn && !editing && selected?.kind !== 'new' && (
          <div className="split-placeholder">
            <span className="split-placeholder-icon"><IconSparkle size={26} /></span>
            <span>{t('agents.empty')}</span>
            <button className="link" onClick={() => setSelected({ kind: 'new' })}>{t('agents.emptySub')}</button>
          </div>
        )}
        <div className="settings-note"><IconInfo size={14} /><span>{t('agents.runNote')}</span></div>
      </div>
    </div>
  );
}

type McpDraft = { name: string; transport: 'stdio' | 'http'; command: string; args: string; url: string; enabled: boolean };
const toDraft = (server?: McpServer): McpDraft => ({ name: server?.name ?? '', transport: server?.transport ?? 'stdio', enabled: server?.enabled ?? true,
  command: server?.transport === 'stdio' ? server.command : '', args: server?.transport === 'stdio' ? server.args.join('\n') : '',
  url: server?.transport === 'http' ? server.url : '' });

function McpForm({ server, onDone }: { server?: McpServer; onDone: () => void }) {
  const t = useT();
  const ready = useStore(s => s.connection === 'ready');
  const [draft, setDraft] = useState<McpDraft>(() => toDraft(server));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const patch = (value: Partial<McpDraft>): void => { setDraft(current => ({ ...current, ...value })); setError(null); };
  const save = async (): Promise<void> => {
    const base = { name: draft.name.trim(), enabled: draft.enabled, ...(server ? { id: server.id } : {}) };
    const input: McpServerSave = draft.transport === 'stdio'
      ? { ...base, transport: 'stdio', command: draft.command.trim(), args: draft.args.split('\n').map(arg => arg.trim()).filter(Boolean) }
      : { ...base, transport: 'http', url: draft.url.trim() };
    setBusy(true);
    const code = McpServerSaveSchema.safeParse(input).success ? await actions.saveMcpServer(input) : 'VALIDATION_ERROR';
    setBusy(false);
    if (!code) { notify('ok', t('mcp.saved')); onDone(); return; }
    const known = ['RECORD_CONFLICT', 'LIMIT_EXCEEDED', 'VALIDATION_ERROR'] as const;
    setError((known as readonly string[]).includes(code) ? t(`mcp.error.${code as (typeof known)[number]}`) : t('mcp.error.generic', { code }));
  };
  return (
    <form className="mcp-form" onSubmit={event => { event.preventDefault(); void save(); }}>
      <div className="field-row">
        <label className="field">
          <span className="field-label">{t('mcp.name')}</span>
          <input className="text-input mono" value={draft.name} maxLength={48} autoFocus spellCheck={false} placeholder="filesystem" onChange={event => patch({ name: event.target.value })} />
        </label>
        <div className="field">
          <span className="field-label">{t('mcp.transport')}</span>
          <Segmented value={draft.transport} onChange={transport => patch({ transport })}
            options={[{ value: 'stdio', label: t('mcp.stdio') }, { value: 'http', label: t('mcp.http') }]} />
        </div>
      </div>
      {draft.transport === 'stdio' ? (
        <>
          <label className="field">
            <span className="field-label">{t('mcp.command')}</span>
            <input className="text-input mono" value={draft.command} maxLength={512} spellCheck={false} placeholder="npx" onChange={event => patch({ command: event.target.value })} />
            <span className="field-hint">{t('mcp.commandHint')}</span>
          </label>
          <label className="field">
            <span className="field-label">{t('mcp.args')}</span>
            <textarea className="text-input text-area mono" rows={3} value={draft.args} spellCheck={false} placeholder={'-y\n@modelcontextprotocol/server-filesystem'}
              onChange={event => patch({ args: event.target.value })} />
            <span className="field-hint">{t('mcp.argsHint')}</span>
          </label>
        </>
      ) : (
        <label className="field">
          <span className="field-label">{t('mcp.url')}</span>
          <input className="text-input mono" value={draft.url} maxLength={512} spellCheck={false} placeholder="https://mcp.example.com/mcp" onChange={event => patch({ url: event.target.value })} />
          <span className="field-hint">{t('mcp.urlHint')}</span>
        </label>
      )}
      <div className="field field-inline">
        <Toggle label={t('mcp.enabled')} checked={draft.enabled} onChange={enabled => patch({ enabled })} />
        <span><span className="field-label">{t('mcp.enabled')}</span><span className="field-hint">{t('mcp.enabledHint')}</span></span>
      </div>
      {error && <div className="field-error" role="alert">{error}</div>}
      <div className="form-actions">
        <span className="tool-spacer" />
        <button type="button" className="btn btn-pill btn-quiet" onClick={onDone}>{t('common.cancel')}</button>
        <button type="submit" className="btn btn-pill btn-accent" disabled={!ready || busy || !draft.name.trim()}>{t('mcp.save')}</button>
      </div>
    </form>
  );
}

export function McpSection() {
  const t = useT();
  const servers = useStore(s => s.mcpServers);
  const ready = useStore(s => s.connection === 'ready');
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [confirm, setConfirm] = useState<McpServer | null>(null);
  useEffect(() => { void actions.refreshMcp(); }, []);
  const toggle = (server: McpServer, enabled: boolean): void => {
    void actions.saveMcpServer(server.transport === 'stdio'
      ? { transport: 'stdio', id: server.id, name: server.name, enabled, command: server.command, args: server.args }
      : { transport: 'http', id: server.id, name: server.name, enabled, url: server.url });
  };
  return (
    <>
      <div className="settings-note"><IconShield size={14} /><span>{t('mcp.hostNote')}</span></div>
      <h3 className="settings-group-title">{t('mcp.servers')}
        <span className="tool-spacer" />
        {editing === null && <button className="btn btn-pill btn-xs" disabled={!ready} onClick={() => setEditing('new')} data-action="add-mcp"><IconPlus size={12} /> {t('mcp.add')}</button>}
      </h3>
      {editing === 'new' && <div className="inline-detail"><McpForm onDone={() => setEditing(null)} /></div>}
      {servers && servers.length === 0 && editing !== 'new' && (
        <div className="feature-empty">
          <span className="feature-empty-icon"><IconPuzzle size={20} /></span>
          <strong>{t('mcp.empty')}</strong>
          <span className="muted">{t('mcp.emptyText')}</span>
        </div>
      )}
      <div className="mcp-list">
        {servers?.map(server => editing === server.id ? (
          <div key={server.id} className="inline-detail"><McpForm server={server} onDone={() => setEditing(null)} /></div>
        ) : (
          <div key={server.id} className="mcp-row" data-mcp={server.name}>
            <span className="mcp-row-icon">{server.transport === 'stdio' ? <IconTerminal size={15} /> : <IconPuzzle size={15} />}</span>
            <span className="mcp-row-text">
              <strong className="mono">{server.name}</strong>
              <span className="muted small mono ellipsis">{server.transport === 'stdio' ? [server.command, ...server.args].join(' ') : server.url}</span>
            </span>
            <span className="pill tone-muted"><span className="dot" />{t(server.enabled ? 'mcp.notConnected' : 'mcp.disabled')}</span>
            <Toggle label={t('mcp.enabled')} checked={server.enabled} disabled={!ready} onChange={enabled => toggle(server, enabled)} />
            <button className="btn btn-pill btn-xs btn-quiet" disabled={!ready} onClick={() => setEditing(server.id)}>{t('common.edit')}</button>
            <button className="icon-btn icon-btn-sm" disabled={!ready} aria-label={t('mcp.deleteTitle', { name: server.name })} onClick={() => setConfirm(server)}><IconX size={14} /></button>
          </div>
        ))}
      </div>
      <h3 className="settings-group-title">{t('mcp.skills')}</h3>
      <div className="setting-row">
        <div className="setting-text"><div className="setting-hint">{t('mcp.skillsHint')}</div></div>
        <div className="setting-control"><span className="badge badge-soft"><IconLock size={11} /> {t('common.notAvailable')}</span></div>
      </div>
      {confirm && (
        <Modal title={t('mcp.deleteTitle', { name: confirm.name })} onClose={() => setConfirm(null)} width={420} footer={<>
          <button className="btn btn-quiet" onClick={() => setConfirm(null)}>{t('common.cancel')}</button>
          <button className="btn btn-danger" data-autofocus onClick={() => { void actions.removeMcpServer(confirm.id); setConfirm(null); }}>{t('common.remove')}</button>
        </>}><p className="muted">{t('mcp.deleteText')}</p></Modal>
      )}
    </>
  );
}
