const test = require('node:test'), assert = require('node:assert/strict');
const { imageQuotaFromCatalog, ImageQuotaQuery, imageQuotaErrorText, imageQuotaPercent } = require('../out/image-quota');
const model = 'gemini-nano-banana-2.1';
const snapshot = (extra = {}) => ({ accountId: 'fixture-A', modelId: model, endpoint: 'daily', queriedAt: '2026-10-07T08:00:00Z', remainingFraction: .25, resetAt: null, ...extra });
const tick = () => new Promise(setImmediate);
const fail = () => '查询失败';
test('ordinary quota errors use fixed guidance with no technical codes or response echoes', () => {
 for (const error of [Error('IMAGE_SAVED_MODELS_FORBIDDEN'),Error('synthetic-private-secret'),Error('IMAGE_ACCOUNT_CHECK_TIMEOUT')]) {
  const text=imageQuotaErrorText(error);assert.doesNotMatch(text,/IMAGE_|synthetic-private/);assert.ok(text.length>0);
 }
});
test('image quota reads only exact image directory members with no Gemini grouping', () => {
 const rows = imageQuotaFromCatalog({ models: { [model]: { quotaInfo: { remainingFraction: 0, resetTime: '2026-10-08T00:00:00Z', accessToken: 'synthetic-private' } }, chat: { quotaInfo: { remainingFraction: 1 } }, 'gemini-3-pro-image': { quotaInfo: { remainingFraction: .9 } } } }, [{ id: model, label: model }]);
 assert.deepEqual(rows, [{ modelId: model, remainingFraction: 0, resetAt: '2026-10-08T00:00:00.000Z' }]);
 assert.doesNotMatch(JSON.stringify(rows), /synthetic-private|chat|shared|credits|amount/);
});
test('missing and malformed quota fields remain unknown rather than zero or image counts', () => {
 for (const remainingFraction of [undefined, null, -.1, 1.1, NaN, Infinity, '0.5']) {
  const [row] = imageQuotaFromCatalog({models:{[model]:{quotaInfo:{remainingFraction,resetTime:'synthetic-secret'}}}},[{id:model}]);
  assert.equal(row.remainingFraction,null); assert.equal(row.resetAt,null);
 }
 const [row] = imageQuotaFromCatalog({models:{[model]:{quotaInfo:{remainingFraction:1,remainingAmount:'100',unit:'credits'}}}},[{id:model}]);
 assert.deepEqual(row,{modelId:model,remainingFraction:1,resetAt:null});
});
test('explicit refresh retains an old reading marked stale, including after failure', async () => {
 const q = new ImageQuotaQuery(() => {}); q.selection('A-model-daily');
 await q.query(async () => snapshot(), fail); assert.equal(q.getState().stale,false);
 let finish; const pending = q.query(() => new Promise((_resolve,reject) => {finish=reject}), fail); await tick();
 assert.equal(q.getState().loading,true); assert.equal(q.getState().stale,true); assert.equal(q.getState().snapshot.remainingFraction,.25);
 finish(Error('synthetic-private-error')); await pending;
 assert.equal(q.getState().loading,false); assert.equal(q.getState().error,'查询失败'); assert.equal(q.getState().stale,true);
});
for (const changed of ['B-model-daily','A-other-model-daily','A-model-production']) test('late quota response cannot cross selection: '+changed, async () => {
 const q = new ImageQuotaQuery(() => {}); q.selection('A-model-daily'); let finish;
 const pending = q.query(() => new Promise(resolve => {finish=resolve}), fail); await tick(); q.selection(changed);
 await pending; finish(snapshot()); await tick(); assert.deepEqual(q.getState(),{loading:false,stale:false});
 await q.query(async () => snapshot({accountId:'fixture-new'}),fail); assert.equal(q.getState().snapshot.accountId,'fixture-new');
});
test('duplicate queries issue one request and disposal/invalidation suppresses publication', async () => {
 let calls=0,finish,emits=0;const q=new ImageQuotaQuery(()=>{emits++});q.selection('one');
 const pending=q.query(()=>{calls++;return new Promise(resolve=>finish=resolve)},fail);await tick();await q.query(async()=>{calls++;return snapshot()},fail);assert.equal(calls,1);
 q.invalidate();await pending;const prior=emits;finish(snapshot());await tick();assert.equal(emits,prior);assert.equal(q.getState().snapshot,undefined);
});
test('after a generation, a previous quota is stale until another explicit query', async () => {
 const q=new ImageQuotaQuery(()=>{});q.selection('one');await q.query(async()=>snapshot(),fail);q.invalidate(true);
 assert.equal(q.getState().stale,true);assert.equal(q.getState().snapshot.remainingFraction,.25);
});

test('quota UI has inline output and technical records nested under a closed advanced section',()=>{
 const {directImageHtml}=require('../out/direct-image-view');const html=directImageHtml('nonce','fixture:');
 assert.match(html,/id="queryQuota"/);assert.match(html,/id="imageQuotaStatus"/);assert.match(html,/<details id="imageDebug"><summary><span data-i18n="[^"]+">高级调试<\/span><\/summary><details id="history">/);
 assert.match(html,/id="imageQuotaError"[^>]*role="alert"/);
});
test('whole quota query times out even when underlying work ignores cancellation',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const q=new ImageQuotaQuery(()=>{});q.selection('one');let finish,signal;
 const pending=q.query(s=>{signal=s;return new Promise(resolve=>finish=resolve)},fail);await tick();t.mock.timers.tick(60_000);await pending;
 assert.equal(signal.aborted,true);assert.equal(q.getState().loading,false);assert.equal(q.getState().error,'查询失败');finish(snapshot());await tick();assert.equal(q.getState().snapshot,undefined);
});


test('sub-full server fractions never round to full quota',()=>{
 assert.equal(imageQuotaPercent(1),'100.00%');assert.equal(imageQuotaPercent(0),'0.00%');assert.equal(imageQuotaPercent(.999999),'接近 100%（未满）');assert.equal(imageQuotaPercent(.5),'50.00%');
});
test('quota snapshots expire after one minute without fabricating a new reading',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let emits=0;const q=new ImageQuotaQuery(()=>emits++);q.selection('one');
 await q.query(async()=>snapshot({remainingFraction:1}),fail);t.mock.timers.tick(59999);assert.equal(q.getState().stale,false);
 t.mock.timers.tick(1);assert.equal(q.getState().stale,true);assert.equal(q.getState().snapshot.remainingFraction,1);assert.equal(emits,3);
 q.selection('two');t.mock.timers.tick(60000);assert.equal(q.getState().snapshot,undefined);
});
