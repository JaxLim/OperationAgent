import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { CLAUDE_MODELS, DEFAULT_CLAUDE_MODEL, MODEL_PROVIDERS, WORKBENCH_LIMITS } from '@operation-agent/contracts';
import type { ModelProvider, Project } from '@operation-agent/contracts';
import type { MessageKey } from '../i18n';
import { useLocale, useT } from '../locale';
import { actions, composePrompt, useStore } from '../state';
import type { Submission } from '../state';
import { relativeTime } from './format';
import { TaskDetail } from './TaskDetail';
import { MODEL_INFO, PROVIDER_NAMES } from './ModelSettings';
import { MenuItem, MenuLabel, MenuSeparator, Popover } from './Menu';
import { IconAlert, IconCheck, IconChevronDown, IconFolder, IconFolderPlus, IconGauge, IconLaptop, IconLock, IconPaperclip, IconPlus, IconPuzzle, IconSend,
  IconShield, IconSparkle, IconTarget, IconX } from './Icons';
import type { SectionId } from './Settings';

export interface ComposerHandle { focus(): void }
export type SettingsTarget = Extract<SectionId, 'providers' | 'chat' | 'mcp' | 'usage'>;

let focusOnMount = false;
/** Focuses the composer now, or when it next mounts (an open task replaces it). No animation-frame timing. */
export function requestComposerFocus(handle: ComposerHandle | null): void {
  if (handle) handle.focus(); else focusOnMount = true;
}

/** Unsent drafts per project. Memory only: prompts are never written to disk, so drafts end with the window. */
const drafts = new Map<string, { text: string; goal: string | null }>();
const MAX_GOAL = 300;

/** Whether a provider has a stored key, as Express reports it. */
function useConfigured(): (provider: ModelProvider) => boolean {
  const model = useStore(s => s.model);
  const providers = useStore(s => s.providers);
  return provider => provider === 'anthropic' ? model?.credential.configured === true
    : providers?.providers.find(item => item.provider === provider)?.credential.configured === true;
}

function ModelPicker({ onOpenSettings }: { onOpenSettings: (target: SettingsTarget) => void }) {
  const t = useT();
  const model = useStore(s => s.model);
  const providers = useStore(s => s.providers);
  const settings = useStore(s => s.settings);
  const ready = useStore(s => s.connection === 'ready');
  const configured = useConfigured();
  const provider = settings?.defaultProvider ?? 'anthropic';
  const chosen = model?.model ?? DEFAULT_CLAUDE_MODEL;
  const linkedModel = provider === 'anthropic' ? null : providers?.providers.find(item => item.provider === provider)?.model ?? null;
  const label = provider === 'anthropic' ? MODEL_INFO[chosen].name : linkedModel ?? t('composer.noModel');
  return (
    <Popover label={t('composer.model')} placement="top-end" className="popover-model" trigger={props => (
      <button {...props} className="composer-select" data-model-picker={provider === 'anthropic' ? chosen : linkedModel ?? ''} disabled={!model || !settings}
        title={`${PROVIDER_NAMES[provider]} · ${label}`}>
        <span className="ellipsis">{label}</span><IconChevronDown size={13} />
      </button>
    )}>
      {close => (
        <>
          <MenuLabel>{t('composer.provider')}</MenuLabel>
          {MODEL_PROVIDERS.map(id => (
            <MenuItem key={id} checked={id === provider} unavailable={!ready || (!configured(id) && id !== provider)} label={PROVIDER_NAMES[id]}
              hint={configured(id) ? undefined : t('composer.addKeyHint')}
              onSelect={() => { void actions.saveSettings({ defaultProvider: id }); close(); }} />
          ))}
          <MenuSeparator />
          <MenuLabel>{t('composer.modelLabel')}</MenuLabel>
          {provider === 'anthropic' ? CLAUDE_MODELS.map(id => (
            <MenuItem key={id} checked={id === chosen} unavailable={!ready} label={<>{MODEL_INFO[id].name}{id === DEFAULT_CLAUDE_MODEL && <span className="menu-tag">{t('common.default')}</span>}</>}
              hint={t(MODEL_INFO[id].tagline)} onSelect={() => { void actions.saveModelChoice(id); close(); }} />
          )) : (
            <MenuItem checked={linkedModel !== null} label={<span className="mono">{linkedModel ?? t('composer.noModel')}</span>} hint={t('composer.otherModelHint')}
              onSelect={() => { close(); onOpenSettings('providers'); }} />
          )}
          <MenuSeparator />
          <div className="menu-note">
            <IconLock size={13} />
            <span>{t('composer.effortNote')}</span>
          </div>
          <MenuItem icon={<IconSparkle size={15} />} label={t('composer.modelSettings')} onSelect={() => { close(); onOpenSettings('providers'); }} />
        </>
      )}
    </Popover>
  );
}

