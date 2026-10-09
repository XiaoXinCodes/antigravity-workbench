const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { hubRpc, queryFreshQuota, queryHub, parseFreshQuota, generation } = require('../out/live-hub');

const auth = { authResult: { hasValidAuth: true } };
const status = (email = 'a@example.test') => ({ userStatus: { email, cascadeModelConfigData: { clientModelConfigs: [{ label: 'stale model', quotaInfo: { remainingFraction: 0.99 } }] } } });
const summary = { response: { groups: [{ displayName: 'Models', buckets: [{ bucketId: 'test', displayName: 'Model A', window: '5 hours', remainingFraction: 0.25, resetTime: '2026-10-01T08:00:00Z' }] }] } };
async function serve(handler, fn) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', data => { raw += data; });
    req.on('end', () => {
      const call = { method: req.url.split('/').at(-1), path: req.url, body: JSON.parse(raw), csrf: req.headers['x-codeium-csrf-token'] };
      seen.push(call);
      handler(call, res, seen);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await fn({ port: server.address().port, csrfToken: 'synthetic-quota-csrf-value' }, seen); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
function normal(call, res) { res.end(JSON.stringify(call.method === 'GetAuthStatus' ? auth : call.method === 'GetUserStatus' ? status() : summary)); }

test('fresh quota explicitly clears official cache and brackets request with same-hub identity proofs', async () => {
  await serve(normal, async (api, seen) => {
    const proof = await queryFreshQuota(api, 'A@example.test');
    assert.equal(proof.email, 'a@example.test'); assert.equal(proof.generation, generation(api));
    assert.equal(proof.quotaSource, 'server'); assert.equal(proof.authValid, true);
    assert.deepEqual(proof.buckets, [{ bucketId: 'test', window: '5 hours', label: 'Models · Model A · 5 hours', remaining: 0.25, resetAt: '2026-10-01T08:00:00Z' }]);
    assert.deepEqual(seen.map(x => x.method), ['GetAuthStatus', 'GetUserStatus', 'RetrieveUserQuotaSummary', 'GetAuthStatus', 'GetUserStatus']);
    assert.deepEqual(seen[2].body, { forceRefresh: true });
    assert.ok(seen.every(x => x.path === '/exa.language_server_pb.LanguageServerService/' + x.method && x.csrf === api.csrfToken));
    assert.ok(!JSON.stringify(proof).includes('stale model'));
  });
});
test('ordinary queryHub remains identity/status only and is never marked fresh', async () => {
  await serve(normal, async (api, seen) => { const proof = await queryHub(api); assert.equal(proof.buckets[0].remaining, 0.99); assert.equal(proof.quotaSource, undefined); assert.equal(seen.length, 2); });
});
test('wrong target email stops before refreshing another account', async () => {
  await serve(normal, async (api, seen) => { await assert.rejects(queryFreshQuota(api, 'b@example.test'), /HUB_QUOTA_ACCOUNT_MISMATCH/); assert.equal(seen.length, 2); });
});
test('identity change during refresh discards all fresh rows', async () => {
  await serve((call, res, seen) => { if (call.method === 'GetUserStatus' && seen.length > 3) res.end(JSON.stringify(status('b@example.test'))); else normal(call, res); }, async api => {
    await assert.rejects(queryFreshQuota(api), /HUB_CHANGED_DURING_QUERY/);
  });
});
test('caller capability change cannot route later requests to a new hub or publish the result', async () => {
  let caller;
  await serve((call, res) => { if (call.method === 'RetrieveUserQuotaSummary') caller.csrfToken = 'synthetic-replacement-value'; normal(call, res); }, async (api, seen) => {
    caller = api; await assert.rejects(queryFreshQuota(api), /HUB_CHANGED_DURING_QUERY/);
    assert.ok(seen.every(x => x.csrf === 'synthetic-quota-csrf-value'));
  });
});
test('auth invalidation after refresh prevents publishing fresh quota', async () => {
  await serve((call, res, seen) => { if (call.method === 'GetAuthStatus' && seen.length > 3) res.end('{"authResult":{"hasValidAuth":false}}'); else normal(call, res); }, async api => {
    await assert.rejects(queryFreshQuota(api), /HUB_AUTH_INVALID/);
  });
});
test('remote failure, redirects and invalid JSON never fall back to cached model quota or leak errors', async () => {
  for (const [code, body, expected] of [[500, 'private backend detail', 'HUB_RPC_FAILED'], [302, 'private redirect', 'HUB_RPC_FAILED'], [200, 'private invalid json', 'HUB_RESPONSE_INVALID']]) {
    await serve((call, res) => { if (call.method === 'RetrieveUserQuotaSummary') { res.statusCode = code; res.end(body); } else normal(call, res); }, async (api, seen) => {
      await assert.rejects(queryFreshQuota(api), error => error.message === expected); assert.equal(seen.length, 3);
    });
  }
});
test('empty or unsupported summary is unavailable, never zero quota or cached quota', async () => {
  for (const value of [{}, { response: {} }, { response: { groups: [], buckets: [] } }]) assert.throws(() => parseFreshQuota(value), /HUB_QUOTA_EMPTY/);
  await serve((call, res) => { if (call.method === 'RetrieveUserQuotaSummary') res.end('{"response":{}}'); else normal(call, res); }, async api => { await assert.rejects(queryFreshQuota(api), /HUB_QUOTA_EMPTY/); });
});
test('groups take precedence over deprecated buckets and preserve zero, disabled and absolute remaining', () => {
  const rows = parseFreshQuota({ response: { buckets: [{ displayName: 'duplicate', remainingFraction: 1 }], groups: [{ displayName: 'Paid', buckets: [
    { displayName: 'zero', remainingFraction: 0 }, { displayName: 'credits', remainingAmount: '9223372036854775807' }, { displayName: 'disabled', disabled: true },
  ] }] } });
  assert.equal(rows.length, 3); assert.equal(rows[0].remaining, 0); assert.equal(rows[1].remaining, null); assert.equal(rows[1].remainingAmount, '9223372036854775807'); assert.equal(rows[2].disabled, true);
  assert.deepEqual(parseFreshQuota({ response: { buckets: [{ bucketId: 'legacy', remainingAmount: 0 }] } }), [{ bucketId: 'legacy', label: 'legacy', remaining: null, remainingAmount: '0', resetAt: null }]);
});
test('malformed fractions, oneofs, counters, structures and excessive rows fail closed', () => {
  for (const bucket of [null, {}, { remainingFraction: -0.01 }, { remainingFraction: 1.01 }, { remainingFraction: NaN }, { remainingFraction: '0.5' }, { remainingFraction: 0, remainingAmount: '1' }, { remainingAmount: '-1' }, { remainingAmount: '1.5' }, { remainingAmount: '9223372036854775808' }, { remainingAmount: Number.MAX_SAFE_INTEGER + 1 }, { disabled: 'true' }]) {
    assert.throws(() => parseFreshQuota({ response: { buckets: [bucket] } }), /HUB_QUOTA_RESPONSE_INVALID/);
  }
  for (const response of [{ groups: {} }, { buckets: {} }, { groups: [{ buckets: {} }] }, { buckets: Array.from({ length: 201 }, () => ({ remainingFraction: 1 })) }]) assert.throws(() => parseFreshQuota({ response }), /HUB_QUOTA_RESPONSE_INVALID/);
});
test('labels are bounded and stripped of terminal/bidi controls; missing fraction stays unknown', () => {
  const [row] = parseFreshQuota({ response: { buckets: [{ displayName: '\u001b\nModel\u202e' + 'x'.repeat(200), resetTime: 'invalid' }] } });
  assert.equal(row.label.length, 120); assert.ok(!['\u001b', '\n', '\u202e'].some(char => row.label.includes(char))); assert.equal(row.remaining, null); assert.equal(row.resetAt, null);
});
test('cancellation before start issues no request and during refresh aborts with quota-specific error', async () => {
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(queryFreshQuota({ port: 1, csrfToken: 'synthetic-quota-csrf-value' }, undefined, cancelled.signal), /QUOTA_QUERY_CANCELLED/);
  const controller = new AbortController();
  await serve((call, res) => { if (call.method === 'RetrieveUserQuotaSummary') controller.abort(); else normal(call, res); }, async (api, seen) => {
    await assert.rejects(queryFreshQuota(api, undefined, controller.signal), /QUOTA_QUERY_CANCELLED/); assert.equal(seen.length, 3);
  });
});
test('cancellation while checking identity prevents the refresh request', async () => {
  const controller = new AbortController();
  await serve(() => controller.abort(), async (api, seen) => { await assert.rejects(queryFreshQuota(api, undefined, controller.signal), /QUOTA_QUERY_CANCELLED/); assert.equal(seen.length, 1); });
});

test('automatic identity verification accepts valid empty quota but rejects malformed success envelopes',async()=>{
 const {queryFreshIdentity}=require('../out/live-hub');
 for(const response of [{},{error:'private'},{response:null},{response:[]},{response:{},error:'private'}]) {
  await serve((call,res)=>{if(call.method==='RetrieveUserQuotaSummary')res.end(JSON.stringify(response));else normal(call,res)},async api=>{await assert.rejects(queryFreshIdentity(api),/HUB_QUOTA_RESPONSE_INVALID/)});
 }
 await serve((call,res)=>{if(call.method==='RetrieveUserQuotaSummary')res.end('{"response":{}}');else normal(call,res)},async api=>{const proof=await queryFreshIdentity(api);assert.equal(proof.quotaSource,'server');assert.deepEqual(proof.buckets,[]);assert.equal(proof.email,'a@example.test')});
});
test('signed-out verification requires explicit negative authentication twice',async()=>{
 const {querySignedOutHub}=require('../out/live-hub');
 for(const authValue of [{},{authResult:{}},{authResult:{hasValidAuth:true}}])await serve((_call,res)=>res.end(JSON.stringify(authValue)),async api=>assert.rejects(querySignedOutHub(api),/HUB_SIGNED_OUT_NOT_VERIFIED/));
 await serve((_call,res)=>res.end('{"authResult":{"hasValidAuth":false}}'),async(api,seen)=>{assert.equal((await querySignedOutHub(api)).authValid,false);assert.equal(seen.length,2)});
});


test('model catalog recheck uses official GetAvailableModels empty payload, without invented forceRefresh',async()=>{
 await serve((call,res)=>res.end(JSON.stringify({response:{imageGenerationModelIds:[],models:{}}})),async(api,seen)=>{
  await hubRpc(api,'GetAvailableModels');await hubRpc(api,'GetAvailableModels');assert.equal(seen.length,2);assert.ok(seen.every(x=>x.method==='GetAvailableModels'));assert.deepEqual(seen.map(x=>x.body),[{},{}]);
 });
});
