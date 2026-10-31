import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';
import { once } from 'node:events';
import { ApiKeyInputSchema, CONTROL_ROUTES, ControlHealthSchema, CryptoBridgeRequestSchema, CryptoBridgeResponseSchema, IPC_CHANNELS, ModelEndpointSchema,
  ModelSettingsViewSchema, ModelTestResultSchema, credentialHint } from '../../packages/contracts/dist/index.js';
import type { CryptoBridgeRequest } from '../../packages/contracts/dist/index.js';
import { openStore } from '../../apps/server/dist/persistence/store.js';
import type { Store } from '../../apps/server/dist/persistence/store.js';
import { createCredentialService } from '../../apps/server/dist/credentials/service.js';
import { UNAVAILABLE_BRIDGE, createIpcCryptoBridge } from '../../apps/server/dist/credentials/bridge.js';
import type { CryptoBridge } from '../../apps/server/dist/credentials/bridge.js';
import { createModelGateway } from '../../apps/server/dist/models/gateway.js';
import { createCryptoBridge, secureStorageAvailable } from '../../apps/desktop/dist/main/crypto-bridge.js';
import type { SecureStore } from '../../apps/desktop/dist/main/crypto-bridge.js';

// A realistic-looking key with a unique marker, so any leak into bytes, messages or errors is detectable.
const KEY = `sk-ant-api03-${randomUUID().replaceAll('-', '')}LEAKPROBE${'x'.repeat(40)}Wq7Z`;
const identity = { mainRunId: randomUUID(), expressRunId: randomUUID() };

/** Stand-in for safeStorage: reversible but never contains the plaintext. */
const fakeBridge = (): CryptoBridge & { calls: string[] } => {
  const calls: string[] = [];
  const flip = (value: string): string => Buffer.from(Buffer.from(value, 'latin1').map(byte => byte ^ 0x5a)).toString('latin1');
  return { calls,
    encrypt: async plaintext => { calls.push('encrypt'); return Buffer.from(flip(plaintext), 'latin1').toString('base64'); },
    decrypt: async ciphertext => { calls.push('decrypt'); return flip(Buffer.from(ciphertext, 'base64').toString('latin1')); } };
};

function withStore(run: (store: Store, directory: string) => Promise<void> | void): Promise<void> {
  const cache = resolve('.cache'); mkdirSync(cache, { recursive: true });
  const directory = mkdtempSync(resolve(cache, 'model-'));
  const store = openStore(directory, randomUUID());
  return (async () => { try { await run(store, directory); } finally { store.close(true); if (directory.startsWith(cache + sep)) rmSync(directory, { recursive: true, force: true }); } })();
}
/** Every byte SQLite left on disk (database, WAL and shared memory). */
function databaseBytes(directory: string): string {
  return readdirSync(directory).filter(name => name.startsWith('control-plane.sqlite')).map(name => readFileSync(resolve(directory, name)).toString('latin1')).join('');
}

