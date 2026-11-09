import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { ESLint } from 'eslint';
import { READ_FILE_LIMITS, ReadChildReplySchema, ReadFileResultSchema } from '../../packages/contracts/dist/index.js';
import { openStore } from '../../apps/server/dist/persistence/store.js';
import type { Store } from '../../apps/server/dist/persistence/store.js';
import { READ_CHILD_SCRIPT, createReadAdapter, readChildArguments, readChildEnvironment } from '../../apps/server/dist/tools/read-adapter.js';
import { normalizeReadPath, normalizeWindowsRoot } from '../../apps/server/dist/tools/read-path.js';
import { TOOL_REGISTRY, registerTool } from '../../apps/server/dist/tools/registry.js';
import { createToolRouter } from '../../apps/server/dist/tools/router.js';

// SEC-08 Read Gate for the Windows x64 Read Adapter. Every case that touches the file system runs the real child program
// in a real, separate, short-lived Node process with the production arguments and environment. Policy cases also assert
// that no child was launched. Outside Windows x64 the gate is not claimed: the router must fail closed instead.

const WINDOWS = process.platform === 'win32' && process.arch === 'x64';
const SECRET = `OA-OUTSIDE-CANARY-${randomUUID()}`;

interface Fixture { base: string; root: string; outside: string; store: Store; projectId: string }
async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const cache = resolve('.cache'); mkdirSync(cache, { recursive: true });
  const base = mkdtempSync(resolve(cache, 'read-gate-'));
  const root = resolve(base, 'workspace'); const outside = resolve(base, 'outside');
  mkdirSync(resolve(root, 'src', 'deep'), { recursive: true }); mkdirSync(outside);
  writeFileSync(resolve(root, 'README.md'), '# hello\n');
  writeFileSync(resolve(root, 'src', 'deep', 'code.ts'), 'export const answer = 42;\n');
  writeFileSync(resolve(outside, 'secret.txt'), SECRET);
  mkdirSync(resolve(root, '.git')); writeFileSync(resolve(root, '.git', 'config'), `[remote] url = https://${SECRET}@example.com`);
  writeFileSync(resolve(root, '.env'), `TOKEN=${SECRET}`);
  const store = openStore(resolve(base, 'data'), randomUUID());
  const projectId = store.addProject({ name: 'gate', path: root }).id;
  try { await run({ base, root, outside, store, projectId }); }
  finally { store.close(true); if (base.startsWith(cache + sep)) rmSync(base, { recursive: true, force: true }); }
}
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('SEC-08 path policy: traversal, absolute, device, stream, short-name and sensitive paths never reach a child', () => {
  for (const path of ['..\\outside\\secret.txt', '../outside', 'src/../../x', 'C:\\Windows\\win.ini', 'c:secret', '/etc/passwd', '\\\\server\\share\\x',
    '\\\\?\\C:\\x', '\\\\.\\pipe\\x']) assert.equal(normalizeReadPath(path).ok ? 'ok' : (normalizeReadPath(path) as { code: string }).code, 'OUTSIDE_WORKSPACE', path);
  for (const path of ['README.md:secret', 'README.md::$DATA', 'nul', 'src/CON.txt', 'COM1', 'LPT¹.log', 'SECRET~1.ENV', 'file.', 'file ', ' lead',
    'a\u0000b', 'a\nb', 'a*b', 'a?b', 'a|b', '"a"', '.', './', 'x'.repeat(256)]) {
    const decision = normalizeReadPath(path);
    assert.equal(decision.ok ? 'ok' : decision.code, 'INVALID_PATH', JSON.stringify(path));
  }
  for (const path of ['.git/config', 'sub/.GIT/HEAD', '.ssh/id_rsa', 'keys/id_ed25519.pub', '.env', '.env.local', 'prod.env', 'certs/server.KEY',
    'a/.aws/credentials', '.npmrc', 'x/.config/gcloud/creds.db', 'terraform.tfstate', 'deploy/secrets.yaml', 'store.p12']) {
    const decision = normalizeReadPath(path);
    assert.equal(decision.ok ? 'ok' : decision.code, 'SENSITIVE_PATH', path);
  }
  assert.deepEqual(normalizeReadPath('src\\deep//./code.ts'), { ok: true, segments: ['src', 'deep', 'code.ts'], path: 'src/deep/code.ts' });
  for (const path of ['.env.example', 'docs/.gitignore', 'config/env.ts', 'gitconfig.md']) assert.equal(normalizeReadPath(path).ok, true, path);
  assert.deepEqual(normalizeWindowsRoot('d:/work/repo/'), { ok: true, root: 'D:\\work\\repo' });
  for (const root of ['C:\\', 'C:/', 'relative\\x', '\\\\server\\share', '\\\\?\\C:\\x', 'C:\\a\\..\\b', 'C:\\a:stream', 'C:\\x\\nul']) {
    assert.equal(normalizeWindowsRoot(root).ok, false, root);
  }
});

