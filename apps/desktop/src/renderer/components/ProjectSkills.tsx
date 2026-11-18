import { useEffect, useState } from 'react';
import { GITHUB_SKILL_LIMITS, GITHUB_SKILL_SOURCES, GitHubSkillSourceSchema, PROJECT_SKILL_ROOTS } from '@operation-agent/contracts';
import type { GitHubSkillCatalog, GitHubSkillEntry, GitHubSkillSource, Project, ProjectSkills as SkillsView } from '@operation-agent/contracts';
import { useT } from '../locale';
import { errorCode, useStore } from '../state';
import { IconCheck, IconFolder, IconPuzzle, IconRetry, IconSearch } from './Icons';
import { Markdown } from './Markdown';
import { Segmented } from './Modal';

type Skill = SkillsView['skills'][number];
const SOURCES = [
  { root: PROJECT_SKILL_ROOTS[0], label: 'OperationAgent' },
  { root: PROJECT_SKILL_ROOTS[1], label: 'Agent Skills' },
  { root: PROJECT_SKILL_ROOTS[2], label: 'Claude' },
  { root: PROJECT_SKILL_ROOTS[3], label: 'OpenCode' },
] as const;
const skillName = (skill: Skill): string => skill.state === 'missing' ? skill.path.split('/')[2]! : skill.name;

export function ProjectSkills({ initialTab = 'project' }: { initialTab?: 'project' | 'github' }) {
  const t = useT();
  const project = useStore(s => s.projects.find(item => item.id === s.settings?.activeProjectId));
  const [tab, setTab] = useState<'project' | 'github'>(initialTab);
  const [sources, setSources] = useState<GitHubSkillSource[]>([]);
  return <>
    <div className="skill-toolbar skill-tabs"><Segmented value={tab} onChange={setTab} options={[
      { value: 'project', label: t('skills.projectTab') }, { value: 'github', label: t('skills.githubTab') },
    ]} /></div>
    {tab === 'github' ? <GitHubCatalog sources={sources} onAdd={source => setSources(current => [...current, source])} />
      : project ? <ProjectSkillList key={project.id} project={project} /> : <p className="muted">{t('skills.selectProject')}</p>}
  </>;
}

function ProjectSkillList({ project }: { project: Project }) {
  const t = useT();
  const ready = useStore(s => s.connection === 'ready');
  const [view, setView] = useState<SkillsView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [source, setSource] = useState('');
  const [selectedPath, select] = useState('');
  const run = async (operation: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try { await operation(); }
    catch (error) { setError(errorCode(error)); }
    finally { setBusy(false); }
  };
  const refresh = async (): Promise<void> => { setView(await window.operationAgent.listProjectSkills({ id: project.id })); };
  const toggle = async (skill: Skill, enabled: boolean): Promise<void> => {
    const { path } = skill;
    if (enabled) {
      if (skill.state === 'missing') return;
      await window.operationAgent.setProjectSkill({ projectId: project.id, path, enabled: true, sha256: skill.sha256 });
    } else {
      await window.operationAgent.setProjectSkill({ projectId: project.id, path, enabled: false });
    }
    setView(current => current && { ...current, skills: current.skills.flatMap(item => {
      if (item.path !== path) return [item];
      if (item.state === 'missing') return [];
      return [{ ...item, state: enabled ? 'enabled' : 'available' }];
    }) });
  };

  const skills = view?.skills ?? [];
  const q = query.trim().toLowerCase();
  const results = skills.filter(skill => (!source || skill.path.startsWith(source + '/')) &&
    `${skill.path} ${skill.state === 'missing' ? '' : skill.description}`.toLowerCase().includes(q));
  const selected = results.find(skill => skill.path === selectedPath) ?? results[0];
  return <div className="skill-library" aria-busy={busy}>
    <div className="skill-toolbar">
      <span className="skill-project" title={project.path}><IconFolder size={16} /> <strong>{project.name}</strong></span>
      <button type="button" className="btn btn-pill btn-xs" disabled={busy || !ready}
        onClick={() => void run(refresh)} data-action="scan-skills"><IconRetry size={14} />{t(view ? 'skills.refresh' : 'skills.scan')}</button>
    </div>
    {error && <p className="field-error" role="alert">{t(error === 'RECORD_CONFLICT' ? 'skills.conflict' : 'skills.error', { code: error })}</p>}
    {view?.partial && <p className="muted small">{t('skills.partial')}</p>}
    {!view ? <div className="feature-empty">
      <span className="feature-empty-icon"><IconPuzzle size={20} /></span>
      <span>{t(busy ? 'skills.scanning' : 'skills.scanHint')}</span>
    </div> : <>
      <label className="settings-search skill-search">
        <IconSearch size={15} /><input value={query} onChange={event => setQuery(event.target.value)} maxLength={128}
          placeholder={t('skills.search')} aria-label={t('skills.search')} />
      </label>
      <div className="library-filters" aria-label={t('skills.sources')}>
        <button className="library-filter" aria-pressed={!source} onClick={() => setSource('')}>{t('skills.allSources')} <span>{skills.length}</span></button>
        {SOURCES.map(item => <button className="library-filter" key={item.root} aria-pressed={source === item.root}
          title={item.root} onClick={() => setSource(item.root)}>{item.label} <span>{skills.filter(skill => skill.path.startsWith(item.root + '/')).length}</span></button>)}
      </div>
      {selected ? <div className="skill-workspace">
        <div className="skill-index" aria-label={t('section.skills.title')}>
          {results.map(skill => <button type="button" key={skill.path} className="skill-index-row" aria-pressed={selected.path === skill.path}
            onClick={() => select(skill.path)}>
            <span className="skill-index-name"><strong>{skillName(skill)}</strong>{skill.state === 'enabled' && <IconCheck size={13} />}</span>
            <span className="muted small">{SOURCES.find(item => skill.path.startsWith(item.root + '/'))?.label}</span>
          </button>)}
        </div>
        <SkillDetail key={selected.state === 'missing' ? selected.path : selected.path + selected.sha256}
          projectId={project.id} skill={selected} canEdit={ready && !busy} onToggle={enabled => void run(() => toggle(selected, enabled))} />
      </div> : <div className="feature-empty"><span>{t(skills.length ? 'skills.noMatch' : 'skills.empty')}</span></div>}
    </>}
  </div>;
}