test('model contracts: keys are bounded printable ASCII, failures never echo the value, endpoints are fixed or loopback', () => {
  assert.equal(ApiKeyInputSchema.safeParse({ apiKey: KEY }).success, true);
  for (const apiKey of ['short', `${KEY} `, `sk-ant-${'a'.repeat(300)}`, `sk-ant-密钥${'a'.repeat(30)}`, `sk-ant-\n${'a'.repeat(30)}`]) {
    const parsed = ApiKeyInputSchema.safeParse({ apiKey });
    assert.equal(parsed.success, false);
    assert.equal(parsed.error?.message.includes(apiKey.trim()), false, 'a rejected key must not appear in the error');
  }
  assert.equal(ApiKeyInputSchema.safeParse({ apiKey: KEY, provider: 'other' }).success, false);
  assert.equal(credentialHint(KEY), 'Wq7Z'); assert.equal(credentialHint(`${'a'.repeat(30)}!!!!`), null);
  assert.equal(ModelEndpointSchema.safeParse('https://api.anthropic.com').success, true);
  assert.equal(ModelEndpointSchema.safeParse('http://127.0.0.1:43123').success, true);
  for (const endpoint of ['https://api.anthropic.com/', 'http://localhost:1', 'https://evil.example', 'http://127.0.0.1:1/x', 'http://10.0.0.1:80'])
    assert.equal(ModelEndpointSchema.safeParse(endpoint).success, false, endpoint);
  assert.equal(ModelSettingsViewSchema.safeParse({ provider: 'anthropic', model: 'claude-sonnet-5-5', credential: { configured: true, hint: 'Wq7Z',
    updatedAt: new Date().toISOString(), apiKey: KEY }, secureStorage: 'available' }).success, false, 'a view can never carry key material');
  assert.equal(ModelSettingsViewSchema.safeParse({ provider: 'anthropic', model: 'gpt-4', credential: { configured: false }, secureStorage: 'available' }).success, false);
  assert.equal(ModelTestResultSchema.safeParse({ status: 'ok', model: 'claude-opus-5-5', httpStatus: 200, latencyMs: 3, checkedAt: new Date().toISOString(),
    message: 'provider text' }).success, false);
  const request = { kind: 'crypto-request', ...identity, requestId: randomUUID(), operation: 'encrypt', plaintext: KEY };
  assert.equal(CryptoBridgeRequestSchema.safeParse(request).success, true);
  assert.equal(CryptoBridgeRequestSchema.safeParse({ ...request, operation: 'sign' }).success, false);
  const decrypt = { kind: 'crypto-request', ...identity, requestId: randomUUID(), operation: 'decrypt', ciphertext: 'QUJD' };
  assert.equal(CryptoBridgeRequestSchema.safeParse(decrypt).success, true);
  assert.equal(CryptoBridgeRequestSchema.safeParse({ ...decrypt, ciphertext: 'A'.repeat(8_196) }).success, false);
  assert.equal(CryptoBridgeRequestSchema.safeParse({ ...decrypt, ciphertext: 'not base64!' }).success, false);
  assert.equal(CryptoBridgeResponseSchema.safeParse({ kind: 'crypto-response', ...identity, requestId: randomUUID(), ok: false, error: 'boom' }).success, false);
  assert.equal(ControlHealthSchema.shape.databaseVersion.value, 5);
  assert.deepEqual([CONTROL_ROUTES.modelSettings, CONTROL_ROUTES.modelCredential, CONTROL_ROUTES.modelCredentialClear, CONTROL_ROUTES.modelTest],
    ['/v1/model/settings', '/v1/model/credential', '/v1/model/credential/clear', '/v1/model/test']);
  assert.deepEqual([IPC_CHANNELS.getModelSettings, IPC_CHANNELS.saveModelChoice, IPC_CHANNELS.setApiKey, IPC_CHANNELS.clearApiKey, IPC_CHANNELS.testModelConnection],
    ['oa:model-settings-get', 'oa:model-choice-save', 'oa:model-key-set', 'oa:model-key-clear', 'oa:model-test']);
});

test('CredentialService stores only ciphertext and a hint; the key never reaches SQLite bytes', () => withStore(async (store, directory) => {
  assert.equal(store.databaseVersion, 5);
  assert.equal(store.getModel(), 'claude-sonnet-5-5');
  assert.equal(store.saveModel('claude-opus-5-5'), 'claude-opus-5-5');
  assert.throws(() => store.saveModel('gpt-4' as never));
  const bridge = fakeBridge();
  const credentials = createCredentialService(store, bridge);
  assert.deepEqual(credentials.status(), { configured: false });
  assert.deepEqual(await credentials.withKey(async () => 'unused'), { ok: false, reason: 'not_configured' });
  const saved = await credentials.set(KEY);
  assert.equal(saved.configured, true); assert.equal(saved.configured && saved.hint, 'Wq7Z');
  assert.equal(JSON.stringify(saved).includes('LEAKPROBE'), false);
  assert.equal(databaseBytes(directory).includes('LEAKPROBE'), false, 'plaintext key found in SQLite files');
  assert.equal(store.readCiphertext()?.includes('LEAKPROBE'), false);
  const used = await credentials.withKey(async key => key === KEY);
  assert.deepEqual(used, { ok: true, value: true });
  await assert.rejects(credentials.set('not a key'), /^Error: VALIDATION_ERROR$/);
  assert.deepEqual(await credentials.clear(), { configured: false });
  assert.equal(store.readCiphertext(), null);
}));

