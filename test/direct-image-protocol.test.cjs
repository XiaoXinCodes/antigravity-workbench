const {test}=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const Module=require('node:module');
const vm=require('node:vm');
const fixture=require('./fixtures/direct-image-wire.json');
const {png}=require('./fixtures/png-fixture.cjs');
const {imageEndpoint,imageEndpointHost,imageRequestEnvelope}=require('../out/direct-image-protocol');
const {bindSavedImageAccount,currentImageModels}=require('../out/direct-image-binding');
const {generateDirectImage}=require('../out/direct-image-core');
const {resolveEndpointImageProject}=require('../out/direct-image-project-transport');
const {sendDirectImage}=require('../out/direct-image-transport');
const {imageHttpFailure,formatImageFailure}=require('../out/direct-image-http-error');
const {sanitizeDebugData}=require('../out/debug-events');
const {captureRecentImageFailure,readRecentImageFailure}=require('../out/recent-image-failure');

const id='12345678-1234-4123-8123-123456789abc',email='fixture@example.test',token='fixture.bearer.only';
const model = currentImageModels({authResult:{hasValidAuth:true}}, {userStatus:{email}}, {response:{imageGenerationModelIds:['gemini-3.1-flash-image'], models:{'gemini-3.1-flash-image':{}}}}, email)[0];
const selected={id,label:'Fixture',expectedEmail:email,active:true,hostCurrent:true};
const stored=JSON.stringify({id,expectedEmail:email,hostId:'fixture-host',slots:{file:null,
 keyring:JSON.stringify({project_id:'stale-project-with-no-endpoint',token:{access_token:token,
 refresh_token:'fixture.refresh.never.used',expiry:'2099-01-01T00:00:00Z'}})}});
const vault={get:async key=>key===`live-switch.account.v1.${id}`?stored:undefined};
const input={vault,selected,hostId:'fixture-host',model,assertCurrent:async()=>{},verifyIdentity:async actual=>{
 assert.equal(actual,token);return {email};}};
const request=outputDirectory=>({accountId:id,modelId:model.id,prompt:'A red circle. 红圆。',aspectRatio:'1:1',
 references:[],outputDirectory,size:'auto',quality:'auto',count:1});
const success={response:{candidates:[{content:{parts:[{inlineData:{mimeType:'image/png',data:png().toString('base64')}}]}}]}};
function fakeHttps(calls,{imageStatus=200,projectStatus=200,networkError=false}={}){
 return (options,receive)=>{
  const req=new EventEmitter();req.destroy=()=>{};
  req.end=wire=>queueMicrotask(()=>{
   calls.push({options,wire,body:JSON.parse(wire)});
   if(networkError){req.emit('error',new Error('synthetic network failure'));return;}
   const metadata=options.path==='/v1internal:loadCodeAssist';
   const res=new EventEmitter();res.destroy=()=>{};res.statusCode=metadata?projectStatus:imageStatus;
   res.headers={'content-type':'application/json','location':'https://do-not-follow.example.test','retry-after':'1'};
   receive(res);
   const payload=res.statusCode===200?(metadata?{cloudaicompanionProject:fixture.image.body.project}:success):
    {error:{status:'RESOURCE_EXHAUSTED',message:'The model has insufficient capacity.'}};
   res.emit('data',Buffer.from(JSON.stringify(payload)));res.emit('end');
  });return req;
 };
}
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

