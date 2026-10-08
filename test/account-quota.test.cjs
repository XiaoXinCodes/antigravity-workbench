const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { SavedAccountQuotaClient, parseAccountQuotaIdentity } = require('../out/account-quota');
const { LiveError } = require('../out/live-storage');

const NOW = Date.parse('2026-10-01T00:00:00Z');
const row = { groups: [{ displayName: 'Model family', buckets: [
  { bucketId: 'five-hour', displayName: '5 hours', remainingFraction: 0.25, resetTime: '2026-10-01T02:00:00Z' },
  { bucketId: 'week', displayName: 'Weekly', remainingFraction: 0.5, resetTime: '2026-10-05T00:00:00Z' },
] }] };
const identity = (email = 'a@example.test', id = 'subject-a') => ({ email, id, verified_email: true });
function token(name = 'a', patch = {}) {
  return JSON.stringify({ auth_method: 'consumer', project_id: 'project-' + name,
    token: { access_token: 'synthetic-access-' + name, refresh_token: 'synthetic-refresh-' + name, token_type: 'Bearer', expiry: '2026-10-01T01:00:00.123456789Z', ...patch },
    id_token: 'unsigned.' + Buffer.from(JSON.stringify({ email: name + '@example.test', sub: 'subject-' + name })).toString('base64url') + '.fixture' });
}
function account(name = 'a', raw = token(name)) { return { id: randomUUID(), label: name, expectedEmail: name + '@example.test', capturedAt: new Date(NOW).toISOString(), identitySource: 'hub', slots: { keyring: null, file: raw, keyringState: 'unobserved' } }; }
function client(handler, now = () => NOW, deadline) {
  const calls = [];
  const query = new SavedAccountQuotaClient(async req => { calls.push(req); return handler ? handler(req, calls.length) : req.endpoint === 'identity' ? identity() : row; }, now, deadline);
  return { query, calls };
}

