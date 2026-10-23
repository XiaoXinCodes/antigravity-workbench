const test=require('node:test');
const assert=require('node:assert/strict');
const {admitReadyOfficialWrite}=require('../out/official-write-admission');
const settle=()=>new Promise(setImmediate);
// Faithful relevant manager sequencing from the exact 1.8/1.9 excerpts; synthetic
// process objects only. stop clears refs before awaiting exit or its 5000ms timer.
function fixture(){
 let current={birth:'C',port:45678},clock=0,serial=0;const timers=[],events=[];
 const schedule=(fn,ms)=>timers.push({at:clock+ms,fn});
 const start=()=>{if(current){events.push('reuse');return current;}events.push('spawn');return current={birth:`new-${++serial}`,port:45678};};
 const stop=()=>{current=undefined;return new Promise(resolve=>schedule(resolve,5000));};
 const advance=async ms=>{clock+=ms;while(timers.some(t=>t.at<=clock)){timers.sort((a,b)=>a.at-b.at);timers.shift().fn();await settle();}};
 return {events,start,stop,advance,schedule,set:x=>{current=x},ready:async()=>{if(!current)throw Error('OFFICIAL_HUB_NOT_READY');return JSON.stringify(current)},wait:async ms=>{assert.equal(ms,5000);await advance(ms);}};
}
test('ready 1.8 admits immediately, while missing current never obtains admission',async()=>{
 const f=fixture();let waits=0;await admitReadyOfficialWrite('1.8.0',f.ready,async()=>{waits++});assert.equal(waits,0);
 f.set(undefined);await assert.rejects(admitReadyOfficialWrite('1.8.0',f.ready),/OFFICIAL_HUB_NOT_READY/);
});
for(const completion of ['timeout','exit']) test(`1.9 prior stop by ${completion} drains before own stop/write`,async()=>{
 const f=fixture();let exit;
 const oldStop=completion==='timeout'?f.stop():new Promise(r=>{exit=r;f.set(undefined)});
 const recovery=oldStop.then(()=>f.start());f.set({birth:'C',port:45678});
 if(exit)f.schedule(exit,50);
 await admitReadyOfficialWrite('1.9.0',f.ready,f.wait);await recovery;assert.deepEqual(f.events,['reuse']);
 const stopped=f.stop();await f.advance(5000);await stopped;f.events.push('write');await f.advance(10000);
 assert.deepEqual(f.events,['reuse','write']);
});
test('naive ready-only stop permits a prior automatic restart during write',async()=>{
 const f=fixture(),recovery=f.stop().then(()=>f.start());f.set({birth:'C',port:45678});
 await f.ready();const ownStop=f.stop();await f.advance(5000);await Promise.all([recovery,ownStop]);
 assert.deepEqual(f.events,['spawn']);assert.match(await f.ready(),/new-1/);
});
for(const change of ['clear','same-port-new-birth']) test(`ready identity ${change} during drain blocks`,async()=>{
 const f=fixture();f.schedule(()=>f.set(change==='clear'?undefined:{birth:'D',port:45678}),3000);
 await assert.rejects(admitReadyOfficialWrite('1.9.0',f.ready,f.wait),/OFFICIAL_HUB_NOT_READY|HUB_CHANGED_DURING_OPERATION/);
});
test('cancel during drain never grants admission or calls a stop',async()=>{
 const controller=new AbortController();let stops=0;
 const pending=admitReadyOfficialWrite('1.9.0',async()=>'ready',undefined,controller.signal).then(()=>{stops++});
 await settle();controller.abort();await assert.rejects(pending,/CANCELLED/);assert.equal(stops,0);
});
test('real same-host timers drain prior completion and its microtask before admission', {timeout:15000},async()=>{
 const events=[];
 const oldStop=new Promise(resolve=>setTimeout(resolve,5000));
 const continuation=oldStop.then(()=>{events.push('old-restart-reuses-current')});
 await admitReadyOfficialWrite('1.9.0',async()=>'same-ready-birth');
 events.push('admitted');await continuation;assert.deepEqual(events,['old-restart-reuses-current','admitted']);
});
test('overdue timer queue after a blocked event loop preserves prior stop ordering',async()=>{
 const f=fixture();const recovery=f.stop().then(()=>f.start());f.set({birth:'C',port:45678});
 await admitReadyOfficialWrite('1.9.0',f.ready,async()=>{await f.advance(60000)});
 await recovery;assert.deepEqual(f.events,['reuse']);
});
test('ready publication clears startingPromise in the same synchronous tail',async()=>{
 let port,startingPromise,release;
 startingPromise=(async()=>{try{await new Promise(r=>{release=r});port=45678;return port;}finally{startingPromise=undefined;}})();
 release();await settle();assert.equal(port,45678);assert.equal(startingPromise,undefined);
});
test('real overdue timers after event-loop blocking still drain restart first',{timeout:15000},async()=>{
 const events=[];const previous=new Promise(resolve=>setTimeout(resolve,5000)).then(()=>events.push('old-restart'));
 const admission=admitReadyOfficialWrite('1.9.0',async()=>'same-ready-birth').then(()=>events.push('admitted'));
 await settle();Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5300);
 await Promise.all([previous,admission]);assert.deepEqual(events,['old-restart','admitted']);
});
test('cancellation during final asynchronous identity check never grants admission',async()=>{
 const controller=new AbortController();let checks=0;
 await assert.rejects(admitReadyOfficialWrite('1.8.0',async()=>{if(++checks===2){await settle();controller.abort();}return 'ready';},undefined,controller.signal),/CANCELLED/);
});
test('unknown runtime contract cannot silently use the immediate 1.8 route',async()=>{
 await assert.rejects(admitReadyOfficialWrite(undefined,async()=>'ready'),/OFFICIAL_CREDENTIAL_WRITE_BARRIER_UNAVAILABLE/);
});

