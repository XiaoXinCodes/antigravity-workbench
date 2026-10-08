const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { SYNTHETIC_RUNTIME, LIVE_SWITCHING_SUPPORTED } = require('../out/legacy/switch-contract');
const { SyntheticCredentialStorageV1 } = require('../out/legacy/switch-storage');
const { FileSwitchCoordinator } = require('../out/legacy/switch-coordinator');
const { SyntheticSwitchController } = require('../out/legacy/switch-transaction');
const A = 'fixture:alpha', B = 'fixture:beta';
const slots = () => ({ keyring: { schema: 'fixture-keyring-v1', subject: A }, fallback: null });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(r => setImmediate(r));
async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ag-switch-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const calls = [];
  const storage = new SyntheticCredentialStorageV1(options.slots ?? slots(), options.fault);
  const state = { subject: A, generation: 'generation:0', windowCount: 1, activeTaskCount: 0, held: false, stopped: false };
  let generation = 0;
  const backend = {
    mode: 'synthetic',
    async inspect() { calls.push('inspect'); return { ...state }; },
    async quiesce() { calls.push('quiesce'); state.held = true; state.stopped = true; return { stopped: true, workloadHeld: true }; },
    async reload() {
      calls.push('reload'); assert.equal(state.held, true); assert.equal(state.stopped, true);
      const store = storage.inspectFixture(); state.subject = store.keyring?.subject ?? store.fallback?.subject;
      state.generation = `generation:${++generation}`; state.stopped = false;
    },
    async acknowledge(challenge) {
      calls.push('acknowledge');
      return { challenge, subject: state.subject, generation: state.generation, observedAt: Date.now(),
        quota: { subject: state.subject, generation: state.generation, challenge, observedAt: Date.now(), source: 'backend' } };
    },
    async releaseWorkload() { calls.push('releaseWorkload'); state.held = false; },
  };
  const coordinator = new FileSwitchCoordinator(directory);
  const dependencies = { storage, backend, coordinator, operationTimeoutMs: options.timeout ?? 5000 };
  const controller = new SyntheticSwitchController(dependencies);
  return { directory, storage, state, backend, coordinator, dependencies, controller, calls,
    run: signal => controller.switchTo(B, SYNTHETIC_RUNTIME, signal),
    lockExists: async () => fs.access(path.join(directory, '.account-switch.lock')).then(() => true, () => false) };
}
function failOnce(object, name, after = false) {
  const original = object[name].bind(object); let fail = true;
  object[name] = async (...args) => {
    if (fail) { fail = false; if (after) await original(...args); throw new Error('PRIVATE_TOKEN_DIAGNOSTIC'); }
    return original(...args);
  };
}

