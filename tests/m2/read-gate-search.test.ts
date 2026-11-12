import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { AGENT_TOOL_DEFINITIONS, FindFilesArgsSchema, READ_CHILD_PROTOCOL, READ_FILE_LIMITS, ReadChildReplySchema, ReadChildRequestSchema, ReadFileArgsSchema,
  SearchTextArgsSchema } from '../../packages/contracts/dist/index.js';
import { openStore } from '../../apps/server/dist/persistence/store.js';
import type { Store } from '../../apps/server/dist/persistence/store.js';
import { READ_CHILD_SCRIPT, createReadAdapter, readChildArguments, readChildEnvironment } from '../../apps/server/dist/tools/read-adapter.js';
import { SENSITIVE_FILE_POLICY, TREE_SKIP_SEQUENCES, normalizeFileNamePattern, normalizeReadPath } from '../../apps/server/dist/tools/read-path.js';
import { TOOL_REGISTRY } from '../../apps/server/dist/tools/registry.js';
import { createToolRouter } from '../../apps/server/dist/tools/router.js';
import { formatFindResult, formatReadResult, formatSearchResult } from '../../apps/server/dist/agent/tool-results.js';

// SEC-08 Read Gate for the M5.2 read operations (ADR-PLAT-001 D3): read_file line ranges, search_text and find_files.
// Like the original gate, every case that touches the file system runs the real child program in a real, separate,
// short-lived Node process with the production arguments and environment. The new operations walk whole trees and open
// many files, so they get the same tests as list_directory (links, sensitive directories, swapped directories) plus the
// ones specific to them: content from outside never comes back, sensitive files are never opened, every limit holds.

const WINDOWS = process.platform === 'win32' && process.arch === 'x64';
const SECRET = `OA-OUTSIDE-CANARY-${randomUUID()}`;
const NEEDLE = 'oa_needle_symbol';

interface Fixture { root: string; outside: string; store: Store; projectId: string }
async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const cache = resolve('.cache'); mkdirSync(cache, { recursive: true });
  const base = mkdtempSync(resolve(cache, 'read-gate-search-'));
  const root = resolve(base, 'workspace'); const outside = resolve(base, 'outside');
  mkdirSync(resolve(root, 'src', 'deep'), { recursive: true }); mkdirSync(outside);
  writeFileSync(resolve(root, 'src', 'main.ts'), `export function ${NEEDLE}() { return 1; }\n`);
  writeFileSync(resolve(root, 'src', 'deep', 'use.test.ts'), `import { ${NEEDLE} } from '../main';\n${NEEDLE}();\n`);
  // Everything below holds the needle and must never be searched or returned.
  writeFileSync(resolve(outside, 'secret.ts'), `${NEEDLE} ${SECRET}\n`);
  mkdirSync(resolve(root, '.git')); writeFileSync(resolve(root, '.git', 'config.ts'), `${NEEDLE} ${SECRET}\n`);
  mkdirSync(resolve(root, 'node_modules', 'dep'), { recursive: true }); writeFileSync(resolve(root, 'node_modules', 'dep', 'index.ts'), `${NEEDLE} ${SECRET}\n`);
  mkdirSync(resolve(root, '.config', 'gcloud'), { recursive: true }); writeFileSync(resolve(root, '.config', 'gcloud', 'creds.ts'), `${NEEDLE} ${SECRET}\n`);
  writeFileSync(resolve(root, '.env'), `TOKEN=${NEEDLE}-${SECRET}`);
  writeFileSync(resolve(root, 'prod.env'), `TOKEN=${NEEDLE}-${SECRET}`);
  writeFileSync(resolve(root, 'server.key'), `${NEEDLE} ${SECRET}`);
  writeFileSync(resolve(root, 'credentials.json'), `{"k":"${NEEDLE} ${SECRET}"}`);
  writeFileSync(resolve(root, 'id_rsa'), `${NEEDLE} ${SECRET}`);
  writeFileSync(resolve(root, 'blob.bin'), Buffer.concat([Buffer.from(`${NEEDLE} `), Buffer.from([0, 1, 2]), Buffer.from(SECRET)]));
  writeFileSync(resolve(root, '.env.example'), `TOKEN=${NEEDLE}-placeholder\n`);
  const store = openStore(resolve(base, 'data'), randomUUID());
  const projectId = store.addProject({ name: 'gate', path: root }).id;
  try { await run({ root, outside, store, projectId }); }
  finally { store.close(true); if (base.startsWith(cache + sep)) rmSync(base, { recursive: true, force: true }); }
}

