import { FAILSAFE_SCHEMA, load } from 'js-yaml';
import { PROJECT_SKILL_LIMITS, PROJECT_SKILL_ROOTS, SkillMetadataSchema, SkillPathSchema } from '@operation-agent/contracts';
import type { Project, ProjectSkillPreview, ProjectSkillPreviewRequest, ProjectSkills, ReadFailureCode, SetProjectSkill, SkillMetadata } from '@operation-agent/contracts';
import type { ToolRouter } from './router.js';

export interface SkillGrant { path: string; sha256: string }
export interface ProjectSkillStore {
  getProject(projectId: string): Project | null;
  listSkillGrants(projectId: string): SkillGrant[];
  setSkillGrant(projectId: string, path: string, sha256: string | null): void;
}
type ApprovedSkill = SkillGrant & SkillMetadata;
type SkillFile = { metadata: ApprovedSkill; body: string } | { failure: 'missing' } | { failure: 'unavailable'; code: ReadFailureCode };
type SkillLoadFailure = { code: 'CANCELLED' | 'CLEANUP_UNCONFIRMED' };

function parseSkill(content: string, path: string): { metadata: SkillMetadata; body: string } | null {
  const source = content.replace(/^\uFEFF/, '');
  const firstLine = /^---[\t ]*\r?\n/.exec(source);
  if (!firstLine) return null;
  const remaining = source.slice(firstLine[0].length);
  const end = /^---[\t ]*(?:\r?\n|$)/m.exec(remaining);
  if (!end || end.index > PROJECT_SKILL_LIMITS.maxFrontmatterChars) return null;
  let fields: unknown;
  try { fields = load(remaining.slice(0, end.index), { schema: FAILSAFE_SCHEMA, maxDepth: 12 }); }
  catch { return null; }
  const parsed = SkillMetadataSchema.safeParse(fields);
  if (!parsed.success || parsed.data.name !== path.split('/')[2]) return null;
  const body = remaining.slice(end.index + end[0].length).trim();
  return body ? { metadata: parsed.data, body } : null;
}

export class ProjectSkillService {
  constructor(private readonly store: ProjectSkillStore, private readonly tools: ToolRouter) {}

  private async read(projectId: string, path: string, correlation?: { taskId: string; toolCallId: string; signal?: AbortSignal }): Promise<SkillFile> {
    if (!SkillPathSchema.safeParse(path).success) return { failure: 'missing' };
    const result = await this.tools.readFile({ projectId, ...correlation, args: { path, maxBytes: PROJECT_SKILL_LIMITS.maxFileBytes } });
    if (result.status === 'failed') return { failure: 'unavailable', code: result.code };
    if (result.status !== 'ok' || result.truncated || result.path !== path) return { failure: 'missing' };
    const skill = parseSkill(result.content, path);
    return skill ? { metadata: { ...skill.metadata, path, sha256: result.sha256 }, body: skill.body } : { failure: 'missing' };
  }