test('SEC-08 registry: deadlines outside 1s–30s are rejected at registration; the read tool is fixed to the Read Adapter', () => {
  for (const timeoutMs of [0, 999, 30_001, 1.5]) assert.throws(() => registerTool({ ...TOOL_REGISTRY.read_file, timeoutMs }), /TOOL_REGISTRATION_REJECTED/);
  assert.throws(() => createReadAdapter({ timeoutMs: 60_000 }), /TOOL_REGISTRATION_REJECTED/);
  assert.equal(TOOL_REGISTRY.read_file.channel, 'read-adapter');
  assert.ok(Object.isFrozen(TOOL_REGISTRY.read_file) && Object.isFrozen(TOOL_REGISTRY.read_file.readGatePlatforms));
  assert.deepEqual(TOOL_REGISTRY.read_file.readGatePlatforms, ['win32-x64']);
});

test('SEC-08 platforms without a Read Gate fail closed with READ_ADAPTER_UNAVAILABLE and launch nothing', async () => {
  await withFixture(async ({ store, projectId }) => {
    const adapter = createReadAdapter();
    for (const platform of ['linux-x64', 'darwin-arm64', 'win32-arm64'] as const) {
      const router = createToolRouter({ store, adapter, platform });
      assert.deepEqual(await router.readFile({ projectId, args: { path: 'README.md' } }), { status: 'failed', code: 'READ_ADAPTER_UNAVAILABLE', retryable: false });
      assert.deepEqual(await router.listDirectory({ projectId, args: { path: '.' } }), { status: 'failed', code: 'READ_ADAPTER_UNAVAILABLE', retryable: false });
    }
    assert.equal(adapter.snapshot().launched, 0);
    assert.equal(store.listToolAudit().filter(entry => entry.code === 'READ_ADAPTER_UNAVAILABLE').length, 6);
  });
});

test('SEC-08 boundary lint: Express never reads workspace files in-process and the child stays self-contained', async () => {
  const eslint = new ESLint();
  const errors = async (filePath: string, code: string): Promise<string[]> =>
    (await eslint.lintText(code, { filePath })).flatMap(r => r.messages.filter(m => m.severity === 2).map(m => String(m.ruleId)));
  for (const [path, code] of [
    ['apps/server/src/tools/router.ts', "import { readFileSync } from 'node:fs'; export const x = readFileSync;"],
    ['apps/server/src/tools/router.ts', "import 'node:fs/promises';"],
    ['apps/server/src/tools/router.ts', "import './read-child.js';"],
    ['apps/server/src/index.ts', "import './tools/read-child.js';"],
    ['apps/server/src/tools/router.ts', "import 'node:child_process';"],
    ['apps/server/src/tools/read-child.ts', "import '@operation-agent/contracts';"],
    ['apps/server/src/tools/read-child.ts', "import 'node:child_process';"],
    ['apps/server/src/tools/read-child.ts', "import './read-path.js';"],
  ] as const) assert.ok((await errors(path, code)).includes('architecture/boundaries'), `${path}: ${code}`);
  assert.deepEqual(await errors('apps/server/src/tools/read-adapter.ts', "import { spawn } from 'node:child_process'; export const s = spawn;"), []);
});

