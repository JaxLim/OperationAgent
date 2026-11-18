import assert from 'node:assert/strict';
import { setImmediate as flush } from 'node:timers/promises';
import { test } from 'node:test';
import { createHfDeviceAuthorization, refreshHfTokens, type HfTokens } from '../../apps/server/dist/models/hf-device.js';

const deviceUrl = 'https://huggingface.co/oauth/device';
const tokenUrl = 'https://huggingface.co/oauth/token';
const clientId = 'test-public-client';
const device = { device_code: 'private-code', user_code: 'ABCD-EFGH', verification_uri: 'https://hf.co/oauth/device', expires_in: 60 };
const bearer = { access_token: 'access-1', refresh_token: 'refresh-1', token_type: 'Bearer', expires_in: 3600 };
const error = (code: string) => Response.json({ error: code }, { status: 400 });

test('后台按默认间隔轮询，slow_down 永久增加间隔，保存完成才授权', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const requests: { url: unknown; init: RequestInit }[] = [];
  const replies = [Response.json(device), error('slow_down'), error('authorization_pending'), Response.json(bearer)];
  t.mock.method(globalThis, 'fetch', (url: unknown, init: RequestInit) => {
    requests.push({ url, init });
    return replies.shift();
  });
  let finishSave!: () => void;
  const saved: HfTokens[] = [];
  const auth = createHfDeviceAuthorization({ saveTokens: async tokens => {
    saved.push(tokens);
    await new Promise<void>(resolve => { finishSave = resolve; });
  } });
  const { sessionId, ...shown } = await auth.begin(clientId);
  assert.match(sessionId, /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i);
  assert.deepEqual(shown, { userCode: device.user_code, expiresAt: 61_000 });
  for (const [delay, count] of [[4999, 1], [1, 2], [9999, 2], [1, 3], [9999, 3], [1, 4]] as const) {
    t.mock.timers.tick(delay);
    await flush();
    assert.equal(requests.length, count);
  }
  for (const [index, { url, init }] of requests.entries()) {
    assert.equal(url, index ? tokenUrl : deviceUrl);
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.deepEqual(Object.fromEntries(new URLSearchParams(String(init.body))), index
      ? { client_id: clientId, grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: device.device_code }
      : { client_id: clientId, scope: 'inference-api' });
  }
  assert.deepEqual(saved, [{ clientId, accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: Date.now() + 3_600_000 }]);
  assert.equal(auth.status(sessionId), 'waiting');
  finishSave();
  await flush();
  assert.equal(auth.status(sessionId), 'authorized');
});

for (const terminal of ['cancelled', 'expired'] as const) {
  test(`${terminal} 中止在途轮询，迟到的令牌不会保存`, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
    let resolve!: (reply: Response) => void;
    let signal: AbortSignal | undefined;
    t.mock.method(globalThis, 'fetch', (url: string, init: RequestInit) => {
      if (url === deviceUrl) return Response.json({ ...device, interval: 1 });
      signal = init.signal!;
      return new Promise<Response>(done => { resolve = done; });
    });
    let writes = 0;
    const auth = createHfDeviceAuthorization({ saveTokens() { writes++; } });
    const { sessionId } = await auth.begin(clientId);
    t.mock.timers.tick(1000);
    await flush();
    if (terminal === 'cancelled') auth.cancel(sessionId);
    else t.mock.timers.tick(59_000);
    assert.equal(signal?.aborted, true);
    resolve(Response.json(bearer));
    await flush();
    assert.equal(auth.status(sessionId), terminal);
    assert.equal(writes, 0);
  });
}

for (const terminal of ['cancelled', 'expired'] as const) {
  test(`加密期间 ${terminal} 中止保存信号`, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
    t.mock.method(globalThis, 'fetch', (url: string) => Response.json(url === deviceUrl ? device : bearer));
    let finishEncryption!: () => void;
    let writes = 0;
    const auth = createHfDeviceAuthorization({ async saveTokens(_tokens, signal) {
      await new Promise<void>(resolve => { finishEncryption = resolve; });
      signal.throwIfAborted();
      writes++;
    } });
    const { sessionId } = await auth.begin(clientId);
    t.mock.timers.tick(5000);
    await flush();
    if (terminal === 'cancelled') auth.cancel(sessionId);
    else t.mock.timers.tick(55_000);
    finishEncryption();
    await flush();
    assert.equal(auth.status(sessionId), terminal);
    assert.equal(writes, 0);
  });
}

test('校验客户端、验证地址、授权错误和保存失败', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const replies = [Response.json({ ...device, verification_uri: deviceUrl + '?next=evil' })];
  const calls = t.mock.method(globalThis, 'fetch', () => replies.shift());
  let writes = 0;
  const auth = createHfDeviceAuthorization({ saveTokens() { writes++; throw new Error('private'); } });
  await assert.rejects(auth.begin(' '));
  assert.equal(calls.mock.callCount(), 0);
  await assert.rejects(auth.begin(clientId));
  for (const [reply, status] of [[error('expired_token'), 'expired'], [error('access_denied'), 'failed'],
    [Response.json({ ...bearer, scope: 'profile' }), 'failed'], [Response.json(bearer), 'failed']] as const) {
    replies.push(Response.json({ ...device, verification_uri: deviceUrl }), reply);
    const { sessionId } = await auth.begin(clientId);
    t.mock.timers.tick(5000);
    await flush();
    assert.equal(auth.status(sessionId), status);
  }
  assert.equal(writes, 1);
});

test('刷新使用同一客户端，处理令牌轮换和省略 refresh_token', async t => {
  const old = { clientId, accessToken: 'old', refreshToken: 'refresh-old', expiresAt: 1 };
  const replies = [Response.json(bearer), Response.json({ ...bearer, refresh_token: undefined }), error('invalid_grant')];
  t.mock.method(globalThis, 'fetch', (url: string, init: RequestInit) => {
    assert.equal(url, tokenUrl);
    assert.equal(init.redirect, 'error');
    assert.deepEqual(Object.fromEntries(new URLSearchParams(String(init.body))), {
      client_id: clientId, grant_type: 'refresh_token', refresh_token: old.refreshToken,
    });
    return replies.shift();
  });
  for (const expected of [bearer.refresh_token, old.refreshToken]) {
    const refreshed = await refreshHfTokens(old);
    assert.equal(refreshed.refreshToken, expected);
    assert.equal(refreshed.accessToken, bearer.access_token);
    assert.equal(refreshed.clientId, clientId);
    assert.ok(refreshed.expiresAt > Date.now());
  }
  await assert.rejects(refreshHfTokens(old), { message: 'HF_REFRESH_FAILED' });
});
