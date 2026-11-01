import { LINKED_PROVIDERS, MODEL_LIMITS, ModelIdSchema, PROVIDER_ENDPOINTS, PROVIDER_LIMITS, ProviderEndpointSchema, ProviderModelListSchema,
  ProviderTestResultSchema } from '@operation-agent/contracts';
import type { LinkedProvider, ModelTestStatus, ProviderModelList, ProviderTestResult } from '@operation-agent/contracts';
import { classifyStatus } from './gateway.js';

// Linked-provider half of the Model Gateway (Express-internal). Two fixed operations per provider: prove a key (and
// the chosen model) works, and list the model ids the key can use. Only the fixed official endpoints are contacted;
// redirects fail; replies are size-bounded and reduced to validated ids. Provider text never leaves this module.

export interface ProviderGateway {
  test(provider: LinkedProvider, apiKey: string, model: string | null): Promise<ProviderTestResult>;
  listModels(provider: LinkedProvider, apiKey: string): Promise<ProviderModelList>;
}

interface Request { path: string; headers: Record<string, string> }
interface Adapter {
  /** A request that succeeds only for a working key (and, when given, an available model). */
  test(apiKey: string, model: string | null): Request;
  list(apiKey: string): Request;
  ids(body: unknown): unknown[];
}
const bearer = (apiKey: string): Record<string, string> => ({ authorization: `Bearer ${apiKey}` });
const field = (body: unknown, name: string): unknown[] => {
  const value = body !== null && typeof body === 'object' ? (body as Record<string, unknown>)[name] : undefined;
  return Array.isArray(value) ? value : [];
};
const property = (item: unknown, name: string): unknown => item !== null && typeof item === 'object' ? (item as Record<string, unknown>)[name] : undefined;
const ADAPTERS: Readonly<Record<LinkedProvider, Adapter>> = {
  openai: {
    test: (apiKey, model) => ({ path: model ? `/v1/models/${encodeURIComponent(model)}` : '/v1/models', headers: bearer(apiKey) }),
    list: apiKey => ({ path: '/v1/models', headers: bearer(apiKey) }),
    ids: body => field(body, 'data').map(item => property(item, 'id')),
  },
  google: {
    test: (apiKey, model) => ({ path: model ? `/v1beta/models/${encodeURIComponent(model)}` : '/v1beta/models?pageSize=1', headers: { 'x-goog-api-key': apiKey } }),
    list: apiKey => ({ path: '/v1beta/models?pageSize=1000', headers: { 'x-goog-api-key': apiKey } }),
    // Only models that generate content are useful to an agent; names arrive as "models/<id>".
    ids: body => field(body, 'models').filter(item => field(item, 'supportedGenerationMethods').includes('generateContent'))
      .map(item => { const name = property(item, 'name'); return typeof name === 'string' ? name.replace(/^models\//, '') : name; }),
  },
  openrouter: {
    // The key endpoint answers only for a valid key; OpenRouter routes any listed model, so the model is not probed.
    test: apiKey => ({ path: '/api/v1/key', headers: bearer(apiKey) }),
    // The catalogue is public: the key is not sent where it is not needed.
    list: () => ({ path: '/api/v1/models', headers: {} }),
    ids: body => field(body, 'data').map(item => property(item, 'id')),
  },
};

/** Reads at most `maxBytes` of a reply, so a hostile or broken endpoint cannot exhaust memory. */
async function readBounded(response: Response, maxBytes: number): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createProviderGateway(options: { endpoints?: Partial<Record<LinkedProvider, string>>; timeoutMs?: number } = {}): ProviderGateway {
  const endpoints = Object.fromEntries(LINKED_PROVIDERS.map(provider =>
    [provider, ProviderEndpointSchema.parse(options.endpoints?.[provider] ?? PROVIDER_ENDPOINTS[provider])])) as Record<LinkedProvider, string>;
  const timeoutMs = options.timeoutMs ?? MODEL_LIMITS.testTimeoutMs;
  const send = (provider: LinkedProvider, request: Request): Promise<Response> => fetch(new URL(request.path, endpoints[provider]).href, {
    method: 'GET', redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json', ...request.headers } });
  return {
    async test(provider, apiKey, model) {
      const started = Date.now();
      const result = (status: ModelTestStatus, httpStatus: number | null): ProviderTestResult => ProviderTestResultSchema.parse({
        provider, status, model, httpStatus, latencyMs: httpStatus === null ? null : Date.now() - started, checkedAt: new Date().toISOString() });
      let response: Response;
      try { response = await send(provider, ADAPTERS[provider].test(apiKey, model)); } catch { return result('unreachable', null); }
      await response.body?.cancel().catch(() => {});
      return result(classifyStatus(response.status), response.status);
    },
    async listModels(provider, apiKey) {
      const result = (status: ModelTestStatus, models: string[] = []): ProviderModelList =>
        ProviderModelListSchema.parse({ provider, status, models, fetchedAt: new Date().toISOString() });
      let response: Response;
      try { response = await send(provider, ADAPTERS[provider].list(apiKey)); } catch { return result('unreachable'); }
      const status = classifyStatus(response.status);
      if (status !== 'ok') { await response.body?.cancel().catch(() => {}); return result(status === 'model_unavailable' ? 'provider_error' : status); }
      let text: string | null;
      try { text = await readBounded(response, PROVIDER_LIMITS.maxModelListBytes); } catch { return result('unreachable'); }
      let body: unknown;
      try { body = text === null ? null : JSON.parse(text); } catch { body = null; }
      if (body === null) return result('provider_error');
      const ids = new Set<string>();
      for (const id of ADAPTERS[provider].ids(body)) {
        if (ModelIdSchema.safeParse(id).success) ids.add(id as string);
        if (ids.size >= PROVIDER_LIMITS.maxModels) break;
      }
      return result('ok', [...ids].sort());
    },
  };
}