for(const endpoint of ['production','daily'])test(`final ${endpoint} wire uses one endpoint-bound project and exactly one image request`,async()=>{
 const output=await fs.mkdtemp(path.join(os.tmpdir(),'ag-protocol-'));
 const calls=[],http=fakeHttps(calls),signal=new AbortController().signal;
 try{
  const result=await generateDirectImage({...request(output),endpoint},signal,{
   bind:()=>bindSavedImageAccount({...input,endpoint,signal,
    resolveEndpointProject:(bearer,s,target)=>resolveEndpointImageProject(bearer,s,target,http)}),
   send:(bearer,body,s,target)=>sendDirectImage(bearer,body,s,http,target),
  });
  assert.equal(result.images.length,1);assert.deepEqual(await fs.readFile(result.images[0].file),png());
  assert.equal(calls.length,2);assert.deepEqual(calls.map(c=>c.options.path),[fixture.project.path,fixture.image.path]);
  for(const call of calls){
   for(const key of ['protocol','port','method','agent','rejectUnauthorized'])assert.equal(call.options[key],fixture[key]);
   assert.equal(call.options.hostname,fixture.hosts[endpoint]);
   assert.equal(call.options.headers.Authorization,`Bearer ${token}`);
   assert.equal(call.options.headers['User-Agent'],fixture.client.httpUserAgent);
   assert.equal(call.options.headers['Content-Length'],Buffer.byteLength(call.wire));
   assert.deepEqual(Object.keys(call.options.headers).sort(),['Accept','Authorization','Content-Length','Content-Type','User-Agent']);
  }
  assert.deepEqual(calls[0].body,fixture.project.body);
  const body=calls[1].body,labels=body.request.labels;
  assert.match(body.requestId,/^agent-/);assert.match(body.requestId.slice(6),uuid);assert.match(labels.trajectory_id,uuid);
  assert.notEqual(body.requestId.slice(6),labels.trajectory_id);assert.equal(labels.request_id,`${labels.trajectory_id}-0`);
  body.requestId=fixture.image.body.requestId;labels.trajectory_id=fixture.image.body.request.labels.trajectory_id;
  labels.request_id=fixture.image.body.request.labels.request_id;
  assert.deepEqual(body,fixture.image.body);assert.equal(Object.hasOwn(body,'userAgent'),false);
  assert.deepEqual(Object.keys(body),['project','requestId','request','model','requestType']);
  assert.doesNotMatch(calls[1].wire,/stale-project|fixture\.bearer|fixture\.refresh|safetySettings|thinkingConfig|maxOutputTokens|vivid|hub\/|aidev_client/);
  assert.equal(result.conversationId,null);assert.deepEqual(Object.keys(vault),['get']);
 }finally{await fs.rm(output,{recursive:true,force:true});}
});

test('every HTTP failure, redirect and network failure stops after a single send without endpoint fallback',async()=>{
 for(const opts of [{imageStatus:429},{imageStatus:503},{imageStatus:302},{networkError:true}]){
  const calls=[];await assert.rejects(sendDirectImage(token,fixture.image.body,new AbortController().signal,fakeHttps(calls,opts),'daily'));
  assert.equal(calls.length,1);assert.equal(calls[0].options.hostname,fixture.hosts.daily);
 }
 for(const projectStatus of [302,403,429,503]){
  const calls=[];await assert.rejects(resolveEndpointImageProject(token,new AbortController().signal,'daily',fakeHttps(calls,{projectStatus})));
  assert.equal(calls.length,1);assert.equal(calls[0].options.path,fixture.project.path);
 }
});

test('explicit endpoint rejects missing or mismatched provenance and never reuses an unscoped saved project',async()=>{
 const signal=new AbortController().signal;
 await assert.rejects(bindSavedImageAccount({...input,signal,endpoint:'daily'}),{message:'IMAGE_DIRECT_PROJECT_ENDPOINT_MISMATCH'});
 for(const resolved of [{endpoint:'production',projectId:'other-environment'},{endpoint:'daily',projectId:'bad\u0000project'}]){
  let lookups=0;await assert.rejects(bindSavedImageAccount({...input,signal,endpoint:'daily',
   resolveEndpointProject:async()=>{lookups++;return resolved;}}),{message:resolved.endpoint==='daily'?'IMAGE_DIRECT_PROJECT_LOOKUP_INVALID':'IMAGE_DIRECT_PROJECT_ENDPOINT_MISMATCH'});
  assert.equal(lookups,1);
 }
 await assert.rejects(bindSavedImageAccount({...input,signal,endpoint:'daily',resolveEndpointProject:async()=>{throw Error('PRIVATE_SENTINEL');}}),{message:'IMAGE_DIRECT_PROJECT_LOOKUP_FAILED'});
 let lookups=0;
 const bind=endpoint=>bindSavedImageAccount({...input,signal,endpoint,resolveEndpointProject:async(_token,_signal,target)=>{
  lookups++;return {endpoint:target,projectId:`from-${target}`};}});
 const daily=await bind('daily'),production=await bind('production');
 assert.equal(lookups,2);assert.equal(daily.projectId,'from-daily');assert.equal(production.projectId,'from-production');
 assert.equal(daily.projectSource,'loadCodeAssist');assert.equal(production.endpoint,'production');
});

