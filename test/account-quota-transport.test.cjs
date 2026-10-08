const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { requestAccountQuota, ACCOUNT_QUOTA_ENDPOINTS } = require('../out/account-quota-transport');

const request = (patch = {}) => ({ endpoint: 'identity', accessToken: 'synthetic-access-only', signal: new AbortController().signal, ...patch });
function fixture(t, handler) {
  const calls = [];
  t.mock.method(https, 'request', (options, callback) => {
    const req = new EventEmitter(); const call = { options, destroyed: false, body: undefined, req };
    calls.push(call);
    req.destroy = () => { call.destroyed = true; return req; };
    req.end = body => { call.body = body; queueMicrotask(() => handler(call, (status = 200, raw = '{}', headers = { 'content-type': 'application/json' }) => {
      const response = new PassThrough(); response.statusCode = status; response.headers = headers;
      callback(response); if (!response.destroyed) response.end(raw); return response;
    })); };
    return req;
  });
  return calls;
}

test('transport uses only exact allowlisted HTTPS endpoints, own user-agent, pinned TLS and no proxy/redirects', async t => {
  const calls = fixture(t, (_, reply) => reply(200, '{"ok":true}'));
  assert.deepEqual(await requestAccountQuota(request()), { ok: true });
  assert.deepEqual(await requestAccountQuota(request({ endpoint: 'quota', projectId: 'synthetic-project' })), { ok: true });
  assert.equal(Object.isFrozen(ACCOUNT_QUOTA_ENDPOINTS), true);
  assert.deepEqual(calls.map(x => [x.options.protocol, x.options.hostname, x.options.port, x.options.path, x.options.method]), [
    ['https:', 'www.googleapis.com', 443, '/oauth2/v2/userinfo', 'GET'],
    ['https:', 'cloudcode-pa.googleapis.com', 443, '/v1internal:retrieveUserQuotaSummary', 'POST'],
  ]);
  for (const call of calls) {
    assert.equal(call.options.agent, false); assert.equal(call.options.rejectUnauthorized, true);
    assert.equal(call.options.headers.Authorization, 'Bearer synthetic-access-only');
    assert.equal(call.options.headers['User-Agent'], 'Antigravity-Workbench-Quota/1.0');
    assert.equal(call.options.headers['Cache-Control'], 'no-cache');
    assert.ok(!JSON.stringify(call.options.path).includes('synthetic')); assert.equal(call.options.auth, undefined);
  }
  assert.equal(calls[0].body, undefined); assert.deepEqual(JSON.parse(calls[1].body), { project: 'synthetic-project' });
  assert.equal(calls[1].options.headers['Content-Length'], Buffer.byteLength(calls[1].body));
});
test('missing native project makes empty body, never default or fabricated project', async t => {
  const calls = fixture(t, (_, reply) => reply()); await requestAccountQuota(request({ endpoint: 'quota' })); assert.equal(calls[0].body, '{}');
});
test('arbitrary URLs, prototype keys, control tokens and unsafe projects are rejected before network', async t => {
  const calls = fixture(t, (_, reply) => reply());
  for (const endpoint of ['http://localhost/evil', 'https://cloudcode-pa.googleapis.com.attacker.example/evil', 'https://oauth2.googleapis.com/token', '__proto__', 'constructor', '/token']) {
    await assert.rejects(requestAccountQuota(request({ endpoint })), /ACCOUNT_QUOTA_ENDPOINT_BLOCKED/);
  }
  for (const accessToken of ['', '\r\nX-Test: secret', 'x'.repeat(16_385), 'Bearer already-prefixed']) await assert.rejects(requestAccountQuota(request({ accessToken })), /ACCOUNT_QUOTA_TOKEN_UNSUPPORTED/);
  await assert.rejects(requestAccountQuota(request({ endpoint: 'quota', projectId: 'https://evil.test' })), /ACCOUNT_QUOTA_TOKEN_UNSUPPORTED/);
  assert.equal(calls.length, 0);
});
test('401, 403, 429, redirects and server errors stay distinct and never forward server body', async t => {
  let status; const calls = fixture(t, (_, reply) => reply(status, 'synthetic-secret-server-response'));
  for (const [value, code] of [[401, 'REAUTH_REQUIRED'], [403, 'FORBIDDEN'], [429, 'RATE_LIMITED'], [301, 'REDIRECT_BLOCKED'], [302, 'REDIRECT_BLOCKED'], [307, 'REDIRECT_BLOCKED'], [308, 'REDIRECT_BLOCKED'], [500, 'REQUEST_FAILED'], [404, 'REQUEST_FAILED']]) {
    status = value; await assert.rejects(requestAccountQuota(request()), error => error.code === 'ACCOUNT_QUOTA_' + code && !String(error).includes('synthetic'));
  }
  assert.equal(calls.length, 9);
});
test('strict JSON content type, valid JSON and valid UTF8 are required', async t => {
  let raw, headers; fixture(t, (_, reply) => reply(200, raw, headers));
  for (const item of [['{}', {}], ['{}', { 'content-type': 'text/html' }], ['{bad', { 'content-type': 'application/json' }], [Buffer.from([0x7b,0x22,0x78,0x22,0x3a,0x22,0xff,0x22,0x7d]), { 'content-type': 'application/json' }]]) {
    [raw, headers] = item; await assert.rejects(requestAccountQuota(request()), /ACCOUNT_QUOTA_RESPONSE_INVALID/);
  }
});
test('oversize responses are stopped without retaining the entire payload', async t => {
  const calls = fixture(t, (_, reply) => reply(200, Buffer.alloc(1024 * 1024 + 1, 'x')));
  await assert.rejects(requestAccountQuota(request()), /ACCOUNT_QUOTA_RESPONSE_TOO_LARGE/); assert.equal(calls[0].destroyed, true);
});
test('raw socket errors cannot expose request credentials', async t => {
  fixture(t, call => call.req.emit('error', new Error('Bearer synthetic-access-only')));
  await assert.rejects(requestAccountQuota(request()), error => error.code === 'ACCOUNT_QUOTA_REQUEST_FAILED' && !String(error).includes('synthetic'));
});
test('pre-cancel sends nothing and mid-flight cancel destroys request', async t => {
  const calls = fixture(t, () => {}); const before = new AbortController(); before.abort();
  await assert.rejects(requestAccountQuota(request({ signal: before.signal })), /QUOTA_QUERY_CANCELLED/); assert.equal(calls.length, 0);
  const controller = new AbortController(); const work = requestAccountQuota(request({ signal: controller.signal })); controller.abort();
  await assert.rejects(work, /QUOTA_QUERY_CANCELLED/); assert.equal(calls[0].destroyed, true);
});
test('per-request timeout destroys socket even when no response arrives', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = fixture(t, () => {}); const work = requestAccountQuota(request()); t.mock.timers.tick(15_000);
  await assert.rejects(work, /ACCOUNT_QUOTA_TIMEOUT/); assert.equal(calls[0].destroyed, true);
});