function AddMenu({ onGoal, hasGoal, onOpenSettings }: { onGoal: () => void; hasGoal: boolean; onOpenSettings: (target: SettingsTarget) => void }) {
  const t = useT();
  return (
    <Popover label={t('composer.add')} placement="top-start" className="popover-add" trigger={props => (
      <button {...props} className="composer-icon" aria-label={t('composer.add')} title={t('composer.add')}><IconPlus size={18} /></button>
    )}>
      {close => (
        <>
          <MenuLabel>{t('composer.taskLabel')}</MenuLabel>
          <MenuItem icon={<IconTarget size={16} />} label={t(hasGoal ? 'composer.editGoal' : 'composer.setGoal')} hint={t('composer.goalHint')}
            onSelect={() => { close(); onGoal(); }} />
          <MenuSeparator />
          <MenuLabel>{t('composer.attach')}</MenuLabel>
          <MenuItem icon={<IconPaperclip size={16} />} label={t('composer.files')} unavailable hint={t('composer.filesHint')} />
          <MenuSeparator />
          <MenuLabel>{t('composer.extend')}</MenuLabel>
          <MenuItem icon={<IconPuzzle size={16} />} label={t('composer.tools')} unavailable hint={t('composer.toolsHint')} />
          <MenuItem label={t('composer.toolsSettings')} onSelect={() => { close(); onOpenSettings('mcp'); }} />
        </>
      )}
    </Popover>
  );
}

/** Shows only what is known: the request size against the contract limit (reported), a token estimate, and what is not reported. */
function ContextMeter({ chars, onOpenSettings }: { chars: number; onOpenSettings: (target: SettingsTarget) => void }) {
  const t = useT(); const locale = useLocale();
  const max = WORKBENCH_LIMITS.maxPromptChars;
  const ratio = Math.min(1, chars / max);
  const tone = ratio > 0.9 ? 'danger' : ratio > 0.7 ? 'warn' : 'ok';
  const radius = 7; const circumference = 2 * Math.PI * radius;
  const counts = { chars: chars.toLocaleString(locale), max: max.toLocaleString(locale) };
  return (
    <Popover label={t('meter.title')} role="dialog" placement="top-end" className="popover-meter" trigger={props => (
      <button {...props} className={`composer-meter tone-${tone}`} aria-label={t('meter.aria', counts)} title={t('meter.title')}>
        {ratio < 0.5 ? <IconGauge size={17} /> : (
          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
            <circle cx="9" cy="9" r={radius} className="meter-track" />
            <circle cx="9" cy="9" r={radius} className="meter-value" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - ratio)} />
          </svg>
        )}
      </button>
    )}>
      {() => (
        <div className="meter-panel">
          <div className="meter-row">
            <span className="meter-label">{t('meter.requestSize')}</span><span className="data-tag data-reported">{t('data.reported')}</span>
            <span className="meter-value-text">{t('meter.chars', counts)}</span>
            <span className="meter-bar"><span className={`tone-${tone}`} style={{ width: `${ratio * 100}%` }} /></span>
          </div>
          <div className="meter-row">
            <span className="meter-label">{t('meter.draftTokens')}</span><span className="data-tag data-estimated">{t('data.estimated')}</span>
            <span className="meter-value-text">{t('meter.tokens', { tokens: Math.ceil(chars / 4).toLocaleString(locale) })}</span>
            <span className="meter-note">{t('meter.tokensNote')}</span>
          </div>
          <div className="meter-row">
            <span className="meter-label">{t('meter.usage')}</span><span className="data-tag data-unavailable">{t('data.unavailable')}</span>
            <span className="meter-note">{t('meter.usageNote')}</span>
          </div>
          <div className="meter-row">
            <span className="meter-label">{t('meter.quota')}</span><span className="data-tag data-unavailable">{t('data.unavailable')}</span>
            <span className="meter-note">{t('meter.quotaNote')}</span>
          </div>
          <button className="link meter-link" onClick={() => onOpenSettings('usage')}>{t('meter.settings')}</button>
        </div>
      )}
    </Popover>
  );
}

