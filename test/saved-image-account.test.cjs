const test=require('node:test'),assert=require('node:assert/strict');
const {SavedImageAccounts,imageAccountRevision}=require('../out/saved-image-account');
const {SavedAccountQuotaClient}=require('../out/account-quota');
const {LiveSwitchService,ACCOUNT_PREFIX,QUOTA_PENDING_PREFIX,QUOTA_REFRESH_PREFIX}=require('../out/live-switch');
const {CONSUMER_CLIENT_ID_SHA256}=require('../out/account-quota-client');
const {imageModelsFromCatalog}=require('../out/direct-image-binding');
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const NOW=Date.parse('2026-10-04T10:00:00Z'),ma='gemini-3.1-flash-image',mb='gemini-3-pro-image';
const tick=()=>new Promise(setImmediate);
function fixture({expired=false}={}){
 let now=NOW,held=false,reads=0,exchanges=0;const events=[],vault=new Map(),tokens=new Map();
 const accounts=[A,B].map((id,index)=>({id,label:index?'B':'A',expectedEmail:index?'b@example.test':'a@example.test',hostId:'host-fixture',hostCurrent:true,active:!index,capturedAt:new Date(NOW).toISOString(),identitySource:'hub'}));
 for(const a of accounts){const access='synthetic-access-'+a.label,refresh='synthetic-refresh-'+a.label;tokens.set(access,a.expectedEmail);tokens.set('synthetic-new-'+a.label,a.expectedEmail);
  const stored={auth_method:'consumer',token:{access_token:access,refresh_token:refresh,expiry:new Date(NOW+(expired?-1000:3600000)).toISOString()}};
  vault.set(ACCOUNT_PREFIX+a.id,JSON.stringify({...a,slots:{keyring:null,file:JSON.stringify(stored),keyringState:'unobserved'}}));}
 const service=new LiveSwitchService({get:async k=>vault.get(k),store:async(k,v)=>{events.push(['write',k]);vault.set(k,v)},delete:async k=>vault.delete(k)},
  {read:async()=>{throw Error('OFFICIAL_READ_FORBIDDEN')},write:async()=>{throw Error('OFFICIAL_WRITE_FORBIDDEN')}},'host-fixture');
 const provider={clientIdSha256:CONSUMER_CLIENT_ID_SHA256,exchange:async token=>{exchanges++;const label=token.endsWith('A')?'A':'B';events.push(['refresh',label]);return{access_token:'synthetic-new-'+label,refresh_token:'synthetic-rotated-'+label,expires_in:3600}}};
 const deps={accounts:()=>accounts,now:()=>now,client:new SavedAccountQuotaClient(async r=>{assert.equal(r.endpoint,'identity');const email=tokens.get(r.accessToken);assert.ok(email);return{email,id:'subject-'+email[0],verified_email:true}},()=>now),
  withOperation:async fn=>{assert.equal(held,false);held=true;try{return await fn()}finally{held=false}},
  store:async()=>({
   load:async id=>{assert.equal(held,true);reads++;const account=await service.account(id);return{account,revision:imageAccountRevision(vault.get(ACCOUNT_PREFIX+id))}},
   verify:async(id,revision,allowPending)=>{const raw=vault.get(ACCOUNT_PREFIX+id);if(!raw||imageAccountRevision(raw)!==revision)throw Error('IMAGE_SAVED_ACCOUNT_CHANGED');if(!allowPending&&(vault.has(QUOTA_PENDING_PREFIX+id)||vault.has(QUOTA_REFRESH_PREFIX+id)))throw Error('IMAGE_SAVED_AUTH_PENDING')},
   refresh:(id,present)=>{let pending;return{provider,loadPending:async expected=>pending=await service.pendingQuotaRefresh(id,expected),stage:async(expected,next)=>{present();await service.stageQuotaRefresh(id,expected,next,pending);pending=next},commit:async(expected,next)=>{present();await service.commitQuotaRefresh(id,expected,next);pending=undefined}}},
  }),
  project:async(token,_signal,endpoint)=>{const email=tokens.get(token);events.push(['project',email,endpoint]);return{projectId:'project-'+email[0]+'-'+endpoint,endpoint}},
  models:async(token,project,_signal,endpoint)=>{const email=tokens.get(token);assert.equal(project,'project-'+email[0]+'-'+endpoint);events.push(['models',email,endpoint]);const model=email[0]==='a'?ma:mb;return{imageGenerationModelIds:[model],models:{[model]:{}}}},parseModels:imageModelsFromCatalog};
 const engine=new SavedImageAccounts(deps);const signal=new AbortController().signal;
 return{engine,deps,signal,accounts,vault,events,provider,service,get reads(){return reads},get exchanges(){return exchanges},setNow:n=>{now=n}};
}
test('scheduled requests can disable refresh for current login while saved logins keep the existing rotation transaction',async()=>{
 const f=fixture({expired:true});f.deps.refreshAllowed=a=>!a.active;const engine=new SavedImageAccounts(f.deps);engine.selectForWindow(A);engine.selectForWindow(B);
 await assert.rejects(engine.choices(A,f.signal,'daily'),/REAUTH_REQUIRED/);assert.equal(f.exchanges,0);
 await engine.choices(B,f.signal,'daily');assert.equal(f.exchanges,1);assert.equal(f.vault.has(QUOTA_PENDING_PREFIX+B),false);assert.equal(f.vault.has(QUOTA_REFRESH_PREFIX+B),false);
 assert.ok(f.events.every(event=>event[0]!=='write'||event[1].startsWith('live-switch.')));
});
test('unselected saved accounts remain unread until an explicit controller selection',async()=>{
 const f=fixture();await assert.rejects(f.engine.choices(B,f.signal,'daily'),/SELECTION_REQUIRED/);assert.equal(f.reads,0);assert.deepEqual(f.events,[]);
 f.engine.selectForWindow(B);assert.equal(f.engine.isSelected(B),true);assert.equal(f.engine.isSelected(A),false);
 const second=new SavedImageAccounts(f.deps);assert.equal(second.isSelected(B),false);
});
test('A/B concurrent choices and project catalogs remain account and endpoint partitioned',async()=>{
 const f=fixture();f.engine.selectForWindow(A);f.engine.selectForWindow(B);
 const [a,b]=await Promise.all([f.engine.choices(A,f.signal,'daily'),f.engine.choices(B,f.signal,'daily')]);assert.deepEqual(a.map(x=>x.id),[ma]);assert.deepEqual(b.map(x=>x.id),[mb]);
 await f.engine.choices(A,f.signal,'daily');assert.equal(f.events.filter(x=>x[0]==='models').length,2);
 const bound=await f.engine.bind(B,mb,f.signal,'production');assert.equal(bound.accountId,B);assert.equal(bound.projectId,'project-b-production');assert.equal(bound.token,'synthetic-access-B');
 assert.equal(f.events.filter(x=>x[0]==='models').length,3);assert.equal(f.exchanges,0);
});
test('same-account queued expired lookups re-read after lock and rotate once, only selected encrypted copy',async()=>{
 const f=fixture({expired:true}),a=f.vault.get(ACCOUNT_PREFIX+A);f.engine.selectForWindow(B);
 await Promise.all([f.engine.choices(B,f.signal,'daily'),f.engine.choices(B,f.signal,'daily')]);assert.equal(f.exchanges,1);assert.equal(f.vault.get(ACCOUNT_PREFIX+A),a);
 const b=await f.service.account(B);assert.equal(JSON.parse(b.slots.file).token.refresh_token,'synthetic-rotated-B');assert.equal(f.vault.has(QUOTA_PENDING_PREFIX+B),false);
 assert.equal(f.events.filter(x=>x[0]==='models').length,1);
});
test('changed encrypted revision invalidates a previously prepared account and metadata cache',async()=>{
 const f=fixture();f.engine.selectForWindow(B);const bound=await f.engine.bind(B,mb,f.signal,'daily');
 const b=JSON.parse(f.vault.get(ACCOUNT_PREFIX+B));b.label='external change';f.vault.set(ACCOUNT_PREFIX+B,JSON.stringify(b));
 await assert.rejects(bound.verify(f.signal),/ACCOUNT_CHANGED/);await f.engine.choices(B,f.signal,'daily');assert.equal(f.events.filter(x=>x[0]==='models').length,2);
});
test('an external replacement during metadata cannot be accepted as the bound credential revision',async()=>{
 const f=fixture();f.engine.selectForWindow(B);const models=f.deps.models;f.deps.models=async(...args)=>{const response=await models(...args);const b=JSON.parse(f.vault.get(ACCOUNT_PREFIX+B));b.slots.file=b.slots.file.replace('synthetic-access-B','synthetic-other');f.vault.set(ACCOUNT_PREFIX+B,JSON.stringify(b));return response};
 await assert.rejects(f.engine.bind(B,mb,f.signal,'daily'),/ACCOUNT_CHANGED/);
});
test('official active-account changes neither invalidate nor redirect a frozen saved binding',async()=>{
 const f=fixture();f.engine.selectForWindow(B);const bound=await f.engine.bind(B,mb,f.signal,'daily');f.accounts[0].active=false;f.accounts[1].active=true;
 await bound.verify(f.signal);assert.equal(bound.accountId,B);assert.equal(bound.token,'synthetic-access-B');
});
test('removed account cannot send, gain automatic replacement or regain an invalidated selection',async()=>{
 const f=fixture();f.engine.selectForWindow(B);const bound=await f.engine.bind(B,mb,f.signal,'daily');const removed=f.accounts.pop();f.vault.delete(ACCOUNT_PREFIX+B);
 await assert.rejects(bound.verify(f.signal),/REMOVED/);f.engine.forgetMissing();f.accounts.push(removed);assert.equal(f.engine.isSelected(B),false);
});
test('removal during a refresh cannot resurrect a deleted credential or commit late material',async()=>{
 const f=fixture({expired:true});f.engine.selectForWindow(B);let finish;f.provider.exchange=()=>new Promise(r=>finish=r);
 const pending=f.engine.choices(B,f.signal,'daily');await tick();f.accounts.pop();f.vault.delete(ACCOUNT_PREFIX+B);finish({access_token:'synthetic-new-B',refresh_token:'synthetic-rotated-B',expires_in:3600});
 await assert.rejects(pending);assert.equal(f.vault.has(ACCOUNT_PREFIX+B),false);assert.equal(f.vault.has(QUOTA_PENDING_PREFIX+B),false);
});
test('cancel during refresh finishes bounded safe rotation, then suppresses metadata and late UI data',async()=>{
 const f=fixture({expired:true});f.engine.selectForWindow(B);let finish,refreshSignal;const cancel=new AbortController();
 f.provider.exchange=(_token,signal)=>{refreshSignal=signal;return new Promise(r=>finish=r)};
 const pending=f.engine.choices(B,cancel.signal,'daily');await tick();cancel.abort();assert.equal(refreshSignal.aborted,false);
 finish({access_token:'synthetic-new-B',refresh_token:'synthetic-rotated-B',expires_in:3600});await assert.rejects(pending,/CANCELLED/);
 assert.equal(JSON.parse((await f.service.account(B)).slots.file).token.refresh_token,'synthetic-rotated-B');assert.equal(f.events.some(x=>x[0]==='models'),false);
});
test('cancelled metadata late response never populates reusable cache',async()=>{
 const f=fixture();f.engine.selectForWindow(B);let finish;const original=f.deps.models;f.deps.models=()=>new Promise(r=>finish=r);const cancel=new AbortController();
 const pending=f.engine.choices(B,cancel.signal,'daily');await tick();cancel.abort();await assert.rejects(pending,/CANCELLED/);finish({imageGenerationModelIds:[mb],models:{[mb]:{}}});await tick();
 f.deps.models=original;await f.engine.choices(B,f.signal,'daily');assert.equal(f.events.filter(x=>x[0]==='project').length,2);
});
test('unknown catalog, project mismatch, disabled model and service errors never borrow A or fall back',async()=>{
 for(const kind of ['empty','disabled','project','error']){const f=fixture();f.engine.selectForWindow(B);
  if(kind==='project')f.deps.project=async()=>({projectId:'project-b',endpoint:'production'});
  else f.deps.models=async()=>{if(kind==='error')throw Error('IMAGE_DIRECT_RESOURCE_EXHAUSTED');return kind==='empty'?{}:{imageGenerationModelIds:[mb],models:{[mb]:{disabled:true}}}};
  await assert.rejects(f.engine.bind(B,ma,f.signal,'daily'));assert.equal(f.exchanges,0);assert.equal(f.events.some(x=>x[1]==='a@example.test'),false);
 }
});
test('cache expires with time and bound token expiry stops later batch requests',async()=>{
 const f=fixture();f.engine.selectForWindow(B);const bound=await f.engine.bind(B,mb,f.signal,'daily');f.setNow(NOW+301000);await f.engine.choices(B,f.signal,'daily');assert.equal(f.events.filter(x=>x[0]==='models').length,2);
 f.setNow(NOW+3600000);await assert.rejects(bound.verify(f.signal),/AUTH_EXPIRED/);
});
test('explicit recheck bypasses a valid catalog cache and failed recheck cannot reuse stale model data',async()=>{
 const f=fixture();f.engine.selectForWindow(B);await f.engine.choices(B,f.signal,'daily');await f.engine.choices(B,f.signal,'daily',true);assert.equal(f.events.filter(x=>x[0]==='models').length,2);
 const original=f.deps.models;f.deps.models=async()=>{throw Error('IMAGE_SAVED_MODELS_FORBIDDEN')};await assert.rejects(f.engine.choices(B,f.signal,'daily',true));f.deps.models=original;
 await f.engine.bind(B,mb,f.signal,'daily');assert.equal(f.events.filter(x=>x[0]==='models').length,3);
});
test('reselecting an unchanged account reuses bounded cached checks without another token exchange',async()=>{
 const f=fixture({expired:true});f.engine.selectForWindow(B);await f.engine.choices(B,f.signal,'daily');
 f.engine.selectForWindow(A);await f.engine.choices(A,f.signal,'daily');
 const before=f.events.filter(x=>x[0]==='models').length,exchanges=f.exchanges;
 f.engine.selectForWindow(B);await f.engine.choices(B,f.signal,'daily');
 assert.equal(f.events.filter(x=>x[0]==='models').length,before);assert.equal(f.exchanges,exchanges);
 f.setNow(NOW+301000);await f.engine.choices(B,f.signal,'daily');assert.equal(f.events.filter(x=>x[0]==='models').length,before+1);
});
test('revoked authorization stops at reauthentication guidance without a new grant or model request',async()=>{
 const {LiveError}=require('../out/live-storage'),f=fixture({expired:true});let exchanges=0;
 const original=f.vault.get(ACCOUNT_PREFIX+B);f.provider.exchange=async()=>{exchanges++;throw new LiveError('ACCOUNT_QUOTA_REAUTH_REQUIRED')};
 f.engine.selectForWindow(B);await assert.rejects(f.engine.choices(B,f.signal,'daily'),/REAUTH_REQUIRED/);
 assert.equal(exchanges,1);assert.equal(f.vault.get(ACCOUNT_PREFIX+B),original);assert.equal(f.events.some(x=>['models','project'].includes(x[0])),false);
});


