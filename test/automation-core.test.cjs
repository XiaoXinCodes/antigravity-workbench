const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),{EventEmitter}=require('node:events');
const {wakeOccurrences,validateWakeSchedule}=require('../out/wake-schedule'),{WakeEngine}=require('../out/wake-engine'),{initialWakeState,parseWakeState}=require('../out/wake-state'),{PrivateState}=require('../out/private-state'),{sendWake,parseWakeStream,wakeRequestBody}=require('../out/wake-transport'),{observeQuotaAlerts}=require('../out/quota-alerts'),privacy=require('../out/identity-presentation'),{setLanguage}=require('../out/i18n');
const A='11111111-1111-4111-8111-111111111111',T='22222222-2222-4222-8222-222222222222',R='33333333-3333-4333-8333-333333333333',NOW=Date.parse('2026-10-09T10:00:00Z');
const schedule={timezone:'Etc/UTC',times:['10:01','12:00'],weekdays:[0,1,2,3,4,5,6]};
function memory(){let state=initialWakeState(),tail=Promise.resolve();return{read:async()=>structuredClone(state),transaction(fn){const work=tail.then(()=>{const next=structuredClone(state),result=fn(next);state=parseWakeState(next);return result});tail=work.catch(()=>{});return work}}}
function fixture(store=memory()) {let now=NOW,fingerprint='synthetic-bound-A',calls=0,handler=async(_task,_signal,before)=>{await before();return{phase:'succeeded',code:'WAKE_COMPLETE',outputTokens:2,totalTokens:12}};const deps={fingerprint:()=>fingerprint,run:async(...args)=>{calls++;return handler(...args)}};return{store,engine:new WakeEngine(store,deps,()=>{},()=>now),deps,setTime:t=>now=t,replace:()=>fingerprint='replacement',handle:fn=>handler=fn,get calls(){return calls},task:{id:T,revision:R,accountId:A,fingerprint,modelId:'synthetic-model-a',endpoint:'daily',schedule,enabled:false,outputBudget:8,nextDue:0}}}
const tick=()=>new Promise(setImmediate);
async function enabled(f){await f.engine.save(f.task);await f.engine.consent();await f.engine.pause(T,true);await f.engine.enable(true);f.setTime(NOW+60_000)}
test('calendar preview uses exact IANA local days, weekly and multiple times',()=>{
 assert.deepEqual(wakeOccurrences(schedule,NOW,3).map(t=>new Date(t).toISOString()),['2026-10-09T10:01:00.000Z','2026-10-09T12:00:00.000Z','2026-10-10T10:01:00.000Z']);
 assert.equal(new Date(wakeOccurrences({timezone:'Asia/Kathmandu',times:['08:00'],weekdays:[1]},Date.parse('2026-10-09T00:00:00Z'))[0]).toISOString(),'2026-10-12T02:15:00.000Z');
 assert.deepEqual(validateWakeSchedule({...schedule,times:['12:00','10:01','12:00']} ).times,['10:01','12:00']);
 for(const s of [{...schedule,timezone:'no/such-zone'},{...schedule,times:['24:00']},{...schedule,weekdays:[]},{...schedule,times:Array(13).fill('08:00')}])assert.throws(()=>validateWakeSchedule(s),/INVALID/);
});
test('DST nonexistent wall time is skipped and repeated hour uses only earlier instant',()=>{
 const daily={timezone:'America/New_York',times:['02:30'],weekdays:schedule.weekdays};
 assert.equal(new Date(wakeOccurrences(daily,Date.parse('2026-03-08T00:00:00Z'))[0]).toISOString(),'2026-03-09T06:30:00.000Z');
 const repeated={...daily,times:['01:30']};assert.equal(new Date(wakeOccurrences(repeated,Date.parse('2026-11-01T00:00:00Z'))[0]).toISOString(),'2026-11-01T05:30:00.000Z');
 assert.equal(new Date(wakeOccurrences(repeated,Date.parse('2026-11-01T05:31:00Z'))[0]).toISOString(),'2026-11-02T06:30:00.000Z');
});
test('default-off makes no model call; explicit consent, enable and task selection are necessary',async()=>{
 const f=fixture();await f.engine.save(f.task);f.setTime(NOW+60_000);await f.engine.tick();assert.equal(f.calls,0);await assert.rejects(f.engine.enable(true),/CONSENT/);await assert.rejects(f.engine.test(T),/CONSENT/);assert.equal((await f.store.read()).tasks[0].enabled,false);
 await f.engine.consent();await f.engine.test(T);assert.equal(f.calls,1);assert.equal((await f.store.read()).instances[0].phase,'succeeded');assert.equal((await f.store.read()).enabled,false);
});
test('two window engines atomically claim one occurrence; duplicate ticks and tests do not resend',async()=>{
 const f=fixture();await enabled(f);let finish;f.handle(async(_task,_signal,before)=>{await before();await new Promise(r=>finish=r);return{phase:'succeeded',code:'WAKE_COMPLETE'}});
 const other=new WakeEngine(f.store,f.deps,()=>{},()=>NOW+60_000),first=f.engine.tick();while(!finish)await tick();await other.tick();await Promise.all([f.engine.test(T),other.test(T)]);assert.equal(f.calls,1);finish();await first;await other.tick();assert.equal(f.calls,1);assert.equal((await f.store.read()).instances.length,1);
});
test('different scheduled accounts share one bounded execution slot and keep an unclaimed due time',async()=>{
 const f=fixture();await enabled(f);f.setTime(NOW);const otherId='44444444-4444-4444-8444-444444444444';await f.engine.save({...f.task,id:otherId,enabled:true});await f.engine.pause(otherId,true);f.setTime(NOW+120_000);
 await f.engine.tick();assert.equal(f.calls,1);assert.ok((await f.store.read()).tasks.find(t=>t.id===otherId).nextDue<=NOW+120_000);await f.engine.tick();assert.equal(f.calls,2);assert.equal((await f.store.read()).instances.length,2);
});
test('sleep past lateness skips a missed run, advances the calendar without catchup burst',async()=>{
 const f=fixture();await enabled(f);f.setTime(NOW+26*3600_000);await f.engine.tick();assert.equal(f.calls,0);const state=await f.store.read();assert.equal(state.instances.length,1);assert.equal(state.instances[0].code,'WAKE_TOO_LATE');assert.ok(state.tasks[0].nextDue>NOW+26*3600_000);await f.engine.tick();assert.equal(f.calls,0);
});
test('cancel or schedule edit during preparation prevents sending; late completion is isolated',async()=>{
 for(const action of ['cancel','edit','delete','replace']){const f=fixture();await enabled(f);let finish;f.handle(async(_task,_signal,before)=>{await new Promise(r=>finish=r);await before();return{phase:'succeeded',code:'WAKE_COMPLETE'}});const run=f.engine.tick();while(!finish)await tick();
  if(action==='cancel')await f.engine.cancel(T);if(action==='edit')await f.engine.save({...f.task,schedule:{...schedule,times:['13:00']}});if(action==='delete')await f.engine.remove(T);if(action==='replace')f.replace();finish();await run;assert.equal((await f.store.read()).instances[0].phase,'cancelled',action);
 }
});
test('sent timeout is durable unknown, task pauses and restart never replays it',async()=>{
 const f=fixture();await enabled(f);f.handle(async(_task,_signal,before)=>{await before();throw Error('SOCKET_TIMEOUT')});await f.engine.tick();let state=await f.store.read();assert.equal(state.instances[0].phase,'unknown');assert.equal(state.tasks[0].enabled,false);
 const restarted=new WakeEngine(f.store,f.deps,()=>{},()=>NOW+24*3600_000);await restarted.tick();assert.equal(f.calls,1);await f.engine.pause(T,true);state=await f.store.read();assert.ok(state.tasks[0].nextDue>NOW+60_000);await f.engine.tick();assert.equal(f.calls,1);
});
test('cross-window cancel after send retains unknown and rejects late reported success',async()=>{
 const f=fixture();await enabled(f);let finish;f.handle(async(_task,_signal,before)=>{await before();await new Promise(r=>finish=r);return{phase:'succeeded',code:'WAKE_COMPLETE'}});const run=f.engine.tick();while(!finish)await tick();const other=new WakeEngine(f.store,f.deps);await other.cancel(T);finish();await run;assert.equal((await f.store.read()).instances[0].phase,'unknown');
});
test('expired leases do not reclaim an abandoned sent instance; preparation expiration skips',async()=>{
 for(const phase of ['preparing','sent']){const f=fixture();await enabled(f);await f.store.transaction(s=>{s.instances.push({id:'old',taskId:T,revision:s.tasks[0].revision,accountId:A,modelId:'synthetic-model-a',due:NOW,manual:false,nonce:R,leaseUntil:NOW,phase,code:''});s.tasks[0].nextDue=NOW+3600_000});await f.engine.tick();assert.equal(f.calls,0);assert.equal((await f.store.read()).instances[0].phase,phase==='sent'?'unknown':'skipped')}
});
test('persistent state has atomic disk claims across independent stores and rejects unsafe state',async()=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'ag-automation-core-')));try{const directory=path.join(root,'private'),store=new PrivateState(directory,parseWakeState,initialWakeState),other=new PrivateState(directory,parseWakeState,initialWakeState);await store.transaction(s=>{s.consent=true});await other.transaction(s=>{s.enabled=true});assert.equal((await store.read()).enabled,true);
  const f=fixture(store);await enabled(f);await f.engine.tick();const restart=fixture(other);restart.setTime(NOW+60_000);await restart.engine.tick();assert.equal(f.calls+restart.calls,1);assert.ok((await fs.stat(path.join(directory,'state.json'))).mode&0o600);
  await assert.rejects(store.transaction(s=>{s.tasks[0].outputBudget=0}),/INVALID/);assert.equal((await store.read()).tasks[0].outputBudget,8);
  const link=path.join(root,'link');await fs.symlink(directory,link);await assert.rejects(new PrivateState(link,parseWakeState,initialWakeState).read(),/UNSAFE/);
 }finally{await fs.rm(root,{recursive:true,force:true})}
});
test('protocol has positive output budget, fixed endpoint, final stream proof and separate actual usage',async()=>{
 const binding={token:'synthetic-bearer',projectId:'synthetic-project',modelId:'synthetic-model-a',endpoint:'daily',verify:async()=>{}};for(const budget of [0,-1,65,NaN])assert.throws(()=>wakeRequestBody(binding,budget),/INVALID/);
 let sent=false,options,body;const transport=(opts,receive)=>{assert.equal(sent,true);options=opts;const req=new EventEmitter();req.destroy=()=>{};req.end=text=>{body=JSON.parse(text);const res=new EventEmitter();res.statusCode=200;receive(res);res.emit('data',Buffer.from('data: {"response":{"candidates":[{"finishReason":"MAX_TOKENS"}],"usageMetadata":{"candidatesTokenCount":8,"totalTokenCount":23}}}\n\n'));res.emit('end')};return req};
 const result=await sendWake(binding,8,new AbortController().signal,async()=>{sent=true},transport);assert.equal(options.hostname,'daily-cloudcode-pa.googleapis.com');assert.equal(options.path,'/v1internal:streamGenerateContent?alt=sse');assert.equal(body.model,binding.modelId);assert.equal(body.request.generationConfig.maxOutputTokens,8);assert.equal(result.phase,'succeeded');assert.equal(result.outputTokens,8);assert.equal(result.totalTokens,23);assert.equal(parseWakeStream('data: {"response":{"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}}\n').phase,'unknown');assert.equal(parseWakeStream('data: broken\n').phase,'unknown');
 let count=0;const timeout=(opts,receive)=>{count++;const req=new EventEmitter();req.destroy=()=>{};req.end=()=>{const res=new EventEmitter();res.statusCode=200;receive(res);res.emit('aborted')};return req};assert.equal((await sendWake(binding,8,new AbortController().signal,async()=>{},timeout)).phase,'unknown');assert.equal(count,1);
});
test('alerts are default off, fresh-only, edge-triggered, deduped and server-confirmed',async()=>{
 const store=memory(),sample={accountId:A,fingerprint:'bound-A',quotaKey:'bucket-a',modelLabel:'Synthetic A',observedAt:new Date(NOW).toISOString(),fraction:.8};
 assert.deepEqual(await observeQuotaAlerts(store,[sample],NOW),[]);await store.transaction(s=>{s.alerts={low:true,exhausted:true,recovered:true,threshold:10}});
 const low={...sample,fraction:.05,observedAt:new Date(NOW+1000).toISOString()};assert.deepEqual((await observeQuotaAlerts(store,[low],NOW+1000)).map(a=>a.edge),['low']);assert.deepEqual(await observeQuotaAlerts(store,[low],NOW+1000),[]);
 for(const fraction of [null,NaN,1.2])assert.deepEqual(await observeQuotaAlerts(store,[{...sample,fraction,observedAt:new Date(NOW+2000).toISOString()}],NOW+2000),[]);
 assert.deepEqual(await observeQuotaAlerts(store,[{...sample,observedAt:'bad'}],NOW),[]);assert.deepEqual(await observeQuotaAlerts(store,[{...sample,observedAt:new Date(NOW+9000).toISOString()}],NOW),[]);
 assert.deepEqual(await observeQuotaAlerts(store,[sample],NOW+3600_000),[]); // Clock/reset expiry cannot recover.
 const empty={...low,fraction:0,observedAt:new Date(NOW+2000).toISOString()};assert.equal((await observeQuotaAlerts(store,[empty],NOW+2000))[0].edge,'exhausted');
 const recovered={...sample,observedAt:new Date(NOW+3000).toISOString()};const [a,b]=await Promise.all([observeQuotaAlerts(store,[recovered],NOW+3000),observeQuotaAlerts(store,[recovered],NOW+3000)]);assert.equal(a.length+b.length,1);assert.equal(a[0]?.edge??b[0]?.edge,'recovered');
 assert.deepEqual(await observeQuotaAlerts(store,[{...low,fingerprint:'replacement'}],NOW+4000),[]);
});
test('privacy aliases stay distinct across Chinese/English and never mutate internal IDs',()=>{
 const accounts=[{id:A,label:'Account Alpha',expectedEmail:'alpha@example.test'},{id:T,label:'A',expectedEmail:'beta@example.test'}];privacy.setIdentityHidden(true);const a=privacy.displayAccount(accounts[0]),b=privacy.displayAccount(accounts[1]);assert.notEqual(a,b);assert.equal(privacy.displayEmail('alpha@example.test',accounts),a);assert.ok(!privacy.hideIdentityText('Switch Account Alpha · alpha@example.test and A',accounts).includes('alpha@example.test'));assert.equal(privacy.hideIdentityText('Available model',accounts),'Available model');setLanguage('en');assert.match(privacy.displayAccount(accounts[0]),/^Account /);assert.equal(a.slice(-10),privacy.displayAccount(accounts[0]).slice(-10));assert.equal(accounts[0].id,A);privacy.setIdentityHidden(false);assert.equal(privacy.displayAccount(accounts[0]),'Account Alpha');setLanguage('zh-CN');
});

