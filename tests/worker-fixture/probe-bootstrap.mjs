// SEC-W01 probe (test-only; never staged into a release). It plays a compromised Worker: inside the real
// AppContainer + Job it attempts each forbidden action, reports one OA-PROBE line on the bounded stderr
// diagnostic pipe, then serves the normal fixture so the parent's handshake and cleanup run unchanged.
import { readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { createSocket } from 'node:dgram';
import { lookup } from 'node:dns/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { runFixture } from '../../apps/agent-worker/dist/fixture.js';

const here = name => fileURLToPath(new URL(`./${name}`, import.meta.url));
const targets = JSON.parse(readFileSync(here('targets.json'), 'utf8'));
const TIMEOUT_MS = 1500;

// DENIED: the OS refused (or the target is not even visible). ALLOWED: the action succeeded. Anything else,
// including a timeout, is reported verbatim and counts as UNKNOWN, which fails the gate (ADR-WIN-001).
const denied = new Set(['EACCES', 'EPERM', 'ESRCH', 'ENETUNREACH', 'EHOSTUNREACH', 'EADDRNOTAVAIL']);
const classify = error => denied.has(error?.code) || (error?.code === 'ERR_DLOPEN_FAILED' && /access is denied/i.test(error.message))
  ? 'DENIED' : `ERROR:${error?.code ?? error?.message ?? 'UNKNOWN'}`.slice(0, 48);
const withTimeout = (promise, label = 'TIMEOUT') => Promise.race([promise, new Promise(done => setTimeout(() => done(label), TIMEOUT_MS))]);
const attempt = async action => { try { return (await action()) ?? 'ALLOWED'; } catch (error) { return classify(error); } };

const tcp = (host, port) => withTimeout(new Promise(done => {
  const socket = connect({ host, port });
  socket.once('connect', () => { socket.destroy(); done('ALLOWED'); });
  socket.once('error', error => { socket.destroy(); done(error.code === 'ECONNREFUSED' ? 'ALLOWED_REFUSED' : classify(error)); });
}));
const udp = (type, host, port, payload, expectReply) => withTimeout(new Promise(done => {
  const socket = createSocket(type);
  socket.once('error', error => { socket.close(); done(classify(error)); });
  socket.once('message', () => { socket.close(); done('ALLOWED'); });
  socket.send(payload, port, host, error => { if (error) { socket.close(); done(classify(error)); } else if (!expectReply) { setTimeout(() => { socket.close(); done('SENT'); }, 300); } });
}), 'NO_RESPONSE');
// A minimal DNS A query for example.com.
const dnsQuery = Buffer.from('abcd01000001000000000000076578616d706c6503636f6d0000010001', 'hex');

const probes = {
  'self.read-runtime': () => attempt(() => { readFileSync(here('bootstrap.mjs')); }),
  'native.dlopen-parent-addon': () => attempt(() => { process.dlopen({ exports: {} }, targets.parentAddon); }),
  'proc.spawn': () => attempt(() => withTimeout(new Promise((done, fail) => {
    const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore', windowsHide: true });
    child.once('spawn', () => { child.kill(); done('ALLOWED'); }); child.once('error', fail);
  }))),
  'proc.kill-sibling': () => attempt(() => { process.kill(targets.siblingPid, 'SIGTERM'); }),
  'net.tcp4.public': () => tcp(targets.public4.host, targets.public4.port),
  'net.tcp6.public': () => tcp(targets.public6.host, targets.public6.port),
  'net.tcp4.loopback': () => tcp('127.0.0.1', targets.loopback.tcp4),
  'net.tcp6.loopback': () => tcp('::1', targets.loopback.tcp6),
  'net.udp4.dns-public': () => udp('udp4', targets.public4.dns, 53, dnsQuery, true),
  'net.udp4.loopback': () => udp('udp4', '127.0.0.1', targets.loopback.udp4, Buffer.from('oa-probe'), false),
  'net.dns.lookup': () => attempt(() => withTimeout(lookup(targets.dnsName).then(() => 'ALLOWED'))),
};
for (const { label, path, secret } of targets.readCanaries) {
  probes[`file.read.${label}`] = () => attempt(() => readFileSync(path, 'utf8').includes(secret) ? 'ALLOWED' : 'ERROR:CONTENT_MISMATCH');
}
for (const { label, path } of targets.listDirectories) probes[`file.list.${label}`] = () => attempt(() => { readdirSync(path); });
for (const { label, path } of targets.writeDirectories) {
  probes[`file.write.${label}`] = () => attempt(() => { const file = join(path, `oa-probe-${randomUUID()}.txt`); writeFileSync(file, 'x'); rmSync(file, { force: true }); });
}
const names = Object.keys(probes);
const outcomes = await Promise.all(names.map(name => probes[name]().catch(error => classify(error))));
// The trusted channel loads last: the attacks above run without it, and a refused load is reported, not thrown.
const addon = { exports: {} };
let loaded = true;
try { process.dlopen(addon, here('channel.node')); } catch (error) { loaded = false; names.push('native.load'); outcomes.push(classify(error)); }
names.push('native.exports'); outcomes.push(Object.keys(addon.exports).sort().join(','));
const native = addon.exports;
const report = { env: Object.keys(process.env).sort(), results: Object.fromEntries(names.map((name, index) => [name, outcomes[index]])) };
process.stderr.write(`OA-PROBE ${JSON.stringify(report)}\n`);
if (!loaded) process.exit(1);

const channel = {
  read: (maxBytes, deadlineMs) => native.read(maxBytes, deadlineMs),
  write: (frame, deadlineMs) => native.write(Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength), deadlineMs),
  close: () => native.close(),
};
const clock = { schedule(milliseconds, callback) { const timer = setTimeout(callback, milliseconds); return () => clearTimeout(timer); } };
await runFixture(channel, clock);