function ProjectChip({ project }: { project: Project }) {
  const t = useT();
  const projects = useStore(s => s.projects);
  const ready = useStore(s => s.connection === 'ready');
  return (
    <Popover label={t('composer.project')} placement="top-start" trigger={props => (
      <button {...props} className="meta-chip" title={project.path}><IconFolder size={14} /><span className="ellipsis">{project.name}</span><IconChevronDown size={12} /></button>
    )}>
      {close => (
        <>
          <MenuLabel>{t('sidebar.projects')}</MenuLabel>
          {projects.map(item => (
            <MenuItem key={item.id} checked={item.id === project.id} unavailable={!ready} label={item.name} hint={item.path}
              onSelect={() => { void actions.selectProject(item.id); close(); }} />
          ))}
          <MenuSeparator />
          <MenuItem icon={<IconFolderPlus size={16} />} label={t('composer.addFolder')} unavailable={!ready} onSelect={() => { close(); void actions.addProject(); }} />
        </>
      )}
    </Popover>
  );
}

const Composer = forwardRef<ComposerHandle, { project: Project; disabled: boolean; docked: boolean; onOpenSettings: (target: SettingsTarget) => void }>(
  function Composer({ project, disabled, docked, onOpenSettings }, handle) {
    const t = useT(); const locale = useLocale();
    const saved = drafts.get(project.id);
    const [text, setText] = useState(saved?.text ?? '');
    const [goal, setGoal] = useState<string | null>(saved?.goal ?? null);
    const [goalDraft, setGoalDraft] = useState<string | null>(null);
    const [sending, setSending] = useState(false);
    const ref = useRef<HTMLTextAreaElement>(null);
    /** Set while the goal editor closes itself, so the blur that moving focus causes does not save it a second time. */
    const closingGoal = useRef(false);
    useImperativeHandle(handle, () => ({ focus: () => ref.current?.focus() }), []);
    useEffect(() => { if (focusOnMount) { focusOnMount = false; ref.current?.focus(); } }, []);
    useEffect(() => {
      if (sending) return;
      if (text || goal) drafts.set(project.id, { text, goal }); else drafts.delete(project.id);
    }, [project.id, text, goal, sending]);
    useLayoutEffect(() => {
      const element = ref.current;
      if (!element) return;
      const max = docked ? 220 : 280;
      element.style.height = 'auto';
      element.style.height = `${Math.min(max, element.scrollHeight)}px`;
      element.style.overflowY = element.scrollHeight > max ? 'auto' : 'hidden';
    }, [text, docked]);
    const composed = composePrompt(text.trim(), goal).length;
    const room = WORKBENCH_LIMITS.maxPromptChars - (goal ? goal.length + 8 : 0);
    // A goal added after the text can push the request past the limit; maxLength never shortens existing text.
    const tooLong = composed > WORKBENCH_LIMITS.maxPromptChars;
    const submit = async (): Promise<void> => {
      const prompt = text.trim();
      if (!prompt || sending || disabled || tooLong) return;
      setSending(true);
      // The first request swaps the centered composer for the docked one, which mounts while the request is recorded:
      // drop the draft first so it starts empty, and let whichever composer is mounted afterwards take focus.
      focusOnMount = true;
      drafts.delete(project.id);
      try { await actions.submitTask(project.id, prompt, goal); setText(''); setGoal(null); } finally { setSending(false); ref.current?.focus(); }
    };
    const closeGoal = (save: boolean, refocus: boolean): void => {
      const value = goalDraft?.trim() ?? '';
      if (save && value) setGoal(value.slice(0, MAX_GOAL));
      setGoalDraft(null);
      if (!refocus) return;
      closingGoal.current = true;
      try { ref.current?.focus(); } finally { closingGoal.current = false; }
    };
    return (
      <div className={`composer-wrap${docked ? ' is-docked' : ''}`}>
        <div className={`composer${disabled ? ' is-disabled' : ''}`} onMouseDown={event => {
          if (event.target === event.currentTarget) { event.preventDefault(); ref.current?.focus(); }
        }}>
          {(goal || goalDraft !== null) && (
            <div className="composer-chips">
              {goalDraft !== null ? (
                <label className="goal-input">
                  <IconTarget size={14} />
                  <input autoFocus value={goalDraft} maxLength={MAX_GOAL} placeholder={t('composer.goalPlaceholder')} aria-label={t('composer.goalLabel')}
                    onChange={event => setGoalDraft(event.target.value)} onBlur={() => { if (!closingGoal.current) closeGoal(true, false); }}
                    onKeyDown={event => {
                      if (event.key === 'Enter') { event.preventDefault(); closeGoal(true, true); }
                      if (event.key === 'Escape') { event.preventDefault(); closeGoal(false, true); }
                    }} />
                </label>
              ) : goal && (
                <span className="input-chip" title={goal}>
                  <IconTarget size={13} /><span className="input-chip-kind">{t('composer.goal')}</span><span className="ellipsis">{goal}</span>
                  <button onClick={() => { setGoal(null); ref.current?.focus(); }} aria-label={t('composer.removeGoal')}><IconX size={12} /></button>
                </span>
              )}
            </div>
          )}
          <textarea ref={ref} value={text} rows={docked ? 1 : 2} maxLength={room} disabled={disabled}
            placeholder={disabled ? t('composer.unavailable') : docked ? t('composer.reply') : t('composer.describe', { name: project.name })}
            onChange={event => setText(event.target.value)} aria-label={t('composer.requestLabel')}
            onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }} />
          <div className="composer-bar">
            <AddMenu hasGoal={goal !== null} onGoal={() => setGoalDraft(goal ?? '')} onOpenSettings={onOpenSettings} />
            <span className="tool-spacer" />
            <ContextMeter chars={composed} onOpenSettings={onOpenSettings} />
            <ModelPicker onOpenSettings={onOpenSettings} />
            <button className="send-btn" onClick={() => void submit()} disabled={!text.trim() || sending || disabled || tooLong} aria-label={t('composer.send')}
              title={t(tooLong ? 'composer.tooLongTitle' : 'composer.sendTitle')}>
              <IconSend size={16} />
            </button>
          </div>
        </div>
        {tooLong && (
          <div className="composer-error" role="alert">
            {t('composer.tooLong', { over: (composed - WORKBENCH_LIMITS.maxPromptChars).toLocaleString(locale), max: WORKBENCH_LIMITS.maxPromptChars.toLocaleString(locale) })}
          </div>
        )}
        <div className="composer-meta">
          <span className="meta-chip is-static" title={t('composer.thisComputerTitle')}><IconLaptop size={14} />{t('composer.thisComputer')}</span>
          <ProjectChip project={project} />
          <span className="meta-chip is-static is-gate" title={t('composer.agentUnavailableTitle')}>
            <IconLock size={13} />{t('composer.agentUnavailable')}</span>
        </div>
      </div>
    );
  });

