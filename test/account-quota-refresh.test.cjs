const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { SavedAccountQuotaClient } = require('../out/account-quota');
const { CONSUMER_CLIENT_ID_SHA256 } = require('../out/account-quota-client');
const { LiveError } = require('../out/live-storage');
const NOW = Date.parse('2026-10-01T00:00:00Z');
function envelope(patch = {}, claims = { email: 'a@example.test', sub: 'subject-a' }) {
  return JSON.stringify({ auth_method: 'consumer', future_metadata: { preserved: true }, project_id: 'project-a',
    id_token: 'unsigned.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.fixture',
    token: { access_token: 'synthetic-old-access', refresh_token: 'synthetic-old-refresh', token_type: 'Bearer', expiry: '2026-09-30T23:00:00Z', extra_native: 'preserve', ...patch } });
}
function setup(options = {}) {
  const events = [], calls = []; let pending, saved;
  const account = { id: randomUUID(), label: 'A', expectedEmail: 'a@example.test', capturedAt: new Date(NOW).toISOString(), identitySource: 'hub', slots: { keyring: null, file: envelope(), keyringState: 'unobserved' } };
  const response = { access_token: 'synthetic-new-access', refresh_token: 'synthetic-rotated-refresh', token_type: 'Bearer', expires_in: 3600, ...options.response };
  const refresh = {
    provider: { clientIdSha256: CONSUMER_CLIENT_ID_SHA256, async exchange(value, signal) { events.push('exchange'); assert.equal(value, 'synthetic-old-refresh'); assert.equal(signal.aborted, false); return response; } },
    async loadPending(expected) { assert.deepEqual(expected, account.slots); events.push('load'); return pending; },
    async stage(expected, next) { assert.deepEqual(expected, account.slots); events.push('stage'); pending = structuredClone(next); },
    async commit(expected, next) { assert.deepEqual(expected, account.slots); events.push('commit'); saved = structuredClone(next); pending = undefined; },
  };
  const client = new SavedAccountQuotaClient(async req => { calls.push(req); events.push(req.endpoint); return req.endpoint === 'identity' ? { email: 'a@example.test', id: 'subject-a', verified_email: true } : { buckets: [{ displayName: 'Window', remainingFraction: 0.6 }] }; }, () => NOW);
  return { account, response, refresh, client, events, calls, get saved() { return saved; }, get pending() { return pending; }, set pending(value) { pending = value; } };
}
test('expired native consumer grant independently refreshes, quarantines, verifies, commits before quota', async () => {
  const f = setup(); const original = structuredClone(f.account);
  const proof = await f.client.query(f.account, undefined, { refresh: f.refresh });
  assert.deepEqual(f.events, ['load', 'exchange', 'stage', 'identity', 'commit', 'identity', 'quota', 'identity']);
  assert.equal(proof.email, 'a@example.test'); assert.equal(proof.buckets[0].remaining, 0.6); assert.deepEqual(f.account, original);
  const stored = JSON.parse(f.saved.file);
  assert.equal(stored.token.access_token, 'synthetic-new-access'); assert.equal(stored.token.refresh_token, 'synthetic-rotated-refresh');
  assert.equal(stored.token.expiry, '2026-10-01T01:00:00.000Z'); assert.equal(stored.token.extra_native, 'preserve'); assert.deepEqual(stored.future_metadata, { preserved: true });
  assert.equal(f.saved.keyring, null); assert.equal(f.saved.keyringState, 'unobserved'); assert.equal(f.pending, undefined);
  assert.ok(f.calls.every(call => call.accessToken === 'synthetic-new-access')); assert.ok(!JSON.stringify(proof).includes('synthetic'));
});
test('omitted replacement refresh token preserves the original exactly', async () => {
  const f = setup({ response: { refresh_token: undefined } }); await f.client.query(f.account, undefined, { refresh: f.refresh });
  assert.equal(JSON.parse(f.saved.file).token.refresh_token, 'synthetic-old-refresh');
});
test('server identity is verified before the saved account is replaced', async () => {
  const f = setup(); const client = new SavedAccountQuotaClient(async () => ({ email: 'b@example.test', id: 'subject-b', verified_email: true }), () => NOW);
  await assert.rejects(client.query(f.account, undefined, { refresh: f.refresh }), /ACCOUNT_QUOTA_IDENTITY_MISMATCH/);
  assert.equal(f.saved, undefined); assert.ok(f.pending); assert.ok(!f.events.includes('commit'));
});
test('changed subject with the same email cannot commit refresh', async () => {
  const f = setup(); const client = new SavedAccountQuotaClient(async () => ({ email: 'a@example.test', id: 'different-subject', verified_email: true }), () => NOW);
  await assert.rejects(client.query(f.account, undefined, { refresh: f.refresh }), /ACCOUNT_QUOTA_IDENTITY_MISMATCH/); assert.equal(f.saved, undefined); assert.ok(f.pending);
});
test('identity network failure retains encrypted quarantine; retry validates pending without another exchange', async () => {
  const f = setup(); const failed = new SavedAccountQuotaClient(async () => { throw new Error('secret upstream error'); }, () => NOW);
  await assert.rejects(failed.query(f.account, undefined, { refresh: f.refresh }), /ACCOUNT_QUOTA_REFRESH_PENDING/);
  assert.ok(f.pending); assert.equal(f.saved, undefined);
  const proof = await f.client.query(f.account, undefined, { refresh: f.refresh });
  assert.equal(proof.email, 'a@example.test'); assert.equal(f.events.filter(x => x === 'exchange').length, 1); assert.ok(f.saved); assert.equal(f.pending, undefined);
});
test('quarantine and commit failures cannot publish quota or echo token-bearing errors', async () => {
  for (const method of ['stage', 'commit']) {
    const f = setup(); f.refresh[method] = async () => { throw new Error('synthetic-rotated-refresh'); };
    await assert.rejects(f.client.query(f.account, undefined, { refresh: f.refresh }), error => error.code === 'ACCOUNT_QUOTA_SECURE_SAVE_FAILED' && !String(error).includes('synthetic'));
    assert.ok(!f.calls.some(call => call.endpoint === 'quota'));
  }
});
test('caller cancellation during exchange finishes stage, identity and commit before reporting cancel', async () => {
  const f = setup(), controller = new AbortController(); let finish; let exchangeSignal;
  f.refresh.provider.exchange = async (_value, signal) => { exchangeSignal = signal; f.events.push('exchange'); return new Promise(resolve => { finish = resolve; }); };
  const work = f.client.query(f.account, controller.signal, { refresh: f.refresh });
  await new Promise(resolve => setImmediate(resolve)); controller.abort();
  assert.equal(exchangeSignal.aborted, false); assert.equal(f.saved, undefined); finish(f.response);
  await assert.rejects(work, /QUOTA_QUERY_CANCELLED/); assert.ok(f.saved); assert.equal(f.pending, undefined); assert.ok(!f.calls.some(call => call.endpoint === 'quota'));
});
test('caller cancellation after staging cannot abandon a rotated grant or skip commit', async () => {
  const f = setup(), controller = new AbortController(); const stage = f.refresh.stage;
  f.refresh.stage = async (...args) => { await stage(...args); controller.abort(); };
  await assert.rejects(f.client.query(f.account, controller.signal, { refresh: f.refresh }), /QUOTA_QUERY_CANCELLED/); assert.ok(f.saved); assert.equal(f.pending, undefined);
});
test('failed post-exchange persistence is not hidden as cancellation', async () => {
  const f = setup(), controller = new AbortController(); f.refresh.commit = async () => { controller.abort(); throw Error('secret'); };
  await assert.rejects(f.client.query(f.account, controller.signal, { refresh: f.refresh }), /ACCOUNT_QUOTA_SECURE_SAVE_FAILED/); assert.ok(f.pending);
});
test('contradictory native audience, legacy unknown method or unverified provider never sends refresh', async () => {
  const wrongAudience = envelope({}, { email: 'a@example.test', sub: 'subject-a', aud: 'unrelated-client' });
  const legacy = JSON.parse(envelope()); legacy.auth_method = 'oauth';
  for (const raw of [wrongAudience, JSON.stringify(legacy)]) {
    const f = setup(); f.account.slots.file = raw; await assert.rejects(f.client.query(f.account, undefined, { refresh: f.refresh }), /ACCOUNT_QUOTA_CLIENT_UNVERIFIED/); assert.ok(!f.events.includes('exchange'));
  }
  const f = setup(); f.refresh.provider.clientIdSha256 = 'unverified'; await assert.rejects(f.client.query(f.account, undefined, { refresh: f.refresh }), /ACCOUNT_QUOTA_CLIENT_UNVERIFIED/);
});
test('invalid grant/client/policy errors do not probe another client', async () => {
  for (const code of ['ACCOUNT_QUOTA_REAUTH_REQUIRED', 'ACCOUNT_QUOTA_CLIENT_UNVERIFIED', 'ACCOUNT_QUOTA_FORBIDDEN', 'ACCOUNT_QUOTA_RATE_LIMITED']) {
    const f = setup(); let calls = 0; f.refresh.provider.exchange = async () => { calls++; throw new LiveError(code); };
    await assert.rejects(f.client.query(f.account, undefined, { refresh: f.refresh }), error => error.code === code); assert.equal(calls, 1); assert.equal(f.saved, undefined);
  }
});
test('raw provider errors become outcome-unknown without leaking credential material', async () => {
  const f = setup(); f.refresh.provider.exchange = async () => { throw new Error('synthetic-old-refresh'); };
  await assert.rejects(f.client.query(f.account, undefined, { refresh: f.refresh }), error => error.code === 'ACCOUNT_QUOTA_REFRESH_OUTCOME_UNKNOWN' && !String(error).includes('synthetic'));
});
test('malformed token responses never reach the stable saved account', async () => {
  for (const response of [{ access_token: '' }, { refresh_token: '' }, { expires_in: 0 }, { expires_in: '3600' }, { token_type: 'DPoP' }, { id_token: 'unsafe token' }]) {
    const f = setup({ response }); await assert.rejects(f.client.query(f.account, undefined, { refresh: f.refresh }), /ACCOUNT_QUOTA_REFRESH_OUTCOME_UNKNOWN/); assert.equal(f.saved, undefined);
  }
});
test('one 401 on fresh token triggers one refresh and restarts identity-bound quota sequence', async () => {
  const f = setup(); f.account.slots.file = envelope({ expiry: '2026-10-01T01:00:00Z' }); let oldCalls = 0;
  const client = new SavedAccountQuotaClient(async req => { if (req.accessToken === 'synthetic-old-access') { oldCalls++; throw new LiveError('ACCOUNT_QUOTA_REAUTH_REQUIRED'); } return req.endpoint === 'identity' ? { email: 'a@example.test', id: 'subject-a', verified_email: true } : { buckets: [{ displayName: 'Window', remainingFraction: 0.4 }] }; }, () => NOW);
  assert.equal((await client.query(f.account, undefined, { refresh: f.refresh })).buckets[0].remaining, 0.4); assert.equal(oldCalls, 1); assert.equal(f.events.filter(x => x === 'exchange').length, 1);
});
test('quota cannot expose old or new access/refresh tokens after a successful refresh', async () => {
  for (const secret of ['synthetic-old-access', 'synthetic-old-refresh', 'synthetic-new-access', 'synthetic-rotated-refresh']) {
    const f = setup(); const client = new SavedAccountQuotaClient(async req => req.endpoint === 'identity' ? { email: 'a@example.test', id: 'subject-a', verified_email: true } : { buckets: [{ displayName: secret, remainingFraction: 0.4 }] }, () => NOW);
    await assert.rejects(client.query(f.account, undefined, { refresh: f.refresh }), /ACCOUNT_QUOTA_RESPONSE_INVALID/); assert.ok(f.saved);
  }
});
test('duplicate saved IDs sharing one grant cannot refresh concurrently', async () => {
  const f = setup(); let finish; f.refresh.provider.exchange = async () => new Promise(resolve => { finish = resolve; });
  const a = f.client.query(f.account, undefined, { refresh: f.refresh }); await new Promise(resolve => setImmediate(resolve));
  const duplicate = { ...f.account, id: randomUUID() };
  await assert.rejects(f.client.query(duplicate, undefined, { refresh: f.refresh }), /ACCOUNT_QUOTA_ALREADY_RUNNING/);
  finish(f.response); await a;
});
test('critical refresh phase remains bounded even if a provider ignores its abort signal', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = setup();
  f.refresh.provider.exchange = async () => { f.events.push('exchange'); return new Promise(() => {}); };
  const work = f.client.query(f.account, undefined, { refresh: f.refresh });
  while (!f.events.includes('exchange')) await Promise.resolve();
  t.mock.timers.tick(35_000); await assert.rejects(work, /ACCOUNT_QUOTA_REFRESH_OUTCOME_UNKNOWN/); assert.equal(f.saved, undefined);
});
test('both native slots retain independent metadata while receiving the same verified rotation', async () => {
  const f = setup(); const keyring = JSON.parse(envelope()); keyring.slot_metadata = 'keyring-only';
  f.account.slots = { keyring: JSON.stringify(keyring), file: envelope() };
  await f.client.query(f.account, undefined, { refresh: f.refresh });
  assert.equal(JSON.parse(f.saved.keyring).slot_metadata, 'keyring-only'); assert.equal(JSON.parse(f.saved.file).slot_metadata, undefined);
  assert.equal(JSON.parse(f.saved.keyring).token.refresh_token, JSON.parse(f.saved.file).token.refresh_token);
});
test('known encrypted-store conflict and recovery codes remain actionable and contain no raw errors', async () => {
  for (const [method, code] of [['loadPending', 'ACCOUNT_QUOTA_REFRESH_CONFLICT'], ['stage', 'ACCOUNT_QUOTA_REFRESH_SAVE_FAILED'], ['commit', 'ACCOUNT_QUOTA_REFRESH_RECOVERY_INVALID']]) {
    const f = setup(); f.refresh[method] = async () => { throw new LiveError(code); };
    await assert.rejects(f.client.query(f.account, undefined, { refresh: f.refresh }), error => error.code === code); assert.equal(f.saved, undefined);
  }
});