test('endpoints are fixed enums, not URLs, proxy targets, arbitrary objects or workspace overrides',async()=>{
 for(const value of ['sandbox','https://attacker.test',null,{},'DAILY','daily\n']){
  assert.throws(()=>imageEndpoint(value),{message:'IMAGE_DIRECT_ENDPOINT_INVALID'});
  let calls=0;await assert.rejects(sendDirectImage(token,{},new AbortController().signal,()=>{calls++;},value),{message:'IMAGE_DIRECT_ENDPOINT_INVALID'});assert.equal(calls,0);
 }
 assert.equal(imageEndpoint(), 'daily');
 const category=require('../package.json').contributes.configuration,setting=category.properties['antigravityAccounts.images.endpoint'];
 assert.equal(category.title,'Antigravity Workbench');assert.match(require('../package.nls.zh-cn.json')[setting.description.slice(1,-1)],/高级排障/);assert.equal(setting.default,'daily');assert.equal(setting.scope,'application');
 assert.deepEqual(setting.enum,['production','daily']);assert.equal(setting.enumDescriptions.length,setting.enum.length);
 assert.equal(require('../out/direct-image-protocol').IMAGE_HTTP_USER_AGENT, `Antigravity-Workbench/${require('../package.json').version}`);assert.equal(imageEndpointHost('daily'),fixture.hosts.daily);
 const entry=require.resolve('../out/direct-image-vscode'),original=Module._load;
 let config={workspaceValue:'production'},calls=0;
 Module._load=function(name,...args){if(name==='vscode')return {workspace:{getConfiguration:()=>({inspect:()=>config})}};return original.call(this,name,...args);};
 try{
  delete require.cache[entry];const direct=require(entry).createDirectImageIntegration({},()=>{calls++;return [];});
  assert.equal(direct.getEndpoint(),'daily');
  config={globalValue:'production',workspaceValue:'daily'};assert.equal(direct.getEndpoint(),'production');
  config={globalValue:'daily',workspaceValue:'production'};assert.equal(direct.getEndpoint(),'daily');
  config={workspaceValue:'production'};assert.equal(direct.getEndpoint(),'daily');
  await assert.rejects(direct.run({...request('/tmp/unused'),endpoint:'production'},new AbortController().signal,()=>{}),{message:'IMAGE_DIRECT_ENDPOINT_CHANGED'});
  assert.equal(calls,0);
 }finally{Module._load=original;delete require.cache[entry];}
});

test('model labels preserve the verified model and enum; unknown models never borrow M21 or thinking settings',()=>{
 const auth={authResult:{hasValidAuth:true}},status={userStatus:{email}};
 const models=currentImageModels(auth,status,{response:{imageGenerationModelIds:[model.id],models:{[model.id]:{model:'MODEL_PLACEHOLDER_M999'}}}},email);
 assert.equal(models[0].modelEnum,'MODEL_PLACEHOLDER_M999');
 assert.equal(imageRequestEnvelope(model.id,models[0].modelEnum).labels.model_enum,'MODEL_PLACEHOLDER_M999');
 assert.equal(imageRequestEnvelope(model.id).labels.model_enum,'MODEL_PLACEHOLDER_M21');
 const unknown=imageRequestEnvelope('future-image-model');assert.equal(unknown.labels.model_enum,undefined);assert.equal(unknown.labels.used_claude,undefined);
 assert.doesNotMatch(JSON.stringify(unknown),/thinkingConfig|maxOutputTokens|MODEL_PLACEHOLDER_M21/);
});

