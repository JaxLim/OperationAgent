import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fork } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { release } from 'node:os';
import { z } from 'zod';
import { HostEvent, Identity, Mode, Probe, WorkerMessage } from './contracts.js';
import { loadNative } from './native.js';
import { CaseRecord, evaluate } from './evaluate.js';

const lab = fileURLToPath(new URL('../../', import.meta.url));
const root = resolve(lab, '../..');
const native = loadNative(resolve(lab, '_build/native/probe.node'));
if (process.platform !== 'win32' || process.arch !== 'x64' || process.version !== 'v24.22.1') throw new Error('Use locked Windows x64 Node');
const batch = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
const runRoot = resolve(lab, '_runs', batch);
const runtime = resolve(runRoot, 'runtime 空格');
const evidence = resolve(lab, 'evidence', batch);
await mkdir(runtime, { recursive: true }); await mkdir(evidence, { recursive: true });
const moniker = `OperationAgent.Dec001.${randomUUID()}`;
const sid = native.deriveSid(moniker); native.grantReadExecute(runtime, sid);
await cp(resolve(root, '.tools/node/node.exe'), resolve(runtime, 'node.exe'));
await cp(resolve(lab, '_build/native/probe.node'), resolve(runtime, 'probe.node'));
for (const file of ['contracts.js', 'native.js', 'worker.js']) await cp(resolve(lab, '_build/js', file), resolve(runtime, file));
await writeFile(resolve(runtime, 'package.json'), '{"type":"module","private":true}\n');
await cp(resolve(lab, 'node_modules/zod'), resolve(runtime, 'node_modules/zod'), { recursive: true, dereference: true });
const labels = ['workspace', 'database', 'credentials', 'outside-workspace'];
const targets: Array<{ label: string; path: string }> = [];
for (const label of labels) {
  const dir = resolve(runRoot, 'fixtures', label); await mkdir(dir, { recursive: true });
  const path = resolve(dir, 'synthetic-marker.txt'); await writeFile(path, `Synthetic ${label}; no real secrets.\n`); targets.push({ label, path });
}
const hashFile = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex');
const sourceNames = ['native/probe.cc', 'src/contracts.ts', 'src/native.ts', 'src/worker.ts', 'src/host.ts', 'src/run.ts', 'src/wire.ts', 'src/evaluate.ts', 'src/supervisor.ts', 'package.json', 'pnpm-lock.yaml', 'build.mjs'];
const sourceHashes = Object.fromEntries(await Promise.all(sourceNames.map(async name => [name, await hashFile(resolve(lab, name))])));
const fixtureHashes = Object.fromEntries(await Promise.all(targets.map(async target => [target.label, await hashFile(target.path)])));
const positiveControls = { files: targets.map(target => ({ label: target.label, read: native.probeFile(target.path, 'read'), write: native.probeFile(target.path, 'write') })), externalTcp: native.probeTcp('1.1.1.1', 443) };
const metadata = { batch, time: new Date().toISOString(), os: release(), node: process.version, arch: process.arch, nodeAbi: process.versions.modules,
  controller: Identity.parse(native.identity(0)), moniker, sid, runtime, targets, profileCreated: false,
  nodeSha256: createHash('sha256').update(await readFile(resolve(runtime, 'node.exe'))).digest('hex'),
  addonSha256: createHash('sha256').update(await readFile(resolve(runtime, 'probe.node'))).digest('hex'),
  sourceHashes, fixtureHashes, positiveControls,
  architectureSha256: await hashFile(resolve(root, 'ARCHITECTURE.md')), agentsSha256: await hashFile(resolve(root, 'AGENTS.md')),
};
await cp(resolve(lab, '_build/native/build-result.json'), resolve(evidence, 'native-build.json'));
await cp(resolve(lab, '_downloads/sources.json'), resolve(evidence, 'download-checksums.json'));
await writeFile(resolve(evidence, 'environment.json'), JSON.stringify(metadata, null, 2) + '\n');
type Event = z.infer<typeof HostEvent>;
const results: unknown[] = [];
async function runCase(mode: z.infer<typeof Mode>, scenario: string) {
  const runId = randomUUID(); const events: Event[] = []; let stderr = ''; let workerPid = 0; let expressPid = 0; let killAt = 0;
  const started = performance.now();
  const host = fork(resolve(lab, '_build/js', scenario === 'main-kill' ? 'supervisor.js' : 'host.js'), [JSON.stringify({ runId, mode, runtime, moniker, targets, scenario })], {
    execPath: process.execPath, execArgv: [], cwd: lab, env: { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows', SystemDrive: process.env.SystemDrive ?? 'C:' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
  });
  host.stderr?.on('data', (chunk: Buffer) => { if (stderr.length < 16384) stderr += chunk.toString('utf8'); });
  let failure: string | undefined;
  host.on('error', error => { failure = error.message; });
  host.on('message', (raw: unknown) => {
    try {
      const event = HostEvent.parse(raw); if (event.runId !== runId) throw new Error('Host instance mismatch');
      if (events.length >= 2000) throw new Error('HOST_EVENT_COUNT_LIMIT'); events.push(event);
      if (event.kind === 'host-ready') expressPid = event.data.identity.pid;
      if (event.kind === 'failure') failure = JSON.stringify(event.data);
      if (event.kind === 'worker-launched') workerPid = z.object({ pid: z.number().int().positive() }).parse(event.data).pid;
      if (event.kind === 'scenario' && (scenario === 'parent-kill' || scenario === 'main-kill')) {
        const data = z.object({ action: z.string() }).parse(event.data);
        if (data.action === 'worker-hung') { killAt = performance.now(); host.kill('SIGKILL'); }
      }
    } catch (error) { failure = error instanceof Error ? error.message : String(error); host.kill('SIGKILL'); }
  });
  const timer = setTimeout(() => { failure = 'HARNESS_TIMEOUT'; host.kill('SIGKILL'); }, 95000);
  const exit = await new Promise<{ code: number | null; signal: string | null }>(resolve => host.once('exit', (code, signal) => resolve({ code, signal })));
  clearTimeout(timer);
  if (!events.some(event => event.kind === 'worker-message') && !failure) failure = 'WORKER_RPC_NOT_READY';
  const waitStart = performance.now();
  while (workerPid && native.isAlive(workerPid) && performance.now() - waitStart < 6000) await new Promise(resolve => setTimeout(resolve, 25));
  const alive = workerPid > 0 && native.isAlive(workerPid);
  const expressAliveAfter = expressPid > 0 && native.isAlive(expressPid);
  const record = CaseRecord.parse({ mode, scenario, runId, supervisorPid: scenario === 'main-kill' ? host.pid : null, hostPid: expressPid || host.pid, workerPid, elapsedMs: performance.now() - started, killCleanupMs: killAt ? performance.now() - killAt : null, exit, failure: failure ?? null, stderr, workerAliveAfter: alive, expressAliveAfter, events });
  await writeFile(resolve(evidence, `${mode}-${scenario}.json`), JSON.stringify(record, null, 2) + '\n');
  const messages = events.filter(e => e.kind === 'worker-message').map(e => WorkerMessage.parse(e.data));
  const early = messages.find(m => 'method' in m);
  const later = messages.find(m => 'id' in m && m.id === 2);
  const parsedLater = later && 'result' in later ? Probe.safeParse(later.result) : undefined;
  const summary = { mode, scenario, workerPid, ready: Boolean(early), probe: parsedLater?.success ? parsedLater.data : null, workerAliveAfter: alive, expressAliveAfter, failure: failure ?? null, stderr, exit, matrix: evaluate(record) };
  results.push(summary); console.log(JSON.stringify({ mode, scenario, workerPid, matrix: summary.matrix, failure: summary.failure }));
  if (alive) { process.kill(workerPid, 'SIGKILL'); throw new Error(`Orphan detected; cleanup fallback used for experimental PID ${workerPid}`); }
  if (expressAliveAfter) { process.kill(expressPid, 'SIGKILL'); throw new Error('Experimental Express orphan detected and terminated'); }
}
const selected = process.argv.find(arg => arg.startsWith('--mode='))?.slice('--mode='.length);
const modes = selected ? [Mode.parse(selected)] : process.argv.includes('--quick') ? ['fork', 'appcontainer', 'lpac'] as const : ['fork', 'fork-job', 'plain-native', 'restricted', 'appcontainer', 'lpac', 'lowbox'] as const;
for (const mode of modes) await runCase(mode, 'permissions');
if (process.argv.includes('--lifecycle') || (!process.argv.includes('--quick') && !selected)) for (const scenario of ['disconnect', 'hang', 'parent-kill', 'main-kill', 'node-spawn']) await runCase(selected ? Mode.parse(selected) : 'lowbox', scenario);
const fixturesUnchanged = (await Promise.all(targets.map(async target => await hashFile(target.path) === fixtureHashes[target.label]))).every(Boolean);
await writeFile(resolve(evidence, 'summary.json'), JSON.stringify({ metadata, results, fixturesUnchanged, productionSandbox: false, dec001Closed: false, meaningOfExitZero: 'Evidence collection completed; NOT a security acceptance pass' }, null, 2) + '\n');
if (!fixturesUnchanged) throw new Error('FIXTURE_CONTENT_CHANGED');
console.log(JSON.stringify({ evidence, dec001Closed: false }));
if (process.argv.includes('--require-dec001')) process.exitCode = 2;
