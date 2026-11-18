import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { resolve, sep } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const cache = resolve(root, '.cache/sec23');
const launcher = resolve(cache, 'tool-launcher.exe');
const disposable = process.platform === 'win32' && process.arch === 'x64' &&
  process.env.RUNNER_OS === 'Windows' && process.env.GITHUB_ACTIONS === 'true';

test('SEC-23 launcher refuses the developer host before provisioning', { skip: process.platform !== 'win32' || disposable }, () => {
  const result = spawnSync(launcher, ['invalid', 'bash', '1000'], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /DISPOSABLE_WINDOWS_RUNNER_REQUIRED/);
});

test('SEC-23 Windows x64: write_file and bash run in an AppContainer with scoped writes, network policy and Job cleanup',
  { skip: !disposable && 'BLOCKED: needs a disposable Windows runner', timeout: 120_000 }, async t => {
    let connections = 0;
    const listener = createServer(socket => { connections++; socket.end(); });
    listener.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    t.after(() => listener.close());
    const port = listener.address().port;
    const outsideCheck = connect(port, '127.0.0.1');
    await once(outsideCheck, 'close');
    assert.equal(connections, 1, 'host control confirmed the same endpoint was listening');

    async function fixture() {
      await mkdir(cache, { recursive: true });
      const directory = await mkdtemp(resolve(cache, 'case-'));
      t.after(async () => {
        const target = await realpath(directory);
        if (target.startsWith((await realpath(cache)) + sep)) await rm(target, { recursive: true, force: true, maxRetries: 4 });
      });
      const workspace = resolve(directory, 'workspace');
      const runtime = resolve(directory, 'runtime');
      const bashBin = resolve(runtime, 'usr/bin');
      await mkdir(resolve(workspace, '.git'), { recursive: true });
      await mkdir(bashBin, { recursive: true });
      await Promise.all([
        copyFile(process.execPath, resolve(runtime, 'node.exe')),
        copyFile(resolve(root, 'packages/platform-sandbox/write-file.mjs'), resolve(runtime, 'write-file.mjs')),
        writeFile(resolve(workspace, '.git/config'), 'git sentinel\n'),
        writeFile(resolve(directory, 'outside.txt'), 'outside sentinel\n'),
        ...['bash.exe', 'msys-2.0.dll', 'msys-intl-8.dll', 'msys-iconv-2.dll'].map(name =>
          copyFile(resolve('C:/Program Files/Git/usr/bin', name), resolve(bashBin, name))),
        writeFile(resolve(runtime, 'probe.cjs'), [
          'const fs = require("node:fs");',
          'const net = require("node:net");',
          'if (process.argv[2] === "hold") {',
          '  fs.writeFileSync("child.pid", String(process.pid)); setInterval(() => {}, 1000);',
          '} else {',
          '  const socket = net.connect(Number(process.argv[2]), "127.0.0.1");',
          '  function finish(outcome) { fs.writeFileSync("network.txt", outcome); socket.destroy(); }',
          '  socket.once("connect", () => finish("CONNECTED"));',
          '  socket.once("error", error => finish(error.code));',
          '  socket.setTimeout(2000, () => finish("TIMEOUT"));',
          '}',
        ].join('\n')),
      ]);
      const run = (tool, input, timeout, target) => new Promise((done, reject) => {
        const child = execFile(launcher, [directory, tool, String(timeout), ...(target ? [target] : [])],
          { encoding: 'utf8', windowsHide: true, timeout: timeout + 15_000, maxBuffer: 64 * 1024 },
          (error, stdout, stderr) => {
            if (error) { reject(new Error(stderr.trim() || error.message)); return; }
            try { done({ ...JSON.parse(stdout), diagnostics: stderr.trim() }); } catch (error) { reject(error); }
          });
        child.stdin.on('error', () => { /* Launch rejection is reported by execFile. */ });
        child.stdin.end(input);
      });
      return { directory, workspace, runtime, run };
    }
    const evidence = { check: 'SEC_23_WIN32_X64', source: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).stdout.trim(),
      hostControl: true, completed: false, cases: {} };
    const output = resolve(root, 'artifacts/p1/win32-x64/sec23.json');
    await mkdir(resolve(output, '..'), { recursive: true });
    const check = result => {
      assert.equal(result.activeProcesses, 0);
      assert.equal(result.profileRemoved, true);
      assert.ok(result.integrity <= 4096);
    };
    const bashPath = path => '"' + path.replaceAll('\\', '/').replaceAll('"', '\\"') + '"';
    try {
      const writer = await fixture();
      const wrote = evidence.cases.writeFile = await writer.run('write_file', 'hello from the sandbox\n', 10_000, 'created.txt');
      check(wrote);
      assert.equal(wrote.exitCode, 0, wrote.diagnostics);
      assert.equal(wrote.timedOut, false);
      assert.equal(await readFile(resolve(writer.workspace, 'created.txt'), 'utf8'), 'hello from the sandbox\n');

      const shell = await fixture();
      const childCommand = `${bashPath(resolve(shell.runtime, 'node.exe'))} --preserve-symlinks --preserve-symlinks-main ${bashPath(resolve(shell.runtime, 'probe.cjs'))}`;
      const script = [
        'printf "bash allowed\n" > shell.txt || exit 20',
        'if printf "outside\n" > ../outside.txt; then exit 21; fi',
        'if printf "git write\n" >> .git/config; then exit 22; fi',
        `${childCommand} ${port}`,
      ].join('\n') + '\n';
      const shellResult = evidence.cases.bash = await shell.run('bash', script, 15_000);
      check(shellResult);
      assert.equal(shellResult.exitCode, 0, shellResult.diagnostics);
      assert.equal(shellResult.timedOut, false);
      assert.equal(await readFile(resolve(shell.workspace, 'shell.txt'), 'utf8'), 'bash allowed\n');
      assert.equal(await readFile(resolve(shell.directory, 'outside.txt'), 'utf8'), 'outside sentinel\n');
      assert.equal(await readFile(resolve(shell.workspace, '.git/config'), 'utf8'), 'git sentinel\n');
      const network = evidence.cases.network = await readFile(resolve(shell.workspace, 'network.txt'), 'utf8');
      assert.ok(['EACCES', 'EPERM', 'ECONNREFUSED', 'ETIMEDOUT', 'TIMEOUT'].includes(network), network);
      assert.equal(connections, 1, 'the sandboxed process made no connection to the live endpoint');

      const tree = await fixture();
      const hold = `${bashPath(resolve(tree.runtime, 'node.exe'))} --preserve-symlinks --preserve-symlinks-main ${bashPath(resolve(tree.runtime, 'probe.cjs'))} hold &\nwait\n`;
      const killed = evidence.cases.processTree = await tree.run('bash', hold, 5_000);
      check(killed);
      assert.equal(killed.timedOut, true, killed.diagnostics);
      assert.ok(killed.totalProcesses >= 2);
      const childPid = Number(await readFile(resolve(tree.workspace, 'child.pid'), 'utf8'));
      assert.ok(Number.isInteger(childPid) && childPid > 0);
      assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });
      evidence.completed = true;
    } finally {
      await writeFile(output, JSON.stringify(evidence, null, 2) + '\n', 'utf8');
    }
  });