test('saved catalog binds new IDs unchanged and refuses a nonmember after endpoint recheck',async()=>{
 const f=fixture(),id='gemini-nano-banana-2.1';f.engine.selectForWindow(B);f.deps.models=async()=>({imageGenerationModelIds:[id],models:{[id]:{},'text-only':{}}});
 const bound=await f.engine.bind(B,id,f.signal,'daily');assert.equal(bound.modelId,id);assert.equal(bound.accountId,B);await assert.rejects(f.engine.bind(B,'text-only',f.signal,'daily'),/MODEL_UNVERIFIED/);
 f.deps.models=async()=>({imageGenerationModelIds:[mb],models:{[mb]:{}}});await assert.rejects(f.engine.bind(B,id,f.signal,'production'),/MODEL_UNVERIFIED/);
});
test('diagnostic bypasses cache without changing explicit selections or caching disabled/empty catalogs',async()=>{
 const f=fixture();f.engine.selectForWindow(B);await f.engine.choices(B,f.signal,'daily');const raw=f.vault.get(ACCOUNT_PREFIX+B);let checks=0;
 f.deps.models=async()=>({imageGenerationModelIds:[mb],models:{[mb]:{disabled:true}}});const report=await f.engine.diagnoseCatalog(B,f.signal,'daily',async()=>{checks++});
 assert.equal(report.status,'queried');assert.equal(report.imageModels[0].disabled,true);assert.ok(checks>=3);assert.equal(f.vault.get(ACCOUNT_PREFIX+B),raw);assert.equal(f.engine.isSelected(B),true);
 f.deps.models=async()=>({imageGenerationModelIds:[],models:{}});assert.equal((await f.engine.diagnoseCatalog(A,f.signal,'daily',async()=>{})).imageModels.length,0);assert.equal(f.engine.isSelected(A),false);
 await assert.rejects(f.engine.choices(A,f.signal,'daily'),/SELECTION_REQUIRED/);assert.equal((await f.engine.choices(B,f.signal,'daily'))[0].id,mb);
});
test('diagnostic stops before project/catalog when same-current-account guard fails',async()=>{
 const f=fixture();await assert.rejects(f.engine.diagnoseCatalog(A,f.signal,'daily',async()=>{throw Error('IMAGE_DIRECT_ACCOUNT_CHANGED')}),/ACCOUNT_CHANGED/);assert.equal(f.events.length,0);assert.equal(f.reads,0);
});


