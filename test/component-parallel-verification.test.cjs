const {test}=require('node:test'),assert=require('node:assert/strict');
const {ComponentCoordination,componentIdentityDigest}=require('../out/component-coordination');
const {LiveError}=require('../out/live-storage');
const challenge=require('node:crypto').randomUUID();
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
async function fixture(options={}){
 const hosts=[1,2,3].map(pid=>({pid,startIdentity:`host-${pid}`}));
 const old=new Map(hosts.map(h=>[h.pid,{pid:10+h.pid,startIdentity:'old-'+h.pid}])),hubs=new Map(old),events=[],samples=[];
 let active=0,peak=0;
 const group=new ComponentCoordination({requireVerification:true,
  timing:s=>{samples.push(s);if(options.throwObserver)throw Error('display');},
  assertOperation:async()=>{if(options.lost)throw new LiveError('LOCK_OWNERSHIP_CHANGED');},
  census:async()=>({complete:true,unknown:false,hosts,hubs:[...hubs.values(),...(options.extraHub?[{pid:999,startIdentity:'new-unknown'}]:[])]}),
  participant:host=>({host,prepare:async()=>({host,hub:hubs.get(host.pid)||old.get(host.pid),contract:'1.8.0',verification:'identity-v1'}),
   stop:async()=>{events.push('stop:'+host.pid);hubs.delete(host.pid);},
   resume:async()=>{events.push('resume:'+host.pid);hubs.set(host.pid,{pid:20+host.pid,startIdentity:'new-'+host.pid});},
   verify:async challenge=>{active++;peak=Math.max(peak,active);events.push('start:'+host.pid);try{
    await options.verify?.(host.pid);
    if(options.fail===host.pid)throw new LiveError('COMPONENT_ACTION_PENDING');
    return{host,hub:options.oldBirth===host.pid?old.get(host.pid):hubs.get(host.pid),digest:componentIdentityDigest(options.wrong===host.pid?'wrong@example.test':'expected@example.test',challenge)};
   }finally{active--;events.push('end:'+host.pid);}},release:async()=>events.push('release:'+host.pid)})});
 await group.prepare();await group.stop();assert.equal(hubs.size,0);await group.resume();
 return{group,events,samples,options,get peak(){return peak;},get active(){return active;}};
}
test('two-worker bound settles every participant and observers cannot affect success',async()=>{
 const a=deferred(),b=deferred();const f=await fixture({throwObserver:true,verify:pid=>pid===1?a.promise:pid===2?b.promise:undefined});
 let done=false;const run=f.group.verifyAll('expected@example.test',challenge).then(()=>{done=true;});await new Promise(r=>setImmediate(r));
 assert.equal(f.active,2);assert.ok(!f.events.includes('start:3'));a.resolve();await new Promise(r=>setImmediate(r));assert.ok(f.events.includes('end:3'));assert.equal(done,false);
 b.resolve();await run;assert.equal(f.peak,2);await f.group.close();assert.equal(f.events.filter(x=>x.startsWith('release:')).length,3);
 assert.equal(f.samples.filter(s=>s.wait==='fresh-identity-ack').length,3);
 assert.ok(f.samples.every(s=>Number.isInteger(s.elapsedMs)&&s.elapsedMs>=0&&s.total===3&&s.participant>=1&&s.participant<=3));
 assert.doesNotMatch(JSON.stringify(f.samples),/host-|expected|token|pid|path/);
});
test('timeout failure waits for late sibling, forbids close and preserves failures for retry',async()=>{
 const late=deferred();const f=await fixture({fail:1,verify:pid=>pid===2?late.promise:undefined});
 let settled=false;const run=f.group.verifyAll('expected@example.test',challenge).then(()=>{throw Error('unexpected');},e=>{settled=true;return e;});await new Promise(r=>setImmediate(r));
 assert.equal(settled,false);assert.equal(f.active,1);assert.ok(f.events.includes('end:3'));await assert.rejects(f.group.close(),{code:'COMPONENT_ACTION_PENDING'});assert.ok(!f.events.some(e=>e.startsWith('release:')));
 late.resolve();assert.equal((await run).code,'COMPONENT_ACTION_PENDING');await assert.rejects(f.group.close(),{code:'COMPONENT_IDENTITY_UNVERIFIED'});
 f.options.fail=undefined;await f.group.verifyAll('expected@example.test',challenge);await f.group.close();assert.equal(f.events.filter(e=>e.startsWith('resume:')).length,3);
});
for(const fault of ['wrong','oldBirth','extraHub'])test('parallel proof still rejects '+fault+' and never releases',async()=>{
 const f=await fixture();f.options[fault]=fault==='extraHub'?true:2;await assert.rejects(f.group.verifyAll('expected@example.test',challenge),{code:fault==='extraHub'?'COMPONENT_PARTICIPANTS_CHANGED':'COMPONENT_IDENTITY_UNVERIFIED'});
 assert.equal(f.events.filter(e=>e.startsWith('end:')).length,3);await assert.rejects(f.group.close());assert.ok(!f.events.some(e=>e.startsWith('release:')));
});
test('lock loss during parallel read waits for dispatched work and blocks commit',async()=>{
 const gate=deferred();const f=await fixture({verify:()=>gate.promise});const run=f.group.verifyAll('expected@example.test',challenge);await new Promise(r=>setImmediate(r));f.options.lost=true;gate.resolve();await assert.rejects(run,{code:'LOCK_OWNERSHIP_CHANGED'});assert.equal(f.active,0);assert.ok(!f.events.includes('start:3'));
});
test('synthetic 3x100ms read latency uses two waves instead of three; not a native speed claim',async t=>{
 const wait=()=>new Promise(r=>setTimeout(r,100));const f=await fixture({verify:wait});let start=performance.now();for(let i=0;i<3;i++)await wait();const sequential=performance.now()-start;
 start=performance.now();await f.group.verifyAll('expected@example.test',challenge);const parallel=performance.now()-start;
 t.diagnostic(JSON.stringify({synthetic:true,participants:3,limit:2,sequentialMs:Math.round(sequential),parallelMs:Math.round(parallel),peak:f.peak}));
 assert.equal(f.peak,2);assert.ok(parallel>=180); // no flaky speed ratio assertion; deterministic overlap tested above
});
