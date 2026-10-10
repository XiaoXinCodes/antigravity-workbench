const test=require('node:test'),assert=require('node:assert/strict');
const {ManualQuotaBatch,QUOTA_BATCH_LIMIT}=require('../out/quota-batch');
const account=id=>({id,expectedEmail:id+'@example.test',capturedAt:'synthetic-original',hostCurrent:true}),settle=()=>new Promise(setImmediate);
test('manual batch is serial, bounded, duplicate-safe and excludes foreign host accounts',async()=>{
 const accounts=Array.from({length:57},(_,n)=>account(String(n)));accounts.push(accounts[0],{...account('foreign'),hostCurrent:false});let active=0,max=0;const read=[];
 const batch=new ManualQuotaBatch(()=>accounts,async id=>{max=Math.max(max,++active);read.push(id);await settle();active--;},()=>{},()=>{});
 const first=batch.start();assert.equal(batch.start(),first);await first;assert.equal(max,1);assert.equal(read.length,QUOTA_BATCH_LIMIT);assert.equal(batch.getState().omitted,7);assert.equal(batch.getState().completed,50);assert.equal(batch.getState().running,false);
});
test('cancel retains the active operation until safe settlement, prevents later requests, and supports clean retry',async()=>{
 let release,cancels=0;const read=[];const batch=new ManualQuotaBatch(()=>[account('a'),account('b')],id=>{read.push(id);return new Promise(r=>release=r)},()=>cancels++,()=>{});
 const first=batch.start();await settle();batch.cancel();assert.equal(cancels,1);assert.equal(batch.getState().running,true);assert.equal(batch.start(),first);release();await first;assert.deepEqual(read,['a']);assert.equal(batch.getState().cancelled,true);
 const retry=batch.start();await settle();release();await settle();release();await retry;assert.deepEqual(read,['a','a','b']);assert.equal(batch.getState().cancelled,false);
});
test('changed or deleted queued accounts are skipped and a rejected read does not count as completed',async()=>{
 let accounts=[account('a'),account('b'),account('c'),account('d')];const read=[];
 const batch=new ManualQuotaBatch(()=>accounts,async id=>{read.push(id);if(id==='a'){accounts=[accounts[0],{...accounts[1],capturedAt:'replacement'},accounts[3]]}else throw Error('blocked');},()=>{},()=>{});
 await batch.start();assert.deepEqual(read,['a','d']);assert.equal(batch.getState().skipped,3);assert.equal(batch.getState().completed,1);
});
