import { randomUUID } from 'node:crypto';
import { HfLoginChallengeSchema, HfLoginInputSchema, MODEL_LIMITS, type HfLoginState } from '@operation-agent/contracts';
import { readBounded } from './providers.js';

const DEVICE_URL = 'https://huggingface.co/oauth/device';
const TOKEN_URL = 'https://huggingface.co/oauth/token';
const SCOPE = 'inference-api';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const MAX_REPLY_BYTES = 16_384;
const MAX_TIMER_MS = 2 ** 31 - 1;
const DEFAULT_INTERVAL_MS = 5000;
const MAX_RECENT_SESSIONS = 32;

export interface HfTokens {
  clientId: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

type State = HfLoginState['state'];
type Terminal = Exclude<State, 'waiting'>;
type Fields = Record<string, unknown>;

async function post(fetcher: typeof fetch, url: string, form: Record<string, string>, signal: AbortSignal) {
  const response = await fetcher(url, {
    method: 'POST', redirect: 'error', credentials: 'omit', signal,
    headers: { Accept: 'application/json' }, body: new URLSearchParams(form),
  });
  const raw = await readBounded(response, MAX_REPLY_BYTES);
  const data: unknown = raw && JSON.parse(raw);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('HF_INVALID_RESPONSE');
  return { response, data: data as Fields };
}

function milliseconds(seconds: unknown): number {
  if (typeof seconds !== 'number' || seconds <= 0 || !Number.isSafeInteger(seconds) ||
      !Number.isSafeInteger(Date.now() + seconds * 1000)) throw new Error('HF_INVALID_RESPONSE');
  return seconds * 1000;
}

function isOpaque(value: unknown): value is string {
  return typeof value === 'string' && /^[!-~]+$/.test(value);
}

function parseTokens(clientId: string, data: Fields, previousRefresh?: string): HfTokens {
  const refreshToken = data.refresh_token === undefined ? previousRefresh : data.refresh_token;
  if (!isOpaque(data.access_token) || typeof data.token_type !== 'string' || data.token_type.toLowerCase() !== 'bearer' ||
      (refreshToken !== undefined && !isOpaque(refreshToken)) ||
      (data.scope !== undefined && (typeof data.scope !== 'string' || !data.scope.split(' ').includes(SCOPE)))) {
    throw new Error('HF_INVALID_RESPONSE');
  }
  return { clientId, accessToken: data.access_token, expiresAt: Date.now() + milliseconds(data.expires_in),
    ...(refreshToken === undefined ? {} : { refreshToken }) };
}

export async function refreshHfTokens(tokens: HfTokens): Promise<HfTokens> {
  try {
    const { clientId } = HfLoginInputSchema.parse({ clientId: tokens.clientId });
    if (!isOpaque(tokens.refreshToken)) throw new Error('HF_MISSING_REFRESH_TOKEN');
    const { response, data } = await post(fetch, TOKEN_URL, {
      client_id: clientId, grant_type: 'refresh_token', refresh_token: tokens.refreshToken,
    }, AbortSignal.timeout(MODEL_LIMITS.testTimeoutMs));
    if (!response.ok) throw new Error('HF_REFRESH_FAILED');
    return parseTokens(clientId, data, tokens.refreshToken);
  } catch {
    throw new Error('HF_REFRESH_FAILED');
  }
}

export function createHfDeviceAuthorization(options: {
  saveTokens(tokens: HfTokens, signal: AbortSignal): Promise<void> | void;
  fetch?: typeof fetch;
}) {
  const fetcher = options.fetch ?? fetch;
  const recent = new Map<string, Terminal>();
  let starting = false;
  let active: { id: string; expiresAt: number; finish(state: Terminal): void } | undefined;

  function status(id: string): State {
    if (active?.id === id && Date.now() >= active.expiresAt) active.finish('expired');
    return active?.id === id ? 'waiting' : recent.get(id) ?? 'failed';
  }

  async function begin(clientId: string) {
    if (!HfLoginInputSchema.safeParse({ clientId }).success) throw new Error('VALIDATION_ERROR');
    if (starting || (active && status(active.id) === 'waiting')) throw new Error('AUTH_SESSION_IN_PROGRESS');
    starting = true;
    try {
      const { response, data } = await post(fetcher, DEVICE_URL, { client_id: clientId, scope: SCOPE },
        AbortSignal.timeout(MODEL_LIMITS.testTimeoutMs));
      if (!response.ok || !isOpaque(data.device_code) || !isOpaque(data.user_code) ||
          (data.verification_uri !== DEVICE_URL && data.verification_uri !== 'https://hf.co/oauth/device')) {
        throw new Error('HF_INVALID_RESPONSE');
      }
      const lifetime = milliseconds(data.expires_in);
      if (lifetime > MAX_TIMER_MS) throw new Error('HF_INVALID_RESPONSE');
      let interval = data.interval === undefined ? DEFAULT_INTERVAL_MS : milliseconds(data.interval);
      const challenge = HfLoginChallengeSchema.parse({
        sessionId: randomUUID(), userCode: data.user_code, expiresAt: Date.now() + lifetime,
      });
      const { sessionId, expiresAt } = challenge;
      const controller = new AbortController();
      let deviceCode = data.device_code;
      let pollTimer: NodeJS.Timeout | undefined;
      const expiryTimer = setTimeout(() => finish('expired'), lifetime).unref();

      function finish(state: Terminal) {
        if (active?.id !== sessionId) return;
        active = undefined;
        clearTimeout(expiryTimer);
        clearTimeout(pollTimer);
        deviceCode = '';
        recent.set(sessionId, state);
        if (recent.size > MAX_RECENT_SESSIONS) recent.delete(recent.keys().next().value!);
        if (state === 'cancelled' || state === 'expired') controller.abort();
      }

      function schedule() {
        if (interval < expiresAt - Date.now()) pollTimer = setTimeout(() => void poll(), interval).unref();
      }

      async function poll() {
        if (status(sessionId) !== 'waiting') return;
        const timeout = AbortSignal.timeout(MODEL_LIMITS.testTimeoutMs);
        try {
          const reply = await post(fetcher, TOKEN_URL, {
            client_id: clientId, grant_type: DEVICE_GRANT, device_code: deviceCode,
          }, AbortSignal.any([controller.signal, timeout]));
          if (status(sessionId) !== 'waiting') return;
          if (!reply.response.ok) {
            switch (reply.data.error) {
              case 'slow_down': interval += DEFAULT_INTERVAL_MS; break;
              case 'authorization_pending': break;
              case 'expired_token': finish('expired'); return;
              default: finish('failed'); return;
            }
            schedule();
            return;
          }
          const tokens = parseTokens(clientId, reply.data);
          deviceCode = '';
          try {
            await options.saveTokens(tokens, controller.signal);
          } catch {
            finish('failed');
            return;
          }
          finish('authorized');
        } catch (error) {
          if (status(sessionId) !== 'waiting') return;
          const cause = error instanceof Error ? error.cause : undefined;
          if (timeout.aborted || (cause && typeof cause === 'object' && 'code' in cause &&
              cause.code === 'UND_ERR_CONNECT_TIMEOUT')) {
            interval *= 2;
            schedule();
          } else finish('failed');
        }
      }

      active = { id: sessionId, expiresAt, finish };
      schedule();
      return challenge;
    } catch {
      throw new Error('HF_DEVICE_AUTH_FAILED');
    } finally {
      starting = false;
    }
  }

  function cancel(id: string) {
    if (active?.id === id && status(id) === 'waiting') active.finish('cancelled');
  }
  return { begin, status, cancel };
}
