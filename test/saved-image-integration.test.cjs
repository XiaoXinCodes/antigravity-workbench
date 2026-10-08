const test=require('node:test'),assert=require('node:assert/strict'),Module=require('node:module'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {png}=require('./fixtures/png-fixture.cjs');
const realTransport=require('../out/account-quota-transport');
const {CONSUMER_CLIENT_ID_SHA256}=require('../out/account-quota-client');
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',model='gemini-3-pro-image';
async function fixture(t,{failSecond=false,locked=false,recovery=false,modelError}={}){
 const output=await fs.mkdtemp(path.join(os.tmpdir(),'ag-saved-integration-'));t.after(()=>fs.rm(output,{recursive:true,force:true}));
 const accounts=[{id:A,label:'A',expectedEmail:'a@example.test',active:true,hostCurrent:true,hostId:'fixture-host'},{id:B,label:'B',expectedEmail:'b@example.test',active:false,hostCurrent:true,hostId:'fixture-host'}];
 const vault=new Map();for(const a of accounts)vault.set('live-switch.account.v1.'+a.id,JSON.stringify({...a,slots:{keyring:null,keyringState:'unobserved',file:JSON.stringify({auth_method:'consumer',token:{access_token:'fixture-old-'+a.label,refresh_token:'fixture-refresh-'+a.label,expiry:'2020-01-01T00:00:00Z'}})}}));
 const originalA=vault.get('live-switch.account.v1.'+A),events=[],writes=[];let held=false,reads=0,sends=0,exchanges=0;
 const locks={withOperation:async fn=>{if(locked)throw new (require('../out/live-storage').LiveError)('LIVE_OPERATION_OR_RECOVERY_LOCKED');assert.equal(held,false,'must not reenter the host lock');held=true;try{return await fn()}finally{held=false}},hasRecovery:async()=>recovery};
 const context={subscriptions:[],globalState:{get:(_k,d)=>d,update:async()=>{throw Error('CONSENT_MUST_NOT_PERSIST')}},globalStorageUri:{toString:()=> 'fixture-profile'},secrets:{get:async k=>{reads++;return vault.get(k)},store:async(k,v)=>{assert.ok(held);writes.push(k);vault.set(k,v)},delete:async k=>{assert.ok(held);vault.delete(k)}}};
 const original=Module._load,entry=require.resolve('../out/direct-image-vscode');
 Module._load=function(name,...args){
  if(name==='vscode')return{workspace:{isTrusted:true,getConfiguration:()=>({inspect:()=>({globalValue:'daily'})})},UIKind:{Desktop:1},env:{uiKind:1,remoteName:'wsl'},extensions:{getExtension:()=>{throw Error('OFFICIAL_HUB_MUST_NOT_BE_USED_FOR_B')}}};
  if(name==='./native-host')return{nativeHostStatus:()=>({available:true}),resolveCredentialHostId:async()=> 'fixture-host'};
  if(name==='./direct-image-current-token')return{readCurrentOfficialWslToken:async()=>{throw Error('CURRENT_TOKEN_FALLBACK_MUST_NOT_BE_USED_FOR_B')}};
  if(name==='./live-wsl-proof')return{createWslFileGuard:()=>{throw Error('SWITCH_PROCESS_EXCLUSION_MUST_NOT_BE_USED_FOR_B')},createWslReadGuard:()=>{throw Error('CURRENT_HUB_PROOF_MUST_NOT_BE_USED_FOR_B')}};
  if(name==='./live-environment')return{EnvironmentTokenSlots:class{async mode(){return'wsl-file'}async read(){throw Error('OFFICIAL_CREDENTIAL_READ_FORBIDDEN')}async write(){throw Error('OFFICIAL_CREDENTIAL_WRITE_FORBIDDEN')}}};
  if(name==='./account-quota-transport')return{...realTransport,requestAccountQuota:async req=>{assert.ok(held);assert.equal(req.endpoint,'identity');assert.equal(req.accessToken,'fixture-new-B');events.push('identity-B');return{email:'b@example.test',id:'subject-B',verified_email:true}}};
  if(name==='./account-quota-client')return{CONSUMER_CLIENT_ID_SHA256,createConsumerRefreshProvider:()=>({clientIdSha256:CONSUMER_CLIENT_ID_SHA256,exchange:async token=>{assert.ok(held);assert.equal(token,'fixture-refresh-B');exchanges++;return{access_token:'fixture-new-B',refresh_token:'fixture-rotated-B',expires_in:3600}}})};
  if(name==='./direct-image-project-transport')return{resolveEndpointImageProject:async(token,_signal,endpoint)=>{assert.ok(held);assert.equal(token,'fixture-new-B');assert.equal(endpoint,'daily');events.push('project-B');return{projectId:'project-B',endpoint}}};
  if(name==='./saved-image-models')return{readSavedImageModels:async(token,project)=>{assert.ok(held);assert.equal(token,'fixture-new-B');assert.equal(project,'project-B');events.push('models-B');if(modelError)throw Error(modelError);return{imageGenerationModelIds:[model],models:{[model]:{}}}}};
  if(name==='./direct-image-transport')return{sendDirectImage:async(token,body,_signal,_unused,endpoint)=>{assert.ok(held);assert.equal(token,'fixture-new-B');assert.equal(body.project,'project-B');assert.equal(body.model,model);assert.equal(endpoint,'daily');sends++;accounts[0].active=false;accounts[1].active=true;if(failSecond&&sends===2)throw Error('IMAGE_DIRECT_RESOURCE_EXHAUSTED');return{candidates:[{content:{parts:[{inlineData:{mimeType:'image/png',data:png().toString('base64')}}]}}]}}};
  return original.call(this,name,...args);
 };
 let direct;try{delete require.cache[entry];for(const m of ['saved-image-account','account-quota','direct-image-binding'])delete require.cache[require.resolve('../out/'+m)];direct=require(entry).createDirectImageIntegration(context,()=>accounts,{locks,journal:{write:async()=>true,read:async()=>[],dispose(){}}})}finally{Module._load=original;delete require.cache[entry]}
 const request={accountId:B,accountSource:'saved',modelId:model,prompt:'synthetic B scene',aspectRatio:'1:1',count:3,references:[],outputDirectory:output,endpoint:'daily'};
 return{direct,request,events,writes,vault,originalA,get reads(){return reads},get sends(){return sends},get exchanges(){return exchanges}};
}
for(const failSecond of [false,true])test(`saved-account integration: independent refresh/project/catalog/batch ${failSecond?'stops on error':'success'}, no official Hub or credential access`,async t=>{
 const f=await fixture(t,{failSecond}),signal=new AbortController().signal;
 const blocked=await f.direct.readChoices(signal,B);assert.equal(blocked.readiness,'error');assert.equal(blocked.accountMessage,'IMAGE_SAVED_SELECTION_REQUIRED');assert.equal(f.reads,0);assert.equal(f.sends,0);
 f.direct.selectSavedAccount(B);const choices=await f.direct.readChoices(signal,B);assert.equal(choices.readiness,'ready');assert.deepEqual(choices.models.map(x=>x.id),[model]);
 const result=await f.direct.run(f.request,signal,()=>{});assert.equal(result.batch.outcome,failSecond?'partial':'complete');assert.equal(result.images.length,failSecond?1:3);assert.ok(result.images.every(x=>x.accountId===B));
 assert.equal(f.sends,failSecond?2:3);assert.equal(f.exchanges,1);assert.equal(f.events.filter(x=>x==='models-B').length,1);assert.equal(f.events.filter(x=>x==='project-B').length,1);
 assert.equal(f.vault.get('live-switch.account.v1.'+A),f.originalA);assert.ok(f.writes.every(k=>k.endsWith(B)));assert.equal(JSON.parse(JSON.parse(f.vault.get('live-switch.account.v1.'+B)).slots.file).token.refresh_token,'fixture-rotated-B');
});


test('saved image check distinguishes startup operation contention from recovery locks',async t=>{
 for(const recovery of [false,true]){
  const f=await fixture(t,{locked:true,recovery});f.direct.selectSavedAccount(B);const choices=await f.direct.readChoices(new AbortController().signal,B);
  assert.equal(choices.accountMessage,recovery?'IMAGE_ACCOUNT_RECOVERY_PENDING':'IMAGE_ACCOUNT_INITIALIZING');assert.equal(f.reads,0);assert.equal(f.exchanges,0);assert.equal(f.sends,0);
 }
});
test('temporary model failures survive the real saved-account refresh and classification path',async t=>{
 const f=await fixture(t,{modelError:'IMAGE_SAVED_MODELS_TRANSIENT'});f.direct.selectSavedAccount(B);const choices=await f.direct.readChoices(new AbortController().signal,B);
 assert.equal(choices.accountMessage,'IMAGE_SAVED_MODELS_TRANSIENT');assert.equal(f.exchanges,1);assert.equal(f.sends,0);assert.equal(f.vault.get('live-switch.account.v1.'+A),f.originalA);
});