test('saved account B queries its own server quota while active hub is unrelated and never touched', async () => {
  const b = account('b'); const original = JSON.stringify(b);
  const f = client(req => req.endpoint === 'identity' ? identity('B@example.test', 'subject-b') : row);
  const proof = await f.query.query(b);
  assert.equal(proof.email, 'b@example.test'); assert.equal(proof.authValid, true); assert.equal(proof.quotaSource, 'server');
  assert.match(proof.generation, new RegExp('^saved-account:' + b.id + ':'));
  assert.equal(proof.observedAt, new Date(NOW).toISOString());
  assert.deepEqual(proof.buckets.map(x => x.remaining), [0.25, 0.5]);
  assert.deepEqual(f.calls.map(x => x.endpoint), ['identity', 'quota', 'identity']);
  assert.ok(f.calls.every(x => x.accessToken === 'synthetic-access-b'));
  assert.equal(f.calls[1].projectId, 'project-b'); assert.equal(f.calls[0].projectId, undefined);
  assert.equal(JSON.stringify(b), original);
  assert.ok(!JSON.stringify(proof).includes('synthetic')); assert.ok(!JSON.stringify(proof).includes('subject-b'));
  assert.ok(!JSON.stringify(f.calls).includes('synthetic-refresh'));
});
test('unsigned matching JWT is no substitute for server identity', async () => {
  const f = client(() => identity('b@example.test', 'subject-b'));
  await assert.rejects(f.query.query(account()), /ACCOUNT_QUOTA_IDENTITY_MISMATCH/);
  assert.equal(f.calls.length, 1);
});
test('same email with different server subject is rejected before quota', async () => {
  const f = client(() => identity('a@example.test', 'subject-other'));
  await assert.rejects(f.query.query(account()), /ACCOUNT_QUOTA_IDENTITY_MISMATCH/);
  assert.equal(f.calls.length, 1);
});
test('identity changes during quota discard all rows', async () => {
  const f = client((req, index) => req.endpoint === 'quota' ? row : identity('a@example.test', index === 1 ? 'subject-a' : 'subject-other'));
  await assert.rejects(f.query.query(account()), /ACCOUNT_QUOTA_IDENTITY_MISMATCH/);
});
test('mutable caller account cannot redirect in-flight identity, bearer, project or result binding', async () => {
  const a = account(); const id = a.id;
  const f = client((req, index) => {
    if (index === 1) { a.id = randomUUID(); a.expectedEmail = 'b@example.test'; a.slots.file = token('b'); }
    return req.endpoint === 'quota' ? row : identity();
  });
  const proof = await f.query.query(a);
  assert.equal(proof.email, 'a@example.test'); assert.match(proof.generation, new RegExp('^saved-account:' + id));
  assert.ok(f.calls.every(x => x.accessToken === 'synthetic-access-a'));
});
test('native fractional and timezone expiries work, unknown top-level metadata is preserved untouched', async () => {
  const raw = JSON.parse(token()); raw.future_native_field = { value: 5 }; raw.token.expiry = '2026-10-01T03:00:00+02:00';
  const a = account('a', JSON.stringify(raw)); const before = JSON.stringify(a);
  await client().query.query(a); assert.equal(JSON.stringify(a), before);
});
test('expires_in is never reset from capturedAt; missing, zero, malformed and expired native expiry require reauth', async () => {
  for (const expiry of [undefined, null, '', '0001-01-01T00:00:00Z', 'garbage', '2026-10-01T00:00:29Z', '2026-09-30T23:59:59Z']) {
    const f = client(); await assert.rejects(f.query.query(account('a', token('a', { expiry, expires_in: 3600 }))), /ACCOUNT_QUOTA_REAUTH_REQUIRED/);
    assert.equal(f.calls.length, 0);
  }
});
test('missing or unsafe bearer does not cause refresh calls or leak it in errors', async () => {
  for (const access_token of [undefined, '', 'secret\r\nX-Stolen: yes', 'x'.repeat(16_385)]) {
    const f = client(); await assert.rejects(f.query.query(account('a', token('a', { access_token }))), /ACCOUNT_QUOTA_REAUTH_REQUIRED/);
    assert.equal(f.calls.length, 0);
  }
});
test('unknown personal auth method, non-Bearer, WIF and conflicting slot credentials fail closed', async () => {
  const a = account(); const raw = JSON.parse(a.slots.file);
  for (const changed of [{ ...raw, auth_method: 'adc' }, { ...raw, wif_provider: {} }, { ...raw, saved_wif_provider: {} }, { ...raw, token: { ...raw.token, token_type: 'DPoP' } }]) {
    const f = client(); await assert.rejects(f.query.query(account('a', JSON.stringify(changed))), /ACCOUNT_QUOTA_TOKEN_UNSUPPORTED/); assert.equal(f.calls.length, 0);
  }
  const b = account(); b.slots = { keyring: token(), file: token('a', { refresh_token: 'synthetic-different-refresh' }) };
  const f = client(); await assert.rejects(f.query.query(b), /ACCOUNT_QUOTA_TOKEN_CONFLICT/); assert.equal(f.calls.length, 0);
});
test('same-refresh native slots choose usable newest access token without merging records', async () => {
  const a = account(); a.slots = { keyring: token('a', { access_token: 'synthetic-old', expiry: '2026-09-30T00:00:00Z' }), file: token() };
  const f = client(); await f.query.query(a); assert.ok(f.calls.every(x => x.accessToken === 'synthetic-access-a'));
});
test('no project uses an empty payload rather than invented identity, and invalid project is rejected', async () => {
  const raw = JSON.parse(token()); delete raw.project_id;
  const f = client(); await f.query.query(account('a', JSON.stringify(raw))); assert.equal(f.calls[1].projectId, undefined);
  raw.project_id = 'https://attacker.example/token';
  await assert.rejects(client().query.query(account('a', JSON.stringify(raw))), /ACCOUNT_QUOTA_TOKEN_UNSUPPORTED/);
});
test('server identity must be verified and fully populated; profile fields never become proof', () => {
  for (const value of [{}, { email: 'a@example.test' }, { ...identity(), verified_email: false }, { ...identity(), verified_email: 'true' }, { ...identity(), id: '' }, { ...identity(), email: 'a@example.test\n' }, { ...identity(), email: 'a@ex\u202eample.test' }]) assert.throws(() => parseAccountQuotaIdentity(value), /ACCOUNT_QUOTA_IDENTITY_INVALID/);
  assert.deepEqual(parseAccountQuotaIdentity({ ...identity(), name: 'private', picture: 'private-url' }), { email: 'a@example.test', subject: 'subject-a' });
});
test('malformed/empty/over-limit quota never becomes cached success or a fabricated percentage', async () => {
  for (const value of [{}, { groups: [] }, { groups: 'not an array' }, { groups: [{ buckets: [{ remainingFraction: -1 }] }] }, { buckets: Array(201).fill({}) }, { error: { message: 'synthetic-access-a' } }]) {
    const f = client(req => req.endpoint === 'identity' ? identity() : value);
    await assert.rejects(f.query.query(account()), /ACCOUNT_QUOTA_(EMPTY|RESPONSE_INVALID)/);
    assert.equal(f.calls.length, 2);
  }
});
test('quota preserves zero, unknown, remaining amount, disabled, each quota window and reset separately', async () => {
  const f = client(req => req.endpoint === 'identity' ? identity() : { buckets: [{ displayName: 'Zero', remainingFraction: 0 }, { displayName: 'Unknown' }, { displayName: 'Credits', remainingAmount: '30', disabled: true }] });
  const proof = await f.query.query(account());
  assert.deepEqual(proof.buckets, [{ label: 'Zero', remaining: 0, resetAt: null }, { label: 'Unknown', remaining: null, resetAt: null }, { label: 'Credits', remaining: null, resetAt: null, remainingAmount: '30', disabled: true }]);
});
test('error and abort paths discard credentials and arbitrary upstream messages', async () => {
  for (const error of [new Error('Bearer synthetic-secret'), new LiveError('synthetic-secret'), { message: 'synthetic-secret' }]) {
    const f = client(() => { throw error; });
    await assert.rejects(f.query.query(account()), e => e.code === 'ACCOUNT_QUOTA_REQUEST_FAILED' && !String(e).includes('synthetic'));
  }
  for (const code of ['ACCOUNT_QUOTA_REAUTH_REQUIRED', 'ACCOUNT_QUOTA_FORBIDDEN', 'ACCOUNT_QUOTA_RATE_LIMITED', 'ACCOUNT_QUOTA_TIMEOUT']) {
    const f = client(() => { throw new LiveError(code); }); await assert.rejects(f.query.query(account()), e => e.code === code);
  }
});
test('pre-cancel has no requests; mid-request cancel ignores a late transport result', async () => {
  const controller = new AbortController(); controller.abort(); const pre = client();
  await assert.rejects(pre.query.query(account(), controller.signal), /QUOTA_QUERY_CANCELLED/); assert.equal(pre.calls.length, 0);
  let complete; const next = new AbortController(); const f = client(() => new Promise(resolve => { complete = resolve; }));
  const work = f.query.query(account(), next.signal); await new Promise(resolve => setImmediate(resolve)); next.abort();
  await assert.rejects(work, /QUOTA_QUERY_CANCELLED/); complete(identity()); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.calls.length, 1);
});
test('bounded deadline aborts and ignores an uncooperative late response', async () => {
  const f = client(() => new Promise(() => {}), () => NOW, 10);
  await assert.rejects(f.query.query(account()), /ACCOUNT_QUOTA_TIMEOUT/); assert.equal(f.calls[0].signal.aborted, true);
});
test('at most two saved-account queries run; queued cancel releases its place without a request', async () => {
  const held = []; const f = client(req => new Promise(resolve => held.push(() => resolve(req.endpoint === 'quota' ? row : identity(req.accessToken.endsWith('b') ? 'b@example.test' : req.accessToken.endsWith('c') ? 'c@example.test' : 'a@example.test', 'subject-' + req.accessToken.at(-1))))));
  const a = f.query.query(account('a')), b = f.query.query(account('b'));
  const controller = new AbortController(); const c = f.query.query(account('c'), controller.signal);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.calls.length, 2); controller.abort(); await assert.rejects(c, /QUOTA_QUERY_CANCELLED/);
  for (let i = 0; i < 3; i++) { held.splice(0).forEach(done => done()); await new Promise(resolve => setImmediate(resolve)); }
  await Promise.all([a, b]); assert.equal(f.calls.length, 6); assert.ok(f.calls.every(x => !x.accessToken.endsWith('c')));
  const d = f.query.query(account('c'));
  for (let i = 0; i < 3; i++) { await new Promise(resolve => setImmediate(resolve)); held.splice(0).forEach(done => done()); }
  assert.equal((await d).email, 'c@example.test');
});
test('duplicate account queries cannot race and can be retried after cancellation', async () => {
  const a = account(); const controller = new AbortController(); const f = client(() => new Promise(() => {}));
  const work = f.query.query(a, controller.signal);
  await assert.rejects(f.query.query(a), /ACCOUNT_QUOTA_ALREADY_RUNNING/); controller.abort(); await assert.rejects(work, /QUOTA_QUERY_CANCELLED/);
  const next = new AbortController(); const retry = f.query.query(a, next.signal); next.abort(); await assert.rejects(retry, /QUOTA_QUERY_CANCELLED/);
});