  async list(projectId: string): Promise<ProjectSkills> {
    if (!this.store.getProject(projectId)) throw new Error('NOT_FOUND');
    if (!this.tools.readAvailable) throw new Error('READ_ADAPTER_UNAVAILABLE');
    const roots = await Promise.all(PROJECT_SKILL_ROOTS.map(path => this.tools.listDirectory({ projectId, args: { path, depth: 2 } })));
    if (!this.store.getProject(projectId)) throw new Error('NOT_FOUND');
    const grants = new Map(this.store.listSkillGrants(projectId).map(grant => [grant.path, grant.sha256]));
    const discovered = new Set<string>();
    let partial = false;
    for (const result of roots) {
      if (result.status !== 'ok') {
        partial ||= result.status === 'failed' || result.code !== 'NOT_FOUND';
        continue;
      }
      partial ||= result.truncated || result.unlisted.length > 0;
      for (const entry of result.entries) {
        if (entry.type === 'file' && SkillPathSchema.safeParse(entry.path).success && !grants.has(entry.path)) discovered.add(entry.path);
      }
    }
    const paths = [...grants.keys(), ...Array.from(discovered).slice(0, PROJECT_SKILL_LIMITS.maxDiscovered)];
    partial ||= discovered.size > PROJECT_SKILL_LIMITS.maxDiscovered;
    const results = await Promise.all(paths.map(path => this.read(projectId, path)));
    if (!this.store.getProject(projectId)) throw new Error('NOT_FOUND');
    const current = new Map(this.store.listSkillGrants(projectId).map(grant => [grant.path, grant.sha256]));
    const skills: ProjectSkills['skills'] = [];
    for (const [index, file] of results.entries()) {
      const path = paths[index]!;
      const granted = current.get(path);
      if ('failure' in file) {
        partial ||= file.failure === 'unavailable';
        if (granted !== undefined) skills.push({ path, state: 'missing' });
      } else {
        const { metadata } = file;
        skills.push({ ...metadata, state: granted === undefined ? 'available' : granted === metadata.sha256 ? 'enabled' : 'changed' });
      }
    }
    return { skills, partial };
  }

  async set(input: SetProjectSkill): Promise<void> {
    if (!this.store.getProject(input.projectId)) throw new Error('NOT_FOUND');
    if (!input.enabled) {
      this.store.setSkillGrant(input.projectId, input.path, null);
      return;
    }
    const previous = this.hash(input.projectId, input.path);
    await this.preview(input);
    const current = this.hash(input.projectId, input.path);
    if (current === input.sha256) return;
    if (current !== previous) throw new Error('RECORD_CONFLICT');
    this.store.setSkillGrant(input.projectId, input.path, input.sha256);
  }

  async preview({ projectId, path, sha256 }: ProjectSkillPreviewRequest): Promise<ProjectSkillPreview> {
    if (!this.store.getProject(projectId)) throw new Error('NOT_FOUND');
    if (!this.tools.readAvailable) throw new Error('READ_ADAPTER_UNAVAILABLE');
    const file = await this.read(projectId, path);
    if (!this.store.getProject(projectId)) throw new Error('NOT_FOUND');
    if ('failure' in file && file.failure === 'unavailable') throw new Error('SERVICE_UNAVAILABLE');
    if ('failure' in file || file.metadata.sha256 !== sha256) throw new Error('RECORD_CONFLICT');
    return { body: file.body };
  }

  private hash(projectId: string, path: string): string | undefined {
    return this.store.listSkillGrants(projectId).find(grant => grant.path === path)?.sha256;
  }

  async snapshot(projectId: string): Promise<ApprovedSkill[]> {
    if (!this.tools.readAvailable) return [];
    const grants = this.store.listSkillGrants(projectId);
    const files = await Promise.all(grants.map(grant => this.read(projectId, grant.path)));
    const current = new Map(this.store.listSkillGrants(projectId).map(grant => [grant.path, grant.sha256]));
    return files.flatMap((file, index) => 'metadata' in file && file.metadata.sha256 === grants[index]!.sha256 &&
      file.metadata.sha256 === current.get(file.metadata.path) ? [file.metadata] : []);
  }

  async load(projectId: string, approved: SkillGrant, correlation: { taskId: string; toolCallId: string; signal?: AbortSignal }): Promise<string | SkillLoadFailure | null> {
    if (this.hash(projectId, approved.path) !== approved.sha256) return null;
    const file = await this.read(projectId, approved.path, correlation);
    if ('failure' in file && file.failure === 'unavailable' && (file.code === 'CANCELLED' || file.code === 'CLEANUP_UNCONFIRMED')) {
      return { code: file.code };
    }
    if ('failure' in file || file.metadata.sha256 !== approved.sha256 || this.hash(projectId, approved.path) !== approved.sha256) return null;
    return file.body;
  }
}
