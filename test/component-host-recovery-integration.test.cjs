const test = require('node:test');
const assert = require('node:assert/strict');
const { LiveSwitchService, JOURNAL_KEY } = require('../out/live-switch');
const { ComponentHostRecovery } = require('../out/component-host-recovery');
const { ComponentMailbox } = require('../out/component-mailbox');
const { ReadOnlyComponentLifecycle } = require('../out/component-readonly-lifecycle');

// In-memory credentials and explicit birth transitions only. No restart command,
// OS process, official extension, SecretStorage or account service is invoked.
const birth = pid => ({ pid, startIdentity: `linux:11111111-1111-1111-1111-111111111111:${pid}` });
const token = name => JSON.stringify({ token: { access_token: `synthetic-${name}`, refresh_token: `synthetic-refresh-${name}`, token_type: 'Bearer' }, auth_method: 'oauth' });
const slotsFor = name => ({ keyring: token(name), file: token(name) });
async function fixture() {
  const data = new Map(), calls = { writes: 0, forbiddenWrites: 0, stop: 0, reload: 0, fresh: [] };
  let current = slotsFor('B'), recovering = false, self = birth(1), state = {}, marker = null, failClear = false;
  const vault = { get: async k => data.get(k), store: async (k,v) => { data.set(k,v); }, delete: async k => { data.delete(k); } };
  const slots = { read: async () => structuredClone(current), write: async (next, expected) => {
    if (recovering) { calls.forbiddenWrites++; throw Error('FORBIDDEN_RECOVERY_WRITE'); }
    assert.deepEqual(current, expected); current = structuredClone(next); calls.writes++;
  } };
  const service = () => new LiveSwitchService(vault, slots);
  const saved = await service().capture({ label: 'B', expectedEmail: 'b@example.test', identitySource: 'user' });
  current = slotsFor('A');
  await assert.rejects(service().install(saved.id, { generation: 'old', proof: async () => ({ email: 'a@example.test', generation: 'old', authValid: true, quotaSource: 'server', observedAt: new Date().toISOString(), buckets: [] }), assertCredentialWriteSafe: async () => {}, stop: async () => {}, reload: async () => { throw Error('SYNTHETIC_PREEXISTING_RECONNECT_FAILURE'); } }), /SYNTHETIC_PREEXISTING_RECONNECT_FAILURE/);
  const journal = await service().journal(); assert.equal(journal.phase, 'installed'); assert.equal(calls.writes, 1);
  recovering = true;
  const statuses = new Map([1,2,11,12,101,102,111,112,202,212].map(pid => [pid, 'alive']));
  const proofState = new Map([101,102,202].map(pid => [pid, { email: 'b@example.test', authValid: true }]));
  const actors = new Map([101,102,202].map(pid => [pid, new ReadOnlyComponentLifecycle({ host: birth(pid), assertOwner: async () => {},
    ready: async () => ({ hub: birth(pid + 10), generation: `generation-${pid}` }),
    proof: async () => { calls.fresh.push(pid); return { ...proofState.get(pid), generation: `generation-${pid}`, quotaSource: 'server', observedAt: new Date().toISOString(), buckets: [] }; },
  })]));
  const store = { read: async () => structuredClone(state), transaction: async fn => { const next = structuredClone(state); const result = fn(next); state = next; return result; } };
  const io = { self: async () => self, now: () => 100, inspect: async b => statuses.get(b.pid) ?? 'unknown', assertOperation: async () => {},
    fresh: async (_participant, host, targetId) => {
      const actor = actors.get(host.pid), proof = await actor.proof();
      assert.equal(targetId, saved.id);
      if (proof.email !== 'b@example.test') throw Error('HOST_RECOVERY_IDENTITY_UNVERIFIED');
      return { host, hub: (await actor.describe()).hub, targetId };
    } };
  const recovery = () => new ComponentHostRecovery('/synthetic-unused', io, store);
  const recoveryJournal = { ...journal, operation: 'switch' };
  const input = { attempt: 'attempt', journal: recoveryJournal, owner: birth(1), participants: [
    { workspaceKey: 'workspace-a', host: birth(1), hubs: [birth(11)] },
    { workspaceKey: 'workspace-b', host: birth(2), hubs: [birth(12)] },
  ], deadline: 1000, confirmed: true };
  const finalizer = { prepare: async (id, binding) => {
    const owner = { schema: 3, id, completion: binding }; marker = JSON.stringify({ owner, raw: JSON.stringify(owner) }); return marker;
  }, pending: async () => marker, identity: async () => marker, clear: async (_id, expected) => {
    assert.equal(expected, marker);
    if (failClear) { failClear = false; throw Error('SYNTHETIC_CLEANUP_CRASH'); }
    await recovery().verifyAll('attempt', recoveryJournal); await recovery().complete('attempt'); marker = null;
  } };
  const rejoin = async () => {
    await recovery().prepare(input);
    for (const pid of [1,2]) { self = birth(pid); await recovery().markDispatchOnce('attempt', input.participants[pid - 1].workspaceKey); }
    // Models independently observed native-host exits/rebirths, not a restart API.
    for (const pid of [1,2,11,12]) statuses.set(pid, 'dead');
    for (const pid of [101,102]) { self = birth(pid); await recovery().claim('attempt', input.participants[pid - 101].workspaceKey); }
    self = birth(101);
  };
  const finish = async () => {
    const local = actors.get(101); await local.prepare();
    const lifecycle = { get generation() { return local.generation; },
      stop: async () => { calls.stop++; return local.stop(); }, reload: async () => { calls.reload++; return local.reload(); },
      proof: async signal => { await recovery().verifyAll('attempt', recoveryJournal); return local.proof(signal); },
    };
    return service().finishVerified(lifecycle, undefined, undefined, finalizer);
  };
  const assertReadOnly = () => { assert.equal(calls.writes, 1); assert.equal(calls.forbiddenWrites, 0); assert.equal(calls.stop, 0); assert.equal(calls.reload, 0); };
  return { calls, service, recovery, recoveryJournal, input, rejoin, finish, finalizer, proofState, data, assertReadOnly,
    replacePeer: async () => {
      statuses.set(102, 'dead'); statuses.set(112, 'dead'); self = birth(202);
      await recovery().claim('attempt', 'workspace-b'); self = birth(101);
    },
    cleanupMailbox: () => {
      let rows = { schema: 1, actors: [1,2,101,102,202].map(pid => ({ host: birth(pid), recovery: journal.id,
        phase: pid < 100 ? 'restoring' : 'ready', verification: 'identity-v1' })) };
      const local = { read: async () => structuredClone(rows), transaction: async fn => {
        const next = structuredClone(rows); const result = fn(next); rows = next; return result;
      } };
      const locks = { isOperationCurrent: async () => true, inspectRecovery: async () => ({ state: marker ? 'active' : 'absent' }) };
      const mailbox = new ComponentMailbox('/synthetic-unused', birth(101), locks,
        async () => { throw Error('FORBIDDEN_MAILBOX_ACTOR_CREATION'); }, local,
        async pid => statuses.get(pid) === 'alive' ? { state: 'alive', startIdentity: birth(pid).startIdentity } : { state: statuses.get(pid) ?? 'unknown' });
      return { rows: () => structuredClone(rows), finish: async includeRetired => {
        const record = await recovery().read();
        await mailbox.finishHostRecovery(journal.id, { state: 'active' },
          [...record.participants.map(p => p.host), ...(includeRetired ? record.retiredBirths ?? [] : [])], record.claims.map(c => c.host));
      } };
    },
    current: () => structuredClone(current), setSlots: next => { current = next; }, crashCleanup: () => { failClear = true; } };
}

