const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ComponentCoordination } = require('../out/component-coordination');

function fixture(options = {}) {
  const hosts = [1, 2, 3].map(pid => ({ pid, startIdentity: `host-${pid}` }));
  const hubs = new Map(hosts.map(host => [host.pid, { pid: host.pid + 10, startIdentity: `hub-${host.pid}` }]));
  const events = [];
  const runtime = {
    assertOperation: async () => { if (options.lostLock) throw Error('lost lock'); },
    census: async () => ({ complete: !options.incomplete, unknown: false, hosts: [...hosts], hubs: [...hubs.values()] }),
    participant: host => ({ host,
      prepare: async () => {
        events.push(`prepare:${host.pid}`);
        if (options.unsupported === host.pid) throw Error('unsupported');
        return { host, hub: hubs.get(host.pid), contract: '1.8.0' };
      },
      stop: async () => {
        events.push(`stop:${host.pid}`);
        if (options.earlyAck !== host.pid) hubs.delete(host.pid);
        if (options.stopFailure === host.pid) throw Error('stop failed after exit');
      },
      resume: async () => {
        events.push(`resume:${host.pid}`);
        if (options.restoreFailure === host.pid) throw Error('restore failed');
        hubs.set(host.pid, { pid: host.pid + 20, startIdentity: `new-${host.pid}` });
      },
      release: async () => { events.push(`release:${host.pid}`); },
    }),
  };
  return { group: new ComponentCoordination(runtime), hosts, hubs, events, options };
}
test('all hosts stop before storage admission; restore verifier then peers', async () => {
  const f = fixture(); await f.group.prepare(); await f.group.stop(); await f.group.assertStopped();
  assert.equal(f.hubs.size, 0);
  await f.group.resume(f.hosts[0]);
  await assert.rejects(f.group.assertStopped(), { code: 'COMPONENTS_NOT_STOPPED' });
  await f.group.close(); assert.equal(f.hubs.size, 3);
  assert.equal(f.events.filter(v => v === 'resume:1').length, 1);
});
test('unsupported participant releases preparation without stopping anyone', async () => {
  const f = fixture({ unsupported: 2 }); await assert.rejects(f.group.prepare());
  assert.equal(f.hubs.size, 3); assert.deepEqual(f.events, ['prepare:1', 'prepare:2', 'release:1', 'release:2']);
});
test('partial stop failure restores earlier and ambiguous failing participant', async () => {
  const f = fixture({ stopFailure: 2 }); await f.group.prepare(); await assert.rejects(f.group.stop());
  await assert.rejects(f.group.assertStopped()); await f.group.close();
  assert.equal(f.hubs.size, 3); assert.ok(f.events.includes('resume:2')); assert.ok(!f.events.includes('stop:3'));
});
test('early stop acknowledgement cannot authorize credential write', async () => {
  const f = fixture({ earlyAck: 2 }); await f.group.prepare();
  await assert.rejects(f.group.stop(), { code: 'COMPONENT_RESTART_DURING_WRITE' }); await f.group.close();
});
test('hubless new host and new Hub both invalidate stopped admission', async () => {
  const f = fixture(); await f.group.prepare(); await f.group.stop();
  f.hosts.push({ pid: 4, startIdentity: 'new-host' });
  await assert.rejects(f.group.assertStopped(), { code: 'COMPONENT_PARTICIPANTS_CHANGED' });
  f.hosts.pop(); f.hubs.set(4, { pid: 44, startIdentity: 'new-hub' });
  await assert.rejects(f.group.assertStopped(), { code: 'COMPONENT_RESTART_DURING_WRITE' }); await f.group.close();
});
test('restore failure is reported while still attempting every other participant', async () => {
  const f = fixture({ restoreFailure: 1 }); await f.group.prepare(); await f.group.stop();
  await assert.rejects(f.group.close(), { code: 'COMPONENT_RESTORE_FAILED' });
  assert.ok(f.events.includes('resume:3')); assert.equal(f.hubs.size, 2);
  f.options.restoreFailure = undefined; await f.group.close();
  assert.equal(f.hubs.size, 3); // failed close retains a recovery path
});
test('close cannot race an actual pending stop', async () => {
  const f = fixture(); await f.group.prepare();
  const stopping = f.group.stop();
  await assert.rejects(f.group.close(), { code: 'COMPONENT_ACTION_PENDING' });
  await stopping; await f.group.close(); assert.equal(f.hubs.size, 3);
});
test('cancel after preparation releases participants without interruption', async () => {
  const f = fixture(); await f.group.prepare(); await f.group.close();
  assert.equal(f.hubs.size, 3); assert.ok(!f.events.some(v => v.startsWith('stop:')));
});
test('concurrent or repeated stop cannot enter a second transaction', async () => {
  const f = fixture(); await f.group.prepare(); await f.group.stop();
  await assert.rejects(f.group.stop(), { code: 'COMPONENT_TRANSACTION_STATE' }); await f.group.close();
});
test('rollback can stop the restored verifier while peers remain stopped', async () => {
  const f = fixture(); await f.group.prepare(); await f.group.stop(); await f.group.resume(f.hosts[0]);
  await f.group.stop(); await f.group.assertStopped(); await f.group.close();
  assert.equal(f.events.filter(v => v === 'stop:1').length, 2);
  assert.equal(f.events.filter(v => v === 'stop:2').length, 1);
});
test('failed resume revokes stopped admission even when census is temporarily empty', async () => {
  const f = fixture({ restoreFailure: 1 }); await f.group.prepare(); await f.group.stop();
  await assert.rejects(f.group.resume(f.hosts[0]), { code: 'COMPONENT_RESTORE_FAILED' });
  assert.equal(f.hubs.size, 0);
  await assert.rejects(f.group.stop());
  await assert.rejects(f.group.assertStopped(), { code: 'COMPONENTS_NOT_STOPPED' });
  f.options.restoreFailure = undefined;
  await f.group.resume(f.hosts[0]); await f.group.stop(); await f.group.assertStopped(); await f.group.close();
});
function verifiedFixture() {
  const { componentIdentityDigest } = require('../out/component-coordination');
  const hosts = [1, 2].map(pid => ({pid, startIdentity: `host-${pid}`}));
  const original = hosts.map(h => ({pid:h.pid+10,startIdentity:`old-${h.pid}`}));
  const hubs = new Map(hosts.map((h,i)=>[h.pid,original[i]]));
  const flags = { legacy:false, bad:false, contract:false }, events=[];
  const group = new ComponentCoordination({ requireVerification:true, revalidateStopped:true,
    assertOperation:async()=>{}, census:async()=>({complete:true,unknown:false,hosts,hubs:[...hubs.values()]}),
    participant:host=>({host,
      prepare:async()=>{ if(flags.contract)throw Error('configuration changed'); return {host,hub:hubs.get(host.pid)||original[host.pid-1],contract:'1.8.0',...(!hubs.has(host.pid)?{stopped:true}:{}),...(!flags.legacy?{verification:'identity-v1'}:{})}; },
      stop:async()=>{events.push('stop');if(flags.stopFailure)throw Error('hook failed before exit');hubs.delete(host.pid);},
      resume:async()=>{if(!hubs.has(host.pid))hubs.set(host.pid,{pid:host.pid+20,startIdentity:`new-${host.pid}`});},
      verify:async challenge=>({host,hub:hubs.get(host.pid),digest:componentIdentityDigest(flags.bad&&host.pid===2?'wrong@example.test':'expected@example.test',challenge)}),
      release:async()=>{events.push('release');}
    }) });
  return {group,flags,events,hubs};
}
test('fresh all-peer identity gates release and mismatch can be retried without rewriting',async()=>{
  const f=verifiedFixture(), challenge=require('node:crypto').randomUUID();
  await f.group.prepare();await f.group.stop();await f.group.resume();f.flags.bad=true;
  await assert.rejects(f.group.verifyAll('expected@example.test',challenge),{code:'COMPONENT_IDENTITY_UNVERIFIED'});
  await assert.rejects(f.group.close(),{code:'COMPONENT_IDENTITY_UNVERIFIED'});
  assert.equal(f.events.includes('release'),false);
  f.flags.bad=false;await f.group.verifyAll('expected@example.test',challenge);await f.group.close();
  assert.equal(f.events.filter(x=>x==='stop').length,2);assert.equal(f.events.filter(x=>x==='release').length,2);
});
test('legacy actor is rejected before stop and current contract is rechecked while stopped',async()=>{
  const old=verifiedFixture();old.flags.legacy=true;await assert.rejects(old.group.prepare(),{code:'COMPONENT_CONTRACT_UNSUPPORTED'});assert.equal(old.events.includes('stop'),false);
  const f=verifiedFixture();await f.group.prepare();await f.group.stop();f.flags.contract=true;
  await assert.rejects(f.group.assertStopped(),/configuration changed/);
  await f.group.resume();assert.equal(f.hubs.size,2);
});

