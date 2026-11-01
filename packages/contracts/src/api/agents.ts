import { z } from 'zod';
import { ModelIdSchema, ModelProviderSchema } from './providers.js';

// Agent profiles and MCP server definitions (M2 settings expansion). Both are configuration only: no agent loop runs
// them and no MCP Host launches or contacts a server in this build. Express stores them and re-validates every read.

export const AGENT_LIMITS = Object.freeze({ maxAgents: 16, maxPromptChars: 3_000, maxDescriptionChars: 200, maxListBytes: 150_000 });
/** Tools an agent profile may ask for. Asking grants nothing: each tool still needs its own platform gate. */
export const AGENT_TOOLS = ['read_file', 'git_read', 'web_search', 'mcp', 'write_file', 'bash'] as const;
export const AgentToolSchema = z.enum(AGENT_TOOLS);
export type AgentTool = z.infer<typeof AgentToolSchema>;
export const AgentNameSchema = z.string().regex(/^[a-z][a-z0-9-]{1,31}$/);
export const AgentModelSchema = z.strictObject({ provider: ModelProviderSchema, model: ModelIdSchema });
const agentFields = {
  name: AgentNameSchema,
  description: z.string().trim().max(AGENT_LIMITS.maxDescriptionChars),
  mode: z.enum(['primary', 'subagent']),
  /** null inherits the default provider and model. */
  model: AgentModelSchema.nullable(),
  prompt: z.string().max(AGENT_LIMITS.maxPromptChars),
  tools: z.array(AgentToolSchema).max(AGENT_TOOLS.length).refine(tools => new Set(tools).size === tools.length, 'DUPLICATE_TOOL'),
};
export const AgentInputSchema = z.strictObject(agentFields);
export type AgentInput = z.infer<typeof AgentInputSchema>;
/** Without an id a new profile is created; with one, that profile is replaced. */
export const AgentSaveSchema = z.strictObject({ ...agentFields, id: z.uuid().optional() });
export type AgentSave = z.infer<typeof AgentSaveSchema>;
export const AgentSchema = z.strictObject({ ...agentFields, id: z.uuid(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime() });
export type Agent = z.infer<typeof AgentSchema>;
export const AgentListSchema = z.strictObject({ agents: z.array(AgentSchema).max(AGENT_LIMITS.maxAgents) });
export type AgentList = z.infer<typeof AgentListSchema>;
export const AgentRefSchema = z.strictObject({ id: z.uuid() });
export type AgentRef = z.infer<typeof AgentRefSchema>;
/** Built-in profiles ship with the app and cannot be edited; their names are reserved. */
export const BUILT_IN_AGENTS: readonly AgentInput[] = Object.freeze([
  { name: 'general', mode: 'primary', model: null, prompt: '', description: 'Default agent: plans and carries out coding tasks with every tool the platform has unlocked.',
    tools: ['read_file', 'git_read', 'web_search', 'mcp', 'write_file', 'bash'] },
  { name: 'plan', mode: 'primary', model: null, prompt: '', description: 'Read-only: explores the project and proposes a plan without changing anything.',
    tools: ['read_file', 'git_read', 'web_search'] },
  { name: 'explore', mode: 'subagent', model: null, prompt: '', description: 'Fast read-only search across the codebase for the agent that called it.',
    tools: ['read_file', 'git_read'] },
  { name: 'review', mode: 'subagent', model: null, prompt: '', description: 'Reviews a change for correctness and security issues; never edits files.',
    tools: ['read_file', 'git_read'] },
]);

export const MCP_LIMITS = Object.freeze({ maxServers: 16, maxArgs: 16, maxArgChars: 256, maxCommandChars: 512, maxUrlChars: 512, maxListBytes: 150_000 });
const printable = (value: string): boolean => [...value].every(char => char.charCodeAt(0) > 0x1f && char.charCodeAt(0) !== 0x7f);
const McpNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,47}$/);
/**
 * HTTPS anywhere, or plain HTTP to this computer only. Credentials in the URL are refused: authentication arrives with
 * the MCP Host and its credential storage, never as text in a stored URL.
 */
export const McpUrlSchema = z.string().max(MCP_LIMITS.maxUrlChars)
  // The authority admits no "@", so no user or password can be embedded.
  .regex(/^(?:https:\/\/[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?|http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]))(?::\d{1,5})?(?:[/?#]\S*)?$/, 'MCP_URL_INVALID')
  .refine(printable);
const stdioFields = { transport: z.literal('stdio'), name: McpNameSchema, enabled: z.boolean(),
  command: z.string().min(1).max(MCP_LIMITS.maxCommandChars).refine(printable),
  args: z.array(z.string().max(MCP_LIMITS.maxArgChars).refine(printable)).max(MCP_LIMITS.maxArgs) };
const httpFields = { transport: z.literal('http'), name: McpNameSchema, enabled: z.boolean(), url: McpUrlSchema };
const stored = { id: z.uuid(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime() };
export const McpServerInputSchema = z.discriminatedUnion('transport', [z.strictObject(stdioFields), z.strictObject(httpFields)]);
export type McpServerInput = z.infer<typeof McpServerInputSchema>;
export const McpServerSaveSchema = z.discriminatedUnion('transport', [
  z.strictObject({ ...stdioFields, id: z.uuid().optional() }), z.strictObject({ ...httpFields, id: z.uuid().optional() })]);
export type McpServerSave = z.infer<typeof McpServerSaveSchema>;
export const McpServerSchema = z.discriminatedUnion('transport', [z.strictObject({ ...stdioFields, ...stored }), z.strictObject({ ...httpFields, ...stored })]);
export type McpServer = z.infer<typeof McpServerSchema>;
export const McpServerListSchema = z.strictObject({ servers: z.array(McpServerSchema).max(MCP_LIMITS.maxServers) });
export type McpServerList = z.infer<typeof McpServerListSchema>;
export const McpServerRefSchema = z.strictObject({ id: z.uuid() });
export type McpServerRef = z.infer<typeof McpServerRefSchema>;
