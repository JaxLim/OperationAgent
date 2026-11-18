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
    async function fixture(withBash = false) {
      await mkdir(cache, { recursive: true });
      const directory = await mkdtemp(resolve(cache, 'case-'));
      t.after(async () => {
        const target = await realpath(directory);
        if (target.startsWith((await realpath(cache)) + sep)) await rm(target, { recursive: true, force: true, maxRetries: 4 });
      });
      const workspace = resolve(directory, 'workspace');
      const runtime = resolve(directory, 'runtime');
      await mkdir(resolve(workspace, '.git'), { recursive: true });
      await mkdir(runtime);
      if (withBash) {
        const bashBin = resolve(runtime, 'usr/bin');
        await mkdir(bashBin, { recursive: true });
        await Promise.all(['bash.exe', 'msys-2.0.dll', 'msys-intl-8.dll', 'msys-iconv-2.dll'].map(name =>
          copyFile(resolve('C:/Program Files/Git/usr/bin', name), resolve(bashBin, name))));
      }
      await Promise.all([
        copyFile(process.execPath, resolve(runtime, 'node.exe')),
        copyFile(resolve(root, 'tests/worker-fixture/tool-sandbox/write-file.mjs'), resolve(runtime, 'write-file.mjs')),
        writeFile(resolve(workspace, '.git/config'), 'git sentinel\n'),
        writeFile(resolve(directory, 'outside.txt'), 'outside sentinel\n'),
        writeFile(resolve(runtime, 'probe.cjs'), [
          'const assert = require("node:assert/strict");',
          'const { spawn } = require("node:child_process");',
          'const fs = require("node:fs");',
          'const net = require("node:net");',
          'const mode = process.argv[2];',
          'if (mode === "acl") {',
          '  fs.writeFileSync("allowed.txt", "allowed");',
          '  for (const path of ["../outside.txt", ".git/config"]) {',
          '    assert.throws(() => fs.appendFileSync(path, "probe"), error => ["EACCES", "EPERM"].includes(error.code));',
          '  }',
          '} else if (mode === "hold") {',
          '  const child = spawn(process.execPath, ["--preserve-symlinks", "--preserve-symlinks-main", __filename, "child"], { stdio: "inherit" });',
          '  child.on("exit", () => { process.exitCode = 1; });',
          '} else if (mode === "child") {',
          '  fs.writeFileSync("child.pid", String(process.pid)); setInterval(() => {}, 1000);',
          '} else {',
          '  const socket = net.connect(Number(mode), "127.0.0.1");',
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
      return { directory, workspace, run };
    }
    const evidence = { check: 'SEC_23_WIN32_X64', source: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).stdout.trim(),
      hostControl: false, completed: false, cases: {} };
    const output = resolve(root, 'artifacts/p1/win32-x64/sec23.json');
    await mkdir(resolve(output, '..'), { recursive: true });
    const check = result => {
      assert.equal(result.activeProcesses, 0);
      assert.equal(result.profileRemoved, true);
      assert.ok(result.integrity <= 4096);
    };
    const verify = (name, run) => t.test(name, async () => {
      const result = evidence.cases[name] = { passed: false };
      await run(result);
      result.passed = true;
    });
    try {
      await verify('writeFile', async result => {
        const writer = await fixture();
        const wrote = result.launch = await writer.run('write_file', 'hello from the sandbox\n', 10_000, 'created.txt');
        check(wrote);
        assert.equal(wrote.exitCode, 0, wrote.diagnostics);
        assert.equal(wrote.timedOut, false);
        assert.equal(await readFile(resolve(writer.workspace, 'created.txt'), 'utf8'), 'hello from the sandbox\n');
      });

      await verify('acl', async result => {
        const probe = await fixture();
        const launched = result.launch = await probe.run('probe', '', 10_000, 'acl');
        check(launched);
        assert.equal(launched.exitCode, 0, launched.diagnostics);
        assert.equal(launched.timedOut, false);
        assert.equal(await readFile(resolve(probe.workspace, 'allowed.txt'), 'utf8'), 'allowed');
        assert.equal(await readFile(resolve(probe.directory, 'outside.txt'), 'utf8'), 'outside sentinel\n');
        assert.equal(await readFile(resolve(probe.workspace, '.git/config'), 'utf8'), 'git sentinel\n');
      });

      await verify('network', async result => {
        let connections = 0;
        const listener = createServer(socket => { connections++; socket.end(); });
        listener.listen(0, '127.0.0.1');
        t.after(() => listener.close());
        await once(listener, 'listening');
        const port = listener.address().port;
        await once(connect(port, '127.0.0.1'), 'close');
        assert.equal(connections, 1, 'host control confirmed the same endpoint was listening');
        evidence.hostControl = true;
        const probe = await fixture();
        const network = result.launch = await probe.run('probe', '', 10_000, String(port));
        check(network);
        assert.equal(network.exitCode, 0, network.diagnostics);
        assert.equal(network.timedOut, false);
        result.outcome = await readFile(resolve(probe.workspace, 'network.txt'), 'utf8');
        assert.ok(['EACCES', 'EPERM', 'ECONNREFUSED', 'ETIMEDOUT', 'TIMEOUT'].includes(result.outcome), result.outcome);
        assert.equal(connections, 1, 'the sandboxed process made no connection to the live endpoint');
      });

      await verify('processTree', async result => {
        const tree = await fixture();
        const killed = result.launch = await tree.run('probe', '', 5_000, 'hold');
        check(killed);
        assert.equal(killed.timedOut, true, killed.diagnostics);
        assert.ok(killed.totalProcesses >= 2);
        const childPid = Number(await readFile(resolve(tree.workspace, 'child.pid'), 'utf8'));
        assert.ok(Number.isInteger(childPid) && childPid > 0);
        assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });
      });

      await verify('bash', async result => {
        const shell = await fixture(true);
        const script = [
          'printf "bash allowed\\n" > shell.txt || exit 20',
          'if printf "outside\\n" > ../outside.txt; then exit 21; fi',
          'if printf "git write\\n" >> .git/config; then exit 22; fi',
          'exit 0',
        ].join('\n') + '\n';
        const launched = result.launch = await shell.run('bash', script, 15_000);
        check(launched);
        assert.equal(launched.exitCode, 0, launched.diagnostics);
        assert.equal(launched.timedOut, false);
        assert.equal(await readFile(resolve(shell.workspace, 'shell.txt'), 'utf8'), 'bash allowed\n');
        assert.equal(await readFile(resolve(shell.directory, 'outside.txt'), 'utf8'), 'outside sentinel\n');
        assert.equal(await readFile(resolve(shell.workspace, '.git/config'), 'utf8'), 'git sentinel\n');
      });
      evidence.completed = Object.values(evidence.cases).every(result => result.passed);
    } finally {
      await writeFile(output, JSON.stringify(evidence, null, 2) + '\n', 'utf8');
    }
  });