/** One raw request line to the real child under the production launch; the reply line parsed, or null with no reply. */
function rawChild(root: string, line: string): Promise<{ exitCode: number | null; reply: unknown }> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, readChildArguments(root, READ_CHILD_SCRIPT), { env: readChildEnvironment(), shell: false, windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.resume();
    child.on('error', fail);
    child.on('close', exitCode => { const text = Buffer.concat(out).toString('utf8'); done({ exitCode, reply: text ? JSON.parse(text) as unknown : null }); });
    child.stdin.end(line + '\n');
  });
}

test('M5.2 contracts: arguments and the child protocol are strict, and the model sees every argument', () => {
  for (const [name, schema] of [['read_file', ReadFileArgsSchema], ['search_text', SearchTextArgsSchema], ['find_files', FindFilesArgsSchema]] as const) {
    const json = AGENT_TOOL_DEFINITIONS[name].input_schema as { required: string[]; properties: Record<string, unknown>; additionalProperties: boolean };
    assert.equal(json.additionalProperties, false, name);
    assert.deepEqual(Object.keys(json.properties).sort(), Object.keys(schema.shape).sort(), name);
    assert.deepEqual(json.required, Object.entries(schema.shape).filter(([, field]) => !field.isOptional()).map(([key]) => key), name);
  }
  for (const bad of [{ query: '' }, { query: 'x'.repeat(READ_FILE_LIMITS.maxQueryChars + 1) }, { query: 'x', maxResults: READ_FILE_LIMITS.maxSearchResults + 1 },
    { query: 'x', extra: 1 }]) assert.equal(SearchTextArgsSchema.safeParse(bad).success, false, JSON.stringify(bad).slice(0, 80));
  for (const bad of [{ path: 'a', startLine: 0 }, { path: 'a', lineCount: READ_FILE_LIMITS.maxLineCount + 1 }, { path: 'a', startLine: 1.5 }]) {
    assert.equal(ReadFileArgsSchema.safeParse(bad).success, false, JSON.stringify(bad));
  }
  // A range is both fields or neither, on the wire to the child.
  const read = { v: READ_CHILD_PROTOCOL, op: 'read', segments: ['a'], maxBytes: 10 };
  assert.equal(ReadChildRequestSchema.safeParse(read).success, true);
  assert.equal(ReadChildRequestSchema.safeParse({ ...read, startLine: 3 }).success, false);
  assert.equal(ReadChildRequestSchema.safeParse({ ...read, startLine: 3, lineCount: 2 }).success, true);
  assert.equal(ReadChildReplySchema.safeParse({ v: READ_CHILD_PROTOCOL, status: 'matched', matches: [], truncated: false, filesScanned: 1, filesSkipped: 0,
    note: 'x' }).success, false, 'unknown reply fields are refused');
  // Tree walks have their own, longer deadline, still inside the frozen range.
  for (const name of ['search_text', 'find_files'] as const) {
    assert.ok(TOOL_REGISTRY[name].timeoutMs > READ_FILE_LIMITS.searchBudgetMs && TOOL_REGISTRY[name].timeoutMs <= READ_FILE_LIMITS.maxTimeoutMs);
  }
});

