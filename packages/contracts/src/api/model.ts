import { z } from 'zod';
import { ServiceTreeIdentitySchema } from '../ipc/identity.js';

// M2 model settings (ARCHITECTURE §6.2/§6.3). Express owns the model choice and the credential lifecycle; the Renderer
// only ever sees "configured or not" plus a four-character hint. A saved key is never read back to the Renderer.

export const MODEL_PROVIDER = 'anthropic' as const;
export const CLAUDE_MODELS = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'] as const;
export const ClaudeModelSchema = z.enum(CLAUDE_MODELS);
export type ClaudeModel = z.infer<typeof ClaudeModelSchema>;
export const DEFAULT_CLAUDE_MODEL: ClaudeModel = 'claude-sonnet-5-5';

export const MODEL_LIMITS = Object.freeze({
  minKeyChars: 20, maxKeyChars: 256,
  // Base64 of a safeStorage blob for a ≤256-character key stays far below this bound on every platform.
  maxCiphertextChars: 8_192,
  // A connection test waits this long for the provider; Main waits a little longer for Express.
  testTimeoutMs: 15_000, testRequestMs: 20_000,
  cryptoTimeoutMs: 5_000, maxCryptoPending: 4,
  // Saving or removing a key may wait for one bridge round trip (and a save queued before it); Main waits longer
  // than that, so a slow but successful save is not reported as failed.
  credentialRequestMs: 12_000,
});

/**
 * Printable ASCII without whitespace. The value is never echoed in an error: Zod issues carry no input by default,
 * and every boundary maps failures to fixed codes.
 */
export const ApiKeySchema = z.string().min(MODEL_LIMITS.minKeyChars).max(MODEL_LIMITS.maxKeyChars).regex(/^[\x21-\x7e]+$/);
export const CredentialHintSchema = z.string().regex(/^[A-Za-z0-9_-]{4}$/);
export const ApiKeyInputSchema = z.strictObject({ apiKey: ApiKeySchema });
export type ApiKeyInput = z.infer<typeof ApiKeyInputSchema>;
/** The last four characters of a key; not enough to use it, enough to recognise which key is stored. */
export function credentialHint(apiKey: string): string | null {
  const hint = apiKey.slice(-4);
  return CredentialHintSchema.safeParse(hint).success ? hint : null;
}

export const CredentialStatusSchema = z.discriminatedUnion('configured', [
  z.strictObject({ configured: z.literal(false) }),
  z.strictObject({ configured: z.literal(true), hint: CredentialHintSchema.nullable(), updatedAt: z.iso.datetime() }),
]);
export type CredentialStatus = z.infer<typeof CredentialStatusSchema>;

export const ModelChoiceSchema = z.strictObject({ model: ClaudeModelSchema });
export type ModelChoice = z.infer<typeof ModelChoiceSchema>;
/** Express view: provider, chosen model and credential status. */
export const ModelSettingsSchema = z.strictObject({
  provider: z.literal(MODEL_PROVIDER), model: ClaudeModelSchema, credential: CredentialStatusSchema,
});
export type ModelSettings = z.infer<typeof ModelSettingsSchema>;
/** Renderer view: Main adds whether OS-backed secure storage can encrypt right now (SEC-14). */
export const ModelSettingsViewSchema = ModelSettingsSchema.extend({ secureStorage: z.enum(['available', 'unavailable']) });
export type ModelSettingsView = z.infer<typeof ModelSettingsViewSchema>;

export const ModelTestStatusSchema = z.enum([
  'ok',
  // 401/403 from the provider.
  'auth_failed',
  'rate_limited',
  // 404: the chosen model is not available to this key.
  'model_unavailable',
  // Any other provider status, including overload.
  'provider_error',
  // DNS, TLS, refused connection, redirect or timeout.
  'unreachable',
  'not_configured',
  // The stored ciphertext can no longer be decrypted (for example another OS user); re-enter the key.
  'credential_unavailable',
]);
export type ModelTestStatus = z.infer<typeof ModelTestStatusSchema>;
/** Normalised, redacted result: no provider message text, headers or key material ever leave Express. */
export const ModelTestResultSchema = z.strictObject({
  status: ModelTestStatusSchema, model: ClaudeModelSchema,
  httpStatus: z.number().int().min(100).max(599).nullable(),
  latencyMs: z.number().int().nonnegative().nullable(),
  checkedAt: z.iso.datetime(),
});
export type ModelTestResult = z.infer<typeof ModelTestResultSchema>;

/** The only provider endpoint in production. Tests may bootstrap a loopback fake; nothing else is accepted. */
export const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com' as const;
export const ModelEndpointSchema = z.union([z.literal(ANTHROPIC_ENDPOINT), z.string().regex(/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/)]);

// Express ↔ Main Crypto Bridge (ARCHITECTURE §3.2/§6.3): bound to one service tree over the inherited IPC channel,
// two fixed operations and bounded sizes. Main never interprets what it encrypts; Express never sees the OS key.
const cryptoRequestBase = { kind: z.literal('crypto-request'), ...ServiceTreeIdentitySchema.shape, requestId: z.uuid() };
export const CryptoBridgeRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ ...cryptoRequestBase, operation: z.literal('encrypt'), plaintext: ApiKeySchema }),
  z.strictObject({ ...cryptoRequestBase, operation: z.literal('decrypt'),
    ciphertext: z.base64().min(4).max(MODEL_LIMITS.maxCiphertextChars) }),
]);
export type CryptoBridgeRequest = z.infer<typeof CryptoBridgeRequestSchema>;
export const CryptoBridgeErrorSchema = z.enum(['SECURE_STORAGE_UNAVAILABLE', 'CRYPTO_FAILED']);
export type CryptoBridgeError = z.infer<typeof CryptoBridgeErrorSchema>;
const cryptoResponseBase = { kind: z.literal('crypto-response'), ...ServiceTreeIdentitySchema.shape, requestId: z.uuid() };
export const CryptoBridgeResponseSchema = z.union([
  z.strictObject({ ...cryptoResponseBase, ok: z.literal(true),
    value: z.string().min(1).max(MODEL_LIMITS.maxCiphertextChars) }),
  z.strictObject({ ...cryptoResponseBase, ok: z.literal(false), error: CryptoBridgeErrorSchema }),
]);
export type CryptoBridgeResponse = z.infer<typeof CryptoBridgeResponseSchema>;
