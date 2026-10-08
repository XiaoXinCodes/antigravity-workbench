const test=require('node:test'),assert=require('node:assert/strict');
const {RecoveryStore}=require('../out/recovery-store');
const {verificationClock,settle}=require('./fixtures/verification-clock.cjs');
function fixture(){
 const clock=verificationClock(),data=new Map(),listeners=new Set(),writes=[];
 const vault={get:async key=>data.get(key),store:async(key,value)=>{writes.push({key,value});data.set(key,value);},delete:async key=>{writes.push({key,deleted:true});data.delete(key);},onDidChange:fn=>{listeners.add(fn);return{dispose:()=>listeners.delete(fn)}}};
 return{clock,data,vault,writes,listeners,emit:key=>{for(const fn of listeners)fn({key})},store:new RecoveryStore(vault,{clock,timeoutMs:1000})};
}
test('one store waits for exact readback, lost events use bounded polling, wrong-key events cannot acknowledge',async()=>{
 const f=fixture();f.data.set('j','old');let reads=0;f.vault.get=async key=>key==='j'&&++reads>=2&&reads<6?'old':f.data.get(key);
 const pending=f.store.write('j','old','new');await settle();assert.equal(f.writes.length,1);assert.equal(reads,2);
 f.emit('unrelated');await settle();assert.equal(reads,2);
 await f.clock.advance(500);await pending;assert.equal(f.writes.length,1);assert.equal(await f.store.read('j'),'new');assert.equal(f.listeners.size,0);assert.equal(f.clock.timers.size,0);
});
test('event wakes a classified stale read but only two fresh exact reads certify success',async()=>{
 const f=fixture();f.data.set('j','old');let lag=true,reads=0;f.vault.get=async key=>{reads++;return f.writes.length&&lag?'old':f.data.get(key)};
 const pending=f.store.write('j','old','new');await settle();const before=reads;lag=false;f.emit('j');await pending;
 assert.equal(reads,before+2);assert.equal(f.clock.now(),0);assert.equal(f.listeners.size,0);
});
test('new then old then new readback does not accept the first exact value or rewrite',async()=>{
 const f=fixture();f.data.set('j','old');const sequence=['old','new','old','new','new'];f.vault.get=async()=>sequence.shift()??f.data.get('j');
 let complete=false;const pending=f.store.write('j','old','new').then(()=>{complete=true});await settle();assert.equal(complete,false);
 await f.clock.advance(100);await pending;assert.equal(f.writes.length,1);
});
test('same-key instances serialize and a delayed stale writer cannot overwrite the later revision',async()=>{
 const f=fixture(),other=new RecoveryStore(f.vault,{clock:f.clock,timeoutMs:1000});f.data.set('j','rev1');
 const first=f.store.write('j','rev1','rev2');const second=other.write('j','rev1','conflicting-rev2');
 const rejected=assert.rejects(second,/RECOVERY_CHANGED/);await first;await rejected;
 assert.equal(f.data.get('j'),'rev2');assert.equal(f.writes.length,1);
});
test('unknown same-transaction content, missing existing data, and same-revision conflicts stop without overwrite',async()=>{
 for(const conflict of ['changed-backup','same-revision-other-write',undefined]){
  const f=fixture();f.data.set('j','old');f.vault.store=async(key,value)=>{f.writes.push({key,value});if(conflict===undefined)f.data.delete(key);else f.data.set(key,conflict)};
  await assert.rejects(f.store.write('j','old','new'),/RECOVERY_CHANGED/);assert.equal(f.writes.length,1);assert.equal(f.data.get('j'),conflict);assert.equal(f.listeners.size,0);
 }
});
test('expired confirmation retains pending write and later callers do not issue a second mutation',async()=>{
 const f=fixture();f.data.set('j','old');f.vault.store=async(key,value)=>{f.writes.push({key,value})};
 const pending=f.store.write('j','old','new'),rejected=assert.rejects(pending,/RECOVERY_SAVE_NOT_VERIFIED/);await settle();await f.clock.advance(1000);await rejected;
 assert.equal(await f.store.pendingInstallMatches('j','old','new'),true);
 const second=f.store.write('j','old','overwrite'),again=assert.rejects(second,/RECOVERY_SAVE_NOT_VERIFIED/);await settle();await f.clock.advance(1000);await again;
 assert.equal(f.writes.length,1);assert.equal(f.data.get('j'),'old');assert.equal(f.listeners.size,0);
});
test('hung read is bounded and late results/events cannot write or acknowledge a newer operation',async()=>{
 const f=fixture();let resolve;f.vault.get=()=>new Promise(done=>{resolve=done});
 const pending=f.store.write('j',undefined,'new'),rejected=assert.rejects(pending,/RECOVERY_SAVE_NOT_VERIFIED/);await settle();await f.clock.advance(1000);await rejected;
 resolve(undefined);f.emit('j');await settle();assert.equal(f.writes.length,0);assert.equal(f.listeners.size,0);
});
test('acknowledged revision regressing through delayed echo is freshly read again, not served from memory',async()=>{
 const f=fixture();f.data.set('j','old');await f.store.write('j','old','new');f.data.set('j','old');
 let done=false;const reading=f.store.read('j').then(value=>{done=true;return value});await settle();assert.equal(done,false);
 f.data.set('j','new');f.emit('j');assert.equal(await reading,'new');assert.equal(f.writes.length,1);
});
test('confirmed deletion waits out delayed old echo and preserves unknown replacement content',async()=>{
 const f=fixture();f.data.set('j','old');let stale=true;
 f.vault.get=async key=>f.writes.length&&stale?'old':f.data.get(key);
 const removal=f.store.remove('j','old');await settle();assert.equal(f.writes.length,1);stale=false;f.emit('j');await removal;
 f.data.set('j','new-transaction');assert.equal(await f.store.read('j'),'new-transaction');
 await assert.rejects(f.store.remove('j','old'),/RECOVERY_CHANGED/);assert.equal(f.data.get('j'),'new-transaction');
});
