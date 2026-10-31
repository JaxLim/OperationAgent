// Test-only Express host for the restricted fixture: the real Express launcher/supervisor in a separate
// pinned-Node process, so SEC-17 can kill it like a crashed Express. Never staged into the release sidecar.
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer, connect } from 'node:net';
import { createSocket } from 'node:dgram';
import { lookup } from 'node:dns/promises';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { FixtureSupervisor } from '../../apps/server/dist/worker/launcher.js';

const runtimeDirectory = process.argv[2];
if (!runtimeDirectory || !process.send) process.exit(2);
const expressRunId = randomUUID();
const supervisor = new FixtureSupervisor({ target: `${process.platform}-${process.arch}`, runtimeDirectory, expressRunId });
// SEC-W01 probe fixtures: canaries, loopback listeners that count hits, a decoy process and host-side controls.
const root = resolve(import.meta.dirname, '../..');
const probe = { cleanup: [], hits: { tcp4: 0, tcp6: 0, udp4: 0 }, baseline: { tcp4: 0, tcp6: 0, udp4: 0 }, sibling: null };
const PUBLIC = { public4: { host: '1.1.1.1', port: 443, dns: '1.1.1.1' }, public6: { host: '2606:4700:4700::1111', port: 443 }, dnsName: 'example.com' };
const settle = (promise, ms = 1500) => Promise.race([promise, new Promise(done => setTimeout(() => done('TIMEOUT'), ms))]);
const hostTcp = (host, port) => settle(new Promise(done => {
  const socket = connect({ host, port }); socket.once('connect', () => { socket.destroy(); done('REACHABLE'); });
  socket.once('error', error => { socket.destroy(); done(`ERROR:${error.code}`); });
}));
// Connected UDP DNS query from the unrestricted host: REACHABLE only if a reply arrives.
const hostUdpDns = (host, payload) => settle(new Promise(done => {
  const socket = createSocket('udp4'); const finish = value => { try { socket.close(); } catch { /* Closed. */ } done(value); };
  socket.once('error', error => finish(`ERROR:${error.code}`)); socket.once('message', () => finish('REACHABLE'));
  socket.connect(53, host, error => { if (error) finish(`ERROR:${error.code}`); else socket.send(payload); });
}));
const DNS_QUERY = Buffer.from('abcd01000001000000000000076578616d706c6503636f6d0000010001', 'hex');
const listen = (server, host) => new Promise((done, fail) => { server.once('error', fail); server.listen(0, host, () => done(server.address().port)); });
// Windows Filtering Platform audit (disposable runner only). A packet drop (5152) or blocked connection (5157)
// names the application, direction and destination: affirmative evidence that a datagram never left the machine.
const system32 = tool => resolve(process.env.SystemRoot ?? 'C:\\Windows', 'System32', tool);
const WFP_SUBCATEGORIES = ['{0CCE9225-69AE-11D9-BED3-505054503030}', '{0CCE9226-69AE-11D9-BED3-505054503030}'];
function enableWfpAudit() {
  if (process.env.GITHUB_ACTIONS !== 'true') return false;
  return WFP_SUBCATEGORIES.every(id => spawnSync(system32('auditpol.exe'), ['/set', `/subcategory:${id}`, '/success:enable', '/failure:enable'],
    { windowsHide: true }).status === 0);
}
function wfpEvents(since) {
  const query = `*[System[(EventID=5152 or EventID=5157) and TimeCreated[@SystemTime>='${since}']]]`;
  const result = spawnSync(system32('wevtutil.exe'), ['qe', 'Security', `/q:${query}`, '/f:xml', '/c:5000'],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  const field = (event, name) => new RegExp(`<Data Name='${name}'>([^<]*)</Data>`).exec(event)?.[1] ?? '';
  return (result.stdout ?? '').split('</Event>').filter(event => event.includes('<EventID>'))
    .map(event => ({ id: Number(/<EventID>(\d+)<\/EventID>/.exec(event)?.[1]), application: field(event, 'Application').toLowerCase(),
      direction: field(event, 'Direction') === '%%14593' ? 'outbound' : 'inbound', destination: field(event, 'DestAddress'),
      port: Number(field(event, 'DestPort')), protocol: Number(field(event, 'Protocol')) }))
    .filter(event => event.application.includes('probe-runtime'))
    .map(({ id, direction, destination, port, protocol }) => ({ id, direction, destination, port, protocol }));
}
async function prepareProbe() {
  probe.since = new Date().toISOString(); probe.wfpAudit = enableWfpAudit();
  const secret = randomUUID();
  const canary = (label, directory) => {
    const path = resolve(directory, `oa-canary-${randomUUID()}.txt`); writeFileSync(path, secret); probe.cleanup.push(() => rmSync(path, { force: true }));
    return { label, path, secret };
  };
  const readCanaries = [canary('workspace', resolve(root, '.cache')), canary('profile', homedir()), canary('temp', tmpdir()),
    { label: 'repo-git-config', path: resolve(root, '.git/config'), secret: '[core]' }];
  const tcp4 = createServer(socket => { probe.hits.tcp4++; socket.destroy(); }); const tcp6 = createServer(socket => { probe.hits.tcp6++; socket.destroy(); });
  const udp4 = createSocket('udp4'); udp4.on('message', () => { probe.hits.udp4++; });
  const loopback = { tcp4: await listen(tcp4, '127.0.0.1'), tcp6: await listen(tcp6, '::1'),
    udp4: await new Promise(done => udp4.bind(0, '127.0.0.1', () => done(udp4.address().port))) };
  probe.cleanup.push(() => tcp4.close(), () => tcp6.close(), () => udp4.close());
  probe.sibling = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  probe.cleanup.push(() => probe.sibling.kill());
  const parentAddon = resolve(root, 'packages/platform-worker/native-dist/win32-x64/parent.node');
  const targets = { ...PUBLIC, readCanaries, loopback, siblingPid: probe.sibling.pid, parentAddon,
    listDirectories: [{ label: 'profile', path: homedir() }, { label: 'workspace', path: root }, { label: 'users', path: resolve(process.env.SystemDrive ?? 'C:', '/Users') }],
    writeDirectories: [{ label: 'workspace', path: resolve(root, '.cache') }, { label: 'profile', path: homedir() }, { label: 'temp', path: tmpdir() },
      { label: 'runtime', path: runtimeDirectory }] };
  writeFileSync(resolve(runtimeDirectory, 'targets.json'), JSON.stringify(targets));
  // Host-side controls: what this (unrestricted) host can reach, so an unreachable target is not mistaken for a denial.
  const [tcp4Public, tcp6Public, udp4Dns, dns, loopbackTcp4, loopbackTcp6] = await Promise.all([hostTcp(PUBLIC.public4.host, PUBLIC.public4.port),
    hostTcp(PUBLIC.public6.host, PUBLIC.public6.port), hostUdpDns(PUBLIC.public4.dns, DNS_QUERY),
    settle(lookup(PUBLIC.dnsName).then(() => 'REACHABLE', error => `ERROR:${error.code}`)), hostTcp('127.0.0.1', loopback.tcp4), hostTcp('::1', loopback.tcp6)]);
  const sent = createSocket('udp4'); await new Promise(done => sent.send(Buffer.from('control'), loopback.udp4, '127.0.0.1', () => { sent.close(); done(); }));
  await new Promise(done => setTimeout(done, 300));
  const loopbackUdp4 = probe.hits.udp4 > 0 ? 'REACHABLE' : 'NOT_DELIVERED';
  // Hits caused by the host's own controls are the baseline; only later hits can come from the Worker.
  probe.baseline = { ...probe.hits };
  return { controls: { tcp4Public, tcp6Public, udp4Dns, dns, loopbackTcp4, loopbackTcp6, loopbackUdp4 },
    parentAddonExists: existsSync(parentAddon), canaries: readCanaries.map(item => item.label) };
}
async function observeProbe() {
  const siblingAlive = probe.sibling?.exitCode === null && probe.sibling?.signalCode === null;
  const hits = Object.fromEntries(Object.entries(probe.hits).map(([kind, count]) => [kind, count - probe.baseline[kind]]));
  // The audit log is written asynchronously; give it a moment before reading the probe's WFP events.
  if (probe.wfpAudit) await new Promise(done => setTimeout(done, 2000));
  const observed = { hits, siblingAlive, wfpAudit: probe.wfpAudit === true, wfp: probe.wfpAudit ? wfpEvents(probe.since) : [] };
  for (const step of probe.cleanup.splice(0)) { try { step(); } catch { /* Best-effort cleanup of test fixtures. */ } }
  rmSync(resolve(runtimeDirectory, 'targets.json'), { force: true });
  return observed;
}
const handlers = {
  async 'prepare-probe'() { return prepareProbe(); },
  async 'observe-probe'() { return observeProbe(); },
  async start() { const worker = await supervisor.start(); return { expressRunId, hostPid: process.pid, baseline: worker.baseline, workerRunId: worker.identity.workerRunId }; },
  async health() { return supervisor.worker.health(); },
  // Capture the Worker first: the supervisor may already be restarting a replacement when it exits.
  async fault(mode) { const worker = supervisor.worker; void worker.fault(mode).catch(() => {}); return worker.closed; },
  async burst(count) {
    const worker = supervisor.worker;
    const results = await Promise.allSettled(Array.from({ length: count }, () => worker.health()));
    return { fulfilled: results.filter(result => result.status === 'fulfilled').length,
      rejected: results.filter(result => result.status === 'rejected').length, exit: await worker.closed };
  },
  async snapshot() { return supervisor.snapshot(); },
  async stop() { const worker = supervisor.worker; await supervisor.stop(); return worker ? worker.closed : null; },
};
process.on('message', message => {
  void (async () => {
    try { process.send({ id: message.id, value: await handlers[message.command](message.input) }); }
    catch (error) { process.send({ id: message.id, error: error.message }); }
  })();
});
process.on('disconnect', () => { for (const step of probe.cleanup.splice(0)) { try { step(); } catch { /* Best effort. */ } } void supervisor.stop().finally(() => process.exit(0)); });
process.send({ kind: 'ready', pid: process.pid });
