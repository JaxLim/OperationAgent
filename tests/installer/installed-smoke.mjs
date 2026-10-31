// P1.6 / SEC-18 installed-application smoke test on Windows x64. Installs the real NSIS installer
// silently into the workspace cache, drives the installed app through launch → close → relaunch → crash →
// recovery, inspects SQLite with the *installed* Node and better-sqlite3, runs the sidecar suite against
// the installed resources, then uninstalls. Application data goes to an isolated --user-data-dir.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CONTROL_ROUTES, PROTOCOL_VERSION } from '../../packages/contracts/dist/index.js';
import { httpCall } from '../integration/sidecar-helper.mjs';

const root = resolve(import.meta.dirname, '../..');
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('WINDOWS_X64_REQUIRED');
const version = JSON.parse(await readFile(resolve(root, 'apps/desktop/package.json'), 'utf8')).version;
const installer = resolve(root, 'dist/installers', `OperationAgent-${version}-win-x64.exe`);
const cache = resolve(root, '.cache');
const work = resolve(cache, 'installer-smoke');
if (!work.startsWith(cache + sep)) throw new Error('SMOKE_PATH_ESCAPE');
const installDir = resolve(work, 'OperationAgent');
const userData = resolve(work, 'user-data');
const database = resolve(userData, 'control-plane/control-plane.sqlite');
const evidenceDir = resolve(root, 'artifacts/p1/win32-x64'); await mkdir(evidenceDir, { recursive: true });
const steps = []; const started = Date.now();
const system32 = name => resolve(process.env.SystemRoot, 'System32', name);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function step(name, action) {
  const begin = Date.now();
  try { const detail = await action(); steps.push({ name, passed: true, ms: Date.now() - begin, ...(detail ? { detail } : {}) }); console.log('PASS', name); return detail; }
  catch (error) { steps.push({ name, passed: false, ms: Date.now() - begin, error: error.message }); console.error('FAIL', name, error.message); throw error; }
}
async function until(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) { const value = await check(); if (value) return value; if (Date.now() > deadline) throw new Error('TIMEOUT: ' + label); await delay(200); }
}
function powershell(script) {
  const result = spawnSync(system32('WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error('POWERSHELL_FAILED: ' + result.stderr);
  return result.stdout.trim();
}
function children(pid) {
  const out = powershell(`Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | ForEach-Object { "$($_.ProcessId)|$($_.ExecutablePath)" }`);
  return out ? out.split(/\r?\n/).map(line => { const [id, path] = line.split('|'); return { pid: Number(id), path }; }) : [];
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } }
const sidecarNode = () => resolve(installDir, 'resources/sidecar/node/node.exe');
const sidecarOf = pid => children(pid).find(child => child.path && resolve(child.path).toLowerCase() === sidecarNode().toLowerCase());

// Inspect SQLite with the installed runtime and the installed native module (read-only, app closed).
async function inspect() {
  const script = resolve(work, 'inspect.mjs');
  await writeFile(script, `import { createRequire } from 'node:module';
const Database = createRequire(${JSON.stringify(resolve(installDir, 'resources/sidecar/server/package.json'))})('better-sqlite3');
const db = new Database(${JSON.stringify(database)}, { readonly: true, fileMustExist: true });
const result = { node: process.versions.node, abi: process.versions.modules, sqlite: db.prepare('select sqlite_version() v').get().v,
  migrations: db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(r => r.version),
  runs: db.prepare('SELECT outcome FROM control_plane_runs ORDER BY started_at').all().map(r => r.outcome),
  projects: db.prepare('SELECT name, path FROM projects ORDER BY created_at').all(),
  settings: db.prepare("SELECT value FROM settings WHERE key = 'workbench'").get()?.value ?? null,
  records: db.prepare('SELECT value FROM smoke_records ORDER BY created_at').all().map(r => r.value) };
db.close(); console.log(JSON.stringify(result));`);
  const result = spawnSync(sidecarNode(), [script], { encoding: 'utf8', windowsHide: true, env: { SystemRoot: process.env.SystemRoot } });
  if (result.status !== 0) throw new Error('INSPECT_FAILED: ' + result.stderr);
  return JSON.parse(result.stdout);
}
async function launch() {
  const exe = resolve(installDir, 'OperationAgent.exe');
  const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PATH'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  const child = spawn(exe, [`--user-data-dir=${userData}`], { cwd: installDir, env, windowsHide: false, stdio: 'ignore', detached: false });
  const exited = once(child, 'exit');
  const sidecar = await until(() => sidecarOf(child.pid), 30_000, 'installed sidecar child');
  await until(() => existsSync(database), 15_000, 'database in isolated user data');
  const title = await until(() => powershell(`(Get-Process -Id ${child.pid}).MainWindowTitle`) || false, 20_000, 'main window');
  return { child, exited, sidecar, title };
}
async function closeGracefully(app) {
  // taskkill without /F posts WM_CLOSE: the real window-close → before-quit → sidecar shutdown path.
  spawnSync(system32('taskkill.exe'), ['/PID', String(app.child.pid)], { windowsHide: true });
  const [code] = await Promise.race([app.exited, delay(20_000).then(() => { throw new Error('APP_CLOSE_TIMEOUT'); })]);
  await until(() => !alive(app.sidecar.pid), 10_000, 'sidecar exit after close');
  return code;
}
function screenshot(pid, file) {
  powershell(`Add-Type -AssemblyName System.Drawing; Add-Type @'
using System; using System.Runtime.InteropServices;
public static class W { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
public struct R { public int L, T, Ri, B; } }
'@; [W]::SetProcessDPIAware() | Out-Null; $h = (Get-Process -Id ${pid}).MainWindowHandle; [W]::SetForegroundWindow($h) | Out-Null; Start-Sleep -Milliseconds 1500; $r = New-Object W+R; [W]::GetWindowRect($h, [ref]$r) | Out-Null;
$b = New-Object System.Drawing.Bitmap ($r.Ri - $r.L), ($r.B - $r.T); $g = [System.Drawing.Graphics]::FromImage($b); $g.CopyFromScreen($r.L, $r.T, 0, 0, $b.Size); $b.Save('${file.replace(/'/g, "''")}'); $g.Dispose(); $b.Dispose()`);
}

let installed = false;
try {
  await rm(work, { recursive: true, force: true }); await mkdir(work, { recursive: true });
  const installerHash = await step('installer artifact present', async () => ({ file: installer, bytes: (await stat(installer)).size, sha256: hash(await readFile(installer)) }));
  await step('silent per-user install into an isolated directory', async () => {
    const result = spawnSync(installer, ['/S', `/D=${installDir}`], { windowsHide: true, timeout: 180_000 });
    if (result.status !== 0) throw new Error('INSTALLER_EXIT_' + result.status);
    installed = true;
    await until(() => existsSync(resolve(installDir, 'OperationAgent.exe')) && existsSync(sidecarNode()), 30_000, 'installed files');
    return { installDir, entries: (await readdir(installDir)).length };
  });
  await step('installed sidecar matches its integrity manifest and pinned runtime', async () => {
    const sidecar = resolve(installDir, 'resources/sidecar');
    const manifest = JSON.parse(await readFile(resolve(sidecar, 'manifest.json'), 'utf8'));
    for (const [name, expected] of Object.entries(manifest.files)) assert.equal(hash(await readFile(resolve(sidecar, name))), expected, name);
    const probe = spawnSync(sidecarNode(), ['-p', 'process.versions.node + " " + process.versions.modules'], { encoding: 'utf8', windowsHide: true });
    assert.equal(probe.stdout.trim(), `${manifest.node} ${manifest.abi}`);
    assert.equal(manifest.agentReady, false);
    return { files: Object.keys(manifest.files).length, node: manifest.node, abi: manifest.abi, sqlite: manifest.sqlite };
  });
  const first = await step('first launch: Main starts the installed sidecar and migrates a new database', async () => {
    const app = await launch();
    assert.equal(app.title, 'OperationAgent');
    // Evidence only: a headless session may have no capturable desktop.
    await delay(2500);
    let captured = true; try { screenshot(app.child.pid, resolve(evidenceDir, 'installed-window.png')); } catch { captured = false; }
    return { screenshot: captured, app, pid: app.child.pid, sidecarPid: app.sidecar.pid, sidecarPath: app.sidecar.path, title: app.title };
  });
  await step('graceful window close stops the sidecar and commits a clean run', async () => {
    await closeGracefully(first.app);
    const db = await inspect();
    assert.deepEqual(db.migrations, [1, 2, 3, 4, 5]); assert.deepEqual(db.runs, ['CLEAN']);
    assert.equal(db.node, '24.22.1'); return db;
  });
  await step('installed sidecar writes durable workbench data through the authenticated API', async () => {
    const bootstrap = { kind: 'bootstrap', protocolVersion: PROTOCOL_VERSION, mainRunId: randomUUID(), expressRunId: randomUUID(),
      parentPid: process.pid, token: randomBytes(32).toString('hex'), dataDirectory: resolve(userData, 'control-plane') };
    const child = spawn(sidecarNode(), [resolve(installDir, 'resources/sidecar/server/dist/entry.js')], { cwd: resolve(installDir, 'resources/sidecar'),
      env: { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP }, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const exited = once(child, 'exit');
    const ready = await new Promise((resolve, reject) => { child.once('message', resolve); child.once('exit', () => reject(new Error('SIDECAR_EXIT'))); child.send(bootstrap); });
    const project = await httpCall(ready.port, bootstrap, 'POST', CONTROL_ROUTES.projects, { name: 'smoke-project', path: 'C:/OperationAgentSmoke/project' });
    assert.equal(project.status, 201); assert.equal(project.authenticated, true);
    const settings = await httpCall(ready.port, bootstrap, 'PUT', CONTROL_ROUTES.settings, { theme: 'dark', density: 'compact', contextPanel: true, stopGraceMs: 10000, activeProjectId: project.body.id });
    assert.equal(settings.status, 200);
    const record = await httpCall(ready.port, bootstrap, 'POST', CONTROL_ROUTES.records, { records: [{ id: randomUUID(), value: 'installed 持久化' }] });
    assert.equal(record.status, 201);
    child.send({ kind: 'shutdown', mainRunId: bootstrap.mainRunId, expressRunId: bootstrap.expressRunId });
    const [code] = await exited; assert.equal(code, 0);
    return { projectId: project.body.id };
  });
  await step('relaunch reads the data back and closes cleanly again', async () => {
    const app = await launch(); await delay(1500); await closeGracefully(app);
    const db = await inspect();
    assert.deepEqual(db.projects, [{ name: 'smoke-project', path: 'C:/OperationAgentSmoke/project' }]);
    assert.equal(JSON.parse(db.settings).theme, 'dark'); assert.deepEqual(db.records, ['installed 持久化']);
    assert.deepEqual(db.runs, ['CLEAN', 'CLEAN', 'CLEAN']); return db;
  });
  await step('forced termination of the app tree is reconciled as INTERRUPTED on the next start', async () => {
    const crashed = await launch();
    spawnSync(system32('taskkill.exe'), ['/F', '/T', '/PID', String(crashed.child.pid)], { windowsHide: true });
    await crashed.exited; await until(() => !alive(crashed.sidecar.pid), 10_000, 'sidecar killed with tree');
    const app = await launch(); await delay(1500); await closeGracefully(app);
    const db = await inspect();
    assert.deepEqual(db.runs, ['CLEAN', 'CLEAN', 'CLEAN', 'INTERRUPTED', 'CLEAN']); assert.equal(db.projects.length, 1); return db;
  });
  await step('full sidecar integration suite passes against the installed resources', async () => {
    const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-timeout=120000', resolve(root, 'tests/integration/sidecar.test.mjs')],
      { cwd: root, encoding: 'utf8', windowsHide: true, env: { ...process.env, OA_SIDECAR_STAGE: resolve(installDir, 'resources/sidecar') }, maxBuffer: 8 * 1024 * 1024 });
    await writeFile(resolve(evidenceDir, 'installed-sidecar-suite.log'), (result.stdout ?? '') + (result.stderr ?? ''));
    if (result.status !== 0) throw new Error('INSTALLED_SIDECAR_SUITE_FAILED');
    return { summary: (result.stdout.match(/ℹ (tests|pass|fail) \d+/g) ?? []).join(', ') };
  });
  void installerHash;
} finally {
  if (installed) {
    await step('silent uninstall removes the application', async () => {
      const uninstaller = resolve(installDir, 'Uninstall OperationAgent.exe');
      const result = spawnSync(uninstaller, ['/S', `_?=${installDir}`], { windowsHide: true, timeout: 120_000 });
      if (result.status !== 0) throw new Error('UNINSTALLER_EXIT_' + result.status);
      assert.equal(existsSync(resolve(installDir, 'OperationAgent.exe')), false);
      assert.equal(existsSync(resolve(installDir, 'resources')), false);
      const registry = spawnSync(system32('reg.exe'), ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/s', '/f', 'OperationAgent', '/d'], { encoding: 'utf8', windowsHide: true });
      assert.doesNotMatch(registry.stdout ?? '', /DisplayName\s+REG_SZ\s+OperationAgent/);
    }).catch(() => {});
  }
  const passed = steps.length > 0 && steps.every(row => row.passed) && steps.some(row => row.name.startsWith('silent uninstall'));
  const report = { check: 'P1_INSTALLED_SMOKE_SEC18', passed, target: 'win32-x64', finishedAt: new Date().toISOString(), durationMs: Date.now() - started,
    source: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).stdout.trim(), installer: steps[0]?.detail ?? null,
    steps: steps.map(row => ({ ...row, detail: row.detail && typeof row.detail === 'object' && 'app' in row.detail ? { ...row.detail, app: undefined } : row.detail })) };
  await writeFile(resolve(evidenceDir, 'installed-smoke.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ check: report.check, passed, steps: steps.length }));
  if (!passed) process.exitCode = 1;
}