test('embedded automation UI script parses in both languages',()=>{for(const language of ['zh-CN','en']){setLanguage(language);const html=require('../out/automation-view').automationHtml('vscode-resource:');new(require('node:vm').Script)(html.match(/<script[^>]*>([\s\S]*)<\/script>/)[1]);assert.match(html,/Content-Security-Policy/)}setLanguage('zh-CN')});
test('independent host processes cannot send the same scheduled instance twice',async()=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'ag-automation-processes-')));try{
  const store=new PrivateState(path.join(root,'private'),parseWakeState,initialWakeState),f=fixture(store);await enabled(f);
  const launch=()=>new Promise((resolve,reject)=>{const child=require('node:child_process').spawn(process.execPath,[path.join(__dirname,'fixtures/automation-worker.cjs'),path.join(root,'private'),String(NOW+60_000)],{stdio:['ignore','ignore','pipe']});let errors='';child.stderr.on('data',d=>errors+=d);child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error(errors)))});
  await Promise.all([launch(),launch()]);assert.equal((await fs.readFile(path.join(root,'private','synthetic-sends.txt'),'utf8')).trim().split('\n').length,1);assert.equal((await store.read()).instances.length,1);
 }finally{await fs.rm(root,{recursive:true,force:true})}
});
test('wake catalog uses exact per-account callable IDs, preserves unfamiliar models and excludes explicit image IDs',()=>{
 const Module=require('node:module'),original=Module._load;let parse;try{Module._load=function(name,...args){return name==='vscode'?{}:original.call(this,name,...args)};parse=require('../out/wake-accounts').wakeModelsFromCatalog}finally{Module._load=original}
 const catalog={imageGenerationModelIds:['synthetic-image'],models:{'text-alpha':{displayName:'Alpha'},'future-family':{displayName:'New family'},'disabled-model':{disabled:true},'synthetic-image':{}}};assert.deepEqual(parse(catalog).map(m=>m.id),['text-alpha','future-family']);assert.deepEqual(parse({models:{'text-beta':{}}}).map(m=>m.id),['text-beta']);assert.throws(()=>parse({models:[]}));
});