test('SEC-14: without secure storage, or with a bridge that echoes plaintext, nothing is stored', () => withStore(async (store, directory) => {
  const refused = createCredentialService(store, UNAVAILABLE_BRIDGE);
  const error = await refused.set(KEY).then(() => null, (failure: unknown) => failure as Error);
  assert.equal(error?.message, 'SECURE_STORAGE_UNAVAILABLE'); assert.equal(error?.cause, undefined);
  assert.deepEqual(refused.status(), { configured: false });
  const echoing = createCredentialService(store, { encrypt: async plaintext => Buffer.from(plaintext).toString('latin1'), decrypt: async value => value });
  await assert.rejects(echoing.set(KEY), /SECURE_STORAGE_UNAVAILABLE/);
  const broken = createCredentialService(store, { encrypt: () => Promise.reject(new Error(`CRYPTO_FAILED ${KEY}`)), decrypt: () => Promise.reject(new Error('x')) });
  const brokenError = await broken.set(KEY).then(() => null, (failure: unknown) => failure as Error);
  assert.equal(brokenError?.message, 'SERVICE_UNAVAILABLE', 'a bridge error message must not be passed through');
  assert.deepEqual(store.credentialStatus(), { configured: false });
  assert.equal(databaseBytes(directory).includes('LEAKPROBE'), false);
  // A ciphertext that cannot be decrypted any more is reported, never retried with something weaker.
  await createCredentialService(store, fakeBridge()).set(KEY);
  assert.deepEqual(await createCredentialService(store, UNAVAILABLE_BRIDGE).withKey(async () => 'unused'), { ok: false, reason: 'credential_unavailable' });
}));

test('saves and removals apply in request order, so an acknowledged removal is never undone by an earlier save', () => withStore(async store => {
  let release: () => void = () => {};
  const gate = new Promise<void>(done => { release = done; });
  const slow = fakeBridge();
  const credentials = createCredentialService(store, { ...slow, encrypt: async plaintext => { await gate; return slow.encrypt(plaintext); } });
  const saving = credentials.set(KEY);
  const clearing = credentials.clear();
  release();
  assert.equal((await saving).configured, true);
  assert.deepEqual(await clearing, { configured: false });
  assert.deepEqual(credentials.status(), { configured: false }, 'the later removal wins');
  // A failed save does not block the queue.
  await assert.rejects(createCredentialService(store, UNAVAILABLE_BRIDGE).set(KEY), /SECURE_STORAGE_UNAVAILABLE/);
  const failing = createCredentialService(store, UNAVAILABLE_BRIDGE);
  await failing.set(KEY).catch(() => {});
  assert.deepEqual(await failing.clear(), { configured: false });
}));

test('a crypto reply that arrives after its timeout is dropped without being mistaken for anything else', async () => {
  const sent: CryptoBridgeRequest[] = [];
  const bridge = createIpcCryptoBridge(identity, message => { sent.push(message); return true; });
  await assert.rejects(bridge.encrypt(KEY), /CRYPTO_FAILED/);
  const late = { kind: 'crypto-response', ...identity, requestId: sent[0]!.requestId, ok: true, value: 'Y2lwaGVy' };
  assert.equal(bridge.receive(late), 'expired');
});

