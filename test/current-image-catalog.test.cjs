const test=require('node:test'),assert=require('node:assert/strict'),Module=require('node:module'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {catalogError}=require('../out/model-catalog-error'),{DebugRecorder,installDebugRecorder}=require('../out/debug-events'),{png}=require('./fixtures/png-fixture.cjs');
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',model='synthetic-future-image';
async function fixture(t){
 const output=await fs.mkdtemp(path.join(os.tmpdir(),'ag-current-catalog-'));t.after(()=>fs.rm(output,{recursive:true,force:true}));
 const accounts=[{id:A,label:'Synthetic A',expectedEmail:'synthetic-a@example.test',hostCurrent:true,active:true,capturedAt:'2026-10-11T00:00:00Z'},{id:B,label:'Synthetic B',expectedEmail:'synthetic-b@example.test',hostCurrent:true,active:false}];
 let email=accounts[0].expectedEmail,endpoint='daily',revision='synthetic-revision-1',token='synthetic-token',expiry=Date.now()+3600000,port=9000,held=false,locked=false,recovery=false,raw={imageGenerationModelIds:[model],models:{[model]:{displayName:'Server Future Name'}}},failure,late;
 const calls=[],sends=[],lines=[],log=new DebugRecorder({append:async line=>lines.push(line),readLines:async()=>lines,flush:async()=>{},dispose(){}},{version:'0.1.11',platform:'linux',host:'local'});await log.setEnabled(true);const installed=installDebugRecorder(log);t.after(()=>{installed.dispose();log.dispose()});
 const ext={id:'google.google-antigravity',isActive:true,extensionUri:{toString:()=>'/synthetic'},extensionPath:'/synthetic',extensionKind:1,packageJSON:{version:'synthetic',main:'main.js'},get exports(){return{port,csrfToken:'synthetic-csrf'}}};
 const old=Module._load,entry=require.resolve('../out/direct-image-vscode');Module._load=function(name,...args){
  if(name==='vscode')return{workspace:{isTrusted:true,getConfiguration:()=>({inspect:()=>({globalValue:endpoint})})},UIKind:{Desktop:1},env:{uiKind:1},extensions:{getExtension:()=>ext}};
  if(name==='./native-host')return{nativeHostStatus:()=>({available:true}),resolveCredentialHostId:async()=> 'synthetic-host'};
  if(name==='./live-environment')return{EnvironmentTokenSlots:class{async mode(){return'file'}}};
  if(name==='./live-hub')return{hasOfficialHubApi:()=>true,generation:api=>String(api.port),hubRpc:async(_api,method)=>method==='GetAuthStatus'?{authResult:{hasValidAuth:true}}:{userStatus:{email}}};
  if(name==='./direct-image-binding'){const real=old.call(this,name,...args);return{...real,bindCurrentAccountAccess:async input=>{await input.assertCurrent();const pinned=revision,pinnedEmail=email;return{token,projectId:'synthetic-project',credentialRevision:revision,credentialExpiresAt:expiry,accountId:input.selected.id,endpoint,verify:async()=>{if(pinned!==revision||pinnedEmail!==email)throw Error('IMAGE_DIRECT_ACCOUNT_CHANGED');if(expiry<=Date.now()+5000)throw Error('IMAGE_DIRECT_AUTH_REQUIRED')}}}}}
  if(name==='./saved-image-models')return{readSavedImageModels:async(_token,_project,signal,target)=>{assert.ok(held);calls.push(target);if(late)await late();if(signal.aborted)throw Error('IMAGE_CANCELLED');if(failure)throw failure;return raw}};
  if(name==='./direct-image-transport')return{sendDirectImage:async(_token,body)=>{assert.ok(held);sends.push(body);return{candidates:[{content:{parts:[{inlineData:{mimeType:'image/png',data:png().toString('base64')}}]}}]}}};
  return old.call(this,name,...args);
 };
 let direct;try{delete require.cache[entry];direct=require(entry).createDirectImageIntegration({subscriptions:[],globalState:{get:(_k,d)=>d},globalStorageUri:{toString:()=>'/synthetic-storage'},secrets:{get:async()=>{throw Error('REAL_CREDENTIAL_READ_FORBIDDEN')}}},()=>accounts,{locks:{withOperation:async work=>{if(locked)throw new(require('../out/live-storage').LiveError)('LIVE_OPERATION_OR_RECOVERY_LOCKED');assert.equal(held,false);held=true;try{return await work()}finally{held=false}},hasRecovery:async()=>recovery},journal:{write:async()=>true,read:async()=>[],dispose(){}}})}finally{Module._load=old;delete require.cache[entry]}
 const signal=new AbortController().signal,read=(force=false)=>direct.readChoices(signal,undefined,force),run=()=>direct.run({accountId:accounts.find(a=>a.expectedEmail===email).id,accountSource:'current',endpoint,modelId:model,prompt:'synthetic scene',aspectRatio:'1:1',count:1,references:[],outputDirectory:output},signal,()=>{});
 return{direct,accounts,calls,sends,lines,read,run,signal,set:changes=>{if('endpoint'in changes)endpoint=changes.endpoint;if('revision'in changes)revision=changes.revision;if('token'in changes)token=changes.token;if('expiry'in changes)expiry=changes.expiry;if('port'in changes)port=changes.port;if('email'in changes)email=changes.email;if('raw'in changes)raw=changes.raw;if('failure'in changes)failure=changes.failure;if('locked'in changes)locked=changes.locked;if('recovery'in changes)recovery=changes.recovery;if('late'in changes)late=changes.late}};
}
test('current catalog rebinds exact identity and revision before bounded directory reuse; manual checks and quota bypass it',async t=>{
 const f=await fixture(t),first=await f.read();assert.equal(first.models[0].label,'Server Future Name ('+model+')');const cached=await f.read();assert.equal(f.calls.length,1);assert.equal(cached.catalog.queriedAt,first.catalog.queriedAt);
 await f.read(true);assert.equal(f.calls.length,2);await f.direct.readImageQuota(A,model,f.signal);assert.equal(f.calls.length,3);
});
test('current directory cache expires and rejects reuse after credential revision, token, Hub generation, identity and endpoint changes',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-11T10:00:00Z')});const f=await fixture(t);await f.read();t.mock.timers.tick(300000);await f.read();assert.equal(f.calls.length,2);
 for(const change of [{revision:'revision-2'},{token:'synthetic-token-2'},{port:9001},{endpoint:'production'},{email:f.accounts[1].expectedEmail}]){const before=f.calls.length;f.set(change);const result=await f.read();assert.equal(result.readiness,'ready');assert.equal(f.calls.length,before+1)}
 f.set({expiry:Date.now()});const denied=await f.read();assert.equal(denied.readiness,'error');assert.equal(denied.accountMessage,'IMAGE_DIRECT_AUTH_REQUIRED');assert.equal(f.sends.length,0);
});
test('send always fetches a fresh current directory, rejects removed or disabled models and sends the actual new ID',async t=>{
 const f=await fixture(t);await f.read();f.set({raw:{imageGenerationModelIds:[model],models:{[model]:{disabled:true}}}});await assert.rejects(f.run(),/MODEL_UNVERIFIED/);assert.equal(f.sends.length,0);
 f.set({raw:{imageGenerationModelIds:['synthetic-new-id'],models:{'synthetic-new-id':{}}}});await assert.rejects(f.run(),/MODEL_UNVERIFIED/);assert.equal(f.sends.length,0);
 f.set({raw:{imageGenerationModelIds:[model],models:{[model]:{}}}});const result=await f.run();assert.equal(result.batch.outcome,'complete');assert.equal(f.calls.length,4);assert.equal(f.sends.length,1);assert.equal(f.sends[0].model,model);assert.equal(f.sends[0].project,'synthetic-project');assert.ok(f.sends[0].request.contents);
});
test('current lock contention is reported before catalog transport, and recovery remains distinct',async t=>{
 const f=await fixture(t);f.set({locked:true});let result=await f.read();assert.equal(result.accountMessage,'IMAGE_ACCOUNT_INITIALIZING');assert.deepEqual(result.failure,{catalogStage:'lock',catalogFailure:'lock'});assert.equal(f.calls.length,0);
 f.set({recovery:true});result=await f.read();assert.equal(result.accountMessage,'IMAGE_ACCOUNT_RECOVERY_PENDING');assert.equal(f.calls.length,0);f.set({locked:false,recovery:false});assert.equal((await f.read()).readiness,'ready');
 await new Promise(setImmediate);const rows=f.lines.map(JSON.parse).filter(r=>r.phase==='result');assert.ok(rows.some(r=>r.operation==='image.catalog'&&r.data.catalogFailure==='lock'));assert.ok(rows.some(r=>r.data.code==='IMAGE_ACCOUNT_RECOVERY_PENDING'));
});
test('catalog HTTP, network, TLS and parse diagnostics are fixed fields on a separate operation; refresh can recover',async t=>{
 const f=await fixture(t);
 for(const [stage,kind,status]of [['transport','http',400],['transport','network'],['transport','tls'],['parse','parse',200]]){f.set({failure:catalogError('IMAGE_SAVED_MODELS_FAILED',stage,kind,status)});const result=await f.read(true);assert.equal(result.failure.catalogFailure,kind);assert.equal(result.failure.httpStatus,status);assert.equal(f.sends.length,0)}
 f.set({failure:undefined});assert.equal((await f.read(true)).readiness,'ready');await new Promise(setImmediate);assert.doesNotMatch(f.lines.join('\n'),/synthetic-(?:token|csrf|project)|example\.test|synthetic scene|Server Future Name/);assert.ok(f.lines.map(JSON.parse).every(row=>row.operation==='image.catalog'));assert.ok(f.lines.map(JSON.parse).some(row=>row.data?.httpStatus===400));
});
test('late current catalog response cannot authorize a new identity, revision or endpoint',async t=>{
 for(const change of [{email:'synthetic-b@example.test'},{revision:'replacement'},{endpoint:'production'}]){const f=await fixture(t);let release;f.set({late:()=>new Promise(r=>release=r)});const pending=f.read();for(let i=0;i<50&&!release;i++)await new Promise(setImmediate);assert.ok(release);f.set(change);release();const result=await pending;assert.equal(result.readiness,'error');assert.equal(result.models.length,0);assert.equal(f.sends.length,0)}
});

test('current image metadata distinguishes missing, invalid, empty and disabled without any generation probe',async t=>{
 const f=await fixture(t);const raw={models:{[model]:{displayName:'Raw server name',supportsImages:true}}};
 for(const [payload,code,readiness]of [[raw,'IMAGE_CATALOG_LIST_MISSING','error'],[{...raw,imageGenerationModelIds:null},'IMAGE_CATALOG_LIST_INVALID','error'],[{...raw,imageGenerationModelIds:[]},'IMAGE_CATALOG_LIST_EMPTY','ready'],[{models:{[model]:{disabled:true}},imageGenerationModelIds:[model]},'IMAGE_CATALOG_LIST_UNAVAILABLE','ready']]){
  f.set({raw:payload});const result=await f.read(true);assert.equal(result.accountMessage,code);assert.equal(result.readiness,readiness);assert.deepEqual(result.models,[]);assert.equal(f.sends.length,0);
 }
 f.set({raw:{...raw,imageGenerationModelIds:[model]}});assert.equal((await f.read(true)).models[0].id,model);assert.equal(f.sends.length,0);
});