test('diagnostic rechecks matching identity after a queued host lock before reading saved credentials',async()=>{
 const f=fixture();let checks=0;await assert.rejects(f.engine.diagnoseCatalog(A,f.signal,'daily',async()=>{if(++checks===2)throw Error('IMAGE_DIRECT_ACCOUNT_CHANGED')}),/ACCOUNT_CHANGED/);assert.equal(checks,2);assert.equal(f.reads,0);assert.equal(f.events.length,0);
});

test('image quota always bypasses catalog cache, binds selected model, and preserves server zero',async()=>{
 const f=fixture();f.engine.selectForWindow(B);await f.engine.choices(B,f.signal,'daily');
 const original=f.deps.models;
 f.deps.models=async(...args)=>{const value=await original(...args);value.models[mb].quotaInfo={remainingFraction:0,resetTime:'2026-10-08T00:00:00Z'};return value};
 const first=await f.engine.quota(B,mb,f.signal,'daily'),second=await f.engine.quota(B,mb,f.signal,'daily');
 assert.equal(first.accountId,B);assert.equal(first.modelId,mb);assert.equal(first.endpoint,'daily');assert.equal(first.remainingFraction,0);assert.equal(second.remainingFraction,0);
 assert.equal(f.events.filter(x=>x[0]==='models').length,3);assert.equal(f.exchanges,0);
 assert.equal(first.queriedAt,new Date(NOW).toISOString());assert.doesNotMatch(JSON.stringify(first),/synthetic-access|project-/);
 await assert.rejects(f.engine.quota(B,ma,f.signal,'daily'),/MODEL_UNVERIFIED/);
});

