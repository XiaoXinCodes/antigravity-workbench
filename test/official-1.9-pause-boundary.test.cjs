const { test } = require('node:test');
const assert = require('node:assert/strict');

// Bounded contract counterexamples, not an implementation of official RPC.
// Relevant sequencing independently checked against the exact 1.9.0 source
// f77a37c4bd66612f4ed26d9e80ce3969af543f853e2cc113ca466e7f8b6aa880.
// No official module is evaluated, no processes/timers/accounts are used.
function deferred() {
  let resolve; const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  let serial = 0;
  const events = [], stops = [];
  const m = {
    serverProcess: { birth: ++serial }, port: 40000, serverUrl: 'synthetic-ready',
    isStopping: false, recoveryInFlight: false, pendingRecoveryTimer: false,
    startingPromise: undefined, stopGeneration: 0, heartbeatGeneration: 0,
    autoRecover: true, events, stops,
    async stop() {
      m.stopGeneration++; m.isStopping = true; m.pendingRecoveryTimer = false; m.heartbeatGeneration++;
      if (m.serverProcess) {
        m.serverProcess = undefined; m.port = undefined; m.serverUrl = undefined;
        const old = deferred(); stops.push(old); await old.promise;
      }
    },
    start() {
      if (m.startingPromise) return m.startingPromise;
      if (m.serverProcess && m.serverUrl) return Promise.resolve(m.serverUrl);
      m.isStopping = false; m.pendingRecoveryTimer = false;
      m.serverProcess = { birth: ++serial }; m.port = 40000; m.serverUrl = 'synthetic-ready';
      events.push('start'); return Promise.resolve(m.serverUrl);
    },
    async restart() { await m.stop(); return m.start(); },
    async runRecovery() {
      m.recoveryInFlight = true;
      try { await m.restart(); } finally { m.recoveryInFlight = false; }
    },
    exports: () => ({ port: m.port, hasProcess: !!m.serverProcess }),
  };
  return m;
}

test('second deactivate completion and empty public observations do not drain an earlier recovery', async () => {
  const m = fixture(), recovery = m.runRecovery();
  assert.equal(m.recoveryInFlight, true);
  await m.stop();
  assert.deepEqual(m.exports(), { port: undefined, hasProcess: false });
  assert.equal(m.isStopping, true);
  m.stops[0].resolve(); await recovery;
  assert.deepEqual(m.events, ['start']); assert.equal(m.isStopping, false);
});
test('a ready replacement observed before our stop does not expose the old pending restart', async () => {
  const m = fixture(), recovery = m.runRecovery();
  await m.start(); // Existing renderer setup before the transaction can do this.
  assert.deepEqual(m.exports(), { port: 40000, hasProcess: true });
  const ownStop = m.stop(); m.stops[1].resolve(); await ownStop;
  assert.deepEqual(m.exports(), { port: undefined, hasProcess: false });
  m.stops[0].resolve(); await recovery;
  assert.equal(m.events.length, 2);
});
test('current autoRecover=false cannot cancel a recovery which already entered restart', async () => {
  const m = fixture(), recovery = m.runRecovery();
  m.autoRecover = false; // Model an observed prior user configuration change, not a product write.
  await m.stop(); m.stops[0].resolve(); await recovery;
  assert.deepEqual(m.events, ['start']);
});
test('cancelling the pending timer differs from cancelling its already running callback', async () => {
  const m = fixture(); m.pendingRecoveryTimer = true;
  m.pendingRecoveryTimer = false; const recovery = m.runRecovery();
  await m.stop(); assert.equal(m.pendingRecoveryTimer, false);
  assert.equal(m.recoveryInFlight, true);
  m.stops[0].resolve(); await recovery; assert.equal(m.events.length, 1);
});
test('stopGeneration fences an awaiting heartbeat hang handler but not runRecovery restart', async () => {
  const m = fixture();
  const expected = m.stopGeneration + 1;
  const heartbeatStop = m.stop();
  const handler = heartbeatStop.then(() => { if (m.stopGeneration === expected) m.events.push('schedule-hang'); });
  await m.stop(); m.stops[0].resolve(); await handler;
  assert.deepEqual(m.events, []);
  await m.start(); const recovery = m.runRecovery();
  await m.stop(); m.stops[1].resolve(); await recovery;
  assert.deepEqual(m.events, ['start', 'start']);
});
test('a pre-spawn startingPromise remains live after stop returns with no process', async () => {
  const m = fixture(), preSpawn = deferred();
  m.serverProcess = undefined; m.port = undefined; m.serverUrl = undefined;
  const start = m.startingPromise = (async () => {
    await preSpawn.promise;
    m.serverProcess = { birth: 99 }; m.port = 40000; m.serverUrl = 'synthetic-ready';
    m.events.push('late-spawn'); m.startingPromise = undefined;
  })();
  await m.stop(); assert.deepEqual(m.exports(), { port: undefined, hasProcess: false });
  assert.ok(m.startingPromise); preSpawn.resolve(); await start;
  assert.deepEqual(m.events, ['late-spawn']);
});
test('observable stopped state cannot distinguish settled manager from manager with latent recovery', async () => {
  const settled = fixture(), pending = fixture();
  const finished = settled.stop(); settled.stops[0].resolve(); await finished;
  const latent = pending.runRecovery(); await pending.stop();
  assert.deepEqual(settled.exports(), pending.exports());
  // Neither public exports nor another completed deactivate is a pause lease.
  let credentialWrites = 0;
  const admit = () => { throw Error('OFFICIAL_PAUSE_ACK_UNAVAILABLE'); };
  assert.throws(() => { admit(); credentialWrites++; }, /OFFICIAL_PAUSE_ACK_UNAVAILABLE/);
  pending.stops[0].resolve(); await latent;
  assert.equal(credentialWrites, 0); assert.equal(pending.events.length, 1);
});