test('real duration-list batching overtakes a different-delay barrier but not same-delay FIFO',{timeout:15000},async()=>{
 const events=[];
 const seed=new Promise(resolve=>setTimeout(()=>{events.push('seed-5100');resolve()},5100));
 await new Promise(resolve=>setTimeout(resolve,200));
 const previous=new Promise(resolve=>setTimeout(resolve,5000)).then(()=>events.push('old-restart'));
 const unsafe=new Promise(resolve=>setTimeout(resolve,5100)).then(()=>events.push('unsafe-5100-admission'));
 const safe=admitReadyOfficialWrite('1.9.0',async()=>'same-ready-birth').then(()=>events.push('safe-5000-admission'));
 await settle();Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5500);
 await Promise.all([seed,previous,unsafe,safe]);
 assert.ok(events.indexOf('unsafe-5100-admission')<events.indexOf('old-restart'),JSON.stringify(events));
 assert.ok(events.indexOf('old-restart')<events.indexOf('safe-5000-admission'),JSON.stringify(events));
});
test('final stop cancels a not-yet-fired recovery and fences an in-flight heartbeat',async()=>{
 let stopGeneration=0,heartbeatGeneration=1,isStopping=false,pendingRecovery=true,restarts=0,releaseProbe;
 const probe=new Promise(r=>{releaseProbe=r});const expectedHeartbeat=heartbeatGeneration;
 const heartbeat=(async()=>{await probe;if(expectedHeartbeat!==heartbeatGeneration)return;restarts++})();
 const stop=()=>{stopGeneration++;isStopping=true;pendingRecovery=false;heartbeatGeneration++;};
 const f=fixture();await admitReadyOfficialWrite('1.9.0',f.ready,f.wait);stop();
 if(pendingRecovery&&!isStopping)restarts++;releaseProbe();await heartbeat;
 assert.equal(stopGeneration,1);assert.equal(restarts,0);
});
test('same-host drain alone cannot exclude another live host delayed recovery',async()=>{
 const current=fixture();let peerRunning=false,peerRestart;
 // Direct SIGTERM of a peer Hub leaves that peer manager isStopping=false.
 // Its independent host can still have a delayed recovery after local admission.
 const peerRecovery=new Promise(resolve=>{peerRestart=()=>{peerRunning=true;resolve()}});
 await admitReadyOfficialWrite('1.9.0',current.ready,current.wait);
 const ownStop=current.stop();await current.advance(5000);await ownStop;
 const writeStarted=true;peerRestart();await peerRecovery;
 assert.equal(writeStarted&&peerRunning,true);assert.equal(current.events.includes('spawn'),false);
});