test('user override selects one host for metadata and image sends; a mid-operation change stops generation',async()=>{
 const output=await fs.mkdtemp(path.join(os.tmpdir(),'ag-protocol-integration-'));
 const entry=require.resolve('../out/direct-image-vscode'),original=Module._load;
 const extension={isActive:true,exports:{port:40001,csrfToken:'synthetic-local-session'}};
 let endpoint='daily',changeAfterMetadata=false;
 const calls=[],http=fakeHttps(calls);
 Module._load=function(name,...args){
  if(name==='vscode')return {UIKind:{Desktop:1},env:{uiKind:1,remoteName:'wsl'},extensions:{getExtension:()=>extension},
   workspace:{isTrusted:true,getConfiguration:()=>({inspect:()=>({globalValue:endpoint})})}};
  if(name==='./official-extension-identity')return {pinOfficialExtension:()=>({}),matchesOfficialExtension:()=>true};
  if(name==='./native-host')return {nativeHostStatus:()=>({available:true}),resolveCredentialHostId:async()=> 'fixture-host'};
  if(name==='./live-lock')return {LiveLocks:class{async withOperation(fn){return fn();}async hasRecovery(){return false;}}};
  if(name==='./live-environment')return {EnvironmentTokenSlots:class{async mode(){return 'wsl-file';}}};
  if(name==='./live-hub')return {generation:require('../out/live-hub').generation,hasOfficialHubApi:()=>true,hubRpc:async(_api,method)=>{
   if(method==='GetAuthStatus')return {authResult:{hasValidAuth:true}};
   if(method==='GetUserStatus')return {userStatus:{email}};
   return {response:{imageGenerationModelIds:[model.id],models:{[model.id]:{model:'MODEL_PLACEHOLDER_M21'}}}};
  }};
  if(name==='./account-quota-transport')return {requestAccountQuota:async value=>{assert.equal(value.endpoint,'identity');assert.equal(value.accessToken,token);return {email,verified_email:true,id:'fixture-subject'};}};
  if(name==='./direct-image-project-transport')return {resolveEndpointImageProject:async(bearer,signal,target)=>{
   const result=await resolveEndpointImageProject(bearer,signal,target,http);if(changeAfterMetadata)endpoint='production';return result;
  }};
  if(name==='./direct-image-transport')return {sendDirectImage:(bearer,body,signal,_unused,target)=>sendDirectImage(bearer,body,signal,http,target)};
  return original.call(this,name,...args);
 };
 try{
  delete require.cache[entry];const direct=require(entry).createDirectImageIntegration({globalStorageUri:{toString:()=> 'synthetic'},secrets:vault,globalState:{get:(_key,fallback)=>fallback}},()=>[selected]);
  const run=()=>direct.run({...request(output),endpoint},new AbortController().signal,()=>{});
  const result=await run();assert.equal(result.images.length,1);assert.equal(calls.length,2);
  assert.ok(calls.every(c=>c.options.hostname===fixture.hosts.daily));
  calls.length=0;endpoint='production';
  const production=await run();assert.equal(production.images.length,1);assert.equal(calls.length,2);
  assert.ok(calls.every(c=>c.options.hostname===fixture.hosts.production));
  calls.length=0;endpoint='daily';changeAfterMetadata=true;
  await assert.rejects(run(),{message:'IMAGE_DIRECT_ENDPOINT_CHANGED'});
  assert.equal(calls.length,1);assert.equal(calls[0].options.path,fixture.project.path);
 }finally{Module._load=original;delete require.cache[entry];await fs.rm(output,{recursive:true,force:true});}
});

test('prefixed client request IDs survive safe diagnostics while injected IDs are discarded',()=>{
 const rid=fixture.image.body.requestId;
 const error=imageHttpFailure(429,{error:{status:'RESOURCE_EXHAUSTED',message:'capacity exhausted'}},undefined,rid);
 assert.equal(error.requestId,rid);assert.equal(sanitizeDebugData(error).requestId,rid);assert.ok(formatImageFailure(error).includes(rid));
 assert.equal(readRecentImageFailure(captureRecentImageFailure(error,model.id,'generating',id)).requestId,rid);
 assert.equal(imageHttpFailure(429,{},undefined,rid+' SECRET').requestId,undefined);
});

