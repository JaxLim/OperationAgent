import { z } from 'zod';
import { PROTOCOL_VERSION } from '../version/index.js';
import { ServiceTreeIdentitySchema } from '../ipc/identity.js';
import { ModelProviderSchema, SearchProviderSchema } from './providers.js';

// Product-shell domain owned by Express: preferences, registered project metadata and run history.
// A project is only a remembered folder path. P1 never reads, lists or writes workspace files.

export const WORKBENCH_LIMITS = Object.freeze({ maxProjects: 50, maxRuns: 50, maxPromptChars: 8_000, maxPathChars: 1_024, maxNameChars: 80 });

/** `system` follows the operating system's display language. */
export const LANGUAGES = ['system', 'en', 'zh-CN', 'ja'] as const;
export const LanguageSchema = z.enum(LANGUAGES);
export type Language = z.infer<typeof LanguageSchema>;
/** Named palettes; each has a light and a dark variant, chosen separately for light and dark mode. */
export const THEME_IDS = ['operation', 'nord', 'solarized', 'rose-pine', 'tokyo-night', 'one', 'github', 'gruvbox'] as const;
export const ThemeIdSchema = z.enum(THEME_IDS);
export type ThemeId = z.infer<typeof ThemeIdSchema>;
interface Canvas { readonly bg: string; readonly text: string }
/** Canvas and text colour per variant. Main paints the native caption buttons with these, the Renderer its tokens. */
export const THEME_CANVAS: Readonly<Record<ThemeId, { readonly light: Canvas; readonly dark: Canvas }>> = Object.freeze({
  operation: { light: { bg: '#fcfcfb', text: '#1b1b1f' }, dark: { bg: '#1c1c1e', text: '#ececef' } },
  nord: { light: { bg: '#eceff4', text: '#2e3440' }, dark: { bg: '#2e3440', text: '#eceff4' } },
  solarized: { light: { bg: '#fdf6e3', text: '#586e75' }, dark: { bg: '#002b36', text: '#93a1a1' } },
  'rose-pine': { light: { bg: '#faf4ed', text: '#575279' }, dark: { bg: '#191724', text: '#e0def4' } },
  'tokyo-night': { light: { bg: '#e1e2e7', text: '#3760bf' }, dark: { bg: '#1a1b26', text: '#c0caf5' } },
  one: { light: { bg: '#fafafa', text: '#383a42' }, dark: { bg: '#282c34', text: '#abb2bf' } },
  github: { light: { bg: '#ffffff', text: '#1f2328' }, dark: { bg: '#0d1117', text: '#e6edf3' } },
  gruvbox: { light: { bg: '#fbf1c7', text: '#3c3836' }, dark: { bg: '#282828', text: '#ebdbb2' } },
});
/** default: the chosen provider; any: whichever configured provider fits; off: no web search. */
export const WEB_SEARCH_MODES = ['default', 'any', 'off'] as const;

export const WorkbenchSettingsSchema = z.strictObject({
  theme: z.enum(['system', 'light', 'dark']),
  lightTheme: ThemeIdSchema,
  darkTheme: ThemeIdSchema,
  language: LanguageSchema,
  density: z.enum(['comfortable', 'compact']),
  contextPanel: z.boolean(),
  // ADR-009: default 5 s, allowed 5–30 s; out-of-range values are rejected, never clamped.
  stopGraceMs: z.number().int().min(5_000).max(30_000),
  activeProjectId: z.uuid().nullable(),
  /** Which linked provider new chats would use once the agent loop exists. */
  defaultProvider: ModelProviderSchema,
  // Off by default: a search sends the query to a third party, so it is opted into, never assumed.
  webSearchMode: z.enum(WEB_SEARCH_MODES),
  webSearchProvider: SearchProviderSchema,
});
export type WorkbenchSettings = z.infer<typeof WorkbenchSettingsSchema>;
export const DEFAULT_WORKBENCH_SETTINGS: WorkbenchSettings = Object.freeze({
  theme: 'system', lightTheme: 'operation', darkTheme: 'operation', language: 'system', density: 'comfortable', contextPanel: true,
  stopGraceMs: 5_000, activeProjectId: null, defaultProvider: 'anthropic', webSearchMode: 'off', webSearchProvider: 'exa',
});
/**
 * Settings saved by an older build lack newer fields: those take their defaults while every stored value is still
 * validated. Anything unknown or invalid falls back to the defaults as a whole.
 */
