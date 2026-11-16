import { randomUUID } from 'node:crypto';
import { ProviderSecretSchema } from '@operation-agent/contracts';
import type { CustomProviderInput } from '@operation-agent/contracts';
import type { LinkedRoute } from '../agent/runner.js';
import type { CryptoBridge } from '../credentials/bridge.js';
import { createCredentialService } from '../credentials/service.js';
import type { CredentialService } from '../credentials/service.js';
import type { Store } from '../persistence/store.js';
import type { StoredHfAccount } from '../persistence/connections.js';
import { validateCustomEndpoint } from './custom-transport.js';
import { createHfDeviceAuthorization, refreshHfTokens } from './hf-device.js';
import type { HfTokens } from './hf-device.js';

export function createModelConnections(store: Store, bridge: CryptoBridge) {
  async function encrypt(value: string): Promise<string> {
    if (!ProviderSecretSchema.safeParse(value).success) throw new Error('VALIDATION_ERROR');
    const ciphertext = await bridge.encrypt(value);
    if (ciphertext.includes(value)) throw new Error('SECURE_STORAGE_UNAVAILABLE');
    return ciphertext;
  }
  const authorization = createHfDeviceAuthorization({ async saveTokens(tokens, signal) {
    const access = await encrypt(tokens.accessToken);
    const refresh = tokens.refreshToken ? await encrypt(tokens.refreshToken) : null;
    signal.throwIfAborted();
    store.saveHf({ accountId: randomUUID(), clientId: tokens.clientId, expiresAt: tokens.expiresAt, access, refresh, model: null });
  } });
  let currentSession: string | undefined;
  let generation = 0;
  const refreshing = new Map<string, Promise<void>>();
  async function renew(row: StoredHfAccount): Promise<void> {
    if (!row.refresh) throw new Error('LOGIN_EXPIRED');
    const refreshToken = await bridge.decrypt(row.refresh);
    const tokens: HfTokens = { clientId: row.clientId, accessToken: await bridge.decrypt(row.access),
      refreshToken, expiresAt: row.expiresAt };
    const next = await refreshHfTokens(tokens);
    const access = await encrypt(next.accessToken);
    const refresh = next.refreshToken ? await encrypt(next.refreshToken) : row.refresh;
    if (!store.refreshHf(row, access, refresh, next.expiresAt)) throw new Error('LOGIN_CHANGED');
  }
  async function hfKey(accountId: string): Promise<string | null> {
    let row = store.hfAccount();
    if (!row || row.accountId !== accountId) return null;
    if (row.expiresAt <= Date.now() + 5_000) {
      let pending = refreshing.get(accountId);
      if (!pending) {
        pending = renew(row).finally(() => refreshing.delete(accountId));
        refreshing.set(accountId, pending);
      }
      await pending;
      row = store.hfAccount();
      if (!row || row.accountId !== accountId || row.expiresAt <= Date.now()) return null;
    }
    const key = await bridge.decrypt(row.access);
    return store.hfAccount()?.accountId === accountId ? key : null;
  }
  function readCredentials(read: () => Promise<string | null>): Pick<CredentialService, 'withKey'> {
    return { async withKey(use) {
      let key: string | null;
      try { key = await read(); } catch { return { ok: false, reason: 'credential_unavailable' }; }
      if (!key || !ProviderSecretSchema.safeParse(key).success) return { ok: false, reason: 'not_configured' };
      return { ok: true, value: await use(key) };
    } };
  }
  function route(): LinkedRoute | null {
    const { defaultProvider: provider, customProviderId } = store.getSettings();
    if (provider === 'anthropic') return null;
    if (provider === 'custom') {
      const endpoint = store.listCustom().find(item => item.id === customProviderId);
      if (!endpoint) throw new Error('MODEL_NOT_CONFIGURED');
      return { provider, model: endpoint.model, endpoint, credentials: {
        status: () => ({ configured: !!store.customKey(endpoint.id) }),
        ...readCredentials(async () => {
          const cipher = store.customKey(endpoint.id);
          if (!cipher) return null;
          const key = await bridge.decrypt(cipher);
          return cipher === store.customKey(endpoint.id) ? key : null;
        }),
      } };
    }
    if (provider === 'huggingface') {
      const account = store.hfAccount();
      if (!account) throw new Error('MODEL_NOT_CONFIGURED');
      return { provider, model: account.model, credentials: { status: () => ({ configured: true }),
        ...readCredentials(() => hfKey(account.accountId)) } };
    }
    return { provider, model: store.getProviderModel(provider), credentials: createCredentialService(store.credentialStore(provider), bridge) };
  }
  return {
    route,
    async saveCustom(input: CustomProviderInput) {
      await validateCustomEndpoint(input.baseUrl, input.allowLocal);
      const baseUrl = new URL(input.baseUrl).href.replace(/\/+$/, '');
      const ciphertext = await encrypt(input.apiKey);
      store.saveCustom({ baseUrl, allowLocal: input.allowLocal, model: input.model }, ciphertext);
    },
    async beginHf(clientId: string) {
      const attempt = ++generation;
      if (currentSession) authorization.cancel(currentSession);
      const challenge = await authorization.begin(clientId);
      if (generation !== attempt) { authorization.cancel(challenge.sessionId); throw new Error('LOGIN_CHANGED'); }
      currentSession = challenge.sessionId;
      return challenge;
    },
    hfStatus: (id: string) => ({ state: authorization.status(id) }),
    cancelHf(id: string) { authorization.cancel(id); return { state: authorization.status(id) }; },
    disconnectHf() {
      generation++;
      if (currentSession) authorization.cancel(currentSession);
      store.disconnectHf();
    },
  };
}
