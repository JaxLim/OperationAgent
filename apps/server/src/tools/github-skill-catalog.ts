import { createHash } from 'node:crypto';
import { GITHUB_SKILL_LIMITS, GitHubSkillEntrySchema, GitHubSkillPreviewRequestSchema, GitHubSkillSourceSchema, PROJECT_SKILL_LIMITS } from '@operation-agent/contracts';
import type { GitHubSkillCatalog, GitHubSkillEntry, GitHubSkillPreviewRequest, GitHubSkillSource, ProjectSkillPreview } from '@operation-agent/contracts';
import { readBounded } from '../models/providers.js';

const API = 'https://api.github.com';
const CACHE_MS = 5 * 60_000;
const MAX_TREE_BYTES = 4 * 1024 * 1024;
const MAX_PREVIEW_BYTES = PROJECT_SKILL_LIMITS.maxFileBytes;
const sourceKey = (source: GitHubSkillSource) => JSON.stringify([source.repo, source.subdirectory]);
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export class GitHubSkillCatalogService {
  private readonly scans = new Map<string, { expires: number; value: GitHubSkillCatalog }>();
  private readonly pending = new Map<string, Promise<GitHubSkillCatalog>>();
  constructor(private readonly request: typeof fetch = fetch) {}

  private async get(repo: string, endpoint: string, limit: number): Promise<unknown> {
    try {
      const response = await this.request(`${API}/repos/${repo}/git/${endpoint}`, {
        method: 'GET', redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(GITHUB_SKILL_LIMITS.timeoutMs),
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'OperationAgent-SkillCatalog', 'x-github-api-version': '2026-03-10' },
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 404) throw new Error('NOT_FOUND');
        if (response.status === 403 || response.status === 429) throw new Error('RATE_LIMITED');
        throw new Error('SERVICE_UNAVAILABLE');
      }
      const text = await readBounded(response, limit);
      if (text === null) throw new Error('LIMIT_EXCEEDED');
      return JSON.parse(text) as unknown;
    } catch (error) {
      if (error instanceof Error && ['NOT_FOUND', 'RATE_LIMITED', 'LIMIT_EXCEEDED'].includes(error.message)) throw error;
      throw new Error('SERVICE_UNAVAILABLE', { cause: error });
    }
  }

  async list(input: GitHubSkillSource): Promise<GitHubSkillCatalog> {
    const source = GitHubSkillSourceSchema.parse(input);
    const key = sourceKey(source);
    const cached = this.scans.get(key);
    if (cached && cached.expires > Date.now()) return cached.value;
    const pending = this.pending.get(key);
    if (pending) return pending;
    if (this.pending.size >= 3) throw new Error('RATE_LIMITED');
    const scan = this.scan(source).then(value => {
      this.scans.delete(key);
      if (this.scans.size >= GITHUB_SKILL_LIMITS.maxSources) this.scans.delete(this.scans.keys().next().value!);
      this.scans.set(key, { expires: Date.now() + CACHE_MS, value });
      return value;
    }).finally(() => { this.pending.delete(key); });
    this.pending.set(key, scan);
    return scan;
  }

  private async scan(source: GitHubSkillSource): Promise<GitHubSkillCatalog> {
    const reply = await this.get(source.repo, 'trees/HEAD?recursive=1', MAX_TREE_BYTES);
    if (!object(reply) || !Array.isArray(reply.tree) || typeof reply.truncated !== 'boolean') throw new Error('SERVICE_UNAVAILABLE');
    const skills: GitHubSkillEntry[] = [];
    let partial = reply.truncated;
    const prefix = source.subdirectory ? source.subdirectory + '/' : '';
    for (const entry of reply.tree as unknown[]) {
      if (!object(entry) || entry.type !== 'blob' || (entry.mode !== '100644' && entry.mode !== '100755') ||
          typeof entry.path !== 'string' || !entry.path.startsWith(prefix) ||
          typeof entry.size !== 'number' || entry.size <= 0 || entry.size > MAX_PREVIEW_BYTES) continue;
      const parts = entry.path.split('/');
      if (parts.at(-1) !== 'SKILL.md') continue;
      if (skills.length >= GITHUB_SKILL_LIMITS.maxEntries) { partial = true; break; }
      const skill = GitHubSkillEntrySchema.safeParse({ name: parts.at(-2) ?? source.repo.split('/')[1], path: entry.path, sha: entry.sha });
      if (skill.success) skills.push(skill.data);
    }
    return { skills, partial };
  }

  async preview(input: GitHubSkillPreviewRequest): Promise<ProjectSkillPreview> {
    const source = GitHubSkillPreviewRequestSchema.parse(input);
    const cached = this.scans.get(sourceKey(source));
    if (!cached || cached.expires <= Date.now() || !cached.value.skills.some(skill => skill.path === source.path && skill.sha === source.sha)) {
      throw new Error('RECORD_CONFLICT');
    }
    const reply = await this.get(source.repo, `blobs/${source.sha}`, MAX_PREVIEW_BYTES * 2);
    if (!object(reply) || reply.encoding !== 'base64' || reply.sha !== source.sha || typeof reply.content !== 'string') throw new Error('SERVICE_UNAVAILABLE');
    const bytes = Buffer.from(reply.content, 'base64');
    if (bytes.length === 0 || bytes.length > MAX_PREVIEW_BYTES ||
      createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') !== source.sha) throw new Error('SERVICE_UNAVAILABLE');
    let body: string;
    try { body = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch (error) { throw new Error('SERVICE_UNAVAILABLE', { cause: error }); }
    if (body.includes('\0')) throw new Error('SERVICE_UNAVAILABLE');
    return { body };
  }
}
