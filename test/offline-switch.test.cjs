const test=require('node:test'),assert=require('node:assert/strict');
const {OfflineSwitchCoordinator}=require('../out/offline-switch');
const token=n=>JSON.stringify({token:{refresh_token:'synthetic-'+n}});
const old={keyring:token('old'),file:token('old')},target={keyring:token('new'),file:token('new')};
function fixture(){
 const f={state:{complete:true,unknown:false,hosts:[],hubs:[]},value:{...old},record:undefined,events:[]};
 f.runtime={hostId:'synthetic-host',withLock:async fn=>fn(),assertWritersSettled:async()=>{},
  census:async()=>f.state,
  journal:{read:async()=>f.record,save:async value=>{f.record=structuredClone(value);f.events.push(value.phase);}},
  slots:{read:async()=>({...f.value}),write:async(value,expected,guard)=>{await guard();assert.deepEqual(f.value,expected);f.value.keyring=value.keyring;await guard();assert.equal(f.value.file,expected.file);assert.equal(f.value.keyring,value.keyring);f.value.file=value.file;f.events.push('write');}},
  reopen:async()=>f.events.push('reopen')};
 f.coordinator=new OfflineSwitchCoordinator(f.runtime);
 f.request={confirmed:true,transactionId:'18b6b550-6e0d-4b57-b5be-9d70810f07a9',backup:old,target,expectedEmail:'synthetic@example.test'};
 return f;
}
test('install saves backup before mutation and preserves journal through reopening',async()=>{
 const f=fixture();assert.equal(await f.coordinator.install(f.request),'installed-awaiting-verification');
 assert.deepEqual(f.events,['prepared','write','installed','reopen']);assert.deepEqual(f.record.backup,old);
});
test('hubless host prevents any journal or storage mutation',async()=>{
 const f=fixture();f.state.hosts=[{pid:42,startIdentity:'new'}];await assert.rejects(f.coordinator.install(f.request),/OFFLINE_INSTANCE_PRESENT/);assert.deepEqual(f.events,[]);
});
test('new instance after first slot blocks second slot and rollback',async()=>{
 const f=fixture();f.runtime.slots.write=async(v,e,guard)=>{await guard();f.value.keyring=v.keyring;f.state.hubs=[{pid:43,startIdentity:'new'}];await guard();f.value.file=v.file;};
 await assert.rejects(f.coordinator.install(f.request),/OFFLINE_RECOVERY_REQUIRED/);
 assert.equal(f.value.keyring,target.keyring);assert.equal(f.value.file,old.file);assert.equal(f.record.phase,'prepared');
});
test('mixed old/new owned slots can recover after all new instances close',async()=>{
 const f=fixture();f.record={schema:1,hostId:'synthetic-host',id:f.request.transactionId,phase:'prepared',backup:old,target,expectedEmail:f.request.expectedEmail};
 f.value={keyring:target.keyring,file:old.file};await f.coordinator.restore(true);
 assert.deepEqual(f.value,old);assert.equal(f.record.phase,'restored');assert.ok(!f.events.includes('reopen'));
});
test('external slot value is not overwritten by recovery',async()=>{
 const f=fixture();f.record={schema:1,hostId:'synthetic-host',id:f.request.transactionId,phase:'prepared',backup:old,target,expectedEmail:f.request.expectedEmail};
 f.value.keyring=token('external');await assert.rejects(f.coordinator.restore(true),/OFFLINE_STORAGE_CHANGED/);assert.equal(f.value.keyring,token('external'));
});
test('reopen error preserves installed journal and target',async()=>{
 const f=fixture();f.runtime.reopen=async()=>{throw Error('synthetic');};await assert.rejects(f.coordinator.install(f.request),/OFFLINE_REOPEN_REQUIRED/);assert.equal(f.record.phase,'installed');assert.deepEqual(f.value,target);
});
test('concurrent click rejected before a second transaction starts',async()=>{
 const f=fixture();let release;f.runtime.census=()=>new Promise(r=>{release=()=>r(f.state)});
 const first=f.coordinator.install(f.request);await assert.rejects(f.coordinator.install(f.request),/OFFLINE_OPERATION_BUSY/);
 f.state.unknown=true;release();await assert.rejects(first,/OFFLINE_CENSUS_UNVERIFIED/);assert.deepEqual(f.events,[]);
});
test('cancellation before prepared state leaves storage intact',async()=>{
 const f=fixture(),c=new AbortController();c.abort();await assert.rejects(f.coordinator.install(f.request,c.signal),/CANCELLED/);assert.deepEqual(f.events,[]);
});
test('unconfirmed or wrong-host recovery rejected',async()=>{
 const f=fixture();await assert.rejects(f.coordinator.install({...f.request,confirmed:false}),/OFFLINE_CONFIRMATION_REQUIRED/);
 f.record={schema:1,hostId:'another-host',id:f.request.transactionId,phase:'prepared',backup:old,target,expectedEmail:f.request.expectedEmail};
 await assert.rejects(f.coordinator.restore(true),/OFFLINE_RECOVERY_INVALID/);
});
test('unknown native write outcome never triggers automatic rollback',async()=>{
 const f=fixture();let calls=0;f.runtime.slots.write=async()=>{calls++;f.value.keyring=target.keyring;throw Error('NATIVE_HELPER_TIMEOUT_OR_LIMIT');};
 await assert.rejects(f.coordinator.install(f.request),/OFFLINE_RECOVERY_REQUIRED/);assert.equal(calls,1);assert.equal(f.record.phase,'prepared');
 f.runtime.assertWritersSettled=async()=>{throw Error('OFFLINE_WRITER_STILL_PENDING');};
 await assert.rejects(f.coordinator.restore(true),/OFFLINE_WRITER_STILL_PENDING/);assert.equal(calls,1);
});
test('known target identity mismatch is rejected before preparing',async()=>{
 const f=fixture(),jwt='x.'+Buffer.from(JSON.stringify({email:'other@example.test'})).toString('base64url')+'.x';
 const mismatched=JSON.stringify({token:{refresh_token:'synthetic'},id_token:jwt});
 await assert.rejects(f.coordinator.install({...f.request,target:{keyring:mismatched,file:mismatched}}),/OFFLINE_RECOVERY_INVALID/);assert.deepEqual(f.events,[]);
});
test('native adapter compares again after asynchronous process guard',async()=>{
 const f=fixture();let scans=0;f.runtime.census=async()=>{if(++scans===3)f.value.file=token('external');return f.state;};
 await assert.rejects(f.coordinator.install(f.request),/OFFLINE_RECOVERY_REQUIRED/);assert.equal(f.value.file,token('external'));assert.equal(f.value.keyring,old.keyring);
});
test('exact durable preparation ACK before window closure can be consumed once',async()=>{
 const f=fixture();f.record={schema:1,hostId:'synthetic-host',id:f.request.transactionId,phase:'prepared',backup:old,target,expectedEmail:f.request.expectedEmail};
 await f.coordinator.install(f.request);assert.deepEqual(f.events,['write','installed','reopen']);
 await assert.rejects(f.coordinator.install(f.request),/OFFLINE_RECOVERY_REQUIRED/);
});
test('a settled keep-current journal cannot replay restore over the accepted login',async()=>{
 const f=fixture();await f.coordinator.install(f.request);f.record.phase='kept-current';f.record.keptEmail='synthetic@example.test';f.events=[];
 await assert.rejects(f.coordinator.restore(true),/OFFLINE_TRANSACTION_SETTLED/);assert.deepEqual(f.value,target);assert.deepEqual(f.events,[]);
});
