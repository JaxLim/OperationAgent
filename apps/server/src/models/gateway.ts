import { ANTHROPIC_ENDPOINT, MODEL_LIMITS, ModelEndpointSchema, ModelTestResultSchema } from '@operation-agent/contracts';
import type { ClaudeModel, ModelTestResult, ModelTestStatus } from '@operation-agent/contracts';

// ARCHITECTURE §6.2 Model Gateway (Express-internal). M2 exposes one fixed operation: a minimal Messages API request
// that proves the key and model work. The key is used for this one request only and is never logged, cached or
// returned; provider bodies, headers and error text never leave this module, only a normalised status.

export const ANTHROPIC_VERSION = '2023-06-01';
export interface ModelGateway {
  testConnection(apiKey: string, model: ClaudeModel): Promise<ModelTestResult>;
}

export function classifyStatus(httpStatus: number): ModelTestStatus {
  if (httpStatus >= 200 && httpStatus < 300) return 'ok';
  if (httpStatus === 401 || httpStatus === 403) return 'auth_failed';
  if (httpStatus === 429) return 'rate_limited';
  if (httpStatus === 404) return 'model_unavailable';
  return 'provider_error';
}

export function createModelGateway(options: { endpoint?: string | undefined; timeoutMs?: number } = {}): ModelGateway {
  // Only the fixed provider endpoint (or a loopback test fake handed over in the bootstrap) is ever contacted.
  const endpoint = ModelEndpointSchema.parse(options.endpoint ?? ANTHROPIC_ENDPOINT);
  const url = new URL('/v1/messages', endpoint).href;
  const timeoutMs = options.timeoutMs ?? MODEL_LIMITS.testTimeoutMs;
  return {
    async testConnection(apiKey, model) {
      const started = Date.now();
      const result = (status: ModelTestStatus, httpStatus: number | null): ModelTestResult => ModelTestResultSchema.parse({
        status, model, httpStatus, latencyMs: httpStatus === null ? null : Date.now() - started, checkedAt: new Date().toISOString() });
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          // A redirect could carry the key header to another origin, so it is treated as a failure.
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
          headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
          body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
        });
      } catch { return result('unreachable', null); }
      // The body is not needed and is never forwarded; release it without buffering.
      await response.body?.cancel().catch(() => {});
      return result(classifyStatus(response.status), response.status);
    },
  };
}