test('M5.2 policy: name patterns name files only, and the child gets exactly the sensitive-name rules Express applies', () => {
  assert.deepEqual(normalizeFileNamePattern('*.ts'), { ok: true, glob: '*.ts' });
  assert.deepEqual(normalizeFileNamePattern('**/*.test.ts'), { ok: true, glob: '*.test.ts' });
  assert.deepEqual(normalizeFileNamePattern('  Dockerfile*  '), { ok: true, glob: 'Dockerfile*' });
  for (const bad of ['', '   ', '**/', 'src/*.ts', 'a\\b', '../*', 'a\u0000', 'x'.repeat(READ_FILE_LIMITS.maxGlobChars + 1)]) {
    assert.deepEqual(normalizeFileNamePattern(bad), { ok: false }, JSON.stringify(bad));
  }
  // Every name, suffix and prefix the child is told to avoid is one Express would refuse to read, and the env templates
  // it may open are ones Express allows.
  for (const name of SENSITIVE_FILE_POLICY.names) assert.equal(normalizeReadPath(`dir/${name}`).ok, false, name);
  for (const suffix of SENSITIVE_FILE_POLICY.suffixes) assert.equal(normalizeReadPath(`dir/file${suffix}`).ok, false, suffix);
  for (const prefix of SENSITIVE_FILE_POLICY.prefixes) assert.equal(normalizeReadPath(`dir/${prefix}`).ok, false, prefix);
  for (const name of SENSITIVE_FILE_POLICY.envAllow) assert.equal(normalizeReadPath(name).ok, true, name);
  assert.deepEqual(TREE_SKIP_SEQUENCES.map(sequence => sequence.join('/')), ['.config/gcloud']);
});

test('M5.2 platforms without a Read Gate: search_text and find_files fail closed and launch nothing', async () => {
  await withFixture(async ({ store, projectId }) => {
    const adapter = createReadAdapter();
    const router = createToolRouter({ store, adapter, platform: 'linux-x64' });
    assert.deepEqual(await router.searchText({ projectId, args: { query: NEEDLE } }), { status: 'failed', code: 'READ_ADAPTER_UNAVAILABLE', retryable: false });
    assert.deepEqual(await router.findFiles({ projectId, args: { pattern: '*.ts' } }), { status: 'failed', code: 'READ_ADAPTER_UNAVAILABLE', retryable: false });
    assert.deepEqual(await router.readFile({ projectId, args: { path: 'src/main.ts', startLine: 1 } }), { status: 'failed', code: 'READ_ADAPTER_UNAVAILABLE', retryable: false });
    assert.equal(adapter.snapshot().launched, 0);
    // An invalid query or pattern is refused before anything else, on every platform.
    assert.deepEqual(await router.searchText({ projectId, args: { query: '(', regex: true } }), { status: 'refused', code: 'INVALID_QUERY' });
    assert.deepEqual(await router.findFiles({ projectId, args: { pattern: 'src/*.ts' } }), { status: 'refused', code: 'INVALID_QUERY' });
    assert.equal(adapter.snapshot().launched, 0);
  });
});

test('SEC-08 Windows search_text: finds the needle, never in .git, node_modules, secret directories, secret files, binaries or outside',
  { skip: !WINDOWS && 'win32-x64 only' }, async () => {
    await withFixture(async ({ root, outside, store, projectId }) => {
      // Links to the outside, as a junction and as a hard link, must not widen the search either.
      symlinkSync(outside, resolve(root, 'src', 'away'), 'junction');
      linkSync(resolve(outside, 'secret.ts'), resolve(root, 'src', 'hardlinked.ts'));
      const router = createToolRouter({ store });
      const result = await router.searchText({ projectId, args: { query: NEEDLE } });
      assert.equal(result.status, 'ok');
      if (result.status !== 'ok') return;
      assert.deepEqual(result.matches.map(match => `${match.path}:${match.line}`).sort(),
        ['.env.example:1', 'src/deep/use.test.ts:1', 'src/deep/use.test.ts:2', 'src/main.ts:1']);
      assert.ok(!JSON.stringify(result).includes(SECRET), 'content from outside the workspace or from a secret was returned');
      assert.ok(result.filesSkipped >= 2, 'the binary file and the hard-linked file are skipped, not read');
      // A search rooted at a sensitive directory or file is refused like a read; one rooted at a single file searches it.
      for (const path of ['.git', 'node_modules/../.git', '.env', '.config/gcloud']) {
        const refused = await router.searchText({ projectId, args: { query: NEEDLE, path } });
        assert.equal(refused.status, 'refused', path);
      }
      const single = await router.searchText({ projectId, args: { query: NEEDLE, path: 'src/deep/use.test.ts' } });
      assert.ok(single.status === 'ok' && single.matches.length === 2 && single.filesScanned === 1);
      // Case, regular expressions and name filters.
      const loud = await router.searchText({ projectId, args: { query: NEEDLE.toUpperCase(), ignoreCase: true, fileNames: '*.test.ts' } });
      assert.ok(loud.status === 'ok' && loud.matches.every(match => match.path === 'src/deep/use.test.ts') && loud.matches.length === 2);
      const pattern = await router.searchText({ projectId, args: { query: `function\\s+${NEEDLE}\\(`, regex: true } });
      assert.ok(pattern.status === 'ok' && pattern.matches.length === 1 && pattern.matches[0]!.path === 'src/main.ts');
      // The audit records where each search ran and how many matches it returned, never the query.
      const rows = store.listToolAudit(50).filter(row => row.toolId === 'search_text');
      assert.ok(rows.length >= 8 && rows.every(row => !JSON.stringify(row).includes(NEEDLE)));
      assert.ok(rows.some(row => row.decision === 'allowed' && row.path === '.' && row.bytes === 4));
    });
  });