test('failed stop leaving original alive can fresh-verify cleanup without pretending restart',async()=>{
  const f=verifiedFixture();await f.group.prepare();f.flags.stopFailure=true;
  await assert.rejects(f.group.stop(),/hook failed/);await f.group.resume();
  await f.group.verifyAll('expected@example.test',require('node:crypto').randomUUID());
  await f.group.close();assert.equal(f.events.filter(x=>x==='release').length,2);
});

test('explicit no-write cancellation restores/releases but cannot bypass failed identity verification',async()=>{
  const f=verifiedFixture();await f.group.prepare();await f.group.stop();await f.group.restoreBeforeWrite();
  assert.equal(f.events.filter(x=>x==='release').length,2);
  const bad=verifiedFixture();await bad.group.prepare();await bad.group.stop();await bad.group.resume();bad.flags.bad=true;
  await assert.rejects(bad.group.verifyAll('expected@example.test',require('node:crypto').randomUUID()));
  await assert.rejects(bad.group.restoreBeforeWrite(),{code:'COMPONENT_IDENTITY_UNVERIFIED'});
  assert.equal(bad.events.includes('release'),false);
});
test('failed restoration retains every actor until all resumes succeed, with bounded safe details', async () => {
  const f = fixture({ restoreFailure: 2 }); await f.group.prepare(); await f.group.stop();
  await assert.rejects(f.group.close(), error => {
    assert.deepEqual(error.componentFailures, [{ hostPid: 2, stage: 'resume', code: 'UNCLASSIFIED_ERROR' }]);
    assert.ok(!JSON.stringify(error).includes('restore failed')); return error.code === 'COMPONENT_RESTORE_FAILED';
  });
  assert.equal(f.events.some(e => e.startsWith('release:')), false);
  f.options.restoreFailure = undefined; await f.group.close();
  assert.equal(f.events.filter(e => e === 'resume:1').length, 1);
  assert.equal(f.events.filter(e => e === 'release:1').length, 1);
});
test('preparation failure is not replaced by cleanup failure', async () => {
  const { LiveError } = require('../out/live-storage');
  const group = new ComponentCoordination({ assertOperation:async()=>{}, census:async()=>({complete:true,unknown:false,hosts:[{pid:1,startIdentity:'host'}],hubs:[]}),
    participant:host=>({host,prepare:async()=>{throw new LiveError('OFFICIAL_HUB_NOT_READY');},release:async()=>{throw new LiveError('COMPONENT_ACTION_PENDING');},stop:async()=>{},resume:async()=>{}}) });
  await assert.rejects(group.prepare(), {code:'OFFICIAL_HUB_NOT_READY'});
});

