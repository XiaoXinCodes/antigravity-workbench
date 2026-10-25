const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { ComponentMailbox } = require('../out/component-mailbox');
const { ComponentCoordination } = require('../out/component-coordination');
const { LiveLocks, probeProcessIdentity } = require('../out/live-lock');
const { PrivateState } = require('../out/private-state');
test('atomic replacement between open and first stat is a changed snapshot, not unsafe storage', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'component-open-race-'));
  const store = new PrivateState(root, value => value, () => ({ revision: 1 }));
  const open = fs.open;
  try {
    await store.transaction(() => {});
    const target = path.join(root, 'state.json'), replacement = path.join(root, 'replacement.json');
    await fs.writeFile(replacement, JSON.stringify({ revision: 2 }), { mode: 0o600 });
    let replaced = false;
    fs.open = async (filename, ...args) => {
      const handle = await open(filename, ...args);
      if (filename === target && !replaced) { replaced = true; await fs.rename(replacement, target); }
      return handle;
    };
    await assert.rejects(store.read(), /AUTOMATION_STORAGE_CHANGED/);
    assert.deepEqual(await store.read(), { revision: 2 });
    // A real extra hard link must still be rejected, never retried as a race.
    await fs.link(target, path.join(root, 'extra-link'));
    await assert.rejects(store.read(), /AUTOMATION_STORAGE_UNSAFE/);
  } finally { fs.open = open; await fs.rm(root, { recursive: true, force: true }); }
});
const birth = pid => ({ pid, startIdentity: `linux:00000000-0000-0000-0000-000000000000:${pid}` });
function memoryFixture(options = {}) {
  let data = { schema: 1, actors: [] }, prepared = 0, stopped = 0, resumed = 0;
  const recovery = randomUUID(), operation = { state: 'active', owner: { id: randomUUID(), owner: 'a'.repeat(64) } };
  const state = {
    read: async () => structuredClone(data),
    transaction: async work => {
      const copy = structuredClone(data), result = work(copy);
      if (options.failAck && copy.actors.some(row => row.reply?.ok)) { options.failAck = false; throw Error('ACK disk failure'); }
      data = copy; options.afterCommit?.(data); return result;
    },
  };
  const locks = { isOperationCurrent: async () => !options.lostOwner, isSharedOperationCurrent: async () => !options.lostOwner,
    inspectRecovery: async () => options.recoveryAbsent ? {state:'absent'} : ({ state: 'active', owner: { id: recovery, owner: operation.owner.owner, schema: options.offline ? 4 : 2 } }) };
  const mailbox = new ComponentMailbox('/unused', birth(1), locks, async () => ({
    prepare: async () => { prepared++; if (options.routeReason) throw Object.assign(new (require('../out/live-storage').LiveError)('WSL_FILE_ROUTE_UNVERIFIED'), {fileRouteFailureReason: options.routeReason, message:'PRIVATE_LOG', token:'PRIVATE_TOKEN'}); if (options.failPrepare) { options.failPrepare = false; throw Error('temporary route failure'); } return { host: birth(1), hub: birth(2), contract: '1.8.0', verification: 'identity-v1' }; },
    ...(options.verify ? { verify: options.verify } : {}),
    stop: async () => { stopped++; if (options.stopWait) await options.stopWait; },
    resume: async () => { resumed++; },
  }), state, async pid => options.hostExited ? {state:'dead'} : {state:'alive',startIdentity:birth(pid).startIdentity}, options.handlers);
  return { mailbox, participant: mailbox.participant(birth(1), operation, recovery, options.timeout ?? 2000),
    recovery, operation, data: () => structuredClone(data), counts: () => ({ prepared, stopped, resumed }), options };
}
test('prepare ACK persistence failure replays result without repeating action', async () => {
  const f = memoryFixture({ failAck: true }); await f.mailbox.start();
  try { const receipt = await f.participant.prepare(); assert.equal(receipt.hub.pid, 2); assert.equal(f.counts().prepared, 1); await f.participant.release(); }
  finally { f.mailbox.dispose(); }
});
test('IPC timeout keeps request identity and cleanup joins real stop settlement', async () => {
  let settle; const stopWait = new Promise(resolve => { settle = resolve; });
  const f = memoryFixture({ timeout: 350, stopWait }); await f.mailbox.start();
  try {
    await f.participant.prepare();
    await assert.rejects(f.participant.stop(), { code: 'COMPONENT_ACTION_PENDING' });
    await assert.rejects(f.participant.resume(), { code: 'COMPONENT_ACTION_PENDING' });
    assert.equal(f.counts().resumed, 0);
    settle(); await f.participant.resume(); await f.participant.release();
    assert.deepEqual(f.counts(), { prepared: 1, stopped: 1, resumed: 1 });
  } finally { settle(); f.mailbox.dispose(); }
});
test('legacy schema4 blocks actor preparation without consuming its recovery', async () => {
  const f = memoryFixture({ offline: true }); await f.mailbox.start();
  try { await assert.rejects(f.participant.prepare(), { code: 'RECOVERY_CHANGED' }); assert.equal(f.counts().prepared, 0); }
  finally { f.mailbox.dispose(); }
});
test('read-only prepare failure does not strand an unusable actor on recovery retry', async () => {
  const f = memoryFixture({ failPrepare: true }); await f.mailbox.start();
  try {
    await assert.rejects(f.participant.prepare(), { code: 'COMPONENT_PARTICIPANT_FAILED' });
    assert.equal((await f.participant.prepare()).hub.pid, 2); assert.equal(f.counts().prepared, 2);
    await f.participant.release();
  } finally { f.mailbox.dispose(); }
});
function rpc(worker, action, fields = {}) {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => { worker.off('message', reply); reject(Error('worker timeout')); }, 12000);
    function reply(value) {
      if (value.id !== id) return;
      clearTimeout(timer); worker.off('message', reply);
      if (value.error) reject(Error(value.error)); else resolve(value);
    }
    worker.on('message', reply); worker.send({ id, action, ...fields });
  });
}
test('three isolated hosts exchange durable stop ACKs and restore synthetic children', { timeout: 30000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'component-ipc-'));
  const directory = path.join(root, 'participants'), owner = 'a'.repeat(64), workers = [];
  try {
    const hosts = [];
    for (let i = 0; i < 3; i++) {
      const worker = fork(path.join(__dirname, 'helpers/component-mailbox-worker.cjs'), [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }); workers.push(worker);
      hosts.push((await rpc(worker, 'init', { root, directory, owner })).host);
    }
    const locks = new LiveLocks(root, owner), identity = await probeProcessIdentity(process.pid);
    const mailbox = new ComponentMailbox(directory, { pid: process.pid, startIdentity: identity.startIdentity }, locks, async () => { throw Error('client only'); });
    await locks.withOperation(async () => {
      const transaction = randomUUID(); await locks.beginRecovery(transaction);
      const operation = await locks.inspectOperation();
      const timings=[];
      const group = new ComponentCoordination({requireVerification:true,timing:sample=>timings.push(sample),
        assertOperation: () => locks.assertOperationHeld(),
        participant: host => mailbox.participant(host, operation, transaction, 10000),
        census: async () => ({ complete: true, unknown: false, hosts,
          hubs: (await Promise.all(workers.map(worker => rpc(worker, 'status')))).map(row => row.hub).filter(Boolean) }),
      });
      await group.prepare(); await group.stop(); await group.assertStopped();
      // Synthetic replacement only, after all observed child exits.
      const file = path.join(root, 'synthetic-token'); await fs.writeFile(file, 'synthetic-target', { mode: 0o600 });
      await group.resume(hosts[0]);
      assert.equal((await Promise.all(workers.map(worker => rpc(worker, 'status')))).filter(row => row.hub).length, 1);
      await group.resume(); await group.verifyAll('synthetic@example.test',randomUUID());
      assert.equal(timings.filter(s=>s.wait==='fresh-identity-ack'&&s.outcome==='completed').length,3);
      await locks.clearRecovery(transaction); // after every actual host's fresh synthetic proof
      await group.close();
      assert.equal((await Promise.all(workers.map(worker => rpc(worker, 'status')))).filter(row => row.hub).length, 3);
      assert.equal(await fs.readFile(file, 'utf8'), 'synthetic-target');
    });
    // A replacement operation can rejoin existing actors in the SAME recovery.
    // This models coordinator loss with surviving hosts, not a VS Code restart.
    const recovery = randomUUID();
    const build = async () => {
      const operation = await locks.inspectOperation();
      return new ComponentCoordination({
        assertOperation: () => locks.assertOperationHeld(),
        participant: host => mailbox.participant(host, operation, recovery, 10000),
        census: async () => ({ complete: true, unknown: false, hosts,
          hubs: (await Promise.all(workers.map(worker => rpc(worker, 'status')))).map(row => row.hub).filter(Boolean) }),
      });
    };
    await locks.withOperation(async () => {
      await locks.beginRecovery(recovery);
      const group = await build(); await group.prepare(); await group.stop();
      // Deliberately leave the recovery marker and stopped actors for takeover.
    });
    await locks.withOperation(async () => {
      const replacement = await build(); await replacement.prepare();
      await replacement.stop(); await replacement.assertStopped();
      try { await replacement.resume(hosts[0]); } catch (error) {
        const state = JSON.parse(await fs.readFile(path.join(directory, 'state.json'), 'utf8'));
        assert.fail(`${error.code}: ${state.actors.map(row => row.reply?.code || row.phase || 'none').join(',')}`);
      }
      await locks.clearRecovery(recovery); await replacement.close();
      assert.equal((await Promise.all(workers.map(worker => rpc(worker, 'status')))).filter(row => row.hub).length, 3);
    });
    const text = await fs.readFile(path.join(directory, 'state.json'), 'utf8');
    assert.ok(!text.includes('synthetic-target')); assert.ok(!text.includes('csrfToken'));
  } finally {
    for (const worker of workers) { try { await rpc(worker, 'quit'); } catch { worker.kill('SIGTERM'); } }
    await fs.rm(root, { recursive: true, force: true });
  }
});
test('real coordinator death and replacement host birth recover surviving stopped participants', { timeout: 30000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'component-crash-'));
  const directory = path.join(root, 'participants'), owner = 'a'.repeat(64), workers = [], hosts = [];
  const launch = async index => {
    const worker = fork(path.join(__dirname, 'helpers/component-mailbox-worker.cjs'), [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    workers[index] = worker;
    // Different VS Code profiles still share this credential scope.
    hosts[index] = (await rpc(worker, 'init', { root, directory, owner: index === 2 ? 'b'.repeat(64) : owner })).host;
  };
  try {
    for (let index = 0; index < 3; index++) await launch(index);
    const recovery = randomUUID(), hubs = (await Promise.all(workers.map(worker => rpc(worker, 'status')))).map(row => row.hub);
    await rpc(workers[0], 'coordinate-stop', { hosts, hubs, recovery });
    assert.equal((await Promise.all(workers.map(worker => rpc(worker, 'status')))).filter(row => row.hub).length, 0);
    const former = hosts[0], exited = require('node:events').once(workers[0], 'exit'); workers[0].kill('SIGKILL'); await exited;
    await launch(0); assert.notDeepEqual(hosts[0], former);
    const locks = new LiveLocks(root, owner), identity = await probeProcessIdentity(process.pid);
    const mailbox = new ComponentMailbox(directory, { pid: process.pid, startIdentity: identity.startIdentity }, locks, async () => { throw Error('client only'); });
    await locks.withOperation(async () => {
      await locks.reconcileRecovery(recovery);
      const operation = await locks.inspectOperation();
      const group = new ComponentCoordination({ recovering: true, assertOperation: () => locks.assertOperationHeld(),
        participant: host => mailbox.participant(host, operation, recovery, 10000, true),
        census: async () => ({ complete: true, unknown: false, hosts,
          hubs: (await Promise.all(workers.map(worker => rpc(worker, 'status')))).map(row => row.hub).filter(Boolean) }),
      });
      await group.prepare(); await group.stop(); await group.assertStopped();
      await group.resume(hosts[0]); await locks.clearRecovery(recovery); await group.close();
      await mailbox.restoreCompleted(operation);
    });
    assert.equal((await Promise.all(workers.map(worker => rpc(worker, 'status')))).filter(row => row.hub).length, 3);
    const metadata = JSON.parse(await fs.readFile(path.join(directory, 'state.json'), 'utf8'));
    assert.ok(metadata.actors.every(row => !row.recovery && row.host.pid !== former.pid));
  } finally {
    for (const worker of workers) { try { await rpc(worker, 'quit'); } catch { worker.kill('SIGTERM'); } }
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('legacy recovery route is bound to the exact durable actor transaction',async()=>{
 const recovery=randomUUID(),other=randomUUID();
 const state={read:async()=>({schema:1,actors:[{host:birth(1),recovery,phase:'stopped'}]})};
 const mailbox=new ComponentMailbox('/unused',birth(2),{},async()=>{},state);
 assert.equal(await mailbox.hasRestoration(),true);
 assert.equal(await mailbox.hasRestoration(recovery),true);
 await assert.rejects(mailbox.hasRestoration(other),{code:'RECOVERY_CHANGED'});
 state.read=async()=>({schema:1,actors:[{host:birth(1),recovery,phase:'stopped'},{host:birth(3),recovery:other,phase:'ready'}]});
 await assert.rejects(mailbox.hasRestoration(recovery),{code:'RECOVERY_CHANGED'});
 state.read=async()=>{throw Error('synthetic-invalid-state')};
 await assert.rejects(mailbox.hasRestoration(recovery),/synthetic-invalid-state/);
});

test('mailbox advertises only real verification capability and transports no email', async () => {
  const { componentIdentityDigest } = require('../out/component-coordination');
  const challenge = randomUUID(), email = 'private@example.test';
  const f = memoryFixture({ verify: async nonce => ({host:birth(1),hub:birth(3),digest:componentIdentityDigest(email,nonce)}) });
  await f.mailbox.start();
  try {
    assert.equal((await f.participant.prepare()).verification, 'identity-v1');
    assert.deepEqual(await f.mailbox.recoveryHosts(f.recovery), [birth(1)]);
    assert.equal(await f.mailbox.requiresVerification(f.recovery), true);
    await assert.rejects(f.mailbox.recoveryHosts(randomUUID()), {code:'RECOVERY_CHANGED'});
    await f.participant.stop(); await f.participant.resume();
    assert.equal((await f.participant.verify(challenge)).digest,componentIdentityDigest(email,challenge));
    assert.equal(JSON.stringify(f.data()).includes(email),false);
    await assert.rejects(f.participant.verify('invalid'),{code:'COMPONENT_IDENTITY_UNVERIFIED'});
    await f.participant.release();
  } finally { f.mailbox.dispose(); }
  assert.equal(await f.mailbox.requiresVerification(f.recovery), false);
  const old=memoryFixture();await old.mailbox.start();
  try { assert.equal((await old.participant.prepare()).verification,undefined);await old.participant.release(); }
  finally {old.mailbox.dispose();}
});
test('successful release preserves bounded sanitized prior failure evidence', async () => {
  const f = memoryFixture({failPrepare:true}); await f.mailbox.start();
  try {
    await assert.rejects(f.participant.prepare()); await f.participant.release();
    const row=f.data().actors[0]; assert.equal(row.reply.ok,true); assert.equal(row.recovery,undefined);
    assert.equal(row.failures.length,1); assert.equal(row.failures[0].action,'prepare');
    assert.equal(row.failures[0].code,'COMPONENT_PARTICIPANT_FAILED'); assert.ok(!JSON.stringify(row.failures).includes('temporary route'));
  } finally { f.mailbox.dispose(); }
});

test('exited participant ends waiting without replacing its pending request or issuing recovery',async()=>{
 const f=memoryFixture();await f.mailbox.start();
 try{await f.participant.prepare();f.mailbox.dispose();f.options.hostExited=true;
 await assert.rejects(f.participant.resume(),{code:'COMPONENT_PARTICIPANT_UNAVAILABLE'});
 assert.equal(f.counts().resumed,0);const id=f.data().actors[0].request.id;
 await assert.rejects(f.participant.resume(),{code:'COMPONENT_PARTICIPANT_UNAVAILABLE'});
 assert.equal(f.data().actors[0].request.id,id);
 }finally{f.mailbox.dispose();}
});

test('host restart persists ACK before effect, retains metadata across replies and rejects repeat handoff', async () => {
  let dispatched=false,effects=0,f;
  const handlers={workspaceKey:'a'.repeat(64),restartHost:async id=>{
    assert.equal(id,f.recovery);
    if(dispatched)throw new (require('../out/live-storage').LiveError)('COMPONENT_ACTION_PENDING');
    dispatched=true; // Synthetic durable dispatch-once handler contract.
    return async()=>{const actor=f.data().actors[0];assert.equal(actor.reply.ok,true);assert.equal(actor.reply.id,actor.request.id);effects++;};
  }};
  f=memoryFixture({handlers});await f.mailbox.start();
  try{await f.participant.prepare();await f.participant.stop();
    assert.equal(f.data().actors[0].reply.receipt,undefined);
    assert.deepEqual((await f.mailbox.recoveryParticipants(f.recovery))[0].lastHub,birth(2));
    assert.equal((await f.mailbox.recoveryParticipants(f.recovery))[0].workspaceKey,'a'.repeat(64));
    // Failed/unavailable component object must not prevent an authorized host handoff.
    f.mailbox.actor=undefined;await f.participant.requestRestart();assert.equal(effects,1);
    await assert.rejects(f.participant.requestRestart(),{code:'COMPONENT_ACTION_PENDING'});assert.equal(effects,1);
  }finally{f.mailbox.dispose();}
});
test('host restart ACK retry never reruns handler and effect failure preserves prior diagnostics',async()=>{
  let f,handlersRun=0,effects=0;
  const handlers={restartHost:async()=>{handlersRun++;return async()=>{effects++;throw new (require('../out/live-storage').LiveError)('OFFICIAL_BACKEND_STOP_TIMEOUT');};}};
  f=memoryFixture({handlers,failPrepare:true});await f.mailbox.start();try{
    await assert.rejects(f.participant.prepare(),{code:'COMPONENT_PARTICIPANT_FAILED'});
    await f.participant.prepare();f.options.failAck=true;await f.participant.requestRestart();
    assert.equal(handlersRun,1);assert.equal(effects,1);
    const actor=f.data().actors[0];assert.equal(actor.reply.ok,true);assert.equal(actor.recovery,f.recovery);
    assert.ok(actor.failures.some(x=>x.action==='resume'&&x.code==='OFFICIAL_BACKEND_STOP_TIMEOUT'));
    assert.ok(actor.failures.some(x=>x.action==='prepare'&&x.code==='COMPONENT_PARTICIPANT_FAILED'));
  }finally{f.mailbox.dispose();}
});
test('host restart requires operation owner, matching recovery and explicit handler',async()=>{
  let called=0;const f=memoryFixture({handlers:{restartHost:async()=>{called++;return async()=>{};}}});await f.mailbox.start();
  try{await assert.rejects(f.participant.requestRestart(),{code:'COMPONENT_CONTRACT_UNSUPPORTED'});assert.equal(called,0);
    await f.participant.prepare();f.options.offline=true;await assert.rejects(f.participant.requestRestart(),{code:'RECOVERY_CHANGED'});assert.equal(called,0);
    f.options.offline=false;f.options.lostOwner=true;await assert.rejects(f.participant.requestRestart(),{code:'LOCK_OWNERSHIP_CHANGED'});assert.equal(called,0);
  }finally{f.mailbox.dispose();}
});

function hostFinishFixture(){
 const recovery=randomUUID(),other=randomUUID(),operation={state:'active',owner:{id:randomUUID(),owner:'a'.repeat(64)}};
 const failure={action:'resume',code:'COMPONENT_PARTICIPANT_FAILED',at:new Date().toISOString()};
 let data={schema:1,actors:[{host:birth(1),recovery,phase:'restoring',failures:[failure]},{host:birth(2),recovery,phase:'ready',verification:'identity-v1',failures:[failure]},{host:birth(3),recovery:other,phase:'stopped'}]};
 const statuses=new Map([[1,{state:'dead'}],[2,{state:'alive',startIdentity:birth(2).startIdentity}]]),settings={owner:true,marker:'absent'};
 const locks={isOperationCurrent:async()=>settings.owner,inspectRecovery:async()=>({state:settings.marker})};
 const state={read:async()=>structuredClone(data),transaction:async fn=>{const copy=structuredClone(data);fn(copy);data=copy;}};
 const mailbox=new ComponentMailbox('/unused',birth(2),locks,async()=>{throw Error('NO_ACTOR_HOOKS');},state,async pid=>statuses.get(pid)??{state:'unknown'});
 return {mailbox,recovery,operation,statuses,settings,data:()=>structuredClone(data),mutate:fn=>fn(data),finish:()=>mailbox.finishHostRecovery(recovery,operation,[birth(1)],[birth(2)])};
}
test('finalized host handoff clears only named transaction markers preserving failures and other transactions',async()=>{const f=hostFinishFixture(),before=f.data();await f.finish();const after=f.data();for(const row of after.actors.slice(0,2)){assert.equal(row.recovery,undefined);assert.equal(row.phase,undefined);assert.equal(row.verification,undefined);assert.equal(row.failures.length,1);}assert.deepEqual(after.actors[2],before.actors[2]);});
test('handoff cleanup rejects live or unknown old birth, unknown new birth, marker or owner loss',async()=>{for(const kind of ['old-live','old-unknown','new-unknown','marker','owner']){const f=hostFinishFixture();if(kind==='old-live')f.statuses.set(1,{state:'alive',startIdentity:birth(1).startIdentity});if(kind==='old-unknown')f.statuses.set(1,{state:'unknown'});if(kind==='new-dead')f.statuses.set(2,{state:'dead'});if(kind==='new-unknown')f.statuses.set(2,{state:'unknown'});if(kind==='marker')f.settings.marker='active';if(kind==='owner')f.settings.owner=false;const before=f.data();await assert.rejects(f.finish());assert.deepEqual(f.data(),before);}});
test('handoff cleanup rejects unnamed participants, unready new row and pending commands atomically',async()=>{for(const kind of ['unnamed','phase','pending','foreign','overlap']){const f=hostFinishFixture();if(kind==='unnamed')f.mutate(d=>d.actors.push({host:birth(4),recovery:f.recovery,phase:'ready'}));if(kind==='phase')f.mutate(d=>d.actors[1].phase='restoring');if(kind==='pending')f.mutate(d=>d.actors[1].request={id:randomUUID()});if(kind==='foreign')f.mutate(d=>d.actors[1].recovery=randomUUID());const before=f.data();await assert.rejects(kind==='overlap'?f.mailbox.finishHostRecovery(f.recovery,f.operation,[birth(1)],[birth(1)]):f.finish());assert.deepEqual(f.data(),before);}});
test('PID reuse proves old birth exited but does not authorize changing unrelated row',async()=>{const f=hostFinishFixture();f.statuses.set(1,{state:'alive',startIdentity:birth(99).startIdentity});await f.finish();assert.equal(f.data().actors[0].recovery,undefined);});

test('completed handoff cleanup is idempotent after crash but rejects a new transaction or pending command',async()=>{for(const change of ['none','foreign','pending']){const f=hostFinishFixture();await f.finish();if(change==='foreign')f.mutate(d=>d.actors[1].recovery=randomUUID());if(change==='pending')f.mutate(d=>d.actors[1].request={id:randomUUID()});const before=f.data();if(change==='none')await f.finish();else await assert.rejects(f.finish());assert.deepEqual(f.data(),before);}});

test('restart dispatch ACK survives immediate host exit, while dead host without ACK and other actions fail',async()=>{
 let f,effects=0;f=memoryFixture({handlers:{restartHost:async()=>async()=>{effects++;f.options.hostExited=true;}}});await f.mailbox.start();
 try{await f.participant.prepare();await f.participant.requestRestart();assert.equal(effects,1);assert.equal(f.data().actors[0].reply.ok,true);await assert.rejects(f.participant.stop(),{code:'COMPONENT_PARTICIPANT_UNAVAILABLE'});}finally{f.mailbox.dispose();}
 const g=memoryFixture();await g.mailbox.start();try{await g.participant.prepare();g.mailbox.dispose();g.options.hostExited=true;await assert.rejects(g.participant.requestRestart(),{code:'COMPONENT_PARTICIPANT_UNAVAILABLE'});}finally{g.mailbox.dispose();}
});
test('durable finalized handoff cleanup invalidates cached read-only actor without calling hooks',async()=>{
 const f=memoryFixture();await f.mailbox.start();try{
  await f.participant.prepare();assert.equal(f.counts().prepared,1);
  f.options.recoveryAbsent=true;
  f.mailbox.inspectHost=async pid=>pid===9?{state:'dead'}:{state:'alive',startIdentity:birth(pid).startIdentity};
  await f.mailbox.finishHostRecovery(f.recovery,{state:'active'},[birth(9)],[birth(1)]);
  f.options.recoveryAbsent=false;
  await f.participant.prepare();assert.deepEqual(f.counts(),{prepared:2,stopped:0,resumed:0});
 }finally{f.mailbox.dispose();}
});

test('finalized cleanup accepts exited new host in any phase without asserting current identity',async()=>{for(const state of [{state:'dead'},{state:'alive',startIdentity:birth(99).startIdentity}]){const f=hostFinishFixture();f.statuses.set(2,state);f.mutate(d=>d.actors[1].phase='restoring');const failures=f.data().actors[1].failures;await f.finish();assert.equal(f.data().actors[1].recovery,undefined);assert.deepEqual(f.data().actors[1].failures,failures);await f.finish();}});
test('exited new host cannot clear pending command, foreign transaction or active recovery marker',async()=>{for(const kind of ['pending','foreign','marker','unknown']){const f=hostFinishFixture();f.statuses.set(2,{state:'dead'});if(kind==='pending')f.mutate(d=>d.actors[1].request={id:randomUUID()});if(kind==='foreign')f.mutate(d=>d.actors[1].recovery=randomUUID());if(kind==='marker')f.settings.marker='active';if(kind==='unknown')f.statuses.set(2,{state:'unknown'});const before=f.data();await assert.rejects(f.finish());assert.deepEqual(f.data(),before);}});


test('acknowledged restart effect survives coordinator operation release and runs exactly once',async()=>{
 let effects=0,ackRequest;const options={handlers:{restartHost:async()=>async()=>{effects++;}}};
 const f=memoryFixture(options);await f.mailbox.start();try{
  await f.participant.prepare();
  options.afterCommit=data=>{const row=data.actors[0];if(row.request?.action==='restartHost'&&row.reply?.ok){ackRequest=structuredClone(row.request);options.lostOwner=true;}};
  // The waiting coordinator no longer owns its operation, but dispatch has
  // already been durably acknowledged. Only the authorized effect may finish.
  await assert.rejects(f.participant.requestRestart(),{code:'LOCK_OWNERSHIP_CHANGED'});
  assert.equal(effects,1);assert.ok(ackRequest);
  await f.mailbox.runRestartEffect(ackRequest);assert.equal(effects,1);
  await assert.rejects(f.participant.stop(),{code:'LOCK_OWNERSHIP_CHANGED'});
  await assert.rejects(f.participant.verify(randomUUID()),{code:'LOCK_OWNERSHIP_CHANGED'});
  assert.equal(f.counts().stopped,0);
 }finally{f.mailbox.dispose();}
});
test('restart effect rejects missing failed or mismatched ACK and changed request even after owner release',async()=>{
 for(const change of ['missing','failed','reply-id','request-id','action','recovery']){
  const f=memoryFixture();await f.mailbox.start();try{
   await f.participant.prepare();f.mailbox.dispose();
   const request={id:randomUUID(),action:'restartHost',recovery:f.recovery,operation:{state:'active',owner:{id:randomUUID(),owner:'a'.repeat(64)}}};
   await f.mailbox.state.transaction(data=>{const row=data.actors[0];row.request=structuredClone(request);row.reply={id:request.id,ok:true};
    if(change==='missing')delete row.reply;if(change==='failed')row.reply.ok=false;if(change==='reply-id')row.reply.id=randomUUID();
    if(change==='request-id')row.request.id=randomUUID();if(change==='action')row.request.action='resume';if(change==='recovery')row.request.recovery=randomUUID();
   });
   let effects=0;f.options.lostOwner=true;f.mailbox.restartEffect={id:request.id,run:async()=>{effects++;}};
   await f.mailbox.runRestartEffect(request);await f.mailbox.runRestartEffect(request);
   assert.equal(effects,0);assert.ok(f.data().actors[0].failures.some(x=>x.action==='resume'&&x.code==='RECOVERY_CHANGED'));
  }finally{f.mailbox.dispose();}
 }
});

test('released participation is opt-in and can be rebound only to its original transaction without hooks',async()=>{
 const f=memoryFixture({handlers:{workspaceKey:'c'.repeat(64)}});await f.mailbox.start();try{
  await f.participant.prepare();await f.participant.release();
  assert.deepEqual(await f.mailbox.recoveryParticipants(f.recovery),[]);
  const rows=await f.mailbox.recoveryParticipants(f.recovery,true);assert.equal(rows.length,1);assert.equal(rows[0].recovery,undefined);assert.equal(rows[0].workspaceKey,'c'.repeat(64));assert.deepEqual(rows[0].lastHub,birth(2));
  const before=f.counts(),operation=f.data().actors[0].request.operation;
  await f.mailbox.rebindReleased(f.recovery,operation,birth(1));assert.deepEqual(f.counts(),before);assert.equal(f.data().actors[0].recovery,f.recovery);
 }finally{f.mailbox.dispose();}
});
test('released rebind rejects stale birth owner marker and non-exact release evidence',async()=>{
 for(const change of ['dead','unknown','owner','marker','failed','reply-id','request-action','request-recovery','original-owner']){
  const f=memoryFixture();await f.mailbox.start();try{
   await f.participant.prepare();await f.participant.release();f.mailbox.dispose();const operation=f.data().actors[0].request.operation;
   if(change==='dead')f.options.hostExited=true;if(change==='unknown')f.mailbox.inspectHost=async()=>({state:'unknown'});if(change==='owner')f.options.lostOwner=true;if(change==='marker')f.options.offline=true;
   await f.mailbox.state.transaction(d=>{const row=d.actors[0];if(change==='failed')row.reply.ok=false;if(change==='reply-id')row.reply.id=randomUUID();if(change==='request-action')row.request.action='resume';if(change==='request-recovery')row.request.recovery=randomUUID();if(change==='original-owner')row.request.operation.owner.owner='b'.repeat(64);});
   const before=f.data();await assert.rejects(f.mailbox.rebindReleased(f.recovery,operation,birth(1)));assert.deepEqual(f.data(),before);
   if(['failed','reply-id','request-action','request-recovery'].includes(change))assert.deepEqual(await f.mailbox.recoveryParticipants(f.recovery,true),[]);
  }finally{f.mailbox.dispose();}
 }
});

for (const reason of require('../out/file-route-failure').FILE_ROUTE_FAILURE_REASONS) test('prepare transports only closed route reason '+reason, async () => {
 const f=memoryFixture({routeReason:reason});await f.mailbox.start();
 try { await assert.rejects(f.participant.prepare(), e=>e.code==='WSL_FILE_ROUTE_UNVERIFIED'&&e.fileRouteFailureReason===reason);
  const row=f.data().actors[0];assert.equal(row.failures.at(-1).fileRouteFailureReason,reason);assert.doesNotMatch(JSON.stringify(row),/PRIVATE_LOG|PRIVATE_TOKEN/);await f.participant.release();
 } finally {f.mailbox.dispose();}
});
test('unknown route text is discarded at actor IPC boundary',async()=>{
 const f=memoryFixture({routeReason:'PRIVATE_TOKEN'});await f.mailbox.start();
 try{await assert.rejects(f.participant.prepare(),e=>e.code==='WSL_FILE_ROUTE_UNVERIFIED'&&e.fileRouteFailureReason===undefined);assert.doesNotMatch(JSON.stringify(f.data()),/PRIVATE_TOKEN/);}finally{f.mailbox.dispose();}
});

test('durable route repair survives failed startup and only observes on retry before release',async()=>{
 const {repairComponentRoute}=require('../out/component-route-repair');
 let current=birth(2),oldExited=false,starts=0,stops=0,failStart=true;
 const f=memoryFixture({handlers:{repairRoute:async(record,save,assertOwner,transaction)=>{
  await repairComponentRoute(record,{transaction,host:birth(1),assertOwner,save,inspectOwned:async()=>{if(!current)throw new (require('../out/live-storage').LiveError)('OFFICIAL_HUB_NOT_READY');return current;},
   stop:async()=>{assert.equal(f.data().actors[0].routeRepair.phase,'stopping');stops++;oldExited=true;current=undefined;},isStopped:async()=>oldExited,
   startOnce:async()=>{assert.equal(f.data().actors[0].routeRepair.phase,'starting');starts++;if(failStart)throw new (require('../out/live-storage').LiveError)('OFFICIAL_COMPONENT_RESTART_TIMEOUT');current=birth(3);},
   observeStarted:async()=>{if(!current)throw new (require('../out/live-storage').LiveError)('OFFICIAL_HUB_NOT_READY');return current;},proveOwnRoute:async hub=>assert.deepEqual(hub,birth(3))});
 }}});await f.mailbox.start();
 try{
  await assert.rejects(f.participant.repairRoute(),{code:'OFFICIAL_COMPONENT_RESTART_TIMEOUT'});
  assert.equal(await f.mailbox.hasRouteRepair(f.recovery),true);assert.equal(f.data().actors[0].phase,'restoring');
  await assert.rejects(f.participant.release(),{code:'COMPONENT_RESTORE_REQUIRED'});
  await assert.rejects(f.participant.prepare(),{code:'COMPONENT_RESTORE_REQUIRED'});
  failStart=false;current=birth(3);await f.participant.repairRoute();assert.equal(starts,1);assert.equal(stops,1);
  await f.participant.release();assert.equal(await f.mailbox.hasRouteRepair(),false);assert.equal(await f.mailbox.hasRestoration(),false);
 }finally{f.mailbox.dispose();}
});
test('route control cannot run without exact recovery ownership or bypass normal actor',async()=>{
 let attempts=0;const f=memoryFixture({handlers:{repairRoute:async()=>{attempts++;}}});await f.mailbox.start();
 try{await f.participant.prepare();await assert.rejects(f.participant.repairRoute(),{code:'COMPONENT_CONTRACT_UNSUPPORTED'});assert.equal(attempts,0);await f.participant.release();f.options.lostOwner=true;await assert.rejects(f.participant.repairRoute(),{code:'LOCK_OWNERSHIP_CHANGED'});assert.equal(attempts,0);}finally{f.mailbox.dispose();}
});
test('dead-host route cleanup rejects a foreign transaction before altering evidence',async()=>{
 const {repairComponentRoute}=require('../out/component-route-repair');
 const f=memoryFixture({handlers:{repairRoute:async(record,save,assertOwner,transaction)=>{await repairComponentRoute(record,{transaction,host:birth(1),assertOwner,save,inspectOwned:async()=>birth(2),stop:async()=>{throw Error('synthetic stop failure');},isStopped:async()=>false,startOnce:async()=>{},observeStarted:async()=>birth(3),proveOwnRoute:async()=>{}});}}});await f.mailbox.start();
 try{await assert.rejects(f.participant.repairRoute());const before=f.data();f.options.hostExited=true;await assert.rejects(f.mailbox.recoverRoutes({state:'active',owner:{id:randomUUID(),owner:'a'.repeat(64)}},randomUUID()),{code:'RECOVERY_CHANGED'});assert.deepEqual(f.data(),before);}finally{f.mailbox.dispose();}
});

test('operator host restart resolves ambiguous undispatched startup only after old host and births exit',async()=>{
 const {repairComponentRoute}=require('../out/component-route-repair');let starts=0;
 const f=memoryFixture({handlers:{repairRoute:async(record,save,assertOwner,transaction)=>{await repairComponentRoute(record,{transaction,host:birth(1),assertOwner,save:async r=>{await save(r);if(r.phase==='starting')throw Error('crash after durable starting before dispatch');},inspectOwned:async()=>birth(2),stop:async()=>{},isStopped:async()=>true,startOnce:async()=>{starts++;},observeStarted:async()=>{throw Error('no dispatched startup');},proveOwnRoute:async()=>{}});}}});await f.mailbox.start();
 try{await assert.rejects(f.participant.repairRoute());assert.equal(starts,0);assert.equal(f.data().actors[0].routeRepair.phase,'starting');f.mailbox.dispose();f.options.hostExited=true;await f.mailbox.recoverRoutes(f.operation,f.recovery);assert.equal(await f.mailbox.hasRouteRepair(),false);assert.equal(await f.mailbox.hasRestoration(),false);assert.equal(starts,0);}finally{f.mailbox.dispose();}
});
