const test=require('node:test'),assert=require('node:assert/strict');
const {randomBytes}=require('node:crypto');
const {spawnSync}=require('node:child_process');
const path=require('node:path');
const {execute,seal,open}=require('./helpers/offline-switch-prototype.cjs');
function fixture(){
 const f={confirmed:true,backup:'synthetic-old',target:'synthetic-new',value:'synthetic-old',events:[],state:{complete:true,unknown:false,hosts:[],hubs:[]}};
 f.census=async()=>f.state;
 f.read=async()=>f.value;
 f.journal=async phase=>{f.events.push(phase);};
 f.compareAndWrite=async(value,expected,guard)=>{await guard();if(f.value!==expected)throw Error('CAS');f.events.push('write:'+value);f.value=value;};
 f.reopen=async()=>{f.events.push('reopen');};
 return f;
}
test('stop then switch then start retains installed journal for online verification',async()=>{
 const f=fixture();assert.equal(await execute(f),'installed-awaiting-verification');
 assert.deepEqual(f.events,['prepared','write:synthetic-new','installed','reopen']);
});
for(const state of [
 {complete:true,unknown:false,hosts:[{pid:1,birth:'alive-without-hub'}],hubs:[]},
 {complete:true,unknown:false,hosts:[],hubs:[{pid:2,birth:'orphan'}]},
 {complete:false,unknown:false,hosts:[],hubs:[]},
 {complete:true,unknown:true,hosts:[],hubs:[]},
])test('live host, orphan Hub or incomplete evidence prevents preparation '+JSON.stringify(state),async()=>{
 const f=fixture();f.state=state;await assert.rejects(execute(f),/OFFLINE_/);assert.deepEqual(f.events,[]);
});
test('new birth after prepared journal aborts before mutation',async()=>{
 const f=fixture();f.journal=async p=>{f.events.push(p);f.state.hosts=[{pid:1,birth:'new'}];};
 await assert.rejects(execute(f),/OFFLINE_INSTANCE_PRESENT/);assert.deepEqual(f.events,['prepared']);assert.equal(f.value,f.backup);
});
test('new instance detected after mutation retains journal and never blindly rolls back or reopens',async()=>{
 const f=fixture(),write=f.compareAndWrite;f.compareAndWrite=async(...args)=>{await write(...args);f.state.hosts=[{pid:1,birth:'new'}];};
 await assert.rejects(execute(f),/OFFLINE_RECOVERY_REQUIRED/);
 assert.deepEqual(f.events,['prepared','write:synthetic-new']);
});
test('failure after write restores backup only after fresh closure check',async()=>{
 const f=fixture();f.journal=async p=>{if(p==='installed')throw Error('INJECTED_JOURNAL_FAILURE');f.events.push(p);};
 await assert.rejects(execute(f),/INJECTED_JOURNAL_FAILURE/);
 assert.deepEqual(f.events,['prepared','write:synthetic-new','write:synthetic-old','restored']);
});
test('unexpected storage change is preserved rather than overwritten',async()=>{
 const f=fixture();f.compareAndWrite=async()=>{f.value='synthetic-other';throw Error('PARTIAL');};
 await assert.rejects(execute(f),/OFFLINE_RECOVERY_REQUIRED/);assert.equal(f.value,'synthetic-other');
});
test('reopen failure preserves installed result and does not roll back',async()=>{
 const f=fixture();f.reopen=async()=>{throw Error('launch');};
 await assert.rejects(execute(f),/OFFLINE_REOPEN_REQUIRED/);assert.equal(f.value,f.target);assert.equal(f.events.at(-1),'installed');
});
test('confirmation and cancellation prevent writes',async()=>{
 const f=fixture();f.confirmed=false;await assert.rejects(execute(f),/CONFIRMATION/);
 f.confirmed=true;const c=new AbortController();c.abort();f.signal=c.signal;
 await assert.rejects(execute(f),/CANCELLED/);assert.deepEqual(f.events,[]);
});
test('encrypted handoff binds scope and transaction; corrupt/wrong-key envelopes reject',()=>{
 const key=randomBytes(32),payload={marker:'synthetic-target'},e=seal(key,'scope','tx',payload);
 assert.deepEqual(open(key,'scope','tx',e),payload);
 assert.equal(JSON.stringify(e).includes(payload.marker),false);
 for(const [k,s,t,v] of [[randomBytes(32),'scope','tx',e],[key,'other','tx',e],[key,'scope','other',e],[key,'scope','tx',{...e,tag:Buffer.alloc(16).toString('base64')}]])
  assert.throws(()=>open(k,s,t,v),/OFFLINE_HANDOFF_INVALID/);
});
test('helper receives handoff only through anonymous stdin and emits no payload',()=>{
 const key=randomBytes(32),e=seal(key,'scope','tx',{marker:'synthetic-target'});
 const result=spawnSync(process.execPath,[path.join(__dirname,'helpers/offline-switch-prototype.cjs')],{input:JSON.stringify({key:key.toString('base64'),scope:'scope',tx:'tx',envelope:e}),encoding:'utf8',timeout:3000});
 assert.equal(result.status,0);assert.equal(result.stdout,'HANDOFF_OK');assert.equal(result.stderr,'');
});
