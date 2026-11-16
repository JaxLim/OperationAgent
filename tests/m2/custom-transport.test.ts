import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import { EventEmitter, once } from 'node:events';
import { createServer, type RequestListener } from 'node:http';
import { type AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import tls from 'node:tls';
import { sendCustomChat, validateCustomEndpoint } from '../../apps/server/dist/models/custom-transport.js';

async function localServer(t: TestContext, handler: RequestListener) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  return 'http://localhost:' + (server.address() as AddressInfo).port;
}

test('only public HTTPS and explicitly named local HTTP endpoints are accepted', async () => {
  for (const url of [
    'http://8.8.8.8', 'https://localhost', 'https://127.0.0.1', 'http://[::1]', 'http://127.0.0.2',
    'http://2130706433', 'http://127.1', 'http://%6cocalhost', 'http://localhost.', 'http://@localhost',
    'https://user:pass@8.8.8.8', 'https://8.8.8.8/v1?', 'https://8.8.8.8/#', 'file:///etc/passwd',
    ...['0.0.0.0', '10.1.2.3', '169.254.169.254', '168.63.129.16', '100.100.100.200', '192.0.2.1',
      '198.19.0.1', '224.0.0.1', '[::ffff:8.8.8.8]', '[64:ff9b::808:808]', '[64:ff9b:1::1]',
      '[fd00:ec2::254]', '[fe80::1]', '[2001::1]', '[2002:0808:0808::1]', '[3fff::1]',
      '[2606:4700::5efe:a9fe:a9fe]'].map(host => 'https://' + host),
  ]) await assert.rejects(validateCustomEndpoint(url, true), /CUSTOM_ENDPOINT/, url);
  await assert.rejects(validateCustomEndpoint('http://localhost', false));
  for (const url of ['http://127.0.0.1', 'http://localhost', 'https://8.8.8.8', 'https://[2606:4700:4700::1111]']) {
    await validateCustomEndpoint(url, true);
  }
});

test('every request checks every DNS answer after endpoint validation', async t => {
  const answers = [{ address: '8.8.8.8', family: 4 }];
  const lookup = t.mock.method(dns, 'lookup', async (_host: string, options: { all: boolean }) => {
    assert.equal(options.all, true);
    return answers;
  });
  const endpoint = 'https://provider.example/v1';
  await validateCustomEndpoint(endpoint, false);
  answers.push({ address: '::ffff:169.254.169.254', family: 6 });
  await assert.rejects(sendCustomChat(endpoint, false, {}), /CUSTOM_ENDPOINT/);
  assert.equal(lookup.mock.callCount(), 2);
});

test('TLS dials the approved numeric IP with the provider SNI and certificate verification', async t => {
  let sni: string | undefined;
  const server = tls.createServer({ SNICallback(name, done) {
    sni = name;
    done(new Error('end fixture handshake'));
  } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const lookup = t.mock.method(dns, 'lookup', async () => [{ address: '8.8.8.8', family: 4 }]);
  const connect = tls.connect;
  const dial = t.mock.method(tls, 'connect', (options: tls.ConnectionOptions) => {
    assert.equal(options.host, '8.8.8.8');
    assert.equal(options.rejectUnauthorized, true);
    // Route only the test TCP dial to our listener. Node still constructs the real ClientHello.
    return connect({ ...options, host: '127.0.0.1', port: (server.address() as AddressInfo).port });
  });
  await assert.rejects(sendCustomChat('https://provider.example/v1', false, {}));
  assert.equal(dial.mock.callCount(), 1);
  assert.equal(lookup.mock.callCount(), 1);
  assert.equal(sni, 'provider.example');
});

test('DNS deadline rejects before a pending lookup can dispatch a request', { timeout: 2_000 }, async t => {
  let finish!: (answers: { address: string; family: number }[]) => void;
  const stalled = new Promise(resolve => { finish = resolve; });
  t.mock.method(dns, 'lookup', () => stalled);
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', () => timeout(30));
  const dial = t.mock.method(tls, 'connect', () => assert.fail('late DNS answer dispatched'));
  // An open listener keeps the unref'ed AbortSignal timer observable in this isolated test.
  await localServer(t, (_req, res) => res.end());
  await assert.rejects(sendCustomChat('https://provider.example', false, {}), { name: 'TimeoutError' });
  finish([{ address: '8.8.8.8', family: 4 }]);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(dial.mock.callCount(), 0);
});

test('local socket receives one POST at the appended path and never follows redirects', { timeout: 5_000 }, async t => {
  const calls: string[] = [];
  const base = await localServer(t, async (req, res) => {
    calls.push(req.url!);
    assert.equal(req.method, 'POST');
    assert.equal(req.headers.host, new URL(base).host);
    assert.equal(req.headers.authorization, 'Bearer fixture');
    let body = '';
    for await (const chunk of req) body += chunk;
    assert.equal(body, '{}');
    if (req.url?.startsWith('/redirect/')) res.writeHead(307, { location: base + '/trap' });
    res.end('reply');
  });
  const init = { method: 'POST', headers: { authorization: 'Bearer fixture' }, body: '{}' };
  await assert.rejects(sendCustomChat(base, true, { headers: { host: 'other.example' } }), /CUSTOM_ENDPOINT/);
  await assert.rejects(sendCustomChat(base, true, { headers: { authorization: 'token\nsecret' } }),
    { message: 'CUSTOM_ENDPOINT_INVALID' });
  assert.equal(await (await sendCustomChat(base + '/api/v1/', true, init)).text(), 'reply');
  await assert.rejects(sendCustomChat(base + '/redirect', true, init), /REDIRECT/);
  assert.deepEqual(calls, ['/api/v1/chat/completions', '/redirect/chat/completions']);
});

test('chunked response limit and cancellation close the real connection', { timeout: 5_000 }, async t => {
  const events = new EventEmitter();
  const partial = once(events, 'partial');
  const closed = once(events, 'closed');
  const base = await localServer(t, (req, res) => {
    if (req.url?.startsWith('/large/')) {
      res.writeHead(200, { 'transfer-encoding': 'chunked' });
      res.end(Buffer.alloc(4 * 1024 * 1024 + 1));
    } else {
      res.once('close', () => events.emit('closed'));
      res.write('partial');
      events.emit('partial');
    }
  });
  await assert.rejects(sendCustomChat(base + '/large', true, {}), /TOO_LARGE/);
  const controller = new AbortController();
  const pending = sendCustomChat(base, true, { signal: controller.signal });
  await partial;
  controller.abort();
  await assert.rejects(pending);
  await closed;
});
