const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../out/core');
const NOW = Date.parse('2026-09-30T07:00:00Z');
const payload = (email = 'one@example.test', quota = { weekly: { remaining_fraction: 0.9378, reset_time: '2026-10-01T07:00:00Z' } }) => ({ product: 'antigravity', email, quota });
const collect = value => core.collectStatusline(value, NOW);

test('official map schema produces dated allowlist only, preserving exact fraction', () => {
  const data = collect({ ...payload(), access_token: 'SECRET', transcript_path: '/secret/transcript', cwd: '/secret', version: 'secret-version', quota: { weekly: { remaining_fraction: 0.9378, reset_time: '2026-10-01T07:00:00Z', secret: 'SECRET' } } });
  assert.equal(data.buckets[0].remainingFraction, 0.9378);
  assert.equal(data.capturedAt, '2026-09-30T07:00:00.000Z');
  assert.equal(core.formatBucket(data.buckets[0]), 'weekly：剩余 93.78%');
  assert.doesNotMatch(JSON.stringify(data), /SECRET|secret|transcript|cwd|version/);
});
test('identity supports LDAP and case normalization without alias guessing', () => {
  assert.equal(core.normalizeIdentity('Developer'), 'developer');
  assert.equal(core.normalizeIdentity('A.B+tag@Example.test'), 'a.b+tag@example.test');
  for (const invalid of ['', 'a b', ' a', 'a\n', 'a\u202e', 'a\u061c', 'a\u200f', 'a\u2028', 'a'.repeat(255), 1, null]) assert.throws(() => core.normalizeIdentity(invalid));
});
test('wrong product or missing identity fails instead of reusing selected account', () => {
  for (const data of [null, [], {}, { email: 'one' }, { product: 'gemini', email: 'one' }, { product: 'antigravity' }]) assert.throws(() => collect(data));
});
test('missing, null, and empty quotas are unknown, never zero', () => {
  for (const quota of [undefined, null, {}, [], 'bad']) {
    const result = collect(payload('one', quota));
    // undefined invokes the helper default; explicitly remove for this case.
    const actual = quota === undefined ? collect({ product: 'antigravity', email: 'one' }) : result;
    assert.equal(actual.quotaState, 'missing');
    assert.deepEqual(actual.buckets, []);
  }
});
test('zero/full fractions remain valid; malformed fields are flagged, not clamped', () => {
  for (const value of [0, 1, 0.25]) assert.equal(collect(payload('one', { b: { remaining_fraction: value } })).buckets[0].remainingFraction, value);
  for (const value of [-1, 1.01, '0.5', Infinity, NaN, {}]) {
    const bucket = collect(payload('one', { b: { remaining_fraction: value } })).buckets[0];
    assert.equal(bucket.remainingFraction, null);
    assert.equal(bucket.invalid, true);
  }
  const missing = collect(payload('one', { b: {} })).buckets[0];
  assert.equal(missing.remainingFraction, null);
  assert.equal(missing.invalid, false);
  for (const date of ['2026-02-30T00:00:00Z', '2026-99-01T00:00:00Z']) assert.equal(collect(payload('one', { b: { reset_time: date } })).buckets[0].invalid, true);
});
test('quota bucket names are bounded and untrusted object keys remain data', () => {
  assert.throws(() => collect(payload('one', { ['a\n']: {} })));
  assert.throws(() => collect(payload('one', Object.fromEntries(Array.from({ length: 65 }, (_, i) => [i, {}])))));
  const raw = JSON.parse('{"product":"antigravity","email":"one","quota":{"__proto__":{"remaining_fraction":0.5}}}');
  assert.equal(collect(raw).buckets[0].id, '__proto__');
  assert.equal({}.polluted, undefined);
});
test('reset deadline alone never replenishes quota and relative timing is not used', () => {
  const result = collect(payload('one', { b: { remaining_fraction: 0, reset_time: '2020-01-01T00:00:00Z', reset_in_seconds: 0 } }));
  assert.equal(result.buckets[0].remainingFraction, 0);
  assert.equal(core.snapshotAge(result, NOW + core.FRESH_MS + 1), 'stale');
  assert.equal(core.snapshotAge(result, NOW), 'recent');
  assert.equal(core.snapshotAge(result, NOW - 61_000), 'future');
});
test('snapshot import validates contract, time, duplicates, and rebuilds allowlist', () => {
  const snapshot = collect(payload());
  const rebuilt = core.parseSnapshot({ ...snapshot, raw: 'SECRET', buckets: [{ ...snapshot.buckets[0], secret: 'SECRET' }] }, NOW);
  assert.doesNotMatch(JSON.stringify(rebuilt), /SECRET/);
  for (const invalid of [{ ...snapshot, schemaVersion: 2 }, { ...snapshot, capturedAt: 'bad' }, { ...snapshot, capturedAt: new Date(NOW + 61_000).toISOString() }, { ...snapshot, quotaState: 'missing' }, { ...snapshot, buckets: [snapshot.buckets[0], snapshot.buckets[0]] }, { ...snapshot, buckets: [{ ...snapshot.buckets[0], remainingFraction: undefined }] }]) assert.throws(() => core.parseSnapshot(invalid, NOW));
});
test('older snapshots never overwrite newer and accounts never share quota', () => {
  const first = collect(payload('first', { a: { remaining_fraction: 0.1 } }));
  const second = collect(payload('second', { a: { remaining_fraction: 0.9 } }));
  let accounts = core.mergeSnapshot([], first);
  accounts = core.mergeSnapshot(accounts, second);
  accounts = core.mergeSnapshot(accounts, { ...first, capturedAt: new Date(NOW - 1000).toISOString(), buckets: [] });
  assert.equal(accounts[0].snapshot.buckets[0].remainingFraction, 0.1);
  assert.equal(accounts[1].snapshot.buckets[0].remainingFraction, 0.9);
  const missing = { ...first, capturedAt: new Date(NOW + 1000).toISOString(), quotaState: 'missing', buckets: [] };
  accounts = core.mergeSnapshot(accounts, missing);
  assert.equal(accounts[0].snapshot.quotaState, 'missing');
  assert.deepEqual(accounts[0].snapshot.buckets, []);
});
test('account labels never imply authentication and capacity/duplicates are enforced', () => {
  const accounts = core.addAccount([], 'One', 'Personal');
  assert.deepEqual(accounts, [{ identity: 'one', label: 'Personal', snapshot: null }]);
  assert.throws(() => core.addAccount(accounts, 'ONE', 'Duplicate'));
  assert.throws(() => core.addAccount(accounts, 'two', 'a\n'));
  assert.throws(() => core.addAccount(Array.from({ length: 100 }, (_, i) => ({ identity: String(i), label: String(i), snapshot: null })), 'new', 'new'));
  assert.match(core.SWITCH_BLOCKED, /侧栏标签不代表当前登录/);
  assert.equal(core.mergeSnapshot([], collect(payload('a'.repeat(90)) ))[0].label.length, 80);
});
test('restoration rejects identity mismatch without silently destroying source data', () => {
  const good = [{ identity: 'one', label: 'Personal', snapshot: collect(payload('one')) }];
  assert.deepEqual(core.restoreAccounts(good, NOW), good);
  assert.throws(() => core.restoreAccounts([{ ...good[0], identity: 'two' }], NOW));
  assert.throws(() => core.restoreAccounts([...good, ...good], NOW));
  assert.deepEqual(core.restoreAccounts(undefined, NOW), []);
});
test('bounded JSON accepts only within byte limit and hides parser input', () => {
  assert.deepEqual(core.parseJson('{}'), {});
  assert.throws(() => core.parseJson('SECRET{'), { message: 'INVALID_JSON' });
  assert.throws(() => core.parseJson('a'.repeat(core.LIMITS.inputBytes + 1)), { message: 'INPUT_TOO_LARGE' });
});