test('two new host claims freshly finish installed journal and completion without another credential write', async () => {
  const f = await fixture(); await f.rejoin();
  assert.equal((await f.finish()).email, 'b@example.test');
  assert.equal(await f.service().journal(), null); assert.equal(await f.service().hasCompletion(), false);
  const r = await f.recovery().read(); assert.equal(r.phase, 'complete');
  assert.deepEqual(r.claims.map(c => c.host.pid), [101,102]);
  assert.ok(f.calls.fresh.includes(101)); assert.ok(f.calls.fresh.includes(102)); f.assertReadOnly();
});

for (const mode of ['invalid fresh', 'wrong peer identity', 'unknown slots']) test(`host recovery preserves backup and does not overwrite ${mode}`, async () => {
  const f = await fixture(); await f.rejoin();
  if (mode === 'invalid fresh') f.proofState.get(102).authValid = false;
  if (mode === 'wrong peer identity') f.proofState.get(102).email = 'other@example.test';
  if (mode === 'unknown slots') f.setSlots(slotsFor('EXTERNAL'));
  const before = f.current();
  await assert.rejects(f.finish(), mode === 'unknown slots' ? /VERIFICATION_STORAGE_MISMATCH/ : /VERIFICATION_RETRY_REQUIRED/);
  assert.deepEqual(f.current(), before); assert.deepEqual((await f.service().journal()).backup, slotsFor('A'));
  assert.notEqual((await f.recovery().read()).phase, 'complete'); assert.equal(await f.service().hasCompletion(), false); f.assertReadOnly();
});

