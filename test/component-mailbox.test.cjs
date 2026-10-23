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
      data = copy; return result;
    },
  };
  const locks = { isOperationCurrent: async () => !options.lostOwner, isSharedOperationCurrent: async () => !options.lostOwner,
    inspectRecovery: async () => ({ state: 'active', owner: { id: recovery, owner: operation.owner.owner, schema: options.offline ? 4 : 2 } }) };
  const mailbox = new ComponentMailbox('/unused', birth(1), locks, async () => ({
    prepare: async () => { prepared++; if (options.failPrepare) { options.failPrepare = false; throw Error('temporary route failure'); } return { host: birth(1), hub: birth(2), contract: '1.8.0' }; },
    stop: async () => { stopped++; if (options.stopWait) await options.stopWait; },
    resume: async () => { resumed++; },
  }), state);
  return { mailbox, participant: mailbox.participant(birth(1), operation, recovery, options.timeout ?? 2000),
    counts: () => ({ prepared, stopped, resumed }), options };
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
      const group = new ComponentCoordination({
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
      await locks.clearRecovery(transaction); // finalization before peer restoration
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
