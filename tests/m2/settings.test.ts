import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';
import { once } from 'node:events';
import { AgentSaveSchema, BUILT_IN_AGENTS, CONTROL_ROUTES, DEFAULT_WORKBENCH_SETTINGS, IPC_CHANNELS, McpServerSaveSchema, ModelIdSchema,
  ProviderKeyInputSchema, ProviderOverviewViewSchema, THEME_CANVAS, THEME_IDS, WorkbenchSettingsSchema, readStoredSettings } from '../../packages/contracts/dist/index.js';
import type { AgentSave } from '../../packages/contracts/dist/index.js';
import { openStore } from '../../apps/server/dist/persistence/store.js';
import type { Store } from '../../apps/server/dist/persistence/store.js';
import { createCredentialService } from '../../apps/server/dist/credentials/service.js';
import type { CryptoBridge } from '../../apps/server/dist/credentials/bridge.js';
import { createProviderGateway } from '../../apps/server/dist/models/providers.js';

const KEY = `sk-proj-${randomUUID().replaceAll('-', '')}LEAKPROBE${'y'.repeat(30)}Hk9P`;
const fakeBridge = (): CryptoBridge => {
  const flip = (value: string): string => Buffer.from(Buffer.from(value, 'latin1').map(byte => byte ^ 0x5a)).toString('latin1');
  return { encrypt: async plaintext => Buffer.from(flip(plaintext), 'latin1').toString('base64'),
    decrypt: async ciphertext => flip(Buffer.from(ciphertext, 'base64').toString('latin1')) };
};
function withStore(run: (store: Store, directory: string) => Promise<void> | void): Promise<void> {
  const cache = resolve('.cache'); mkdirSync(cache, { recursive: true });
  const directory = mkdtempSync(resolve(cache, 'settings-'));
  const store = openStore(directory, randomUUID());
  return (async () => { try { await run(store, directory); } finally { store.close(true); if (directory.startsWith(cache + sep)) rmSync(directory, { recursive: true, force: true }); } })();
}
const databaseBytes = (directory: string): string =>
  readdirSync(directory).filter(name => name.startsWith('control-plane.sqlite')).map(name => readFileSync(resolve(directory, name)).toString('latin1')).join('');
const agent = (patch: Partial<AgentSave> = {}): AgentSave =>
  ({ name: 'docs-writer', description: 'Writes docs', mode: 'subagent', model: null, prompt: 'Be brief.', tools: ['read_file'], ...patch });