test('phase none is ineligible for host recovery and cannot consume an installed journal', async () => {
  const f = await fixture(), raw = f.data.get(JOURNAL_KEY);
  await assert.rejects(f.recovery().prepare({ ...f.input, journal: { ...f.recoveryJournal, phase: 'none' } }), /HOST_RECOVERY_NOT_INSTALLED/);
  assert.equal(await f.recovery().read(), undefined); assert.equal(f.data.get(JOURNAL_KEY), raw); f.assertReadOnly();
});

test('cleanup crash after journal deletion resumes exact receipt and fresh host completion on reconstructed services', async () => {
  const f = await fixture(); await f.rejoin(); f.crashCleanup();
  await assert.rejects(f.finish(), /RECOVERY_CLEANUP_PENDING/);
  assert.equal(await f.service().journal(), null); assert.equal(await f.service().hasCompletion(), true);
  assert.equal((await f.recovery().read()).phase, 'verified');
  const proofs = f.calls.fresh.length;
  assert.equal(await f.service().resumeCompletion(f.finalizer), true);
  assert.ok(f.calls.fresh.length > proofs); assert.equal((await f.recovery().read()).phase, 'complete');
  assert.equal(await f.service().hasCompletion(), false); assert.equal(await f.service().resumeCompletion(f.finalizer), false); f.assertReadOnly();
});


test('replacement claim completes fresh verification and clears retired mailbox row only with retired birth obligations', async () => {
  const f = await fixture(); await f.rejoin(); await f.replacePeer();
  assert.deepEqual((await f.recovery().read()).retiredBirths, [birth(102)]);
  assert.equal((await f.finish()).email, 'b@example.test');
  assert.ok(f.calls.fresh.includes(202)); assert.equal(await f.service().journal(), null);
  assert.equal((await f.recovery().read()).phase, 'complete');
  const mailbox = f.cleanupMailbox(), before = mailbox.rows();
  await assert.rejects(mailbox.finish(false), /RECOVERY_CHANGED/);
  assert.deepEqual(mailbox.rows(), before);
  await mailbox.finish(true);
  for (const row of mailbox.rows().actors) {
    assert.equal(row.recovery, undefined); assert.equal(row.phase, undefined); assert.equal(row.verification, undefined);
  }
  assert.ok(mailbox.rows().actors.some(row => row.host.pid === 102)); // Retains inert evidence.
  f.assertReadOnly();
});

test('receipt cleanup crash followed by replacement claim re-verifies new host and clears retired host and Hub obligations', async () => {
  const f = await fixture(); await f.rejoin(); f.crashCleanup();
  await assert.rejects(f.finish(), /RECOVERY_CLEANUP_PENDING/);
  assert.equal(await f.service().journal(), null); assert.equal(await f.service().hasCompletion(), true);
  await f.replacePeer();
  assert.deepEqual((await f.recovery().read()).retiredBirths, [birth(102), birth(112)]);
  const freshBefore = f.calls.fresh.length;
  assert.equal(await f.service().resumeCompletion(f.finalizer), true);
  assert.ok(f.calls.fresh.slice(freshBefore).includes(202));
  assert.equal((await f.recovery().read()).phase, 'complete'); assert.equal(await f.service().hasCompletion(), false);
  const mailbox = f.cleanupMailbox(); await assert.rejects(mailbox.finish(false), /RECOVERY_CHANGED/);
  await mailbox.finish(true); assert.ok(mailbox.rows().actors.every(row => row.recovery === undefined));
  f.assertReadOnly();
});