test('the Express end of the Crypto Bridge matches replies by request id and service-tree identity, with bounds', async () => {
  const sent: CryptoBridgeRequest[] = [];
  const bridge = createIpcCryptoBridge(identity, message => { sent.push(message); return true; });
  const pending = bridge.encrypt(KEY);
  assert.equal(sent.length, 1); assert.equal(sent[0]!.operation, 'encrypt'); assert.equal(CryptoBridgeRequestSchema.safeParse(sent[0]).success, true);
  const reply = { kind: 'crypto-response', ...identity, requestId: sent[0]!.requestId, ok: true, value: 'Y2lwaGVy' };
  assert.equal(bridge.receive({ ...reply, expressRunId: randomUUID() }), 'foreign', 'a foreign service tree is not a crypto reply');
  assert.equal(bridge.receive({ ...reply, requestId: randomUUID() }), 'expired', 'an unknown request id settles nothing');
  assert.equal(bridge.receive({ kind: 'shutdown', ...identity }), 'foreign');
  assert.equal(bridge.receive(reply), 'resolved');
  assert.equal(await pending, 'Y2lwaGVy');
  assert.equal(bridge.receive(reply), 'expired', 'a reply is consumed once; a late duplicate is only dropped');
  const refused = bridge.decrypt('Y2lwaGVy');
  bridge.receive({ kind: 'crypto-response', ...identity, requestId: sent[1]!.requestId, ok: false, error: 'SECURE_STORAGE_UNAVAILABLE' });
  await assert.rejects(refused, /^Error: SECURE_STORAGE_UNAVAILABLE$/);
  const crowded = createIpcCryptoBridge(identity, () => true);
  const waits = Array.from({ length: 4 }, () => crowded.decrypt('Y2lwaGVy').catch((error: Error) => error.message));
  await assert.rejects(crowded.decrypt('Y2lwaGVy'), /CRYPTO_FAILED/);
  assert.deepEqual(await Promise.all(waits), Array(4).fill('CRYPTO_FAILED'), 'unanswered requests time out');
  await assert.rejects(createIpcCryptoBridge(identity, () => false).encrypt(KEY), /CRYPTO_FAILED/);
});

const fakeStore = (options: { available?: boolean; backend?: 'basic_text' | 'gnome_libsecret'; fail?: boolean } = {}): SecureStore & { calls: number } => {
  const state = { calls: 0 };
  return Object.assign(state, {
    isAsyncEncryptionAvailable: async () => options.available ?? true,
    getSelectedStorageBackend: () => options.backend ?? 'gnome_libsecret',
    encryptStringAsync: async (plain: string) => { state.calls++; if (options.fail) throw new Error(`failed for ${plain}`); return Buffer.from([...plain].reverse().join('') + '#'); },
    decryptStringAsync: async (data: Buffer) => { state.calls++; return { shouldReEncrypt: false, result: [...data.toString().slice(0, -1)].reverse().join('') }; },
  });
};

test('the Main Crypto Bridge serves only its own service tree and refuses without OS-backed storage (SEC-14)', async () => {
  const request = { kind: 'crypto-request', ...identity, requestId: randomUUID(), operation: 'encrypt', plaintext: KEY };
  const store = fakeStore(); const handle = createCryptoBridge(store, 'win32');
  const encrypted = await handle(identity, request);
  assert.equal(encrypted?.ok, true);
  const ciphertext = encrypted?.ok ? encrypted.value : '';
  assert.equal(Buffer.from(ciphertext, 'base64').toString().includes('LEAKPROBE'), false);
  const decrypted = await handle(identity, { kind: 'crypto-request', ...identity, requestId: randomUUID(), operation: 'decrypt', ciphertext });
  assert.deepEqual(decrypted && decrypted.ok ? decrypted.value : null, KEY);
  assert.equal(await handle({ ...identity, expressRunId: randomUUID() }, request), null, 'another Express instance gets no reply');
  assert.equal(await handle(identity, { ...request, operation: 'exec' }), null);
  assert.equal(await handle(identity, 'encrypt'), null);
  const unavailable = fakeStore({ available: false });
  const refused = await createCryptoBridge(unavailable, 'win32')(identity, request);
  assert.deepEqual(refused && !refused.ok ? refused.error : null, 'SECURE_STORAGE_UNAVAILABLE'); assert.equal(unavailable.calls, 0);
  const plainText = await createCryptoBridge(fakeStore({ backend: 'basic_text' }), 'linux')(identity, request);
  assert.deepEqual(plainText && !plainText.ok ? plainText.error : null, 'SECURE_STORAGE_UNAVAILABLE', "Linux's plain-text backend is refused");
  assert.equal(await secureStorageAvailable(fakeStore({ backend: 'basic_text' }), 'win32'), true);
  const failed = await createCryptoBridge(fakeStore({ fail: true }), 'win32')(identity, request);
  assert.equal(JSON.stringify(failed).includes('LEAKPROBE'), false); assert.deepEqual(failed && !failed.ok ? failed.error : null, 'CRYPTO_FAILED');
});

