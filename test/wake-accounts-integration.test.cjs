const test=require('node:test'),assert=require('node:assert/strict'),Module=require('node:module'),{EventEmitter}=require('node:events');
const {SavedAccountQuotaClient}=require('../out/account-quota'),{LiveSwitchService,ACCOUNT_PREFIX}=require('../out/live-switch');
const {imageAccountRevision}=require('../out/saved-image-account'),{sendWake}=require('../out/wake-transport');
const {accountDisplayFingerprint}=require('../out/quota-presentation'),{catalog}=require('./fixtures/conversation-catalog.cjs');
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
function fixture(){
 const now=Date.now(),events=[],payloads=[],vault=new Map();let held=false,readCatalog=(id,endpoint)=>catalog('synthetic-text-'+(id===A?'A':'B')+'-'+endpoint);
 const accounts=[A,B].map((id,i)=>({id,label:i?'Synthetic B':'Synthetic A',expectedEmail:i?'b@example.test':'a@example.test',hostId:'synthetic-host',hostCurrent:true,active:!i,capturedAt:new Date(now).toISOString(),identitySource:'hub'}));
 for(const a of accounts)vault.set(ACCOUNT_PREFIX+a.id,JSON.stringify({...a,slots:{keyring:null,keyringState:'unobserved',file:JSON.stringify({auth_method:'consumer',token:{access_token:'synthetic-bearer-'+a.id,refresh_token:'synthetic-refresh-'+a.id,expiry:new Date(now+3600000).toISOString()}})}}));
 const service=new LiveSwitchService({get:async k=>vault.get(k),store:async()=>{throw Error('UNEXPECTED_CREDENTIAL_WRITE')},delete:async()=>{throw Error('UNEXPECTED_CREDENTIAL_DELETE')}},{read:async()=>{throw Error('OFFICIAL_READ_FORBIDDEN')},write:async()=>{throw Error('OFFICIAL_WRITE_FORBIDDEN')}},'synthetic-host');
 const store={load:async id=>{assert.equal(held,true);events.push(['load',id]);return{account:await service.account(id),revision:imageAccountRevision(vault.get(ACCOUNT_PREFIX+id))}},verify:async(id,revision)=>{assert.equal(held,true);if(!vault.has(ACCOUNT_PREFIX+id)||imageAccountRevision(vault.get(ACCOUNT_PREFIX+id))!==revision)throw Error('IMAGE_SAVED_ACCOUNT_CHANGED')},refresh:()=>({loadPending:async()=>undefined,provider:{exchange:async()=>{throw Error('UNEXPECTED_REFRESH')}},stage:async()=>{throw Error('UNEXPECTED_REFRESH')},commit:async()=>{throw Error('UNEXPECTED_REFRESH')}})};
 const request=(options,receive)=>{assert.equal(held,true);const req=new EventEmitter();req.destroy=()=>{};req.end=body=>{payloads.push({options,body:JSON.parse(body)});queueMicrotask(()=>{const response=new EventEmitter();response.resume=()=>{};response.statusCode=200;receive(response);response.emit('data',Buffer.from('data: {"response":{"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"candidatesTokenCount":2,"totalTokenCount":14}}}\n\n'));response.emit('end')})};return req};
 const original=Module._load,entry=require.resolve('../out/wake-accounts');
 Module._load=function(name,...args){
  if(name==='vscode')return{workspace:{isTrusted:true},UIKind:{Desktop:1},env:{uiKind:1}};
  if(name==='./native-host')return{nativeHostStatus:()=>({available:true})};
  if(name==='./live-lock')return{LiveLocks:class{async withOperation(work){assert.equal(held,false);held=true;try{return await work()}finally{held=false}}}};
  if(name==='./saved-account-store')return{savedAccountStore:async()=>store};
  if(name==='./passive-current-identity')return{passiveCurrentEmail:async()=>{assert.equal(held,true);return'a@example.test'}};
  if(name==='./account-quota')return{SavedAccountQuotaClient:class extends SavedAccountQuotaClient{constructor(){super(async r=>{assert.equal(held,true);assert.equal(r.endpoint,'identity');const a=accounts.find(a=>'synthetic-bearer-'+a.id===r.accessToken);assert.ok(a);return{email:a.expectedEmail,id:'synthetic-subject-'+a.id,verified_email:true}})}}};
  if(name==='./direct-image-project-transport')return{resolveEndpointImageProject:async(token,_signal,endpoint)=>{assert.equal(held,true);const a=accounts.find(a=>'synthetic-bearer-'+a.id===token);assert.ok(a);events.push(['project',a.id,endpoint]);return{projectId:'synthetic-project-'+(a.id===A?'A':'B')+'-'+endpoint,endpoint}}};
  if(name==='./account-model-catalog')return{readAccountModelCatalog:async(token,project,signal,endpoint)=>{assert.equal(held,true);const a=accounts.find(a=>'synthetic-bearer-'+a.id===token);assert.ok(a);assert.equal(project,'synthetic-project-'+(a.id===A?'A':'B')+'-'+endpoint);events.push(['catalog',a.id,endpoint]);return readCatalog(a.id,endpoint,signal)}};
  if(name==='./wake-transport')return{sendWake:(...args)=>sendWake(...args,request)};
  if(name==='./saved-image-models'||name==='./direct-image-transport')throw Error('IMAGE_GENERATION_DEPENDENCY_FORBIDDEN');
  return original.call(this,name,...args);
 };
 let api;try{delete require.cache[entry];delete require.cache[require.resolve('../out/saved-image-account')];api=require(entry).createWakeAccounts({globalStorageUri:{toString:()=> 'synthetic-profile'}},{getAccounts:()=>accounts,getState:()=>({accountStorageReady:true,pending:false})})}finally{Module._load=original;delete require.cache[entry];delete require.cache[require.resolve('../out/saved-image-account')]}
 const task=(id=B,endpoint='daily')=>({accountId:id,fingerprint:accountDisplayFingerprint(accounts.find(a=>a.id===id)),modelId:'synthetic-text-'+(id===A?'A':'B')+'-'+endpoint,endpoint,outputBudget:8,schedule:{mode:'calendar'}});
 return{api,accounts,events,payloads,vault,task,signal:new AbortController().signal,catalog:fn=>readCatalog=fn};
}
test('production wake adapter binds each selected account and endpoint to its independent ordinary catalog',async()=>{
 const f=fixture();for(const id of [A,B])for(const endpoint of ['daily','production'])assert.deepEqual((await f.api.models(id,endpoint,f.signal)).map(x=>x.id),[f.task(id,endpoint).modelId,'synthetic-unlisted-model']);
 assert.equal(f.payloads.length,0);const originalA=f.vault.get(ACCOUNT_PREFIX+A);let before=0;
 assert.equal((await f.api.run(f.task(B,'production'),f.signal,async()=>before++)).phase,'succeeded');const p=f.payloads[0];
 assert.equal(before,1);assert.equal(p.options.hostname,'cloudcode-pa.googleapis.com');assert.equal(p.options.path,'/v1internal:streamGenerateContent?alt=sse');assert.equal(p.options.headers.Authorization,'Bearer synthetic-bearer-'+B);
 assert.equal(p.body.project,'synthetic-project-B-production');assert.equal(p.body.model,'synthetic-text-B-production');assert.equal(p.body.requestType,'agent');assert.deepEqual(p.body.request.contents,[{role:'user',parts:[{text:'Hi'}]}]);assert.deepEqual(p.body.request.generationConfig,{maxOutputTokens:8,temperature:0});assert.equal(f.vault.get(ACCOUNT_PREFIX+A),originalA);
});
test('production run re-queries membership and refuses image ID, another account model and another endpoint model before send',async()=>{
 for(const model of ['synthetic-image-model','synthetic-text-A-daily','synthetic-text-B-production','quota-pool-not-model','MODEL_SYNTHETIC_AGENT']){const f=fixture();let before=0;await assert.rejects(f.api.run({...f.task(),modelId:model},f.signal,async()=>before++),/MODEL_UNVERIFIED/);assert.equal(before,0);assert.equal(f.payloads.length,0)}
});
test('model removed after the UI catalog read cannot send from a cached ordinary catalog',async()=>{
 const f=fixture();await f.api.models(B,'daily',f.signal);f.catalog(()=>catalog('replacement-text-model'));await assert.rejects(f.api.run(f.task(),f.signal,async()=>assert.fail('must not send')),/MODEL_UNVERIFIED/);assert.equal(f.payloads.length,0);assert.equal(f.events.filter(e=>e[0]==='catalog').length,2);
});
test('wrapped catalog preserves selected conversation quota and does not borrow full image quota',async()=>{
 const f=fixture();f.catalog((id,endpoint)=>({response:catalog(f.task(id,endpoint).modelId)}));const task=f.task();const q=await f.api.quota(task,f.signal);assert.equal(q.modelId,task.modelId);assert.equal(q.accountId,B);assert.equal(q.remainingFraction,.6);
 await assert.rejects(f.api.run({...task,schedule:{mode:'quota-recovery'}},f.signal,async()=>assert.fail('must not send')),/QUOTA_NOT_FULL/);assert.equal(f.payloads.length,0);
});
test('models-only legacy catalog remains usable for the manually selected conversation model and exact endpoint',async()=>{
 const f=fixture();await f.api.models(B,'daily',f.signal);f.catalog(()=>({models:{'synthetic-text-B-daily':{supportsImages:true}}}));const choices=await f.api.models(B,'daily',f.signal);assert.equal(choices.length,1);assert.equal(choices[0].classification,'unclassified');assert.equal(f.payloads.length,0);assert.equal((await f.api.run(f.task(),f.signal,async()=>{})).phase,'succeeded');assert.equal(f.payloads[0].body.model,f.task().modelId);assert.deepEqual(f.payloads[0].body.request.contents,[{role:'user',parts:[{text:'Hi'}]}]);
});
test('empty confirmed ordinary directory has its own conversation error',async()=>{
 const f=fixture();f.catalog(()=>({models:{},agentModelSorts:[]}));await assert.rejects(f.api.models(B,'daily',f.signal),/WAKE_MODELS_UNAVAILABLE/);assert.equal(f.payloads.length,0);
});
test('replaced account while catalog is pending cannot accept late data or send',async()=>{
 const f=fixture();let finish,started;const entered=new Promise(resolve=>started=resolve);f.catalog(()=>{started();return new Promise(resolve=>finish=resolve)});const task=f.task(),pending=f.api.run(task,f.signal,async()=>assert.fail('must not send'));await entered;f.accounts[1].capturedAt=new Date(Date.now()+1000).toISOString();finish(catalog(task.modelId));await assert.rejects(pending,/ACCOUNT_CHANGED/);assert.equal(f.payloads.length,0);
});
test('cancelled late ordinary directory cannot become cached membership',async()=>{
 const f=fixture();let finish,started;const entered=new Promise(resolve=>started=resolve);f.catalog(()=>{started();return new Promise(resolve=>finish=resolve)});const abort=new AbortController(),pending=f.api.models(B,'daily',abort.signal);await entered;abort.abort();await assert.rejects(pending,/CANCELLED/);finish(catalog(f.task().modelId));await new Promise(setImmediate);f.catalog(()=>catalog('new-text-only'));assert.deepEqual((await f.api.models(B,'daily',f.signal)).map(x=>x.id),['new-text-only','synthetic-unlisted-model']);assert.equal(f.payloads.length,0);
});
test('raw wrapped response is checked for credential echoes before normalizing public catalog',async()=>{
 const f=fixture();f.catalog(()=>({credentialEcho:'synthetic-bearer-'+B,response:catalog(f.task().modelId)}));await assert.rejects(f.api.models(B,'daily',f.signal),{message:'ACCOUNT_QUOTA_RESPONSE_INVALID'});assert.equal(f.payloads.length,0);
});
