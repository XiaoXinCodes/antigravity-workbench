const test = require('node:test'), assert = require('node:assert/strict');
const {DebugRecorder, installDebugRecorder, beginDebugOperation, sanitizeDebugData, sanitizeStoredDebugEvent, debugErrorCode} = require('../out/debug-events');
const info = {version:'0.13.2', platform:'linux', host:'wsl'};
function fixture() {
 const records=[];let disposed=false,gate;const store={append:async(line,current)=>{if(gate)await gate;if(!disposed&&current())records.push(line);},readLines:async()=>records.slice(),flush:async()=>{if(gate)await gate;},dispose(){disposed=true;}};
 return {records,store,log:new DebugRecorder(store,info),hold(promise){gate=promise;}};
}
test('default OFF is inert, including existing spans, and does not create storage',async()=>{
 const f=fixture();const installed=installDebugRecorder(f.log);const span=beginDebugOperation('image.generate');span.event('generating',{code:'IMAGE_CANCELLED'});span.end('failed');assert.deepEqual(f.records,[]);assert.equal(f.log.getState().enabled,false);
 await f.log.setEnabled(true);span.event('generating');assert.deepEqual(f.records,[]);installed.dispose();
});
test('explicit image operation ID correlates optional detailed log with persistent summary', async()=>{
 const f=fixture();await f.log.setEnabled(true);
 const id='12345678-1234-4123-8123-123456789abc';
 f.log.begin('image.generate',id).end('failed',{code:'IMAGE_DIRECT_RESOURCE_EXHAUSTED'});
 assert.equal(JSON.parse(f.records[0]).operationId,id);
 assert.equal(JSON.parse(f.records[1]).operationId,id);
 f.log.begin('image.generate','SENTINEL_PRIVATE').end('failed');
 assert.notEqual(JSON.parse(f.records[2]).operationId,'SENTINEL_PRIVATE');
});
test('image route tracing survives export using only fixed endpoints and derived hosts',async()=>{
 const f=fixture();await f.log.setEnabled(true);
 for(const [imageEndpoint,imageHost] of [['daily','daily-cloudcode-pa.googleapis.com'],['production','cloudcode-pa.googleapis.com']]){
  const span=f.log.begin('image.generate');span.end('failed',{code:'IMAGE_DIRECT_RESOURCE_EXHAUSTED',imageEndpoint,imageHost:'SENTINEL_HOST',url:'https://SENTINEL/?token=SECRET'});
  const event=JSON.parse(f.records.at(-1));assert.equal(event.data.imageEndpoint,imageEndpoint);assert.equal(event.data.imageHost,imageHost);
  event.data.imageHost='SENTINEL_HOST';assert.equal(sanitizeStoredDebugEvent(event).data.imageHost,imageHost);
 }
 for(const imageEndpoint of ['sandbox','https://SENTINEL','daily\n',null,{}])assert.equal(sanitizeDebugData({imageEndpoint,imageHost:'SENTINEL_HOST'}),undefined);
 assert.equal(sanitizeDebugData({imageHost:'daily-cloudcode-pa.googleapis.com'}),undefined);
 const preview=await f.log.preview();assert.match(preview,/daily-cloudcode-pa\.googleapis\.com/);assert.match(preview,/"imageHost":"cloudcode-pa\.googleapis\.com"/);assert.doesNotMatch(preview,/SENTINEL|SECRET|https:/);
});
test('fixed schema excludes canaries from values, property names, account IDs and prompts',async()=>{
 const f=fixture();await f.log.setEnabled(true);const raw={code:'SECRET_TOKEN_VALUE',prompt:'prompt-SENTINEL',token:'token-SENTINEL',password:'password-SENTINEL',authorization:'Bearer SENTINEL',url:'https://host.test/?token=SENTINEL',email:'secret@example.test',taskId:'00000000-0000-4000-8000-000000000000',accountId:'account-SENTINEL',path:'/home/SENTINEL',SECRET_KEY_NAME:'anything',count:2,guard:{version:1,reason:'UNKNOWN_ARGUMENT',generationAllowed:false,unknownFields:['SECRET_FIELD_NAME']}};
 const span=f.log.begin('image.generate');span.event('validating',raw);span.end('failed',raw);const text=f.records.join('\n');assert.doesNotMatch(text,/SENTINEL|SECRET_TOKEN_VALUE|SECRET_KEY_NAME|SECRET_FIELD_NAME|example\.test|00000000|Bearer|home/);const events=f.records.map(JSON.parse);assert.equal(events[1].data.code,'UNCLASSIFIED_ERROR');assert.deepEqual(events[1].data.guard,{version:1,reason:'UNKNOWN_ARGUMENT',generationAllowed:false});assert.equal(events[1].data.count,2);assert.equal(events[0].operationId,events[2].operationId);assert.match(events[0].operationId,/^[a-f0-9-]{36}$/);
});
test('hostile getters, proxies, prototypes, cycles and toJSON are never serialized',()=>{
 let called=0;const hostile={};for(const key of ['code','guard','count','status','imageEndpoint','imageHost'])Object.defineProperty(hostile,key,{get(){called++;throw Error('SENTINEL');}});hostile.toJSON=()=>{called++;return 'SENTINEL';};hostile.self=hostile;
 assert.equal(sanitizeDebugData(hostile),undefined);assert.equal(debugErrorCode(hostile),'UNCLASSIFIED_ERROR');assert.equal(sanitizeDebugData(Object.create({code:'IMAGE_CANCELLED'})),undefined);
 const proxy=new Proxy({}, {getOwnPropertyDescriptor(){throw Error('SENTINEL');},ownKeys(){throw Error('SENTINEL');},get(){throw Error('SENTINEL');}});assert.equal(sanitizeDebugData(proxy),undefined);assert.equal(debugErrorCode(proxy),'UNCLASSIFIED_ERROR');assert.equal(called,0);
 const revoked=Proxy.revocable({},{});revoked.revoke();assert.equal(sanitizeDebugData(revoked.proxy),undefined);assert.equal(sanitizeStoredDebugEvent(revoked.proxy),undefined);
});
test('only known exact fixed error and guard codes survive',()=>{
 for(const value of ['IMAGE_CANCELLED-SENTINEL','IMAGE_CANCELLED\nsecret','SECRET_TOKEN_VALUE','<script>'])assert.equal(debugErrorCode(Error(value)),'UNCLASSIFIED_ERROR');assert.equal(debugErrorCode(Error('IMAGE_CANCELLED')),'IMAGE_CANCELLED');
 for(const guard of [{version:1,reason:'UNKNOWN_SECRET',generationAllowed:true},{version:2,reason:'PROMPT',generationAllowed:true},{version:1,reason:'PROMPT',generationAllowed:'SENTINEL'}])assert.equal(sanitizeDebugData({guard}),undefined);
 assert.deepEqual(sanitizeDebugData({code:'IMAGE_REQUEST_SCOPE_DENIED',guard:{version:1,reason:'FRAMEWORK_METADATA',generationAllowed:'unknown'}}),{code:'IMAGE_REQUEST_SCOPE_DENIED',guard:{version:1,reason:'FRAMEWORK_METADATA',generationAllowed:'unknown'}});
});
test('bounds reject unbounded counts, unknown states and metadata contents',async()=>{
 const f=fixture();const log=new DebugRecorder(f.store,{version:'1.2.3-SENTINEL',host:'wsl+SENTINEL',platform:'linux-SENTINEL'});await log.setEnabled(true);log.begin('account.capture').end('completed',{count:Infinity,requestedCount:-1,completedCount:10001,status:'secret'});const text=f.records.join('');assert.doesNotMatch(text,/SENTINEL|Infinity|requestedCount|completedCount/);assert.equal(JSON.parse(f.records[0]).version,'unknown');
});
test('OFF cancels queued writes, preserves old records, and invalidates old spans after re-enable',async()=>{
 const f=fixture();await f.log.setEnabled(true);const first=f.log.begin('account.quota');first.end('completed');assert.equal(f.records.length,2);let release;f.hold(new Promise(r=>release=r));const active=f.log.begin('image.generate');active.event('generating');const disabling=f.log.setEnabled(false);release();await disabling;assert.equal(f.records.length,2);active.end('failed');await f.log.setEnabled(true);active.event('saving');assert.equal(f.records.length,2);f.log.begin('account.capture').end('completed');await new Promise(r=>setImmediate(r));assert.equal(f.records.length,4);
});
test('storage failure latches writes until user toggles and never changes the business call',async()=>{
 let calls=0;const store={append(){calls++;throw Error('SECRET_RAW_FAILURE');},readLines:async()=>[],flush:async()=>{},dispose(){}};const log=new DebugRecorder(store,info,()=>{throw Error('SECRET_CALLBACK');});await log.setEnabled(true);const span=log.begin('image.generate');assert.doesNotThrow(()=>span.event('generating'));span.end('failed');log.begin('account.login').end('completed');assert.equal(calls,1);assert.equal(log.getState().storageUnavailable,true);
});
test('preview revalidates disk entries and exports no unknown data or invalid records',async()=>{
 const f=fixture();await f.log.setEnabled(true);f.log.begin('image.generate').end('failed',{code:'IMAGE_REQUEST_SCOPE_DENIED'});const entry=JSON.parse(f.records[0]);entry.token='SECRET_TOKEN';entry.data={code:'SECRET_ERROR',unknown:{prompt:'SECRET_PROMPT'}};f.records.push(JSON.stringify(entry),'invalid-json',JSON.stringify({...entry,operation:'SECRET_OPERATION'}),JSON.stringify({...entry,operationId:'SECRET_ACCOUNT'}),JSON.stringify({...entry,at:'SECRET_TIME'}));const preview=await f.log.preview();assert.doesNotMatch(preview,/SECRET|invalid-json|token|unknown/);assert.match(preview,/UNCLASSIFIED_ERROR/);assert.equal(preview.trim().split('\n').length,3);
});
test('dispose cancels queued writes and excludes subsequent calls',async()=>{
 const f=fixture();await f.log.setEnabled(true);let release;f.hold(new Promise(r=>release=r));const span=f.log.begin('account.capture');f.log.dispose();release();await f.store.flush();span.end('failed');assert.deepEqual(f.records,[]);
});

