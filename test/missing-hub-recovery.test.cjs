const test = require('node:test');
const assert = require('node:assert/strict');
const { MissingHubRecovery } = require('../out/missing-hub-recovery');
const { generation } = require('../out/live-hub');
// Handwritten lifecycle model based on the complete 1.8/1.9 static excerpts,
// Library libfile_9d4247a68614819191b479457ee11217. No official code is executed.
// Both versions: reconnect returns before setup, refresh with an existing view
// starts setup, first focus resolves a missing view, port is a live getter.
function fixture({ version = '1.8.0', view = true, peers = 0 } = {}) {
  const f = { version, view, port: undefined, count: 0, calls: [], held: false, starts: 0, autoStart: true, proofError: false, signedOut: false, birth: '12345', peerBirth: '23456', peers };
  const api = { get port() { return f.port; }, csrfToken: 'synthetic-capability' };
  const peerRows = () => Array.from({length:f.peers}, (_,i) => ({id:`peer-${i}`,pid:800+i,owner:'other',scope:'other-window',parentState:'alive',credentialScopeVerified:true}));
  const setup = () => { if (f.starting || f.count) return; f.starting = true; ++f.starts; if (f.autoStart) f.ready(); };
  f.officialStart = setup;
  f.ready = () => { f.starting = false; f.count = 1; f.port = 32123; };
  f.runtime = {
    api: () => api, assertCurrent() {},
    scan: async () => ({currentCount:f.port && f.count ? 1 : 0,totalCount:f.count+f.peers,processes:[...peerRows(),...(!f.port && f.count ? [{owner:'other',scope:'current-window',credentialScopeVerified:true}] : [])],...(f.port && f.count ? {current:{credentialScopeVerified:true}} : {})}),
    identity: () => f.port && f.count ? {pid:710,startTicks:f.birth} : undefined,
    peerIdentity: () => JSON.stringify(peerRows().map(row=>({...row,birth:f.peerBirth,boot:'synthetic',commandHash:'verified'}))),
    execute: async command => { f.calls.push(command); if(command==='antigravity.reconnect' && f.view) setup(); if(command==='antigravity.panel.focus' && !f.view) {f.view=true;setup();} },
    proof: async () => { if(f.proofError) throw Error('HUB_RPC_FAILED'); return {generation:generation(api),signedOut:f.signedOut}; },
    wait: async () => new Promise(resolve=>setTimeout(resolve,1)),
  };
  f.hold = async fn => { assert.equal(f.held,false);f.held=true;try{return await fn();}finally{f.held=false;} };
  f.recovery = new MissingHubRecovery();
  return f;
}
for(const version of ['1.8.0','1.9.0']) for(const view of [true,false]) test(`${version} ${view?'resolved':'unresolved'} view recovery with three peers follows actual refresh/focus contract`,async()=>{
  const f=fixture({version,view,peers:3});
  await f.recovery.run(f.runtime,f.hold,1000);
  assert.equal(f.starts,1);assert.equal(f.held,false);assert.equal(f.peers,3);
  assert.deepEqual(f.calls,['antigravity.reconnect','antigravity.panel.focus']);
});
for(const row of [{owner:'unknown',scope:'unknown'},{owner:'other',scope:'current-window'},{owner:'detached',scope:'detached'},{owner:'other',scope:'other-window',credentialScopeVerified:false}]) test(`unproven ${row.scope} process prevents dispatch`,async()=>{
 const f=fixture();f.runtime.scan=async()=>({currentCount:0,totalCount:1,processes:[row]});
 await assert.rejects(f.recovery.run(f.runtime,f.hold,100));assert.deepEqual(f.calls,[]);assert.equal(f.held,false);
});
for(const cancel of [false,true]) test(`early command return then ${cancel?'cancel':'timeout'} retains launch fence; recheck never dispatches again`,async()=>{
 const f=fixture();f.autoStart=false;
 const attempt=f.recovery.run(f.runtime,f.hold,15);
 while(!f.calls.length) await new Promise(setImmediate);
 if(cancel) f.recovery.cancel();
 await assert.rejects(attempt,cancel?/HUB_RECOVERY_CANCELLED/:/HUB_RECOVERY_TIMEOUT/);
 assert.equal(f.held,true);assert.equal(f.recovery.pending,true);
 const calls=f.calls.length;
 await assert.rejects(f.recovery.run(f.runtime,f.hold,15),/HUB_RECOVERY_PENDING/);
 const joined=f.recovery.observe(1000);f.ready();await joined;
 assert.equal(f.calls.length,calls);assert.equal(f.starts,1);assert.equal(f.held,false);
});
test('process may precede dynamic port; signed-out response completes component recovery',async()=>{
 const f=fixture({peers:2});f.autoStart=false;f.signedOut=true;
 const attempt=f.recovery.run(f.runtime,f.hold,1000);
 while(!f.calls.length) await new Promise(setImmediate);
 f.count=1;await new Promise(resolve=>setTimeout(resolve,5));assert.equal(f.held,true);
 f.ready();assert.equal(await attempt,'signed-out');assert.equal(f.held,false);
});
test('RPC failure does not release launch fence; later fresh proof completes same attempt',async()=>{
 const f=fixture();f.proofError=true;
 await assert.rejects(f.recovery.run(f.runtime,f.hold,15),/HUB_RECOVERY_TIMEOUT/);
 assert.equal(f.held,true);f.proofError=false;await f.recovery.observe(1000);assert.equal(f.held,false);assert.equal(f.starts,1);
});
test('peer replacement never reports success and does not target or stop the replacement',async()=>{
 const f=fixture({peers:1});f.autoStart=false;
 const attempt=f.recovery.run(f.runtime,f.hold,1000);
 while(!f.calls.length) await new Promise(setImmediate);
 f.peerBirth='replacement';f.ready();
 await assert.rejects(attempt,/HUB_CHANGED_DURING_OPERATION/);assert.equal(f.held,false);assert.equal(f.starts,1);
});
test('confirmed restart stops only pinned current before starting; command return is not stop completion',async()=>{
 const f=fixture({peers:3});f.ready();let finish;
 f.runtime.stop=async()=>{f.calls.push('stop-current');await new Promise(resolve=>{finish=resolve});f.count=0;f.port=undefined;};
 f.runtime.expectedCurrent={pid:710,startTicks:f.birth};
 const attempt=f.recovery.run(f.runtime,f.hold,1000);
 while(!finish) await new Promise(setImmediate);
 assert.deepEqual(f.calls,['stop-current']);finish();await attempt;
 assert.deepEqual(f.calls,['stop-current','antigravity.reconnect','antigravity.panel.focus']);assert.equal(f.peers,3);
});
test('confirmation cannot adopt a replaced current birth',async()=>{
 const f=fixture();f.ready();f.runtime.expectedCurrent={pid:710,startTicks:'old'};f.runtime.stop=async()=>f.calls.push('stop');
 await assert.rejects(f.recovery.run(f.runtime,f.hold,100),/HUB_CHANGED_DURING_OPERATION/);assert.deepEqual(f.calls,[]);
});
for(const timing of ['before-stop-return','between-empty-scans']) test(`official automatic restart ${timing} completes without a second start sequence`,async()=>{
 const f=fixture({peers:2});f.ready();f.runtime.expectedCurrent={pid:710,startTicks:f.birth};
 let stopped=false,scans=0;const scan=f.runtime.scan;
 f.runtime.stop=async()=>{stopped=true;f.count=0;f.port=undefined;if(timing==='before-stop-return'){f.birth='replacement';f.ready();}};
 f.runtime.scan=async()=>{if(stopped && timing==='between-empty-scans' && ++scans===2){f.birth='replacement';f.ready();}return scan();};
 await f.recovery.run(f.runtime,f.hold,1000);assert.deepEqual(f.calls,[]);assert.equal(f.held,false);
});
test('restart timeout during real stop keeps fence and completes one authorized restart when stop returns',async()=>{
 const f=fixture();f.ready();f.runtime.expectedCurrent={pid:710,startTicks:f.birth};let finish;
 f.runtime.stop=async()=>{await new Promise(resolve=>{finish=resolve});f.count=0;f.port=undefined;f.birth='new';};
 await assert.rejects(f.recovery.run(f.runtime,f.hold,15),/HUB_RECOVERY_TIMEOUT/);assert.equal(f.held,true);assert.deepEqual(f.calls,[]);
 finish();await f.recovery.observe(1000);assert.equal(f.starts,1);assert.equal(f.held,false);
});
test('scan failure after dispatch preserves fence and a later successful scan can complete',async()=>{
 const f=fixture();let failed=true;const scan=f.runtime.scan;
 f.runtime.scan=async()=>{if(f.calls.length && failed)throw Error('PROCESS_CHECK_FAILED');return scan();};
 await assert.rejects(f.recovery.run(f.runtime,f.hold,15),/HUB_RECOVERY_TIMEOUT/);assert.equal(f.held,true);
 failed=false;await f.recovery.observe(1000);assert.equal(f.held,false);assert.equal(f.starts,1);
});
for(const phase of ['confirmation','second-scan']) test(`capability replacement during ${phase} prevents all dispatch`,async()=>{
 const f=fixture();f.port=32122;f.runtime.expectedGeneration=generation(f.runtime.api());
 if(phase==='confirmation')f.port=32123;
 else{let scans=0;const scan=f.runtime.scan;f.runtime.scan=async()=>{if(++scans===2)f.port=32123;return scan();};}
 await assert.rejects(f.recovery.run(f.runtime,f.hold,1000),/HUB_CHANGED_DURING_OPERATION/);assert.deepEqual(f.calls,[]);assert.equal(f.held,false);
});
test('second old-gone scan is followed immediately by dispatch without an extra race window',async()=>{
 const f=fixture();f.ready();f.runtime.expectedCurrent={pid:710,startTicks:f.birth};let waits=0;
 f.runtime.wait=async()=>{++waits;};
 f.runtime.stop=async()=>{f.count=0;f.port=undefined;f.birth='new';};
 const execute=f.runtime.execute;f.runtime.execute=async command=>{if(command==='antigravity.reconnect')assert.equal(waits,2);return execute(command);};
 await f.recovery.run(f.runtime,f.hold,1000);assert.equal(f.held,false);
});
test('cancel before dispatch makes no official call and releases its guard',async()=>{
 const f=fixture();let begin;
 const hold=fn=>new Promise(resolve=>{begin=()=>resolve(f.hold(fn));});
 const attempt=f.recovery.run(f.runtime,hold,1000);
 while(!begin)await new Promise(setImmediate);f.recovery.cancel();begin();
 await assert.rejects(attempt,/HUB_RECOVERY_CANCELLED/);await new Promise(setImmediate);
 assert.deepEqual(f.calls,[]);assert.equal(f.held,false);assert.equal(f.recovery.pending,false);
});
test('settled stop failure never dispatches start or reports restart success',async()=>{
 const f=fixture();f.ready();f.runtime.expectedCurrent={pid:710,startTicks:f.birth};
 f.runtime.stop=async()=>{throw Error('synthetic stop denied');};
 await assert.rejects(f.recovery.run(f.runtime,f.hold,1000),/HUB_CHANGED_DURING_OPERATION/);
 assert.deepEqual(f.calls,[]);assert.equal(f.held,false);
});
// 1.9 supplemental source: libfile_f7277e362f1881918a9ba0d12df76046.
// cancelPendingRecovery only cancels a timer, not an already running
// restart()->await stop()->start(). The model deliberately lets it resume.
test('1.9 in-flight automatic recovery resumes after manual dispatch and coalesces on startingPromise',async()=>{
 const f=fixture({version:'1.9.0',peers:3});f.autoStart=false;
 let finishAutoStop;const automatic=(async()=>{await new Promise(resolve=>{finishAutoStop=resolve});f.officialStart();})();
 await assert.rejects(f.recovery.run(f.runtime,f.hold,15),/HUB_RECOVERY_TIMEOUT/);
 assert.equal(f.starts,1);assert.equal(f.held,true);
 finishAutoStop();await automatic;assert.equal(f.starts,1);assert.equal(f.held,true);
 f.ready();await f.recovery.observe(1000);assert.equal(f.peers,3);assert.equal(f.held,false);
});
test('1.9 late official exit clearing live exports during proof cannot report readiness',async()=>{
 const f=fixture({version:'1.9.0',peers:2});let first=true;const proof=f.runtime.proof;
 f.runtime.proof=async()=>{const result=await proof();if(first){first=false;f.count=1;f.port=undefined;}return result;};
 await assert.rejects(f.recovery.run(f.runtime,f.hold,15),/HUB_RECOVERY_TIMEOUT/);assert.equal(f.held,true);
 const commands=f.calls.length;f.birth='later-auto-birth';f.ready();await f.recovery.observe(1000);
 assert.equal(f.calls.length,commands);assert.equal(f.held,false);
});
test('1.9 second stop may return while the first stop still owns a living old process',async()=>{
 const f=fixture({version:'1.9.0',peers:2});f.ready();f.runtime.expectedCurrent={pid:710,startTicks:f.birth};
 f.runtime.stop=async()=>{f.port=undefined;}; // old process remains; manager reference was cleared by the earlier stop
 await assert.rejects(f.recovery.run(f.runtime,f.hold,15),/HUB_RECOVERY_TIMEOUT/);
 assert.equal(f.held,true);assert.deepEqual(f.calls,[]);
 const joined=f.recovery.observe(1000);f.birth='auto-replacement';f.ready();await joined;
 assert.deepEqual(f.calls,[]);assert.equal(f.held,false);
});
test('automatic startup during final old-gone scan is observed instead of blindly reconnecting',async()=>{
 const f=fixture({version:'1.9.0'});f.ready();f.runtime.expectedCurrent={pid:710,startTicks:f.birth};
 let stopped=false,scans=0;const scan=f.runtime.scan;
 f.runtime.stop=async()=>{stopped=true;f.count=0;f.port=undefined;};
 f.runtime.scan=async()=>{const state=await scan();if(stopped && ++scans===2){f.birth='auto-new';f.ready();}return state;};
 await f.recovery.run(f.runtime,f.hold,1000);assert.deepEqual(f.calls,[]);assert.equal(f.held,false);
});