async function fakeProvider(respond: (headers: IncomingHttpHeaders, body: string, url: string) => { status: number; headers?: Record<string, string> }) {
  const seen: { headers: IncomingHttpHeaders; body: string; url: string }[] = [];
  const server: Server = createServer((req, res) => {
    let body = ''; req.on('data', chunk => { body += chunk; });
    req.on('end', () => { seen.push({ headers: req.headers, body, url: req.url ?? '' }); const reply = respond(req.headers, body, req.url ?? '');
      res.writeHead(reply.status, { 'content-type': 'application/json', ...reply.headers }); res.end(JSON.stringify({ type: 'error', error: { message: `echo ${KEY}` } })); });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  return { seen, endpoint: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`, close: () => new Promise<void>(done => server.close(() => done())) };
}

test('the Model Gateway sends one minimal Messages request and normalises every outcome without provider text', async () => {
  let status = 200;
  const provider = await fakeProvider(() => ({ status }));
  try {
    const gateway = createModelGateway({ endpoint: provider.endpoint, timeoutMs: 2_000 });
    const ok = await gateway.testConnection(KEY, 'claude-haiku-5-5');
    assert.equal(ok.status, 'ok'); assert.equal(ok.httpStatus, 200); assert.equal(ok.model, 'claude-haiku-5-5');
    const request = provider.seen[0]!;
    assert.equal(request.url, '/v1/messages'); assert.equal(request.headers['x-api-key'], KEY); assert.equal(request.headers['anthropic-version'], '2023-06-01');
    assert.deepEqual(JSON.parse(request.body), { model: 'claude-haiku-5-5', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] });
    for (const [code, expected] of [[401, 'auth_failed'], [403, 'auth_failed'], [429, 'rate_limited'], [404, 'model_unavailable'], [529, 'provider_error'], [500, 'provider_error']] as const) {
      status = code;
      const result = await gateway.testConnection(KEY, 'claude-sonnet-5-5');
      assert.equal(result.status, expected, String(code));
      assert.equal(JSON.stringify(result).includes('LEAKPROBE'), false, 'provider text and the key never reach the result');
    }
  } finally { await provider.close(); }
  const closed = await createModelGateway({ endpoint: provider.endpoint, timeoutMs: 1_000 }).testConnection(KEY, 'claude-sonnet-5-5');
  assert.deepEqual([closed.status, closed.httpStatus, closed.latencyMs], ['unreachable', null, null]);
  assert.throws(() => createModelGateway({ endpoint: 'https://proxy.example' }), 'only the fixed endpoint or a loopback fake is accepted');
});

test('a redirect never carries the key elsewhere, and a slow provider times out as unreachable', async () => {
  const target = await fakeProvider(() => ({ status: 200 }));
  const redirecting = await fakeProvider(() => ({ status: 307, headers: { location: `${target.endpoint}/v1/messages` } }));
  const slow = createServer(() => { /* never answers */ }); slow.listen(0, '127.0.0.1'); await once(slow, 'listening');
  const slowAddress = slow.address();
  try {
    const result = await createModelGateway({ endpoint: redirecting.endpoint, timeoutMs: 2_000 }).testConnection(KEY, 'claude-sonnet-5-5');
    assert.equal(result.status, 'unreachable'); assert.equal(target.seen.length, 0, 'the redirect target never saw a request');
    const started = Date.now();
    const timedOut = await createModelGateway({ endpoint: `http://127.0.0.1:${typeof slowAddress === 'object' && slowAddress ? slowAddress.port : 0}`, timeoutMs: 300 })
      .testConnection(KEY, 'claude-sonnet-5-5');
    assert.equal(timedOut.status, 'unreachable'); assert.ok(Date.now() - started < 3_000);
  } finally { slow.closeAllConnections(); slow.close(); await target.close(); await redirecting.close(); }
});
