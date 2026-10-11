const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {QuotaDisplayCache,parseQuotaDisplay,initialQuotaDisplay}=require('../out/quota-display'),{PrivateState}=require('../out/private-state'),{quotaObservationFingerprint,quotaObservationMatches}=require('../out/quota-observation'),{accountQuotaStale,accountQuotaCatalogReady,accountDisplayFingerprint}=require('../out/quota-presentation'),{ImageQuotaQuery}=require('../out/image-quota');
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',now='2026-10-11T10:00:00.000Z';
const account=(id=A)=>({id,expectedEmail:'synthetic@example.test',hostId:'synthetic-host',capturedAt:'2026-10-01T00:00:00.000Z',quotaDisplayId:id,verifiedSubject:'synthetic-subject'});
const sample=(a,time=now)=>({email:a.expectedEmail,source:'server',observedAt:time,buckets:[{label:'Synthetic Gemini',bucketId:'server-bucket',window:'5h',remaining:.625,resetAt:null}]});
const image=(a,modelId='synthetic-image',endpoint='daily',time=now)=>({accountId:a.id,modelId,endpoint,queriedAt:time,remainingFraction:.4,resetAt:null});
function memory(){let state=initialQuotaDisplay(),tail=Promise.resolve();return{read:async()=>structuredClone(state),transaction(fn){const next=tail.then(()=>{const s=structuredClone(state),result=fn(s);state=parseQuotaDisplay(s);return result});tail=next.catch(()=>{});return next}}}
test('display recovery survives TTL and ordinary capture revision but stays stale for all freshness consumers',async()=>{
 const accounts=[account()],store=memory(),cache=new QuotaDisplayCache(()=>accounts,store);await cache.rememberAccount(accounts[0],sample(accounts[0]));await cache.rememberImage(accounts[0],image(accounts[0]));const old=accountDisplayFingerprint(accounts[0]);accounts[0].capturedAt=now;
 assert.notEqual(accountDisplayFingerprint(accounts[0]),old);const recovered=new QuotaDisplayCache(()=>accounts,store);await recovered.load();const snapshot=recovered.account(accounts[0]);assert.equal(snapshot.buckets[0].remaining,.625);assert.equal(snapshot.observedAt,now);
 const view={...accounts[0],quota:{phase:'ready',historical:true,snapshot}};assert.equal(accountQuotaStale(view,Date.parse(now)),true);assert.equal(accountQuotaCatalogReady(view,Date.parse(now)),false);assert.equal(accountQuotaStale(view,Date.parse(now)+120000),true);
 const query=new ImageQuotaQuery(()=>{},()=>Date.parse(now));query.selection('selected',recovered.image(accounts[0],'synthetic-image','daily'));assert.equal(query.getState().stale,true);assert.equal(query.getState().snapshot.remainingFraction,.4);
 assert.equal(recovered.image(accounts[0],'other-model','daily'),undefined);assert.equal(recovered.image(accounts[0],'synthetic-image','production'),undefined);
});
test('explicit replacement, deletion, host or known principal change cannot inherit observations or legacy history',async()=>{
 for(const change of [a=>a.quotaDisplayId=B,a=>a.expectedEmail='other@example.test',a=>a.hostId='other-host',a=>a.verifiedSubject='other-subject',a=>a.migrationState='pending']){
  const accounts=[account()],cache=new QuotaDisplayCache(()=>accounts);await cache.rememberAccount(accounts[0],sample(accounts[0]));await cache.rememberImage(accounts[0],image(accounts[0]));change(accounts[0]);assert.equal(cache.account(accounts[0]),undefined);assert.equal(cache.image(accounts[0],'synthetic-image','daily'),undefined);
 }
 const accounts=[account()],store=memory(),cache=new QuotaDisplayCache(()=>accounts,store);await cache.rememberAccount(accounts[0],sample(accounts[0]));const removed=accounts.pop();await cache.reconcile();await cache.rememberAccount(removed,sample(removed));assert.equal((await store.read()).accounts.length,0);
 const legacy={...account(),quotaDisplayId:undefined,verifiedSubject:undefined},old=accountDisplayFingerprint(legacy);legacy.quotaDisplayId=legacy.capturedAt;legacy.capturedAt=now;assert.equal(quotaObservationMatches(legacy,old),true);legacy.quotaDisplayId=B;assert.equal(quotaObservationMatches(legacy,old),false);
});
test('parallel controllers merge newer observations, and late failures or completions cannot replace them',async()=>{
 const accounts=[account(),account(B)],store=memory(),a=new QuotaDisplayCache(()=>accounts,store),b=new QuotaDisplayCache(()=>accounts,store);await Promise.all([a.load(),b.load()]);
 await Promise.all([a.rememberAccount(accounts[0],sample(accounts[0])),b.rememberAccount(accounts[1],sample(accounts[1]))]);await b.rememberAccount(accounts[0],sample(accounts[0],'2026-10-11T09:00:00.000Z'));await a.rememberImage(accounts[0],image(accounts[0]));await b.rememberImage(accounts[0],image(accounts[0],'synthetic-image','daily','2026-10-11T09:00:00.000Z'));
 const recovered=new QuotaDisplayCache(()=>accounts,store);await recovered.load();assert.equal(recovered.account(accounts[0]).observedAt,now);assert.equal(recovered.account(accounts[1]).observedAt,now);assert.equal(recovered.image(accounts[0],'synthetic-image','daily').queriedAt,now);
});
test('a write queued before loading does not lose the recovered model or its own reading',async()=>{
 const accounts=[account()],store=memory(),seed=new QuotaDisplayCache(()=>accounts,store);await seed.rememberImage(accounts[0],image(accounts[0]));const cache=new QuotaDisplayCache(()=>accounts,store);await cache.rememberAccount(accounts[0],sample(accounts[0]));assert.ok(cache.image(accounts[0],'synthetic-image','daily'));assert.ok(cache.account(accounts[0]));
});
test('private disk reconstruction stores bounded quota fields and opaque hashes; rejected storage never blocks queries',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'ag-quota-display-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const accounts=[account()],store=new PrivateState(path.join(root,'private'),parseQuotaDisplay,initialQuotaDisplay),cache=new QuotaDisplayCache(()=>accounts,store);
 await cache.rememberAccount(accounts[0],sample(accounts[0]));await cache.rememberImage(accounts[0],image(accounts[0]));await cache.flush();const raw=await fs.readFile(path.join(root,'private/state.json'),'utf8');assert.doesNotMatch(raw,/example\.test|synthetic-subject|token|prompt|project|csrf|bearer/);assert.match(raw,/[a-f0-9]{64}/);if(process.platform!=='win32')assert.equal((await fs.stat(path.join(root,'private/state.json'))).mode&0o777,0o600);
 const recovered=new QuotaDisplayCache(()=>accounts,new PrivateState(path.join(root,'private'),parseQuotaDisplay,initialQuotaDisplay));await recovered.load();assert.equal(recovered.account(accounts[0]).observedAt,now);
 const broken=new QuotaDisplayCache(()=>accounts,{read:async()=>{throw Error('unsafe')},transaction:async()=>{throw Error('unsafe')}});await broken.load();await broken.rememberAccount(accounts[0],sample(accounts[0]));assert.equal(broken.account(accounts[0]).buckets[0].remaining,.625);
 await assert.rejects(cache.rememberAccount(accounts[0],{...sample(accounts[0]),buckets:[{...sample(accounts[0]).buckets[0],token:'synthetic-secret'}]}),/INVALID/);assert.equal(cache.account(accounts[0]).observedAt,now);
 for(const state of [{...initialQuotaDisplay(),credential:'synthetic'}, {...initialQuotaDisplay(),images:[{...image(accounts[0]),identity:'f'.repeat(64),prompt:'synthetic'}]}, {...initialQuotaDisplay(),images:[{...image(accounts[0]),identity:'f'.repeat(64),remainingFraction:Infinity}]}])assert.throws(()=>parseQuotaDisplay(state),/INVALID/);
 assert.ok(quotaObservationFingerprint(accounts[0]).includes('synthetic-subject'));
});