test('SEC-08 Windows: allowed reads return bounded UTF-8 text with identity, truncation on a character boundary, and binary refusal',
  { skip: !WINDOWS && 'Read Gate is implemented for win32-x64 only; other platforms are covered by the fail-closed test' }, async () => {
    await withFixture(async ({ root, store, projectId }) => {
      const router = createToolRouter({ store });
      const ok = await router.readFile({ projectId, args: { path: 'src\\deep\\code.ts' } });
      assert.deepEqual(ok, { status: 'ok', path: 'src/deep/code.ts', content: 'export const answer = 42;\n', bytes: 26, size: 26, truncated: false,
        sha256: createHash('sha256').update('export const answer = 42;\n').digest('hex') });
      // 'é' is two bytes and '😀' four: a 5-byte limit must stop before the emoji, never inside it.
      writeFileSync(resolve(root, 'utf8.txt'), 'aé😀z');
      const cut = await router.readFile({ projectId, args: { path: 'utf8.txt', maxBytes: 5 } });
      assert.deepEqual(cut.status === 'ok' && [cut.content, cut.bytes, cut.size, cut.truncated], ['aé', 3, 8, true]);
      // A leading byte-order mark stays in the content, so bytes and sha256 describe exactly the returned text.
      writeFileSync(resolve(root, 'bom.txt'), Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69]));
      const bom = await router.readFile({ projectId, args: { path: 'bom.txt' } });
      assert.ok(bom.status === 'ok' && bom.content === '﻿hi' && bom.bytes === 5 && Buffer.byteLength(bom.content, 'utf8') === bom.bytes &&
        bom.sha256 === createHash('sha256').update(bom.content, 'utf8').digest('hex'));
      writeFileSync(resolve(root, 'big.txt'), 'x'.repeat(READ_FILE_LIMITS.maxBytes + 10));
      const big = await router.readFile({ projectId, args: { path: 'big.txt', maxBytes: READ_FILE_LIMITS.maxBytes } });
      assert.deepEqual(big.status === 'ok' && [big.bytes, big.truncated], [READ_FILE_LIMITS.maxBytes, true]);
      writeFileSync(resolve(root, 'image.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
      writeFileSync(resolve(root, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
      for (const path of ['image.bin', 'latin1.txt']) assert.deepEqual(await router.readFile({ projectId, args: { path } }), { status: 'refused', code: 'BINARY_FILE' });
      assert.deepEqual(await router.readFile({ projectId, args: { path: 'missing.txt' } }), { status: 'refused', code: 'NOT_FOUND' });
      assert.deepEqual(await router.readFile({ projectId, args: { path: 'src' } }), { status: 'refused', code: 'NOT_A_FILE' });
      assert.deepEqual(await router.readFile({ projectId, args: { path: 'README.md/x' } }), { status: 'refused', code: 'NOT_FOUND' });
      assert.deepEqual(await router.readFile({ projectId: randomUUID(), args: { path: 'README.md' } }), { status: 'refused', code: 'WORKSPACE_UNAVAILABLE' });
      const gone = store.addProject({ name: 'gone', path: resolve(root, '..', 'removed-workspace') }).id;
      assert.deepEqual(await router.readFile({ projectId: gone, args: { path: 'README.md' } }), { status: 'refused', code: 'WORKSPACE_UNAVAILABLE' });
      assert.deepEqual(await router.readFile({ projectId, args: { path: 'README.md', extra: true } }), { status: 'refused', code: 'INVALID_PATH' });
      for (const result of [ok, cut, big]) assert.equal(ReadFileResultSchema.safeParse(result).success, true);
      assert.deepEqual(router.adapter.snapshot().activePids, [], 'every child exited before its read completed');
    });
  });

test('SEC-08 Windows: out-of-bounds and sensitive reads are refused, audited, launch no child, and leave no content in the database',
  { skip: !WINDOWS && 'win32-x64 only' }, async () => {
    await withFixture(async ({ base, store, projectId }) => {
      const router = createToolRouter({ store });
      for (const [path, code] of [['..\\outside\\secret.txt', 'OUTSIDE_WORKSPACE'], [resolve(base, 'outside', 'secret.txt'), 'OUTSIDE_WORKSPACE'],
        ['.git\\config', 'SENSITIVE_PATH'], ['.env', 'SENSITIVE_PATH'], ['README.md:hidden', 'INVALID_PATH']] as const) {
        assert.deepEqual(await router.readFile({ projectId, toolCallId: randomUUID(), args: { path } }), { status: 'refused', code }, path);
      }
      assert.equal(router.adapter.snapshot().launched, 0, 'policy refusals never start a Read Adapter');
      const audit = store.listToolAudit();
      assert.equal(audit.length, 5);
      assert.ok(audit.every(entry => entry.decision === 'refused' && entry.toolCallId !== null && entry.projectId === projectId && entry.bytes === 0));
      assert.deepEqual(audit.map(entry => entry.path).sort(), ['', '', '', '.env', '.git/config'].sort());
      assert.deepEqual(await router.readFile({ projectId, toolCallId: '-'.repeat(36), taskId: 'f'.repeat(36), args: { path: '.env' } }),
        { status: 'refused', code: 'SENSITIVE_PATH' }, 'malformed correlation ids never break the audit');
      assert.deepEqual([store.listToolAudit()[0]!.toolCallId, store.listToolAudit()[0]!.taskId], [null, null]);
      await router.readFile({ projectId, args: { path: 'README.md' } });
      assert.equal(store.listToolAudit()[0]!.decision, 'allowed');
      const bytes = readdirSync(resolve(base, 'data')).map(name => readFileSync(resolve(base, 'data', name)).toString('latin1')).join('');
      assert.ok(!bytes.includes(SECRET) && !bytes.includes('# hello'), 'the audit holds decisions, never file content');
    });
  });

test('SEC-08 Windows: junctions, symbolic links and hard links to outside files are refused', { skip: !WINDOWS && 'win32-x64 only' }, async t => {
  await withFixture(async ({ root, outside, store, projectId }) => {
    const router = createToolRouter({ store });
    // A junction needs no privilege, so any process with workspace write access can plant one.
    symlinkSync(outside, resolve(root, 'linked'), 'junction');
    assert.deepEqual(await router.readFile({ projectId, args: { path: 'linked/secret.txt' } }), { status: 'refused', code: 'LINK_REJECTED' });
    linkSync(resolve(outside, 'secret.txt'), resolve(root, 'hard.txt'));
    assert.deepEqual(await router.readFile({ projectId, args: { path: 'hard.txt' } }), { status: 'refused', code: 'MULTIPLE_LINKS' });
    let fileLink = true;
    try { symlinkSync(resolve(outside, 'secret.txt'), resolve(root, 'soft.txt'), 'file'); } catch { fileLink = false; }
    if (fileLink) assert.deepEqual(await router.readFile({ projectId, args: { path: 'soft.txt' } }), { status: 'refused', code: 'LINK_REJECTED' });
    else t.diagnostic('file symbolic links need Developer Mode or SeCreateSymbolicLinkPrivilege on this host; junction and hard-link cases ran');
  });
});

test('SEC-08 Windows: a directory swapped for a junction while reads run never yields outside content', { skip: !WINDOWS && 'win32-x64 only' }, async t => {
  await withFixture(async ({ root, outside, store, projectId }) => {
    const router = createToolRouter({ store, adapter: createReadAdapter({ maxConcurrent: 4 }) });
    mkdirSync(resolve(root, 'swap')); writeFileSync(resolve(root, 'swap', 'secret.txt'), 'inside');
    // Some volumes (ReFS) do not guarantee unique 64-bit file ids; record whether the two targets collide here, since the
    // child's identity check must hold either way.
    const ino = (path: string): bigint => lstatSync(path, { bigint: true }).ino;
    const collision = ino(resolve(root, 'swap', 'secret.txt')) === ino(resolve(outside, 'secret.txt'));
    let running = true; let swaps = 0; let blocked = 0;
    const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
    // Windows refuses to rename a directory while a child holds a file open inside it; such attempts are retried.
    const retry = async (step: () => void): Promise<void> => {
      for (;;) {
        try { step(); return; } catch (error) {
          if (!(error instanceof Error && 'code' in error && ['EPERM', 'EBUSY', 'EACCES'].includes(String(error.code)))) throw error;
          blocked++; await tick();
        }
      }
    };
    const swapper = (async () => {
      while (running) {
        // Real directory → junction to outside → real directory, as fast as the file system allows.
        await retry(() => renameSync(resolve(root, 'swap'), resolve(root, 'swap-real')));
        await retry(() => symlinkSync(outside, resolve(root, 'swap'), 'junction'));
        await tick();
        await retry(() => rmSync(resolve(root, 'swap')));
        await retry(() => renameSync(resolve(root, 'swap-real'), resolve(root, 'swap')));
        swaps++;
        await tick();
      }
    })();
    const outcomes = new Map<string, number>();
    for (let round = 0; round < 40; round++) {
      const results = await Promise.all(Array.from({ length: 4 }, () => router.readFile({ projectId, args: { path: 'swap/secret.txt' } })));
      for (const result of results) {
        assert.ok(!(result.status === 'ok' && result.content.includes(SECRET)), 'outside content was returned');
        if (result.status === 'ok') assert.equal(result.content, 'inside');
        const key = result.status === 'ok' ? 'ok' : result.code;
        outcomes.set(key, (outcomes.get(key) ?? 0) + 1);
      }
    }
    running = false; await swapper;
    t.diagnostic(`inoCollision=${collision} swaps=${swaps} blocked=${blocked} outcomes=${JSON.stringify(Object.fromEntries(outcomes))}`);
    assert.ok(swaps > 10, 'the swapper actually raced the reads');
    for (const key of outcomes.keys()) assert.ok(['ok', 'LINK_REJECTED', 'NOT_FOUND', 'CHANGED_DURING_READ', 'ACCESS_DENIED'].includes(key), key);
  });
});

test('SEC-08 Windows: the child runs under a read-only permission grant with no inherited environment', { skip: !WINDOWS && 'win32-x64 only' }, async () => {
  await withFixture(async ({ base, root, outside }) => {
    // The probe stands in for a compromised child: same runtime, arguments and environment builder as production.
    const probe = resolve(base, 'probe.mjs');
    writeFileSync(probe, `import fs from 'node:fs';
const attempt = f => { try { f(); return 'ALLOWED'; } catch (e) { return e.code ?? 'ERROR'; } };
const result = {
  inside: attempt(() => fs.readFileSync(process.argv[2] + '\\\\README.md')),
  outside: attempt(() => fs.readFileSync(${JSON.stringify(resolve(outside, 'secret.txt'))})),
  write: attempt(() => fs.writeFileSync(process.argv[2] + '\\\\written.txt', 'x')),
  spawn: await import('node:child_process').then(c => attempt(() => c.spawnSync(process.execPath, ['-v']))),
  worker: await import('node:worker_threads').then(w => attempt(() => new w.Worker('1', { eval: true }))),
  env: process.env, execArgv: process.execArgv,
};
process.stdout.write(JSON.stringify(result));`);
    const previous = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = '--require=./inject.js'; process.env.OA_CANARY_TOKEN = SECRET;
    let output = '';
    try {
      const child = spawn(process.execPath, readChildArguments(root, probe), { cwd: base, env: readChildEnvironment(), shell: false, windowsHide: true });
      child.stdout.on('data', chunk => { output += String(chunk); });
      await new Promise(resolve => child.on('close', resolve));
    } finally {
      if (previous === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previous;
      delete process.env.OA_CANARY_TOKEN;
    }
    const result = JSON.parse(output) as { inside: string; outside: string; write: string; spawn: string; worker: string; env: Record<string, string>; execArgv: string[] };
    assert.deepEqual([result.inside, result.outside, result.write, result.spawn, result.worker],
      ['ALLOWED', 'ERR_ACCESS_DENIED', 'ERR_ACCESS_DENIED', 'ERR_ACCESS_DENIED', 'ERR_ACCESS_DENIED']);
    const names = Object.keys(result.env).map(name => name.toUpperCase());
    assert.ok(names.every(name => ['SYSTEMROOT', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'USERDOMAIN',
      'USERNAME', 'SYSTEMDRIVE'].includes(name)), names.join(','));
    for (const [name, value] of Object.entries(result.env)) if (!['SYSTEMROOT', 'WINDIR'].includes(name.toUpperCase())) assert.equal(value, '', name);
    assert.ok(!output.includes(SECRET) && !names.includes('NODE_OPTIONS'));
    assert.ok(result.execArgv.includes('--permission') && result.execArgv.filter(arg => arg.startsWith('--allow-')).join() === `--allow-fs-read=${root}`);
  });
});

test('SEC-08 Windows: a hung child is killed at the deadline and its exit confirmed; caps and malformed replies fail closed',
  { skip: !WINDOWS && 'win32-x64 only' }, async () => {
    await withFixture(async ({ base, root }) => {
      const script = (name: string, body: string): string => { const path = resolve(base, name); writeFileSync(path, body); return path; };
      const hang = script('hang.mjs', 'setInterval(() => {}, 1000);');
      const adapter = createReadAdapter({ childScript: hang, timeoutMs: 1_000 });
      const pending = adapter.read(root, ['README.md'], 100);
      await new Promise(resolve => setTimeout(resolve, 300));
      const [pid] = adapter.snapshot().activePids;
      assert.ok(pid !== undefined && alive(pid));
      const started = Date.now();
      assert.deepEqual(await pending, { status: 'failed', code: 'TIMED_OUT', retryable: true });
      assert.ok(Date.now() - started < 3_000);
      assert.equal(alive(pid), false, 'the timed-out child no longer exists');
      assert.deepEqual(adapter.snapshot(), { available: true, active: 0, queued: 0, launched: 1, killed: 1, activePids: [] });

      const flood = createReadAdapter({ childScript: script('flood.mjs', "process.stdout.write('A'.repeat(4 * 1024 * 1024)); setInterval(() => {}, 1000);") });
      assert.deepEqual(await flood.read(root, ['README.md'], 100), { status: 'failed', code: 'ADAPTER_FAILED', retryable: false });
      for (const body of [
        "process.stdout.write(JSON.stringify({ v: 1, status: 'ok', content: '', size: 0, truncated: false, path: 'C:/x' }) + '\\n');",
        "process.stdout.write(JSON.stringify({ v: 1, status: 'refused', code: 'NOT_FOUND' }) + '\\n' + JSON.stringify({ v: 1, status: 'refused', code: 'NOT_FOUND' }) + '\\n');",
        "process.stdout.write(JSON.stringify({ v: 1, status: 'ok', content: Buffer.from('x'.repeat(200)).toString('base64'), size: 200, truncated: false }) + '\\n');",
        "process.stdout.write(JSON.stringify({ v: 1, status: 'refused', code: 'NOT_FOUND' }) + '\\n'); process.exitCode = 3;",
      ]) {
        const odd = createReadAdapter({ childScript: script(`odd-${randomUUID()}.mjs`, body) });
        assert.deepEqual(await odd.read(root, ['README.md'], 100), { status: 'failed', code: 'ADAPTER_FAILED', retryable: false }, body);
      }
      const busy = createReadAdapter({ childScript: hang, timeoutMs: 1_000, maxConcurrent: 1, maxQueued: 0 });
      const first = busy.read(root, ['README.md'], 100);
      assert.deepEqual(await busy.read(root, ['README.md'], 100), { status: 'failed', code: 'BUSY', retryable: true });
      assert.equal((await first).status, 'failed');
      assert.equal(ReadChildReplySchema.safeParse({ v: 1, status: 'ok', content: 'not base64!', size: 1, truncated: false }).success, false);
      assert.match(READ_CHILD_SCRIPT, /[\\/]apps[\\/]server[\\/]dist[\\/]tools[\\/]read-child\.js$/);
    });
  });

test('SEC-08 Windows: list_directory is bounded, never follows links, never enters sensitive directories, and is audited',
  { skip: !WINDOWS && 'win32-x64 only' }, async () => {
    await withFixture(async ({ root, outside, store, projectId }) => {
      const router = createToolRouter({ store });
      mkdirSync(resolve(root, 'node_modules', 'pkg'), { recursive: true }); writeFileSync(resolve(root, 'node_modules', 'pkg', 'index.js'), 'x');
      mkdirSync(resolve(root, '.ssh')); writeFileSync(resolve(root, '.ssh', 'id_rsa'), SECRET);
      symlinkSync(outside, resolve(root, 'linked'), 'junction');
      const top = await router.listDirectory({ projectId, args: { path: '.' } });
      assert.deepEqual(top.status === 'ok' && top.entries.map(entry => [entry.path, entry.type]), [['.env', 'file'], ['.git', 'directory'],
        ['.ssh', 'directory'], ['README.md', 'file'], ['linked', 'link'], ['node_modules', 'directory'], ['src', 'directory']]);
      assert.equal(top.status === 'ok' && top.entries.find(entry => entry.path === 'README.md')?.size, 8);
      const deep = await router.listDirectory({ projectId, args: { path: '', depth: 4 } });
      assert.ok(deep.status === 'ok');
      const paths = deep.status === 'ok' ? deep.entries.map(entry => entry.path) : [];
      assert.ok(paths.includes('src/deep') && paths.includes('src/deep/code.ts'));
      for (const hidden of ['.git/config', '.ssh/id_rsa', 'node_modules/pkg', 'linked/secret.txt']) assert.ok(!paths.includes(hidden), hidden);
      assert.ok(!JSON.stringify(deep).includes(SECRET));
      assert.deepEqual(await router.listDirectory({ projectId, args: { path: 'src', depth: 2 } }), { status: 'ok', path: 'src', truncated: false, unlisted: [],
        entries: [{ path: 'src/deep', type: 'directory', size: null }, { path: 'src/deep/code.ts', type: 'file', size: 26 }] });
      const launched = router.adapter.snapshot().launched;
      for (const [path, code] of [['.git', 'SENSITIVE_PATH'], ['x/.ssh', 'SENSITIVE_PATH'], ['..\\outside', 'OUTSIDE_WORKSPACE'],
        ['../outside', 'OUTSIDE_WORKSPACE'], ['C:\\Windows', 'OUTSIDE_WORKSPACE']] as const) {
        assert.deepEqual(await router.listDirectory({ projectId, args: { path } }), { status: 'refused', code }, path);
      }
      assert.equal(router.adapter.snapshot().launched, launched, 'policy refusals start no child');
      assert.deepEqual(await router.listDirectory({ projectId, args: { path: 'linked' } }), { status: 'refused', code: 'LINK_REJECTED' });
      assert.deepEqual(await router.listDirectory({ projectId, args: { path: 'README.md' } }), { status: 'refused', code: 'NOT_A_FILE' });
      assert.deepEqual(await router.listDirectory({ projectId, args: { path: 'missing' } }), { status: 'refused', code: 'NOT_FOUND' });
      assert.deepEqual(await router.listDirectory({ projectId, args: { path: '.', depth: 9 } }), { status: 'refused', code: 'INVALID_PATH' });
      mkdirSync(resolve(root, 'many'));
      for (let index = 0; index < READ_FILE_LIMITS.maxEntries + 5; index++) writeFileSync(resolve(root, 'many', `f${String(index).padStart(4, '0')}.txt`), '');
      const many = await router.listDirectory({ projectId, args: { path: 'many' } });
      assert.deepEqual(many.status === 'ok' && [many.entries.length, many.truncated, many.entries[0]!.path], [READ_FILE_LIMITS.maxEntries, true, 'many/f0000.txt']);
      const audit = store.listToolAudit().filter(entry => entry.toolId === 'list_directory');
      assert.ok(audit.some(entry => entry.decision === 'allowed' && entry.path === 'many' && entry.bytes === READ_FILE_LIMITS.maxEntries));
      assert.ok(audit.some(entry => entry.decision === 'refused' && entry.code === 'SENSITIVE_PATH' && entry.path === '.git'));
      assert.deepEqual(router.adapter.snapshot().activePids, []);
    });
  });

test('SEC-08 Windows: list_directory reads a directory only while it is pinned; a swapped subdirectory never leaks names',
  { skip: !WINDOWS && 'win32-x64 only' }, async t => {
    await withFixture(async ({ root, outside, store, projectId }) => {
      const router = createToolRouter({ store, adapter: createReadAdapter({ maxConcurrent: 4 }) });
      // A directory holding only a junction cannot be pinned, so it is reported as unlisted and never read.
      mkdirSync(resolve(root, 'onlylinks')); symlinkSync(outside, resolve(root, 'onlylinks', 'away'), 'junction');
      const linksOnly = await router.listDirectory({ projectId, args: { path: 'onlylinks' } });
      assert.deepEqual(linksOnly, { status: 'ok', path: 'onlylinks', entries: [], truncated: false, unlisted: ['onlylinks'] });
      const nested = await router.listDirectory({ projectId, args: { path: '.', depth: 2 } });
      assert.ok(nested.status === 'ok' && nested.unlisted.includes('onlylinks') && !nested.entries.some(entry => entry.path.startsWith('onlylinks/')));
      // Outside entries carry a canary in their names; no listing may ever return one.
      for (let index = 0; index < 5; index++) mkdirSync(resolve(outside, `${SECRET}-${index}`, 'deeper'), { recursive: true });
      mkdirSync(resolve(root, 'swap', 'inner'), { recursive: true }); writeFileSync(resolve(root, 'swap', 'inner', 'plain.txt'), 'x');
      let running = true; let swaps = 0;
      const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
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
      for (let round = 0; round < 30; round++) {
        const results = await Promise.all(Array.from({ length: 4 }, () => router.listDirectory({ projectId, args: { path: '.', depth: 3 } })));
        for (const result of results) {
          assert.ok(!JSON.stringify(result).includes(SECRET), 'a name from outside the workspace was listed');
          const key = result.status === 'ok' ? 'ok' : result.code;
          outcomes.set(key, (outcomes.get(key) ?? 0) + 1);
        }
      }
      running = false; await swapper;
      t.diagnostic(`swaps=${swaps} outcomes=${JSON.stringify(Object.fromEntries(outcomes))}`);
      assert.ok(swaps > 5);
    });
  });