test('SEC-08 Windows find_files: names below the root only, links reported but never followed, secret directories never entered',
  { skip: !WINDOWS && 'win32-x64 only' }, async () => {
    await withFixture(async ({ root, outside, store, projectId }) => {
      writeFileSync(resolve(outside, `${SECRET}.ts`), 'x');
      symlinkSync(outside, resolve(root, 'src', 'away'), 'junction');
      const router = createToolRouter({ store });
      const all = await router.findFiles({ projectId, args: { pattern: '*' } });
      assert.equal(all.status, 'ok');
      if (all.status !== 'ok') return;
      assert.ok(!JSON.stringify(all).includes(SECRET), 'a name from outside the workspace was returned');
      assert.ok(all.entries.some(entry => entry.path === 'src/away' && entry.type === 'link'), 'the junction itself is reported');
      assert.ok(!all.entries.some(entry => /^(\.git|node_modules|\.config\/gcloud)\//.test(entry.path)), 'a skipped directory was entered');
      const tests = await router.findFiles({ projectId, args: { pattern: '*.TEST.ts', path: 'src' } });
      assert.deepEqual(tests.status === 'ok' && tests.entries.map(entry => entry.path), ['src/deep/use.test.ts']);
      const capped = await router.findFiles({ projectId, args: { pattern: '*', maxResults: 2 } });
      assert.ok(capped.status === 'ok' && capped.entries.length === 2 && capped.truncated);
      assert.equal((await router.findFiles({ projectId, args: { pattern: '*', path: '../outside' } })).status, 'refused');
    });
  });

test('SEC-08 Windows read_file ranges: exact lines, CRLF and UTF-8 kept, byte limit on a character boundary, binary still refused',
  { skip: !WINDOWS && 'win32-x64 only' }, async () => {
    await withFixture(async ({ root, store, projectId }) => {
      writeFileSync(resolve(root, 'lines.txt'), Array.from({ length: 50 }, (_, index) => `L${index + 1}`).join('\r\n') + '\r\n');
      writeFileSync(resolve(root, 'noeol.txt'), 'a\nb\nc');
      writeFileSync(resolve(root, 'wide.txt'), '😀'.repeat(100) + '\n');
      const router = createToolRouter({ store });
      const middle = await router.readFile({ projectId, args: { path: 'lines.txt', startLine: 10, lineCount: 3 } });
      assert.ok(middle.status === 'ok');
      if (middle.status !== 'ok') return;
      assert.equal(middle.content, 'L10\r\nL11\r\nL12\r\n');
      assert.deepEqual(middle.range, { startLine: 10, lines: 3, totalLines: 50 });
      const tail = await router.readFile({ projectId, args: { path: 'noeol.txt', startLine: 2 } });
      assert.ok(tail.status === 'ok' && tail.content === 'b\nc' && tail.range?.lines === 2 && tail.range.totalLines === 3);
      const past = await router.readFile({ projectId, args: { path: 'noeol.txt', startLine: 9 } });
      assert.ok(past.status === 'ok' && past.content === '' && past.range?.lines === 0 && past.range.totalLines === 3);
      assert.match(formatReadResult(past, 'noeol.txt').content, /has no line 9; it has 3 lines/);
      const countOnly = await router.readFile({ projectId, args: { path: 'lines.txt', lineCount: 2 } });
      assert.ok(countOnly.status === 'ok' && countOnly.content === 'L1\r\nL2\r\n');
      // 10 bytes cannot hold three 4-byte characters: the cut falls back to a whole character.
      const cut = await router.readFile({ projectId, args: { path: 'wide.txt', startLine: 1, maxBytes: 10 } });
      assert.ok(cut.status === 'ok' && cut.content === '😀😀' && cut.truncated);
      assert.deepEqual(await router.readFile({ projectId, args: { path: 'blob.bin', startLine: 1 } }), { status: 'refused', code: 'BINARY_FILE' });
      assert.deepEqual(await router.readFile({ projectId, args: { path: '.env', startLine: 1 } }), { status: 'refused', code: 'SENSITIVE_PATH' });
    });
  });

test('SEC-08 Windows: the child refuses malformed and old-protocol requests itself, whatever Express would send',
  { skip: !WINDOWS && 'win32-x64 only' }, async () => {
    await withFixture(async ({ root }) => {
      const search = { v: READ_CHILD_PROTOCOL, op: 'search', segments: [], budgetMs: 1_000, maxResults: 5, skip: [], skipSequences: [], query: NEEDLE,
        regex: false, ignoreCase: false, glob: null, sensitive: { names: [], suffixes: [], prefixes: [], envAllow: [] } };
      const ok = await rawChild(root, JSON.stringify(search));
      assert.equal((ok.reply as { status: string }).status, 'matched');
      for (const bad of [{ ...search, v: 1 }, { ...search, extra: true }, { ...search, budgetMs: 999_999 }, { ...search, maxResults: 0 },
        { ...search, segments: ['..'] }, { ...search, glob: 'a/b' }, { ...search, sensitive: { names: [] } },
        { v: READ_CHILD_PROTOCOL, op: 'read', segments: ['src', 'main.ts'], maxBytes: 10, startLine: 1 },
        { v: READ_CHILD_PROTOCOL, op: 'find', segments: [], budgetMs: 1_000, maxResults: 5, skip: [], skipSequences: [['one']], glob: '*' }]) {
        const result = await rawChild(root, JSON.stringify(bad));
        assert.deepEqual(result.reply, { v: READ_CHILD_PROTOCOL, status: 'refused', code: 'INVALID_PATH' }, JSON.stringify(bad).slice(0, 120));
      }
      const badPattern = await rawChild(root, JSON.stringify({ ...search, query: '(', regex: true }));
      assert.deepEqual(badPattern.reply, { v: READ_CHILD_PROTOCOL, status: 'refused', code: 'INVALID_QUERY' });
    });
  });

test('SEC-08 Windows: a pathological regular expression is stopped at the deadline and its child reclaimed',
  { skip: !WINDOWS && 'win32-x64 only' }, async () => {
    await withFixture(async ({ root, store, projectId }) => {
      writeFileSync(resolve(root, 'trap.txt'), 'a'.repeat(5_000) + '!\n');
      const adapter = createReadAdapter({ walkTimeoutMs: 2_000 });
      const router = createToolRouter({ store, adapter });
      const started = Date.now();
      const result = await router.searchText({ projectId, args: { query: '^(a+)+$', regex: true, path: 'trap.txt' } });
      assert.deepEqual(result, { status: 'failed', code: 'TIMED_OUT', retryable: true });
      assert.ok(Date.now() - started < 6_000, 'the deadline held');
      assert.deepEqual(adapter.snapshot().activePids, [], 'the child was killed and its exit confirmed');
      assert.equal(adapter.snapshot().available, true, 'one timed-out search does not disable reading');
    });
  });

test('SEC-08 Windows: search_text and find_files read a directory only while it is pinned; a swapped directory never leaks',
  { skip: !WINDOWS && 'win32-x64 only' }, async t => {
    await withFixture(async ({ root, outside, store, projectId }) => {
      const router = createToolRouter({ store, adapter: createReadAdapter({ maxConcurrent: 4 }) });
      // Outside holds the needle in file contents and the canary in names: neither may ever come back.
      for (let index = 0; index < 5; index++) {
        mkdirSync(resolve(outside, `${SECRET}-${index}`), { recursive: true });
        writeFileSync(resolve(outside, `${SECRET}-${index}`, 'leak.ts'), `${NEEDLE} ${SECRET}\n`);
      }
      writeFileSync(resolve(outside, 'leak.ts'), `${NEEDLE} ${SECRET}\n`);
      mkdirSync(resolve(root, 'swap', 'inner'), { recursive: true }); writeFileSync(resolve(root, 'swap', 'inner', 'plain.ts'), `${NEEDLE}\n`);
      let running = true; let swaps = 0;
      const tick = (): Promise<void> => new Promise(done => setImmediate(done));
      const retry = async (step: () => void): Promise<void> => {
        for (;;) { try { step(); return; } catch (error) { if (!(error instanceof Error && 'code' in error && ['EPERM', 'EBUSY', 'EACCES'].includes(String(error.code)))) throw error; await tick(); } }
      };
      const swapper = (async () => {
        while (running) {
          await retry(() => renameSync(resolve(root, 'swap'), resolve(root, 'swap-real')));
          await retry(() => symlinkSync(outside, resolve(root, 'swap'), 'junction'));
          await tick();
          await retry(() => rmSync(resolve(root, 'swap')));
          await retry(() => renameSync(resolve(root, 'swap-real'), resolve(root, 'swap')));
          swaps++; await tick();
        }
      })();
      const outcomes = new Map<string, number>();
      for (let round = 0; round < 20; round++) {
        const results = await Promise.all([router.searchText({ projectId, args: { query: NEEDLE } }), router.searchText({ projectId, args: { query: NEEDLE, path: 'swap' } }),
          router.findFiles({ projectId, args: { pattern: '*' } }), router.findFiles({ projectId, args: { pattern: '*.ts', path: 'swap' } })]);
        for (const result of results) {
          assert.ok(!JSON.stringify(result).includes(SECRET), 'content or a name from outside the workspace was returned');
          const key = result.status === 'ok' ? 'ok' : result.code;
          outcomes.set(key, (outcomes.get(key) ?? 0) + 1);
        }
      }
      running = false; await swapper;
      t.diagnostic(`swaps=${swaps} outcomes=${JSON.stringify(Object.fromEntries(outcomes))}`);
      assert.ok(swaps > 5);
    });
  });

test('M5.2 results for the model: matches as path:line: text, limits stated, refusals explained', () => {
  const search = formatSearchResult({ status: 'ok', path: '.', matches: [{ path: 'src/a.ts', line: 3, text: 'needle()' }], truncated: true, filesScanned: 4,
    filesSkipped: 1 }, 'needle');
  assert.match(search.content, /^1 match in the project \(4 files searched, 1 skipped/);
  assert.match(search.content, /\nsrc\/a\.ts:3: needle\(\)\n\[Stopped early/);
  assert.equal(search.size, 1);
  const refused = formatSearchResult({ status: 'refused', code: 'INVALID_QUERY' }, '(');
  assert.ok(refused.isError && /regular expression must compile/.test(refused.content) && refused.summary.includes('INVALID_QUERY'));
  const found = formatFindResult({ status: 'ok', path: 'src', entries: [{ path: 'src/b.ts', type: 'file', size: 10 }, { path: 'src/l', type: 'link', size: null }],
    truncated: false }, '*');
  assert.match(found.content, /^2 entries named \* in src\nsrc\/b\.ts {2}10 B\nsrc\/l \(link, not followed\)$/);
});