test('display storage remains below its private byte budget even with maximum length catalogs',async()=>{
 const accounts=Array.from({length:50},(_,i)=>account(String(i+1).padStart(8,'0')+'-1111-4111-8111-111111111111')),store=memory(),cache=new QuotaDisplayCache(()=>accounts,store);const buckets=Array.from({length:200},()=>({label:'x'.repeat(200),bucketId:'b'.repeat(200),groupId:'g'.repeat(200),window:'w'.repeat(200),remaining:.5,resetAt:null}));
 for(const a of accounts)await cache.rememberAccount(a,{...sample(a),buckets});const state=await store.read();assert.ok(Buffer.byteLength(JSON.stringify(state))<=1536*1024);assert.ok(state.accounts.length<50);assert.ok(cache.account(accounts.at(-1)));
});

test('a historical card cannot seed or emit quota alerts even when its timestamp and request fingerprint look fresh',async t=>{
 const Module=require('node:module'),{initialWakeState}=require('../out/wake-state');const original=Module._load,entry=require.resolve('../out/automation-ui'),vscode={commands:{registerCommand:()=>({dispose(){}})}};let register;
 Module._load=function(name,...args){return name==='vscode'?vscode:original.call(this,name,...args)};try{delete require.cache[entry];register=require(entry).registerAutomationUi}finally{Module._load=original;delete require.cache[entry]}
 const a={...account(),hostCurrent:true,quota:{phase:'ready',historical:true,snapshot:sample(account())}},notices=[],context={subscriptions:[]};a.quota.accountFingerprint=accountDisplayFingerprint(a);let state=initialWakeState();state.alerts.low=true;const store={read:async()=>structuredClone(state),transaction:async fn=>fn(state)};const api=register(context,{getAccounts:()=>[a],getState:()=>({accountStorageReady:true})},{store,now:()=>Date.parse(now)+2000,notice:text=>notices.push(text),accounts:{fingerprint:()=>a.quota.accountFingerprint,run:async()=>assert.fail('model call'),models:async()=>assert.fail('model directory')}});t.after(()=>context.subscriptions.forEach(s=>s.dispose()));
 await api.observe();assert.equal(state.readings.length,0);delete a.quota.historical;await api.observe();assert.equal(state.readings.length,1);a.quota.snapshot={...a.quota.snapshot,observedAt:'2026-10-11T10:00:01.000Z',buckets:[{label:'Synthetic Gemini',bucketId:'server-bucket',window:'5h',remaining:0,resetAt:null}]};a.quota.historical=true;await api.observe();assert.deepEqual(notices,[]);assert.equal(state.readings[0].state,'healthy');assert.equal(state.enabled,false);
});

test('legacy ISO capture origins and server reset timestamps with offsets remain compatible',async()=>{
 const {validQuotaDisplayId}=require('../out/quota-observation'),a={...account(),quotaDisplayId:'2026-10-01T00:00:00Z'},cache=new QuotaDisplayCache(()=>[a]);assert.equal(validQuotaDisplayId(a.quotaDisplayId),true);assert.equal(validQuotaDisplayId('unsafe-metadata'),false);await cache.rememberAccount(a,{...sample(a),buckets:[{label:'Synthetic',remaining:.5,resetAt:'2026-10-11T12:00:00+02:00'}]});assert.equal(cache.account(a).buckets[0].resetAt,now);
});