test('prepare wraps participant route reason without copying private exception fields',async()=>{
 const {LiveError}=require('../out/live-storage');
 const {readLastAccountFailure}=require('../out/last-account-failure');
 const {debugErrorData}=require('../out/debug-events');
 const host={pid:42,startIdentity:'synthetic'},hub={pid:43,startIdentity:'synthetic-hub'};
 const group=new ComponentCoordination({assertOperation:async()=>{},census:async()=>({complete:true,unknown:false,hosts:[host],hubs:[hub]}),participant:()=>({host,prepare:async()=>{throw Object.assign(new LiveError('WSL_FILE_ROUTE_UNVERIFIED'),{fileRouteFailureReason:'pid-marker-mismatch',token:'PRIVATE_TOKEN'});},release:async()=>{}})});
 await assert.rejects(group.prepare(),e=>{assert.equal(e.hostPid,42);assert.equal(e.fileRouteFailureReason,'pid-marker-mismatch');const data=debugErrorData(e);assert.doesNotMatch(JSON.stringify(data),/PRIVATE_TOKEN/);assert.equal(readLastAccountFailure({schema:1,at:'2026-10-25T07:57:55.699Z',action:'switch',stage:'prepare',phase:'none',...data}).fileRouteFailureReason,'pid-marker-mismatch');return true;});
});