function SkillDetail({ projectId, skill, canEdit, onToggle }: {
  projectId: string; skill: Skill; canEdit: boolean; onToggle: (enabled: boolean) => void;
}) {
  const t = useT();
  const ready = useStore(s => s.connection === 'ready');
  const [format, setFormat] = useState<'preview' | 'source'>('preview');
  const [body, setBody] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const { path } = skill;
  const sha256 = skill.state === 'missing' ? null : skill.sha256;
  useEffect(() => {
    if (!sha256 || !ready) return;
    let current = true;
    setFailure(null);
    void window.operationAgent.previewProjectSkill({ projectId, path, sha256 }).then(
      ({ body }) => { if (current) setBody(body); },
      error => { if (current) { setFailure(errorCode(error)); setBody(null); } });
    return () => { current = false; };
  }, [projectId, path, sha256, ready]);

  return <section className="skill-detail" data-skill-state={skill.state}>
    <div className="skill-detail-heading">
      <div><h4>{skillName(skill)}</h4><p className="mono small muted skill-path">{path}</p></div>
      {skill.state !== 'missing' && skill.state !== 'enabled' && <button type="button" className="btn btn-pill btn-xs btn-accent"
        disabled={!canEdit || body === null} onClick={() => onToggle(true)} data-action="enable-skill">
        {t(skill.state === 'changed' ? 'skills.reauthorize' : 'skills.enable')}</button>}
      {skill.state !== 'available' && <button type="button" className="btn btn-pill btn-xs"
        disabled={!canEdit} onClick={() => onToggle(false)} data-action="disable-skill">{t('skills.disable')}</button>}
    </div>
    {skill.state === 'missing' ? <p className="muted">{t('skills.missing')}</p> : <>
      <p className="skill-description">{skill.description}</p>
      {skill.state === 'changed' && <p className="muted small">{t('skills.changed')}</p>}
      <div className="skill-preview-header">
        <strong>{t('skills.instructions')}</strong>
        <Segmented value={format} options={[{ value: 'preview', label: t('skills.preview') }, { value: 'source', label: t('skills.sourceText') }]}
          disabled={body === null} onChange={setFormat} />
      </div>
      {failure ? <p className="field-error" role="alert">{t(failure === 'RECORD_CONFLICT' ? 'skills.conflict' : 'skills.error', { code: failure })}</p>
        : body === null ? <p className="muted small">{t(ready ? 'skills.loadingPreview' : 'settings.waiting')}</p> :
          <div className="skill-preview" data-skill-preview={format}>{format === 'source' ? <pre>{body}</pre> : <Markdown text={body} />}</div>}
      {skill.state !== 'enabled' && <p className="muted small">{t('skills.hint')}</p>}
    </>}
  </section>;
}