test('settings: older saved shapes gain new defaults, invalid values fall back, palettes cover both variants', () => {
  const legacy = { theme: 'dark', density: 'compact', contextPanel: false, stopGraceMs: 10_000, activeProjectId: null };
  assert.deepEqual(readStoredSettings(legacy), { ...DEFAULT_WORKBENCH_SETTINGS, ...legacy }, 'a 005-era row keeps its values');
  assert.deepEqual(readStoredSettings({ ...legacy, language: 'fr' }), DEFAULT_WORKBENCH_SETTINGS);
  assert.deepEqual(readStoredSettings({ ...legacy, injected: true }), DEFAULT_WORKBENCH_SETTINGS);
  assert.deepEqual(readStoredSettings([1, 2]), DEFAULT_WORKBENCH_SETTINGS);
  assert.equal(DEFAULT_WORKBENCH_SETTINGS.webSearchMode, 'off', 'web search is opted into, never assumed');
  assert.equal(WorkbenchSettingsSchema.safeParse({ ...DEFAULT_WORKBENCH_SETTINGS, lightTheme: 'dracula' }).success, false);
  for (const id of THEME_IDS) for (const variant of ['light', 'dark'] as const) {
    assert.match(THEME_CANVAS[id][variant].bg, /^#[0-9a-f]{6}$/); assert.match(THEME_CANVAS[id][variant].text, /^#[0-9a-f]{6}$/);
  }
});

test('provider and agent contracts: fixed slots, inert ids, bounded definitions, safe MCP URLs', () => {
  assert.equal(ProviderKeyInputSchema.safeParse({ provider: 'openai', apiKey: KEY }).success, true);
  assert.equal(ProviderKeyInputSchema.safeParse({ provider: 'anthropic', apiKey: KEY }).success, false, 'Anthropic keeps its own operation');
  assert.equal(ProviderKeyInputSchema.safeParse({ provider: 'custom', apiKey: KEY }).success, false, 'no custom endpoint before ADR-PROV-001');
  for (const id of ['gpt-5', 'gemini-2.5-pro', 'openai/gpt-4o:free', 'meta-llama/llama-3@latest']) assert.equal(ModelIdSchema.safeParse(id).success, true, id);
  for (const id of ['', 'has space', 'quote"d', '-leading', 'a'.repeat(129), 'line\nbreak']) assert.equal(ModelIdSchema.safeParse(id).success, false, id);
  assert.equal(ProviderOverviewViewSchema.safeParse({ providers: [{ provider: 'openai', model: null, credential: { configured: true, hint: 'Hk9P',
    updatedAt: new Date().toISOString(), apiKey: KEY } }], search: [], secureStorage: 'available' }).success, false, 'a view can never carry key material');
  assert.equal(AgentSaveSchema.safeParse(agent()).success, true);
  for (const bad of [agent({ name: 'Bad Name' }), agent({ tools: ['read_file', 'read_file'] }), agent({ prompt: 'x'.repeat(3_001) }),
    agent({ tools: ['format_disk' as never] }), { ...agent(), extra: 1 }]) assert.equal(AgentSaveSchema.safeParse(bad).success, false, JSON.stringify(bad).slice(0, 60));
  const http = { transport: 'http', name: 'docs', enabled: true } as const;
  for (const url of ['https://mcp.example.com/sse', 'http://127.0.0.1:3000/mcp', 'http://localhost:8080', 'https://a.b/x?y=1'])
    assert.equal(McpServerSaveSchema.safeParse({ ...http, url }).success, true, url);
  for (const url of ['http://mcp.example.com', 'https://user:pass@mcp.example.com', 'https://token@host', 'file:///etc/passwd', 'https://host/\nx', 'javascript:alert(1)'])
    assert.equal(McpServerSaveSchema.safeParse({ ...http, url }).success, false, url);
  assert.equal(McpServerSaveSchema.safeParse({ transport: 'stdio', name: 'fs', enabled: false, command: 'npx', args: ['-y', 'server'] }).success, true);
  assert.equal(McpServerSaveSchema.safeParse({ transport: 'stdio', name: 'fs', enabled: false, command: 'npx', args: ['a\u0000b'] }).success, false);
  assert.equal(McpServerSaveSchema.safeParse({ transport: 'stdio', name: 'fs', enabled: false, command: 'npx', args: [], env: { TOKEN: 'x' } }).success, false,
    'no environment values: secrets never live in a definition');
  assert.equal(CONTROL_ROUTES.providerCredential, '/v1/providers/credential');
  assert.equal(new Set(Object.values(IPC_CHANNELS)).size, Object.values(IPC_CHANNELS).length, 'every IPC channel is distinct');
});

test('linked-provider and search keys are stored per slot as ciphertext only; the Anthropic slot is untouched', () => withStore(async (store, directory) => {
  assert.equal(store.databaseVersion, 8);
  const openai = createCredentialService(store.credentialStore('openai'), fakeBridge());
  const tavily = createCredentialService(store.credentialStore('tavily'), fakeBridge());
  const saved = await openai.set(KEY);
  assert.equal(saved.configured && saved.hint, 'Hk9P');
  assert.deepEqual(tavily.status(), { configured: false }, 'slots are independent');
  assert.deepEqual(store.credentialStatus(), { configured: false }, 'the Anthropic key is a separate slot');
  await tavily.set(KEY);
  assert.equal(databaseBytes(directory).includes('LEAKPROBE'), false, 'plaintext key found in SQLite files');
  assert.deepEqual(await openai.withKey(async key => key === KEY), { ok: true, value: true });
  assert.deepEqual(await openai.clear(), { configured: false });
  assert.equal(tavily.status().configured, true);
  assert.equal(store.getProviderModel('google'), null);
  assert.equal(store.saveProviderModel('google', 'gemini-2.5-pro'), 'gemini-2.5-pro');
  assert.throws(() => store.saveProviderModel('google', 'bad id'));
  assert.throws(() => store.saveProviderModel('anthropic' as never, 'claude-opus-5-5'));
}));

test('agent and MCP definitions: reserved names, unique names, bounds and rollback, removal', () => withStore(store => {
  for (const builtIn of BUILT_IN_AGENTS) assert.throws(() => store.saveAgent(agent({ name: builtIn.name })), /RECORD_CONFLICT/, builtIn.name);
  const [created] = store.saveAgent(agent());
  assert.ok(created); assert.equal(created.name, 'docs-writer');
  assert.throws(() => store.saveAgent(agent()), (error: Error & { code?: string }) => String(error.code).startsWith('SQLITE_CONSTRAINT'), 'names are unique');
  const updated = store.saveAgent({ ...agent({ description: 'Writes changelogs', tools: ['read_file', 'git_read'] }), id: created.id });
  assert.equal(updated.length, 1); assert.equal(updated[0]?.description, 'Writes changelogs'); assert.equal(updated[0]?.createdAt, created.createdAt);
  assert.throws(() => store.saveAgent({ ...agent({ name: 'ghost' }), id: randomUUID() }), /NOT_FOUND/);
  for (let index = 1; index < 16; index++) store.saveAgent(agent({ name: `agent-${index}` }));
  assert.throws(() => store.saveAgent(agent({ name: 'one-too-many' })), /LIMIT_EXCEEDED/);
  assert.equal(store.listAgents().length, 16, 'a refused save leaves nothing behind');
  assert.equal(store.removeAgent(created.id), true); assert.equal(store.removeAgent(created.id), false);
  // A list that would not fit in one bounded reply is rolled back.
  // A control character serialises as six bytes, so a few full prompts exceed the reply bound.
  const heavy = '\u0001'.repeat(3_000);
  const refused = store.listAgents().find(item => {
    try { store.saveAgent({ ...agent({ name: item.name, prompt: heavy }), id: item.id }); return false; }
    catch (error) { assert.match(String(error), /LIMIT_EXCEEDED/); return true; }
  });
  assert.ok(refused, 'the reply bound was reached');
  assert.equal(store.listAgents().find(item => item.id === refused.id)?.prompt, 'Be brief.', 'the refused save was rolled back');

  const [server] = store.saveMcpServer({ transport: 'stdio', name: 'filesystem', enabled: false, command: 'npx', args: ['-y', '@scope/server'] });
  assert.ok(server); assert.equal(server.transport, 'stdio');
  const replaced = store.saveMcpServer({ transport: 'http', name: 'filesystem', enabled: true, url: 'https://mcp.example.com', id: server.id });
  assert.equal(replaced[0]?.transport, 'http'); assert.equal(replaced.length, 1);
  assert.equal(store.removeMcpServer(server.id), true); assert.deepEqual(store.listMcpServers(), []);
}));

async function fakeProvider(respond: (url: string, headers: IncomingHttpHeaders) => { status: number; body?: unknown; raw?: string; headers?: Record<string, string> }) {
  const seen: { url: string; headers: IncomingHttpHeaders }[] = [];
  const server: Server = createServer((req, res) => {
    seen.push({ url: req.url ?? '', headers: req.headers });
    const reply = respond(req.url ?? '', req.headers);
    res.writeHead(reply.status, { 'content-type': 'application/json', ...reply.headers });
    res.end(reply.raw ?? JSON.stringify(reply.body ?? { error: { message: `echo ${KEY}` } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  return { seen, endpoint: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`, close: () => new Promise<void>(done => server.close(() => done())) };
}

test('the provider gateway uses each fixed request shape, keeps only valid ids and never returns provider text', async () => {
  let status = 200;
  const provider = await fakeProvider(url => {
    if (url.startsWith('/v1/models') && url !== '/v1/models') return { status };
    if (url === '/v1/models') return { status, body: { data: [{ id: 'gpt-5' }, { id: 'gpt-5-mini' }, { id: `bad id ${KEY}` }, { id: 7 }, { id: 'gpt-5' }] } };
    if (url.startsWith('/v1beta/models?')) return { status, body: { models: [
      { name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/text-embedding', supportedGenerationMethods: ['embedContent'] }] } };
    if (url === '/api/v1/models') return { status, body: { data: [{ id: 'anthropic/claude-opus-5-5' }, { id: 'openai/gpt-5:free' }] } };
    return { status };
  });
  try {
    const gateway = createProviderGateway({ endpoints: { openai: provider.endpoint, google: provider.endpoint, openrouter: provider.endpoint }, timeoutMs: 2_000 });
    const openaiTest = await gateway.test('openai', KEY, 'gpt-5');
    assert.deepEqual([openaiTest.status, openaiTest.model, openaiTest.httpStatus], ['ok', 'gpt-5', 200]);
    assert.equal(provider.seen.at(-1)?.url, '/v1/models/gpt-5'); assert.equal(provider.seen.at(-1)?.headers.authorization, `Bearer ${KEY}`);
    const openaiList = await gateway.listModels('openai', KEY);
    assert.deepEqual(openaiList.models, ['gpt-5', 'gpt-5-mini'], 'invalid and duplicate ids are dropped');
    const googleList = await gateway.listModels('google', KEY);
    assert.deepEqual(googleList.models, ['gemini-2.5-pro']); assert.equal(provider.seen.at(-1)?.headers['x-goog-api-key'], KEY);
    assert.equal(provider.seen.at(-1)?.headers.authorization, undefined);
    const routerList = await gateway.listModels('openrouter', KEY);
    assert.deepEqual(routerList.models, ['anthropic/claude-opus-5-5', 'openai/gpt-5:free']);
    assert.equal(provider.seen.at(-1)?.headers.authorization, undefined, 'the public catalogue never receives the key');
    await gateway.test('openrouter', KEY, 'openai/gpt-5:free');
    assert.equal(provider.seen.at(-1)?.url, '/api/v1/key');
    for (const [code, expected] of [[401, 'auth_failed'], [429, 'rate_limited'], [404, 'model_unavailable'], [500, 'provider_error']] as const) {
      status = code;
      const tested = await gateway.test('google', KEY, 'gemini-2.5-pro');
      const listed = await gateway.listModels('openai', KEY);
      assert.equal(tested.status, expected, String(code)); assert.deepEqual(listed.models, []);
      assert.equal(JSON.stringify([tested, listed]).includes('LEAKPROBE'), false, 'provider text and the key never reach a result');
    }
  } finally { await provider.close(); }
  const closed = await createProviderGateway({ endpoints: { openai: provider.endpoint }, timeoutMs: 1_000 }).test('openai', KEY, null);
  assert.deepEqual([closed.status, closed.httpStatus], ['unreachable', null]);
  assert.throws(() => createProviderGateway({ endpoints: { openai: 'https://proxy.example' } }), 'only the fixed endpoint or a loopback fake is accepted');
});

test('a redirecting or malformed provider fails closed', async () => {
  const target = await fakeProvider(() => ({ status: 200, body: { data: [{ id: 'gpt-5' }] } }));
  const redirecting = await fakeProvider(() => ({ status: 307, headers: { location: `${target.endpoint}/v1/models` } }));
  const malformed = await fakeProvider(() => ({ status: 200, raw: '{"data": [' }));
  try {
    const moved = await createProviderGateway({ endpoints: { openai: redirecting.endpoint }, timeoutMs: 2_000 }).listModels('openai', KEY);
    assert.equal(moved.status, 'unreachable'); assert.equal(target.seen.length, 0, 'the redirect target never saw the key');
    const broken = await createProviderGateway({ endpoints: { openai: malformed.endpoint }, timeoutMs: 2_000 }).listModels('openai', KEY);
    assert.deepEqual([broken.status, broken.models], ['provider_error', []]);
  } finally { await target.close(); await redirecting.close(); await malformed.close(); }
});