for(const branch of ['saved','current-wsl'])for(const imageStatus of [200,429])test(`single-run call budget: ${branch} bearer, HTTP ${imageStatus}`,async()=>{
 const output=await fs.mkdtemp(path.join(os.tmpdir(),'ag-call-budget-'));
 const original=Module._load,entry=require.resolve('../out/direct-image-vscode');
 const extension={isActive:true,exports:{port:40001,csrfToken:'synthetic-local-session'}};
 const currentRaw=JSON.stringify({token:{access_token:token,expiry:'2099-01-01T00:00:00Z'}});
 // Execute the actual fallback reader with synthetic file/guard dependencies.
 // No OS credential file, process command line or startup log is accessed.
 const tokenExports={};
 vm.runInNewContext(await fs.readFile(require.resolve('../out/direct-image-current-token'),'utf8'),{
  exports:tokenExports,process:{platform:'linux'},require:name=>{
   if(name==='node:fs/promises')return {};
   if(name==='node:os')return {homedir:()=>'/synthetic-no-files'};
   if(name==='./live-lock')return {LiveLocks:class{async withOperation(fn){return fn();}async hasRecovery(){return false;}}};
  if(name==='./live-environment')return {EnvironmentTokenSlots:class{
    async mode(){return 'wsl-file';}async read(){return {file:currentRaw,keyring:null,keyringState:'unobserved'};}}};
   if(name==='./live-wsl-proof')return {createWslReadGuard:()=>async()=>true};
   return require(name.startsWith('./')?'../out/'+name.slice(2):name);
  },
 });
 const expired=stored.replace('2099-01-01T00:00:00Z','2020-01-01T00:00:00Z');
 const saved={get:async key=>key===`live-switch.account.v1.${id}`?(branch==='saved'?stored:expired):undefined};
 const rpc={GetAuthStatus:0,GetUserStatus:0,GetAvailableModels:0};let identities=0;
 const calls=[],http=fakeHttps(calls,{imageStatus});
 Module._load=function(name,...args){
  if(name==='vscode')return {UIKind:{Desktop:1},env:{uiKind:1,remoteName:'wsl'},extensions:{getExtension:()=>extension},
   workspace:{isTrusted:true,getConfiguration:()=>({inspect:()=>undefined})}};
  if(name==='./official-extension-identity')return {pinOfficialExtension:()=>({}),matchesOfficialExtension:()=>true};
  if(name==='./native-host')return {nativeHostStatus:()=>({available:true}),resolveCredentialHostId:async()=> 'fixture-host'};
  if(name==='./live-lock')return {LiveLocks:class{async withOperation(fn){return fn();}async hasRecovery(){return false;}}};
  if(name==='./live-environment')return {EnvironmentTokenSlots:class{async mode(){return 'wsl-file';}}};
  if(name==='./direct-image-current-token')return tokenExports;
  if(name==='./live-hub')return {generation:require('../out/live-hub').generation,hasOfficialHubApi:()=>true,hubRpc:async(_api,method)=>{
   assert.ok(Object.hasOwn(rpc,method));rpc[method]++;
   if(method==='GetAuthStatus')return {authResult:{hasValidAuth:true}};
   if(method==='GetUserStatus')return {userStatus:{email}};
   return {response:{imageGenerationModelIds:[model.id],models:{[model.id]:{}}}};
  }};
  if(name==='./account-quota-transport')return {requestAccountQuota:async value=>{
   assert.equal(value.endpoint,'identity');assert.equal(value.accessToken,token);identities++;
   return {email,verified_email:true,id:'fixture-subject'};}};
  if(name==='./direct-image-project-transport')return {resolveEndpointImageProject:(bearer,signal,target)=>resolveEndpointImageProject(bearer,signal,target,http)};
  if(name==='./direct-image-transport')return {sendDirectImage:(bearer,body,signal,_unused,target)=>sendDirectImage(bearer,body,signal,http,target)};
  return original.call(this,name,...args);
 };
 try{
  delete require.cache[entry];const direct=require(entry).createDirectImageIntegration({globalStorageUri:{toString:()=> 'synthetic'},secrets:saved,globalState:{get:(_key,fallback)=>fallback}},()=>[selected]);
  const result=direct.run({...request(output),endpoint:'daily'},new AbortController().signal,()=>{});
  if(imageStatus===200)await result;else await assert.rejects(result,{message:'IMAGE_DIRECT_RESOURCE_EXHAUSTED'});
  // Once bound, before/after-send checks validate the frozen credential, not the mutable official session.
  const perMethod=branch==='saved'?5:10;
  assert.deepEqual(rpc,{GetAuthStatus:perMethod*2,GetUserStatus:perMethod*2,GetAvailableModels:perMethod});
  assert.equal(identities,1);assert.equal(calls.length,2);
  assert.deepEqual(calls.map(c=>c.options.path),[fixture.project.path,fixture.image.path]);
  assert.ok(calls.every(c=>c.options.hostname===fixture.hosts.daily));
 }finally{Module._load=original;delete require.cache[entry];await fs.rm(output,{recursive:true,force:true});}
});
