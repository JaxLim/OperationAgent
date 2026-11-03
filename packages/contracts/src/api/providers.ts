import { z } from 'zod';
import { ApiKeySchema, CredentialStatusSchema, ModelTestStatusSchema } from './model.js';

// Linked providers (M2 settings expansion). Anthropic keeps its own /v1/model/* operations; the providers here are
// linked with an API key against a fixed official endpoint. Account sign-in (OAuth) and custom endpoints are not part
// of this contract: they wait for ADR-PROV-001.

export const MODEL_PROVIDERS = ['anthropic', 'openai', 'google', 'openrouter'] as const;
export const ModelProviderSchema = z.enum(MODEL_PROVIDERS);
export type ModelProvider = z.infer<typeof ModelProviderSchema>;
export const LINKED_PROVIDERS = ['openai', 'google', 'openrouter'] as const;
export const LinkedProviderSchema = z.enum(LINKED_PROVIDERS);
export type LinkedProvider = z.infer<typeof LinkedProviderSchema>;
/** Web search providers the agent could call through Express once a search tool exists. */
export const SEARCH_PROVIDERS = ['exa', 'tavily', 'brave', 'firecrawl'] as const;
export const SearchProviderSchema = z.enum(SEARCH_PROVIDERS);
export type SearchProvider = z.infer<typeof SearchProviderSchema>;
/** Every stored credential besides the Anthropic key; each slot holds one safeStorage ciphertext. */
export const CREDENTIAL_SLOTS = [...LINKED_PROVIDERS, ...SEARCH_PROVIDERS] as const;
export const CredentialSlotSchema = z.enum(CREDENTIAL_SLOTS);
export type CredentialSlot = z.infer<typeof CredentialSlotSchema>;

/** The only hosts a linked provider is contacted on. Tests may hand the gateway a loopback fake instead. */
export const PROVIDER_ENDPOINTS: Readonly<Record<LinkedProvider, string>> = Object.freeze({
  openai: 'https://api.openai.com', google: 'https://generativelanguage.googleapis.com', openrouter: 'https://openrouter.ai',
});
export const ProviderEndpointSchema = z.union([z.enum(Object.values(PROVIDER_ENDPOINTS) as [string, ...string[]]),
  z.string().regex(/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/)]);
export const PROVIDER_LIMITS = Object.freeze({ maxModels: 1_000, maxModelListBytes: 8 * 1024 * 1024 });

/** Provider model ids: no whitespace, quotes or control characters, so an id can never carry provider text. */
export const ModelIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/);
export const LinkedProviderStatusSchema = z.strictObject({ provider: LinkedProviderSchema, model: ModelIdSchema.nullable(), credential: CredentialStatusSchema });
export type LinkedProviderStatus = z.infer<typeof LinkedProviderStatusSchema>;
export const SearchKeyStatusSchema = z.strictObject({ provider: SearchProviderSchema, credential: CredentialStatusSchema });
export type SearchKeyStatus = z.infer<typeof SearchKeyStatusSchema>;
/** Express view: model choice and credential status per slot, never key material. */
export const ProviderOverviewSchema = z.strictObject({
  providers: z.array(LinkedProviderStatusSchema).max(LINKED_PROVIDERS.length),
  search: z.array(SearchKeyStatusSchema).max(SEARCH_PROVIDERS.length),
});
export type ProviderOverview = z.infer<typeof ProviderOverviewSchema>;
/** Renderer view: Main adds whether OS-backed secure storage can encrypt right now (SEC-14). */
export const ProviderOverviewViewSchema = ProviderOverviewSchema.extend({ secureStorage: z.enum(['available', 'unavailable']) });
export type ProviderOverviewView = z.infer<typeof ProviderOverviewViewSchema>;

export const ProviderKeyInputSchema = z.strictObject({ provider: CredentialSlotSchema, apiKey: ApiKeySchema });
export type ProviderKeyInput = z.infer<typeof ProviderKeyInputSchema>;
export const ProviderRefSchema = z.strictObject({ provider: CredentialSlotSchema });
export type ProviderRef = z.infer<typeof ProviderRefSchema>;
export const LinkedProviderRefSchema = z.strictObject({ provider: LinkedProviderSchema });
export type LinkedProviderRef = z.infer<typeof LinkedProviderRefSchema>;
export const ProviderModelChoiceSchema = z.strictObject({ provider: LinkedProviderSchema, model: ModelIdSchema });
export type ProviderModelChoice = z.infer<typeof ProviderModelChoiceSchema>;

/** Normalised, redacted result, like the Anthropic test: no provider message text, headers or key material. */
export const ProviderTestResultSchema = z.strictObject({
  provider: LinkedProviderSchema, status: ModelTestStatusSchema, model: ModelIdSchema.nullable(),
  httpStatus: z.number().int().min(100).max(599).nullable(), latencyMs: z.number().int().nonnegative().nullable(), checkedAt: z.iso.datetime(),
});
export type ProviderTestResult = z.infer<typeof ProviderTestResultSchema>;
/** Model ids the key can use, as the provider listed them; only ids that pass ModelIdSchema are kept. */
export const ProviderModelListSchema = z.strictObject({
  provider: LinkedProviderSchema, status: ModelTestStatusSchema, models: z.array(ModelIdSchema).max(PROVIDER_LIMITS.maxModels), fetchedAt: z.iso.datetime(),
});
export type ProviderModelList = z.infer<typeof ProviderModelListSchema>;
