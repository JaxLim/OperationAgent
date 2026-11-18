import { z } from 'zod';

export const PROJECT_SKILL_LIMITS = Object.freeze({
  maxEnabled: 8, maxDiscovered: 16, maxFileBytes: 24 * 1024, maxFrontmatterChars: 8 * 1024,
  maxNameChars: 64, maxDescriptionChars: 1024, scanTimeoutMs: 45_000,
});
export const PROJECT_SKILL_ROOTS = Object.freeze(['.operationagent/skills', '.agents/skills', '.claude/skills', '.opencode/skills'] as const);
const namePattern = '[a-z0-9]+(?:-[a-z0-9]+)*';
export const SkillNameSchema = z.string().max(PROJECT_SKILL_LIMITS.maxNameChars).regex(new RegExp(`^${namePattern}$(?![\\s\\S])`));
export const SkillPathSchema = z.string().max(100).regex(
  new RegExp(`^\\.(?:operationagent|agents|claude|opencode)/skills/${namePattern}/SKILL\\.md$(?![\\s\\S])`))
  .refine(path => SkillNameSchema.safeParse(path.split('/')[2]).success);
export const SkillHashSchema = z.string().regex(/^[a-f0-9]{64}$/).length(64);
export const SkillMetadataSchema = z.object({
  name: SkillNameSchema,
  description: z.string().trim().min(1).max(PROJECT_SKILL_LIMITS.maxDescriptionChars)
    .transform(text => text.replace(/\s+/gu, ' ')).refine(text => !/[\p{Cc}\p{Cf}]/u.test(text)),
});
export type SkillMetadata = z.infer<typeof SkillMetadataSchema>;
const SkillViewSchema = z.union([
  z.strictObject({ path: SkillPathSchema, state: z.enum(['available', 'enabled', 'changed']), sha256: SkillHashSchema, ...SkillMetadataSchema.shape }),
  z.strictObject({ path: SkillPathSchema, state: z.literal('missing') }),
]);
export const ProjectSkillsSchema = z.strictObject({
  skills: z.array(SkillViewSchema).max(PROJECT_SKILL_LIMITS.maxEnabled + PROJECT_SKILL_LIMITS.maxDiscovered),
  partial: z.boolean(),
});
export type ProjectSkills = z.infer<typeof ProjectSkillsSchema>;
export const SetProjectSkillSchema = z.discriminatedUnion('enabled', [
  z.strictObject({ projectId: z.uuid(), path: SkillPathSchema, enabled: z.literal(true), sha256: SkillHashSchema }),
  z.strictObject({ projectId: z.uuid(), path: SkillPathSchema, enabled: z.literal(false) }),
]);
export type SetProjectSkill = z.infer<typeof SetProjectSkillSchema>;
export const ProjectSkillPreviewRequestSchema = z.strictObject({ projectId: z.uuid(), path: SkillPathSchema, sha256: SkillHashSchema });
export type ProjectSkillPreviewRequest = z.infer<typeof ProjectSkillPreviewRequestSchema>;
export const ProjectSkillPreviewSchema = z.strictObject({ body: z.string().max(PROJECT_SKILL_LIMITS.maxFileBytes) });
export type ProjectSkillPreview = z.infer<typeof ProjectSkillPreviewSchema>;
export const LoadSkillArgsSchema = z.strictObject({ path: SkillPathSchema });

export const GITHUB_SKILL_LIMITS = Object.freeze({ maxEntries: 150, maxSources: 8, timeoutMs: 9000, maxPathChars: 360 });
export const GITHUB_SKILL_SOURCES = Object.freeze([
  { label: 'Anthropic', repo: 'anthropics/skills', subdirectory: 'skills' },
  { label: 'OpenAI', repo: 'openai/skills', subdirectory: 'skills' },
  { label: 'Matt Pocock', repo: 'mattpocock/skills', subdirectory: '' },
] as const);
const GitHubRepoSchema = z.string().trim().max(140)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/)
  .transform(repo => repo.toLowerCase());
const catalogPath = z.string().max(GITHUB_SKILL_LIMITS.maxPathChars)
  .refine(path => path.split('/').every(part => !!part && part !== '.' && part !== '..' && !/[\\\p{Cc}\p{Cf}]/u.test(part)));
export const GitHubSkillSourceSchema = z.strictObject({ repo: GitHubRepoSchema, subdirectory: z.union([z.literal(''), catalogPath]) });
export type GitHubSkillSource = z.infer<typeof GitHubSkillSourceSchema>;
const GitObjectHashSchema = z.string().length(40).regex(/^[a-f0-9]{40}$/);
export const GitHubSkillEntrySchema = z.strictObject({
  name: z.string().min(1).max(128), path: catalogPath.refine(path => path === 'SKILL.md' || path.endsWith('/SKILL.md')), sha: GitObjectHashSchema,
});
export type GitHubSkillEntry = z.infer<typeof GitHubSkillEntrySchema>;
export const GitHubSkillCatalogSchema = z.strictObject({ skills: z.array(GitHubSkillEntrySchema).max(GITHUB_SKILL_LIMITS.maxEntries), partial: z.boolean() });
export type GitHubSkillCatalog = z.infer<typeof GitHubSkillCatalogSchema>;
export const GitHubSkillPreviewRequestSchema = z.strictObject({ ...GitHubSkillSourceSchema.shape,
  path: GitHubSkillEntrySchema.shape.path, sha: GitObjectHashSchema });
export type GitHubSkillPreviewRequest = z.infer<typeof GitHubSkillPreviewRequestSchema>;