test('safe image field-type summaries survive logging while unknown names and type values are discarded',()=>{
 const data=sanitizeDebugData({guard:{version:1,reason:'UNKNOWN_ARGUMENT',generationAllowed:false,argumentShape:{knownTypes:{Prompt:'string',Size:'number',Quality:'SECRET_VALUE',SECRET_KEY:'string'},unknownFieldCount:2,SECRET:'value'}}});assert.deepEqual(data.guard.argumentShape,{knownTypes:{Prompt:'string',Size:'number'},unknownFieldCount:2});assert.doesNotMatch(JSON.stringify(data),/SECRET/);
 for(const count of [-1,1025,Infinity,'secret'])assert.equal(sanitizeDebugData({guard:{version:1,reason:'PROMPT',generationAllowed:false,argumentShape:{knownTypes:{},unknownFieldCount:count}}}).guard.argumentShape,undefined);
});

test('failure outcome uses exact known cancellation and timeout codes',()=>{
 const {debugFailureOutcome}=require('../out/debug-events');for(const code of ['IMAGE_CANCELLED','LOGIN_CANCELLED','QUOTA_QUERY_CANCELLED'])assert.equal(debugFailureOutcome(code),'cancelled');for(const code of ['IMAGE_TIMEOUT','IMAGE_WORKER_TIMEOUT','IMAGE_CANCEL_TIMEOUT','IMAGE_CONFIGURATION_TIMEOUT','LOGIN_TIMEOUT','QUOTA_QUERY_TIMEOUT','HUB_RPC_TIMEOUT'])assert.equal(debugFailureOutcome(code),'timed_out');for(const code of ['SECRET_CANCELLED','SECRET_TIMEOUT','UNKNOWN_FAILURE',null,{}])assert.equal(debugFailureOutcome(code),'failed');
});