function Exchange({ item }: { item: Submission }) {
  const t = useT(); const locale = useLocale();
  return (
    <div className="exchange">
      <div className="msg-user">
        <div className="bubble">
          {item.prompt}
          {item.goal && <span className="bubble-goal"><IconTarget size={12} />{item.goal}</span>}
        </div>
      </div>
      <article className="msg-system refusal" data-outcome={item.outcome}>
        <div className="msg-system-head">
          <span className="msg-system-mark"><IconShield size={14} /></span>
          <strong>{t('exchange.notStarted')}</strong>
          <span className="badge badge-soft mono">{item.code}</span>
          <span className="tool-spacer" />
          <time className="muted small">{relativeTime(item.at, locale)}</time>
        </div>
        <p className="msg-system-text">{t(item.outcome === 'refused' ? 'exchange.refused' : 'exchange.failed')}</p>
      </article>
    </div>
  );
}

const AVAILABLE: readonly (readonly [MessageKey, MessageKey])[] = [
  ['cap.controlPlane', 'cap.controlPlaneText'], ['cap.persistence', 'cap.persistenceText'], ['cap.projects', 'cap.projectsText'],
  ['cap.models', 'cap.modelsText'], ['cap.config', 'cap.configText'],
];
const LOCKED: readonly (readonly [MessageKey, string])[] = [
  ['cap.tasks', 'WORKER_ISOLATION_UNAVAILABLE'], ['cap.files', 'READ_ADAPTER_UNAVAILABLE'], ['cap.shell', 'SANDBOX_UNAVAILABLE'],
];