export function readStoredSettings(value: unknown): WorkbenchSettings {
  const merged = value !== null && typeof value === 'object' && !Array.isArray(value) ? { ...DEFAULT_WORKBENCH_SETTINGS, ...value } : value;
  const parsed = WorkbenchSettingsSchema.safeParse(merged);
  return parsed.success ? parsed.data : { ...DEFAULT_WORKBENCH_SETTINGS };
}

const windowsAbsolute = /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/;
export const ProjectPathSchema = z.string().min(1).max(WORKBENCH_LIMITS.maxPathChars)
  .refine(value => (windowsAbsolute.test(value) || value.startsWith('/')) && !value.includes('\u0000'), 'ABSOLUTE_PATH_REQUIRED');
export const ProjectInputSchema = z.strictObject({ name: z.string().trim().min(1).max(WORKBENCH_LIMITS.maxNameChars), path: ProjectPathSchema });
export const ProjectSchema = ProjectInputSchema.extend({ id: z.uuid(), createdAt: z.iso.datetime() });
export type Project = z.infer<typeof ProjectSchema>;
export const ProjectListSchema = z.strictObject({ projects: z.array(ProjectSchema).max(WORKBENCH_LIMITS.maxProjects) });
export type ProjectList = z.infer<typeof ProjectListSchema>;
export const ProjectRefSchema = z.strictObject({ id: z.uuid() });
export type ProjectRef = z.infer<typeof ProjectRefSchema>;

export const ControlRunSchema = z.strictObject({ id: z.uuid(), startedAt: z.iso.datetime(), endedAt: z.iso.datetime().nullable(),
  outcome: z.enum(['RUNNING', 'CLEAN', 'INTERRUPTED']) });
export type ControlRun = z.infer<typeof ControlRunSchema>;
export const ControlRunListSchema = z.strictObject({ runs: z.array(ControlRunSchema).max(WORKBENCH_LIMITS.maxRuns) });
export type ControlRunList = z.infer<typeof ControlRunListSchema>;

export const TaskStartInputSchema = z.strictObject({ projectId: z.uuid(), prompt: z.string().trim().min(1).max(WORKBENCH_LIMITS.maxPromptChars) });
export type TaskStartInput = z.infer<typeof TaskStartInputSchema>;
/** P1 has no qualified Worker: every task start is refused before any execution is scheduled. */
export const TaskStartResultSchema = z.strictObject({ accepted: z.literal(false), error: z.literal('WORKER_ISOLATION_UNAVAILABLE') });
export type TaskStartResult = z.infer<typeof TaskStartResultSchema>;

export const CapabilityStatusSchema = z.enum(['unverified', 'unavailable']);
export const CapabilityMatrixSchema = z.strictObject({ ui: CapabilityStatusSchema, read: CapabilityStatusSchema, gitRead: CapabilityStatusSchema,
  highRisk: CapabilityStatusSchema, workerIsolation: CapabilityStatusSchema });
export type CapabilityMatrix = z.infer<typeof CapabilityMatrixSchema>;
export const ControlOverviewSchema = z.strictObject({
  protocolVersion: z.literal(PROTOCOL_VERSION), ...ServiceTreeIdentitySchema.shape,
  controlPlaneReady: z.literal(true), agentReady: z.literal(false),
  startedAt: z.iso.datetime(), uptimeMs: z.number().int().nonnegative(),
  runtime: z.strictObject({ node: z.string().max(32), abi: z.string().max(8), sqlite: z.string().max(32), platform: z.string().max(16), arch: z.string().max(16) }),
  database: z.strictObject({ version: z.literal(9), recoveredRuns: z.number().int().nonnegative(), projects: z.number().int().nonnegative(),
    runs: z.number().int().nonnegative(), records: z.number().int().nonnegative() }),
  worker: z.strictObject({ state: z.literal('unavailable'), error: z.literal('WORKER_ISOLATION_UNAVAILABLE'),
    // No agent loop ships in this build, so no task can run on any platform; per-platform Worker qualification
    // (SEC-W01) is a build record (build/agent-status.json), not something the control plane claims at runtime.
    reason: z.literal('AGENT_LOOP_NOT_IMPLEMENTED'), fixtureLaunch: z.literal('disabled-in-release') }),
  tools: z.strictObject({ read: z.literal('READ_ADAPTER_UNAVAILABLE'), highRisk: z.literal('SANDBOX_UNAVAILABLE') }),
  capabilities: CapabilityMatrixSchema,
});
export type ControlOverview = z.infer<typeof ControlOverviewSchema>;