test('full recovery binding rechecks exact chosen model quota and rejects 99.6%, unknown or stale before any send',async()=>{
 const f=fixture();let remaining=.996;f.deps.models=async()=>({imageGenerationModelIds:[mb],models:{[mb]:{quotaInfo:{remainingFraction:remaining}},other:{quotaInfo:{remainingFraction:1}}}});f.engine.selectForWindow(B);
 await f.engine.choices(B,f.signal,'daily',true);await assert.rejects(f.engine.bind(B,mb,f.signal,'daily',true),/NOT_FULL/);remaining=null;await f.engine.choices(B,f.signal,'daily',true);await assert.rejects(f.engine.bind(B,mb,f.signal,'daily',true),/NOT_FULL/);
 remaining=1;await f.engine.choices(B,f.signal,'daily',true);assert.equal((await f.engine.bind(B,mb,f.signal,'daily',true)).accountId,B);f.setNow(NOW+60000);await assert.rejects(f.engine.bind(B,mb,f.signal,'daily',true),/NOT_FULL/);assert.equal(f.exchanges,0);
});

test('explicit quota observation does not select an image account; refresh guard protects current saved grant while other grants reuse locks',async()=>{
 const f=fixture({expired:true});f.deps.refreshAllowed=a=>!a.active;const engine=new SavedImageAccounts(f.deps);
 await assert.rejects(engine.observeQuota(A,ma,f.signal,'daily',async()=>{}),/REAUTH_REQUIRED/);assert.equal(f.exchanges,0);assert.equal(engine.isSelected(A),false);
 const snapshot=await engine.observeQuota(B,mb,f.signal,'daily',async()=>{});assert.equal(snapshot.modelId,mb);assert.equal(snapshot.remainingFraction,null);assert.equal(f.exchanges,1);assert.equal(engine.isSelected(B),false);assert.equal(f.vault.has(QUOTA_PENDING_PREFIX+B),false);
});