function Capabilities({ open = false }: { open?: boolean }) {
  const t = useT();
  return (
    <details className="capabilities" open={open}>
      <summary><IconShield size={14} />{t('cap.title')}<IconChevronDown size={13} className="capabilities-chev" /></summary>
      <div className="capabilities-grid">
        <div>
          <h3 className="section-label">{t('cap.working')}</h3>
          {AVAILABLE.map(([title, text]) => (
            <div key={title} className="capability"><IconCheck size={14} className="tone-text-ok" /><span><strong>{t(title)}</strong><span className="muted">{t(text)}</span></span></div>
          ))}
        </div>
        <div>
          <h3 className="section-label">{t('cap.locked')}</h3>
          {LOCKED.map(([title, code]) => (
            <div key={title} className="capability"><IconLock size={14} className="muted" /><span><strong>{t(title)}</strong><span className="mono muted">{code}</span></span></div>
          ))}
          <div className="capability"><IconAlert size={14} className="tone-text-warn" /><span className="muted">{t('cap.failClosed')}</span></div>
        </div>
      </div>
    </details>
  );
}

export const Workspace = forwardRef<ComposerHandle, { onOpenSettings: (target: SettingsTarget) => void }>(function Workspace({ onOpenSettings }, handle) {
  const t = useT();
  const projects = useStore(s => s.projects);
  const activeId = useStore(s => s.settings?.activeProjectId ?? null);
  const connection = useStore(s => s.connection);
  const loaded = useStore(s => s.loaded);
  const submissions = useStore(s => s.submissions);
  const project = projects.find(item => item.id === activeId);
  const mine = submissions.filter(item => item.projectId === activeId);
  const selected = useStore(s => s.tasks.find(task => task.id === s.selectedTaskId && task.projectId === activeId));
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [mine.length]);

  if (!loaded) {
    return (
      <section className="center"><div className="hero">
        <div className="hero-mark"><IconShield size={22} /></div>
        <h1 className="hero-title">{t(connection === 'unavailable' ? 'hero.unavailable' : 'hero.starting')}</h1>
        <p className="hero-sub">{t(connection === 'unavailable' ? 'hero.unavailableText' : 'hero.startingText')}</p>
      </div></section>
    );
  }
  if (!project) {
    return (
      <section className="center"><div className="hero">
        <div className="hero-mark"><IconFolder size={22} /></div>
        <h1 className="hero-title">{t('hero.addProject')}</h1>
        <p className="hero-sub">{t('hero.addProjectText')}</p>
        <button className="btn btn-primary btn-pill" onClick={() => void actions.addProject()} disabled={connection !== 'ready'}><IconPlus size={14} /> {t('composer.addFolder')}</button>
        <Capabilities />
      </div></section>
    );
  }
  if (selected) return <TaskDetail task={selected} />;
  if (mine.length === 0) {
    return (
      <section className="center is-empty">
        <div className="hero hero-compose">
          <h1 className="hero-title">{t('hero.prompt')}</h1>
          <Composer key={project.id} ref={handle} project={project} disabled={connection !== 'ready'} docked={false} onOpenSettings={onOpenSettings} />
          <Capabilities />
        </div>
      </section>
    );
  }
  return (
    <section className="center">
      <div className="scroll">
        <div className="column thread" aria-label={t('thread.label')}>
          {mine.map(item => <Exchange key={item.id} item={item} />)}
          <div ref={end} />
        </div>
      </div>
      <Composer key={project.id} ref={handle} project={project} disabled={connection !== 'ready'} docked onOpenSettings={onOpenSettings} />
    </section>
  );
});