test('synthetic transaction commits only after fresh backend identity and quota verification', async t => {
  const f = await fixture(t); const r = await f.run();
  assert.equal(r.status, 'synthetic-committed'); assert.equal(r.code, 'SYNTHETIC_ONLY'); assert.equal(r.activeSubject, B);
  assert.deepEqual(r.phases, ['preparing', 'quiescing', 'snapshotting', 'installing', 'reloading', 'verifying', 'committed']);
  assert.equal(f.state.subject, B); assert.equal(f.state.held, false); assert.equal(await f.lockExists(), false);
  assert.deepEqual(f.calls, ['inspect', 'quiesce', 'reload', 'acknowledge', 'inspect', 'releaseWorkload']);
  assert.equal(LIVE_SWITCHING_SUPPORTED, false);
});
test('all real versions and every altered fingerprint fail closed without touching a port', async t => {
  const f = await fixture(t);
  for (const key of Object.keys(SYNTHETIC_RUNTIME)) {
    const r = await f.controller.switchTo(B, { ...SYNTHETIC_RUNTIME, [key]: 'unknown' });
    assert.equal(r.code, 'UNSUPPORTED_RUNTIME');
  }
  assert.equal((await f.controller.switchTo(B, { ...SYNTHETIC_RUNTIME, extensionVersion: '1.6.0', backendVersion: '1.2.14' })).code, 'UNSUPPORTED_RUNTIME');
  assert.deepEqual(f.calls, []); assert.equal(await f.lockExists(), false);
});
test('real identities and a live-labeled port cannot enter fixture execution', async t => {
  const f = await fixture(t);
  assert.equal((await f.controller.switchTo('person@example.com', SYNTHETIC_RUNTIME)).code, 'INVALID_REQUEST');
  f.backend.mode = 'live'; assert.equal((await f.run()).code, 'UNSUPPORTED_RUNTIME'); assert.deepEqual(f.calls, []);
});
for (const [key, value] of [['windowCount', 2], ['windowCount', 0], ['windowCount', NaN], ['activeTaskCount', 1], ['activeTaskCount', undefined], ['subject', ''], ['generation', '']]) {
  test(`preflight fails closed for ${key}=${String(value)}`, async t => {
    const f = await fixture(t); f.state[key] = value; const r = await f.run();
    assert.equal(r.status, 'blocked'); assert.equal(r.code, 'PREFLIGHT_FAILED');
    assert.deepEqual(f.calls, ['inspect']); assert.deepEqual(f.storage.inspectFixture(), slots()); assert.equal(await f.lockExists(), false);
  });
}
for (const [port, method, after] of [['backend', 'quiesce', true], ['storage', 'snapshot', false], ['storage', 'install', false], ['storage', 'install', true], ['backend', 'reload', true], ['backend', 'acknowledge', false]]) {
  test(`settled ${port}.${method} failure (${after ? 'after' : 'before'}) rolls back completely`, async t => {
    const f = await fixture(t); failOnce(f[port], method, after); const r = await f.run();
    assert.equal(r.status, 'rolled-back'); assert.equal(r.activeSubject, A);
    assert.deepEqual(f.storage.inspectFixture(), slots()); assert.equal(f.state.subject, A); assert.equal(f.state.held, false);
    assert.equal(await f.lockExists(), false); assert.doesNotMatch(JSON.stringify(r), /PRIVATE_TOKEN/);
  });
}
test('partial keyring write restores prior keyring and absent fallback', async t => {
  const f = await fixture(t, { fault: point => { if (point === 'after-keyring-write') throw new Error('INJECTED_PARTIAL_WRITE'); } });
  const r = await f.run(); assert.equal(r.status, 'rolled-back'); assert.deepEqual(f.storage.inspectFixture(), slots());
});
test('rollback preserves differing fallback identity rather than reconstructing it', async t => {
  const initial = { keyring: { schema: 'fixture-keyring-v1', subject: A }, fallback: { schema: 'fixture-fallback-v1', subject: 'fixture:older' } };
  const f = await fixture(t, { slots: initial }); failOnce(f.backend, 'acknowledge');
  assert.equal((await f.run()).status, 'rolled-back'); assert.deepEqual(f.storage.inspectFixture(), initial);
});
test('both verification passes are required; post-reload storage drift rolls back', async t => {
  const f = await fixture(t); const verify = f.storage.verifyInstalled.bind(f.storage); let count = 0;
  f.storage.verifyInstalled = async (...args) => ++count === 2 ? false : verify(...args);
  const r = await f.run(); assert.equal(r.status, 'rolled-back'); assert.equal(r.code, 'STORAGE_VERIFICATION_FAILED');
});
const badAck = {
  subject: a => { a.subject = 'fixture:wrong'; },
  generation: a => { a.generation = 'generation:0'; },
  challenge: a => { a.challenge = 'replayed'; },
  stale: a => { a.observedAt = 0; },
  future: a => { a.observedAt = Date.now() + 60_000; },
  quotaSubject: a => { a.quota.subject = 'fixture:wrong'; },
  quotaGeneration: a => { a.quota.generation = 'generation:0'; },
  quotaChallenge: a => { a.quota.challenge = 'old'; },
  quotaStale: a => { a.quota.observedAt = 0; },
  quotaSource: a => { a.quota.source = 'local-snapshot'; },
  quotaMissing: a => { delete a.quota; },
};
for (const [name, mutate] of Object.entries(badAck)) {
  test(`rejects ${name} acknowledgment without marking target active`, async t => {
    const f = await fixture(t); const original = f.backend.acknowledge.bind(f.backend); let count = 0;
    f.backend.acknowledge = async (...args) => { const ack = await original(...args); if (++count === 1) mutate(ack); return ack; };
    const r = await f.run(); assert.equal(r.status, 'rolled-back'); assert.equal(r.code, 'IDENTITY_VERIFICATION_FAILED'); assert.equal(r.activeSubject, A);
  });
}
test('post-acknowledgment workload drift is rejected', async t => {
  const f = await fixture(t); const original = f.backend.inspect.bind(f.backend); let count = 0;
  f.backend.inspect = async (...args) => { const r = await original(...args); if (++count === 2) r.activeTaskCount = 1; return r; };
  assert.equal((await f.run()).status, 'rolled-back');
});
test('failed rollback retains lock, removes active claim and blocks recreation', async t => {
  const f = await fixture(t); failOnce(f.backend, 'acknowledge'); f.storage.restore = async () => { throw new Error('PRIVATE'); };
  const r = await f.run(); assert.equal(r.status, 'unknown'); assert.equal(r.activeSubject, null); assert.equal(r.recoveryRequired, true);
  assert.equal(await f.lockExists(), true);
  assert.equal((await new SyntheticSwitchController(f.dependencies).switchTo(B, SYNTHETIC_RUNTIME)).status, 'blocked');
  const journal = await fs.readFile(path.join(f.directory, '.account-switch.lock', 'journal.json'), 'utf8');
  assert.equal(JSON.parse(journal).phase, 'unknown'); assert.doesNotMatch(journal, /fixture:|PRIVATE|reference|token/);
});
test('partial restore and old-identity acknowledgment failure are unknown, never rolled back', async t => {
  const f = await fixture(t, { fault: point => { if (point === 'before-restore-fallback') throw new Error('FAIL_RESTORE'); } });
  failOnce(f.backend, 'acknowledge'); assert.equal((await f.run()).status, 'unknown');
  const g = await fixture(t); g.backend.acknowledge = async () => { throw new Error('NO_ACK'); };
  assert.equal((await g.run()).status, 'unknown');
});
test('unsettled write timeout is quarantined; no racing rollback or late success', async t => {
  const f = await fixture(t, { timeout: 500 }); const wait = deferred(); const install = f.storage.install.bind(f.storage);
  f.storage.install = async (...args) => { await wait.promise; return install(...args); };
  const r = await f.run(); assert.equal(r.status, 'unknown'); assert.equal(r.code, 'UNCERTAIN_OPERATION');
  assert.equal(f.calls.filter(c => c === 'reload').length, 0); assert.equal(await f.lockExists(), true);
  wait.resolve(); await tick(); assert.equal((await f.run()).status, 'blocked'); assert.equal(r.activeSubject, null);
});
test('cancellation before start does nothing; in-flight cancellation retains lock', async t => {
  const f = await fixture(t); const c = new AbortController(); c.abort(); assert.equal((await f.run(c.signal)).code, 'CANCELLED'); assert.deepEqual(f.calls, []);
  const g = await fixture(t); const d = new AbortController(); const reached = deferred(); const wait = deferred();
  g.backend.reload = async () => { reached.resolve(); await wait.promise; };
  const p = g.run(d.signal); await reached.promise; d.abort(); assert.equal((await p).status, 'unknown');
  wait.resolve(); assert.equal(await g.lockExists(), true);
});
test('cancellation during a journal write is conservatively unknown', async t => {
  const f = await fixture(t); const c = new AbortController();
  // Deterministic cancellation before the journal callback's promise has settled.
  const acquire = f.coordinator.acquire.bind(f.coordinator);
  f.coordinator.acquire = async id => { const lease = await acquire(id); const record = lease.record;
    lease.record = async phase => { await record(phase); if (phase === 'reloading') c.abort(); }; return lease; };
  const r = await f.run(c.signal);
  // An abort while the journal call is outstanding is intentionally uncertain, not safe to compensate.
  assert.equal(r.status, 'unknown'); assert.equal(await f.lockExists(), true);
});
test('duplicate controller call and independent controller cannot acquire concurrent lease', async t => {
  const f = await fixture(t); const gate = deferred(); const reached = deferred(); const inspect = f.backend.inspect.bind(f.backend);
  f.backend.inspect = async (...args) => { reached.resolve(); await gate.promise; return inspect(...args); };
  const p = f.run(); await reached.promise;
  assert.equal((await f.run()).status, 'blocked');
  assert.equal((await new SyntheticSwitchController(f.dependencies).switchTo(B, SYNTHETIC_RUNTIME)).status, 'blocked');
  gate.resolve(); assert.equal((await p).status, 'synthetic-committed');
});
test('finalization failure never rewrites credentials after workload may have resumed', async t => {
  const f = await fixture(t); failOnce(f.backend, 'releaseWorkload', true);
  const r = await f.run(); assert.equal(r.status, 'unknown'); assert.equal(r.code, 'FINALIZATION_FAILED');
  assert.equal(f.calls.filter(c => c === 'quiesce').length, 1); assert.equal(f.storage.inspectFixture().keyring.subject, B);
});
test('fixture storage rejects real-shaped, unknown, extra-field and cross-transaction records', async () => {
  for (const bad of [{}, { keyring: null, fallback: null, token: 'secret' }, { keyring: { schema: 'fixture-keyring-v1', subject: 'a@example.com' }, fallback: null }, { keyring: { schema: 'new-format', subject: A }, fallback: null }]) assert.throws(() => new SyntheticCredentialStorageV1(bad));
  const s = new SyntheticCredentialStorageV1(slots()); const context = { transactionId: randomUUID(), signal: new AbortController().signal };
  const snapshot = await s.snapshot(context); await assert.rejects(s.restore(snapshot, { ...context, transactionId: randomUUID() }));
  const snapshot2 = await s.snapshot(context); await s.install(B, snapshot, context);
  await assert.rejects(s.install(A, snapshot2, context), /STORAGE_CONFLICT/);
  await assert.rejects(s.restore(snapshot2, context), /STORAGE_CONFLICT/);
});
test('file lease survives an owner process exiting; no automatic stale-lock deletion', async t => {
  const f = await fixture(t);
  const modulePath = require.resolve('../out/legacy/switch-coordinator');
  const child = spawn(process.execPath, ['-e', `const {FileSwitchCoordinator}=require(${JSON.stringify(modulePath)});new FileSwitchCoordinator(${JSON.stringify(f.directory)}).acquire(${JSON.stringify(randomUUID())}).then(l=>l.record('installing'));`], { stdio: 'pipe' });
  const exit = await new Promise(resolve => child.on('close', resolve)); assert.equal(exit, 0);
  assert.equal((await f.run()).status, 'blocked'); assert.equal(await f.lockExists(), true);
});
test('tampered lock ownership cannot release or overwrite another transaction', async t => {
  const f = await fixture(t); const lease = await f.coordinator.acquire(randomUUID());
  await fs.writeFile(path.join(f.directory, '.account-switch.lock', 'owner.json'), JSON.stringify({ transactionId: randomUUID() }));
  await assert.rejects(lease.record('committed'), /LOCK_OWNERSHIP_LOST/); await assert.rejects(lease.release(), /LOCK_OWNERSHIP_LOST/);
  assert.equal(await f.lockExists(), true);
});
test('journal failure before mutation leaves original untouched and releases owned lock', async t => {
  const f = await fixture(t); const acquire = f.coordinator.acquire.bind(f.coordinator);
  f.coordinator.acquire = async id => { const lease = await acquire(id); lease.record = async () => { throw new Error('DISK_ERROR'); }; return lease; };
  const r = await f.run(); assert.equal(r.status, 'blocked'); assert.deepEqual(f.calls, []); assert.equal(await f.lockExists(), false);
});
test('unknown journal failure after storage mutation still preserves recovery lock', async t => {
  const f = await fixture(t); const acquire = f.coordinator.acquire.bind(f.coordinator);
  f.coordinator.acquire = async id => { const lease = await acquire(id); const record = lease.record;
    lease.record = async phase => { if (['reloading', 'rolling-back', 'unknown'].includes(phase)) throw new Error('DISK_ERROR'); await record(phase); }; return lease; };
  const r = await f.run(); assert.equal(r.status, 'unknown'); assert.equal(await f.lockExists(), true); assert.equal(r.activeSubject, null);
});
test('quiesce must prove both stopped backend and held workload; otherwise no install', async t => {
  const f = await fixture(t); f.backend.quiesce = async () => ({ stopped: true, workloadHeld: false });
  const r = await f.run(); assert.equal(r.status, 'unknown'); assert.deepEqual(f.storage.inspectFixture(), slots());
});
test('repeated switches acquire fresh lease and preserve original subject on next rollback', async t => {
  const f = await fixture(t); assert.equal((await f.run()).status, 'synthetic-committed');
  failOnce(f.backend, 'acknowledge'); const r = await f.controller.switchTo(A, SYNTHETIC_RUNTIME);
  assert.equal(r.status, 'rolled-back'); assert.equal(r.activeSubject, B); assert.equal(f.state.subject, B);
});
test('symlink lock is never followed or automatically removed', async t => {
  if (process.platform === 'win32') return t.skip('Windows symlink privilege is not assumed');
  const f = await fixture(t); const target = path.join(f.directory, 'other'); await fs.mkdir(target);
  await fs.symlink(target, path.join(f.directory, '.account-switch.lock'));
  assert.equal((await f.run()).status, 'blocked'); assert.deepEqual(await fs.readdir(target), []);
});
