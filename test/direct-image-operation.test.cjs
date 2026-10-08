const test=require('node:test');
const assert=require('node:assert/strict');
const Module=require('node:module');
const { enterAccountChange }=require('../out/image-activity');
const { rememberImageTransport }=require('../out/image-response-evidence');
const { imageHttpFailure }=require('../out/direct-image-http-error');
const { DebugRecorder,installDebugRecorder }=require('../out/debug-events');
const request={prompt:'PRIVATE_PROMPT',accountId:'00000000-0000-4000-8000-000000000001',modelId:'gemini-3.1-flash-image',aspectRatio:'1:1',count:2,size:'2K',quality:'detail',references:[],outputDirectory:'/PRIVATE_PATH',endpoint:'daily'};
function fixture(options={}) {
 const writes=[],events=[];let held=false,sends=0,cores=0;
 const locks={withOperation:async fn=>{events.push('locked');held=true;try{return await fn();}finally{held=false;events.push('unlocked');}},hasRecovery:async()=>!!options.pending};
 const journal={write:async record=>{writes.push(structuredClone(record));return !options.storageFailure;},read:async()=>writes,dispose(){}};
 const entry=require.resolve('../out/direct-image-vscode'),original=Module._load;
 Module._load=function(name,...args) {
  if(name==='vscode')return {workspace:{getConfiguration:()=>({inspect:()=>({globalValue:options.endpoint})})}};
  if(name==='./direct-image-core')return {generateDirectImageBatch:async(_request,signal,deps)=>{
   cores++;assert.equal(held,true);assert.throws(enterAccountChange,/ACCOUNT_SWITCH_IMAGE_RUNNING/);
   deps.onProgress({phase:'generating',message:'synthetic'});
   await deps.send('PRIVATE_TOKEN',{requestId:'agent-00000000-0000-4000-8000-000000000011'},signal,_request.endpoint);
   let failure;
   try {await deps.send('PRIVATE_TOKEN',{requestId:'agent-00000000-0000-4000-8000-000000000012'},signal,_request.endpoint);} catch(error){failure=error;}
   return {images:[{file:'/PRIVATE_PATH/test.jpg',width:1,height:1}],batch:{requested:2,completed:failure?1:2,outcome:failure?'partial':'complete',...(failure?{error:failure.message}: {})}};
  }};
  if(name==='./direct-image-transport')return {sendDirectImage:async()=>{
   sends++;assert.equal(held,true);assert.throws(enterAccountChange,/ACCOUNT_SWITCH_IMAGE_RUNNING/);
   if(options.throwFirst||options.partial&&sends===2)throw imageHttpFailure(429,{error:{status:'RESOURCE_EXHAUSTED',message:'PRIVATE_RESPONSE'}});
   const response={candidates:[{finishReason:'STOP',content:{parts:[{inlineData:{data:'PRIVATE_PICTURE'}}]}}]};
   rememberImageTransport(response,{httpStatus:200,contentType:'application/json',bodyBytes:100});return response;
  }};
  return original.call(this,name,...args);
 };
 let direct;try{delete require.cache[entry];direct=require(entry).createDirectImageIntegration({subscriptions:[],globalState:{get:(_key,fallback)=>fallback}},()=>[],{locks,journal});}
 finally{Module._load=original;delete require.cache[entry];}
 return{direct,writes,events,sends:()=>sends,cores:()=>cores};
}
for(const endpoint of ['daily','production'])for(const partial of [false,true])test(`whole batch lock and route correlate ${endpoint} ${partial?'partial failure':'success'} responses`,async t=>{
 const lines=[],log=new DebugRecorder({append:async line=>lines.push(line),readLines:async()=>lines,flush:async()=>{},dispose(){}},{version:'0.0.5',platform:'linux',host:'wsl'});
 await log.setEnabled(true);const installed=installDebugRecorder(log);t.after(()=>{installed.dispose();log.dispose()});
 const f=fixture({partial,endpoint}),operationId='00000000-0000-4000-8000-000000000010';
 const result=await f.direct.run({...request,endpoint},new AbortController().signal,()=>{},operationId);
 assert.deepEqual(f.events,['locked','unlocked']);assert.equal(f.sends(),2);assert.equal(result.images.length,1);
 assert.equal(f.writes.length,2);const [start,end]=f.writes;assert.equal(start.operationId,operationId);assert.equal(end.operationId,operationId);
 assert.equal(start.outcome,'started');assert.equal(end.outcome,partial?'partial':'complete');assert.equal(end.endpoint,endpoint);assert.equal(end.size,'2K');
 assert.equal(end.attempted,2);assert.equal(end.artifacts,1);assert.equal(end.jpeg,1);assert.equal(end.responses[0].httpStatus,200);assert.equal(end.responses[1].httpStatus,partial?429:200);
 assert.notEqual(end.responses[0].requestId,end.responses[1].requestId);assert.doesNotMatch(JSON.stringify(f.writes),/PRIVATE_/);
 const traces=lines.map(JSON.parse).filter(row=>row.data?.imageEndpoint);
 assert.equal(traces.length,3);assert.ok(traces.every(row=>row.operationId===operationId&&row.data.imageEndpoint===endpoint&&row.data.imageHost===(endpoint==='daily'?'daily-cloudcode-pa.googleapis.com':'cloudcode-pa.googleapis.com')));
 assert.equal(traces.at(-1).phase,'result');assert.doesNotMatch(await log.preview(),/PRIVATE_/);
 enterAccountChange()();
});
test('shared recovery marker blocks every image send, and a journal failure never triggers retries',async()=>{
 const pending=fixture({pending:true});await assert.rejects(pending.direct.run(request,new AbortController().signal,()=>{}),/IMAGE_ACCOUNT_RECOVERY_PENDING/);
 assert.equal(pending.sends(),0);assert.equal(pending.cores(),0);assert.equal(pending.writes.at(-1).attempted,0);
 const faulty=fixture({storageFailure:true});const result=await faulty.direct.run(request,new AbortController().signal,()=>{});
 assert.equal(result.images.length,1);assert.equal(faulty.sends(),2);assert.match(faulty.direct.operationRecordWarning(),/记录未完整写入/);
 enterAccountChange()();
});
test('blocked preflight has no sent host, while a terminal send failure retains its host without retry',async t=>{
 const lines=[],log=new DebugRecorder({append:async line=>lines.push(line),readLines:async()=>lines,flush:async()=>{},dispose(){}},{version:'0.0.5',platform:'linux',host:'wsl'});
 await log.setEnabled(true);const installed=installDebugRecorder(log);t.after(()=>{installed.dispose();log.dispose()});
 const blocked=fixture({pending:true});await assert.rejects(blocked.direct.run(request,new AbortController().signal,()=>{}),/IMAGE_ACCOUNT_RECOVERY_PENDING/);
 assert.equal(blocked.sends(),0);assert.ok(lines.map(JSON.parse).every(row=>!row.data?.imageHost));
 lines.length=0;const failure=fixture({endpoint:'production',throwFirst:true});
 await assert.rejects(failure.direct.run({...request,endpoint:'production'},new AbortController().signal,()=>{}),/IMAGE_DIRECT_RESOURCE_EXHAUSTED/);
 assert.equal(failure.sends(),1);const result=lines.map(JSON.parse).find(row=>row.phase==='result');
 assert.equal(result.outcome,'failed');assert.equal(result.data.imageEndpoint,'production');assert.equal(result.data.imageHost,'cloudcode-pa.googleapis.com');assert.equal(result.data.httpStatus,429);
 assert.doesNotMatch(await log.preview(),/PRIVATE_/);
});
