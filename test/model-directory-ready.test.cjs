const test=require('node:test'),assert=require('node:assert/strict');
const {readWhenDirectoryReady}=require('../out/model-directory-ready'),{LockConflictError}=require('../out/live-lock'),{catalogError,catalogFailureDetails}=require('../out/model-catalog-error');
const busy=(state='active',kind='account',scope='this-process')=>new LockConflictError('LIVE_OPERATION_OR_RECOVERY_LOCKED',{state,kind,scope});
const signal=()=>new AbortController().signal,options={pollMs:1,timeoutMs:100};
test('reproduces first-open lock failure and manual success; automatic reader instead waits without a click',async()=>{
 let locked=true,calls=0;const read=async()=>{calls++;if(locked)throw busy();return ['synthetic-model']};
 await assert.rejects(read(),e=>catalogFailureDetails(e).catalogStage==='lock');locked=false;assert.deepEqual(await read(),['synthetic-model']);
 locked=true;calls=0;const phases=[];const result=readWhenDirectoryReady(read,()=>false,signal(),p=>{phases.push(p);if(p==='preparing')locked=false},options);
 assert.deepEqual(await result,['synthetic-model']);assert.equal(calls,2);assert.deepEqual(phases,['loading','preparing','loading']);
});
test('late bootstrap and Hub readiness never attempts the catalog until ready',async()=>{
 let preparing=true,calls=0;const phases=[];const pending=readWhenDirectoryReady(async()=>{calls++;return 'ready'},()=>preparing,signal(),p=>{phases.push(p);preparing=false},options);
 assert.equal(calls,0);assert.equal(await pending,'ready');assert.deepEqual(phases,['preparing','loading']);assert.equal(calls,1);
});
test('cancelling during startup cannot perform a read when initialization later finishes',async()=>{
 const abort=new AbortController();let preparing=true,calls=0;const pending=readWhenDirectoryReady(async()=>calls++,()=>preparing,abort.signal,()=>{},options);abort.abort();preparing=false;
 await assert.rejects(pending,/IMAGE_CANCELLED/);assert.equal(calls,0);
});
test('startup timeout is bounded and accurately classified; no transport was attempted',async()=>{
 let calls=0;await assert.rejects(readWhenDirectoryReady(async()=>calls++,()=>true,signal(),()=>{},{pollMs:1,timeoutMs:3}),e=>e.message==='WAKE_DIRECTORY_INITIALIZING'&&catalogFailureDetails(e).catalogFailure==='timeout');assert.equal(calls,0);
});
for(const [state,kind,scope]of [['uncertain','account','this-process'],['active','recovery','this-process'],['active','account','other-profile'],['active','unknown','other-process']])test('does not wait or weaken '+[state,kind,scope].join('/'),async()=>{
 let calls=0;const error=busy(state,kind,scope);await assert.rejects(readWhenDirectoryReady(async()=>{calls++;throw error},()=>false,signal(),()=>{},options),e=>e===error);assert.equal(calls,1);
});
test('active ordinary lock timeout retains the original precise lock failure',async()=>{
 const error=busy();await assert.rejects(readWhenDirectoryReady(async()=>{throw error},()=>false,signal(),()=>{},{pollMs:1,timeoutMs:3}),e=>e===error&&catalogFailureDetails(e).catalogStage==='lock');
});
for(const kind of ['http','network','tls','parse','binding'])test('actual '+kind+' failure remains visible with no automatic retry',async()=>{
 let calls=0;const error=catalogError('SYNTHETIC_CATALOG_FAILED',kind==='parse'?'parse':kind==='binding'?'binding':'transport',kind,kind==='http'?403:undefined);await assert.rejects(readWhenDirectoryReady(async()=>{calls++;throw error},()=>false,signal(),()=>{},options),e=>e===error);assert.equal(calls,1);
});
test('a changed account while waiting fails its binding guard instead of reading the old scope',async()=>{
 let preparing=true,current=true,calls=0;await assert.rejects(readWhenDirectoryReady(async()=>{if(!current)throw Error('WAKE_ACCOUNT_CHANGED');calls++},()=>preparing,signal(),()=>{preparing=false;current=false},options),/WAKE_ACCOUNT_CHANGED/);assert.equal(calls,0);
});