test('native consumer and legacy personal OAuth wrappers are accepted', async () => {
  for (const method of ['consumer', 'oauth', '', undefined]) { const raw = JSON.parse(token()); raw.auth_method = method; await client().query.query(account('a', JSON.stringify(raw))); }
});
test('a quota label reflecting the bearer is never rendered or persisted', async () => {
  const f = client(req => req.endpoint === 'identity' ? identity() : { buckets: [{ displayName: 'synthetic-access-a', remainingFraction: 0.8 }] });
  await assert.rejects(f.query.query(account()), /ACCOUNT_QUOTA_RESPONSE_INVALID/);
});

test('raw bearer reflection is rejected before long labels are truncated', async () => {
  const accessToken = 'synthetic-long-bearer-' + 'x'.repeat(180);
  const f = client(req => req.endpoint === 'identity' ? identity() : { buckets: [{ displayName: accessToken, remainingFraction: 0.8 }] });
  await assert.rejects(f.query.query(account('a', token('a', { access_token: accessToken }))), /ACCOUNT_QUOTA_RESPONSE_INVALID/);
});
test('absence of an ID-token hint still requires and accepts authoritative UserInfo identity', async () => {
  const raw = JSON.parse(token()); delete raw.id_token;
  const f = client(); const proof = await f.query.query(account('a', JSON.stringify(raw)));
  assert.equal(proof.email, 'a@example.test'); assert.equal(f.calls.length, 3);
});
test('tokens becoming expired mid-query stop before further requests or results', async () => {
  let time = NOW; const f = client(() => { time = NOW + 3_600_000; return identity(); }, () => time);
  await assert.rejects(f.query.query(account()), /ACCOUNT_QUOTA_REAUTH_REQUIRED/); assert.equal(f.calls.length, 1);
});
test('waiting queue is bounded at fifty in addition to two active queries', async () => {
  const f = client(() => new Promise(() => {})); const controllers = Array.from({ length: 52 }, () => new AbortController());
  const running = controllers.map(controller => f.query.query(account(), controller.signal));
  const settled = Promise.allSettled(running);
  await assert.rejects(f.query.query(account()), /ACCOUNT_QUOTA_QUEUE_FULL/);
  controllers.forEach(controller => controller.abort());
  const result = await settled; assert.equal(result.length, 52);
  assert.ok(result.every(item => item.status === 'rejected' && item.reason.code === 'QUOTA_QUERY_CANCELLED'));
});