function GitHubCatalog({ sources, onAdd }: { sources: GitHubSkillSource[]; onAdd: (source: GitHubSkillSource) => void }) {
  const t = useT();
  const ready = useStore(s => s.connection === 'ready');
  const [repo, setRepo] = useState('');
  const [subdirectory, setSubdirectory] = useState('');
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<GitHubSkillSource | null>(null);
  const [view, setView] = useState<GitHubSkillCatalog | null>(null);
  const [query, setQuery] = useState('');
  const [selectedPath, select] = useState('');
  const curated = GITHUB_SKILL_SOURCES.map(item => ({ ...item }));
  const cards = [...curated, ...sources.map(item => ({ ...item, label: item.repo }))];
  const scan = async (next: GitHubSkillSource, add = false): Promise<void> => {
    setBusy(true); setError(null); setSource(next); setView(null); select('');
    try {
      const catalog = await window.operationAgent.listGitHubSkills(next);
      setView(catalog);
      if (add) { onAdd(next); setAdding(false); setRepo(''); setSubdirectory(''); }
    } catch (error) { setError(errorCode(error)); }
    finally { setBusy(false); }
  };
  const submit = (): void => {
    const parsed = GitHubSkillSourceSchema.safeParse({ repo, subdirectory: subdirectory.trim() });
    if (!parsed.success) { setError('VALIDATION_ERROR'); return; }
    const duplicate = cards.some(item => item.repo === parsed.data.repo && item.subdirectory === parsed.data.subdirectory);
    void scan(parsed.data, !duplicate);
    if (duplicate) setAdding(false);
  };
  const filter = query.trim().toLowerCase();
  const entries = view?.skills.filter(item => item.path.toLowerCase().includes(filter) || item.name.toLowerCase().includes(filter)) ?? [];
  const selected = entries.find(item => item.path === selectedPath) ?? entries[0];
  return <div className="skill-library" aria-busy={busy}>
    <div className="skill-toolbar">
      <span className="muted small">{t('catalog.lead')}</span>
      <button type="button" className="btn btn-pill btn-xs" disabled={busy || sources.length >= GITHUB_SKILL_LIMITS.maxSources - curated.length}
        onClick={() => setAdding(value => !value)}>{t('catalog.add')}</button>
    </div>
    {adding && <form className="skill-source-form" onSubmit={event => { event.preventDefault(); submit(); }}>
      <label className="field"><span className="field-label">{t('catalog.repo')}</span><input className="text-input" value={repo}
        placeholder="owner/repo" maxLength={140} onChange={event => setRepo(event.target.value)} /></label>
      <label className="field"><span className="field-label">{t('catalog.directory')}</span><input className="text-input" value={subdirectory}
        placeholder="skills" maxLength={GITHUB_SKILL_LIMITS.maxPathChars} onChange={event => setSubdirectory(event.target.value)} /></label>
      <button type="submit" className="btn btn-pill btn-xs btn-accent" disabled={!ready || busy || !repo.trim()}>{t('catalog.browse')}</button>
    </form>}
    <div className="integration-grid">
      {cards.map(card => <button className="integration-entry" type="button" key={card.repo + ':' + card.subdirectory}
        aria-pressed={source?.repo === card.repo && source.subdirectory === card.subdirectory}
        data-catalog-source={card.repo} disabled={!ready || busy} onClick={() => void scan({ repo: card.repo, subdirectory: card.subdirectory })}>
        <span className="feature-empty-icon"><IconFolder size={16} /></span>
        <span><strong>{card.label}</strong><span className="mono muted small">{card.repo}</span></span>
      </button>)}
    </div>
    {error && <p className="field-error" role="alert">{t(error === 'VALIDATION_ERROR' ? 'catalog.invalid' : 'skills.error', { code: error })}</p>}
    {busy && <p className="muted small">{t('catalog.loading')}</p>}
    {view && source && <>
      <label className="settings-search skill-search"><IconSearch size={15} /><input value={query} maxLength={128}
        onChange={event => setQuery(event.target.value)} placeholder={t('skills.search')} aria-label={t('skills.search')} /></label>
      {view.partial && <p className="muted small">{t('skills.partial')}</p>}
      {selected ? <div className="skill-workspace">
        <div className="skill-index" aria-label={t('skills.githubTab')}>
          {entries.map(item => <button type="button" key={item.path} className="skill-index-row" aria-pressed={item.path === selected.path}
            onClick={() => select(item.path)}><strong>{item.name}</strong></button>)}
        </div>
        <GitHubSkillDetail key={source.repo + selected.path + selected.sha} source={source} skill={selected}
          onRescan={() => void scan(source)} />
      </div> : <div className="feature-empty"><span>{t(view.skills.length ? 'skills.noMatch' : 'catalog.empty')}</span></div>}
    </>}
  </div>;
}

function GitHubSkillDetail({ source, skill, onRescan }: { source: GitHubSkillSource; skill: GitHubSkillEntry; onRescan: () => void }) {
  const t = useT();
  const [state, setState] = useState<{ body: string } | { error: string } | null>(null);
  const { repo, subdirectory } = source;
  const { path, sha } = skill;
  useEffect(() => {
    let current = true;
    void window.operationAgent.previewGitHubSkill({ repo, subdirectory, path, sha }).then(
      value => { if (current) setState(value); }, error => { if (current) setState({ error: errorCode(error) }); });
    return () => { current = false; };
  }, [repo, subdirectory, path, sha]);
  return <section className="skill-detail">
    <div className="skill-detail-heading"><div><h4>{skill.name}</h4><p className="mono small muted skill-path">{repo} · {path}</p></div></div>
    {!state ? <p className="muted small">{t('skills.loadingPreview')}</p> : 'body' in state ?
      <div className="skill-preview" data-catalog-preview><Markdown text={state.body} /></div> :
      <p className="field-error" role="alert">{t('skills.error', { code: state.error })}
        {state.error === 'RECORD_CONFLICT' && <button className="btn btn-xs" onClick={onRescan}>{t('catalog.browse')}</button>}
      </p>}
  </section>;
}
