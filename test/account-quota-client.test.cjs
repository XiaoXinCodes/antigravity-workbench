const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createConsumerRefreshTransport, requestConsumerRefresh, readInstalledConsumerOAuthClient, hasVerifiedConsumerClient, createConsumerRefreshProvider, CONSUMER_CLIENT_ID_SHA256 } = require('../out/account-quota-client');
const fixtureClient = { clientId: 'fixture-public-client-id', clientSecret: 'fixture-public-shared-setting' };
function network(handler) {
  const calls = [];
  const request = (options, callback) => {
    const req = new EventEmitter(); const call = { options, req, body: undefined, destroyed: false }; calls.push(call);
    req.destroy = () => { call.destroyed = true; return req; };
    req.end = body => { call.body = body; queueMicrotask(() => handler(call, (status = 200, raw = '{"access_token":"synthetic-new","expires_in":3600}', headers = { 'content-type': 'application/json' }) => {
      const response = new PassThrough(); response.statusCode = status; response.headers = headers; callback(response); if (!response.destroyed) response.end(raw); return response;
    })); };
    return req;
  };
  // Only this isolated fixture accepts a synthetic public-client configuration.
  return { calls, send: createConsumerRefreshTransport(request, client => client === fixtureClient) };
}
const signal = () => new AbortController().signal;
test('OAuth transport fixes endpoint, TLS, honest user-agent and form body without bearer or URL credentials', async () => {
  const f = network((_call, reply) => reply()); const result = await f.send(fixtureClient, 'synthetic-refresh', signal()); assert.equal(result.access_token, 'synthetic-new');
  const c = f.calls[0]; assert.deepEqual([c.options.protocol, c.options.hostname, c.options.port, c.options.path, c.options.method], ['https:', 'oauth2.googleapis.com', 443, '/token', 'POST']);
  assert.equal(c.options.agent, false); assert.equal(c.options.rejectUnauthorized, true); assert.equal(c.options.headers['User-Agent'], 'Antigravity-Workbench-Quota/1.0');
  assert.equal(c.options.headers.Authorization, undefined); assert.equal(c.options.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(c.body)), { client_id: fixtureClient.clientId, client_secret: fixtureClient.clientSecret, refresh_token: 'synthetic-refresh', grant_type: 'refresh_token' });
  assert.ok(!JSON.stringify(c.options).includes('synthetic-refresh'));
});
test('real transport rejects arbitrary or missing public client settings before network', async () => {
  assert.equal(hasVerifiedConsumerClient(fixtureClient), false); assert.equal(hasVerifiedConsumerClient({}), false);
  await assert.rejects(requestConsumerRefresh(fixtureClient, 'synthetic-refresh', signal()), /ACCOUNT_QUOTA_CLIENT_UNVERIFIED/);
  const f = network((_c, reply) => reply()); await assert.rejects(f.send({}, 'synthetic-refresh', signal()), /ACCOUNT_QUOTA_CLIENT_UNVERIFIED/); assert.equal(f.calls.length, 0);
});
test('refresh errors expose fixed distinctions, never response bodies, and never follow redirects', async () => {
  for (const [status, code, expected] of [[400, 'invalid_grant', 'REAUTH_REQUIRED'], [400, 'invalid_client', 'CLIENT_UNVERIFIED'], [400, 'unauthorized_client', 'CLIENT_UNVERIFIED'], [401, 'other', 'CLIENT_UNVERIFIED'], [403, 'access_denied', 'FORBIDDEN'], [429, 'slow_down', 'RATE_LIMITED'], [302, 'redirect', 'REDIRECT_BLOCKED']]) {
    const f = network((_c, reply) => reply(status, JSON.stringify({ error: code, error_description: 'synthetic-refresh private' })));
    await assert.rejects(f.send(fixtureClient, 'synthetic-refresh', signal()), e => e.code === 'ACCOUNT_QUOTA_' + expected && !String(e).includes('synthetic'));
    assert.equal(f.calls.length, 1);
  }
});
test('non-JSON, invalid UTF8, oversized and malformed responses cannot masquerade as successful refresh', async () => {
  for (const [raw, headers] of [['{}', {}], ['{}', { 'content-type': 'text/html' }], ['{invalid', { 'content-type': 'application/json' }], [Buffer.from([0xff]), { 'content-type': 'application/json' }], [Buffer.alloc(256 * 1024 + 1, 'x'), { 'content-type': 'application/json' }]]) {
    const f = network((_c, reply) => reply(200, raw, headers)); await assert.rejects(f.send(fixtureClient, 'synthetic-refresh', signal()), /ACCOUNT_QUOTA_REFRESH_OUTCOME_UNKNOWN/);
  }
});
test('raw socket errors and in-flight internal timeout report uncertain refresh outcome without secrets', async t => {
  const f = network(call => call.req.emit('error', new Error('synthetic-refresh')));
  await assert.rejects(f.send(fixtureClient, 'synthetic-refresh', signal()), e => e.code === 'ACCOUNT_QUOTA_REFRESH_OUTCOME_UNKNOWN' && !String(e).includes('synthetic'));
  t.mock.timers.enable({ apis: ['setTimeout'] }); const stalled = network(() => {}); const work = stalled.send(fixtureClient, 'synthetic-refresh', signal()); t.mock.timers.tick(15_000);
  await assert.rejects(work, /ACCOUNT_QUOTA_REFRESH_OUTCOME_UNKNOWN/); assert.equal(stalled.calls[0].destroyed, true);
});
test('pre-cancel and malformed refresh tokens make no request', async () => {
  const f = network((_c, reply) => reply()); const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(f.send(fixtureClient, 'synthetic-refresh', cancelled.signal), /QUOTA_QUERY_CANCELLED/);
  for (const token of ['', 'secret\r\nline', 'x'.repeat(16385)]) await assert.rejects(f.send(fixtureClient, token, signal()), /ACCOUNT_QUOTA_TOKEN_UNSUPPORTED/);
  assert.equal(f.calls.length, 0);
});
test('provider construction is passive and binds only the known consumer client fingerprint', () => {
  const provider = createConsumerRefreshProvider('/nonexistent-official-agy'); assert.equal(provider.clientIdSha256, CONSUMER_CLIENT_ID_SHA256);
});
test('installed config reader rejects missing, empty, unrelated, linked and writable artifacts; never executes them', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ag-quota-client-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'agy'); await fs.writeFile(file, '#!/bin/sh\necho should-not-execute\n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e', { mode: 0o600 });
  await assert.rejects(readInstalledConsumerOAuthClient(file), /ACCOUNT_QUOTA_CLIENT_UNVERIFIED/);
  await assert.rejects(readInstalledConsumerOAuthClient(dir), /ACCOUNT_QUOTA_CLIENT_UNVERIFIED/);
  await assert.rejects(readInstalledConsumerOAuthClient(path.join(dir, 'missing')), /ACCOUNT_QUOTA_CLIENT_UNVERIFIED/);
  await fs.writeFile(file, ''); await assert.rejects(readInstalledConsumerOAuthClient(file), /ACCOUNT_QUOTA_CLIENT_UNVERIFIED/);
  if (process.platform !== 'win32') { await fs.writeFile(file, 'fixture'); await fs.chmod(file, 0o666); await assert.rejects(readInstalledConsumerOAuthClient(file), /ACCOUNT_QUOTA_CLIENT_UNVERIFIED/); const link = path.join(dir, 'link'); await fs.symlink(file, link); await assert.rejects(readInstalledConsumerOAuthClient(link), /ACCOUNT_QUOTA_CLIENT_UNVERIFIED/); }
  const controller = new AbortController(); controller.abort(); await assert.rejects(readInstalledConsumerOAuthClient(file, controller.signal), /QUOTA_QUERY_CANCELLED/);
});
