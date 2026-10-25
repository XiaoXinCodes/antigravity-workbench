const test = require('node:test');
const assert = require('node:assert/strict');

// Contract counterexamples, NOT a working pause implementation. Synthetic
// objects only; no official code, subprocess, account, timer or IPC is used.
// Relevant semantics: both reviewed starts reuse a current process, otherwise
// start; stop clears that reference. Neither start consults a Workbench lease.
function manager() {
  let child = { birth: 1 }, birth = 1;
  return {
    stop: async () => { child = undefined; },
    start: () => child ??= { birth: ++birth },
    child: () => child,
  };
}
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

for (const version of ['1.8.0', '1.9.0']) {
  test(`${version}: stop ACK and Workbench lease do not inhibit an official start entry`, async () => {
    const official = manager(), lease = { transaction: 'synthetic-tx', held: true };
    await official.stop();
    const ack = !official.child();
    assert.equal(ack, true);
    // A user-triggered renderer setup/retry invokes start independently of
    // Workbench commands; this is not a claim of natural 1.8 auto recovery.
    official.start();
    assert.equal(lease.held, true);
    assert.ok(official.child(), 'the cooperative lease is not a start fence');
  });
}

test('1.9: a second stop ACK cannot cancel an already awaiting recovery restart', async () => {
  const official = manager(), oldStop = deferred();
  await official.stop();
  const recovery = oldStop.promise.then(() => official.start());
  // stop can immediately return when its reference has already been cleared.
  await official.stop();
  assert.equal(official.child(), undefined);
  oldStop.resolve();
  await recovery;
  assert.ok(official.child());
});

test('complete registered-host ACKs miss a live host whose Workbench has not activated', async () => {
  const registered = manager(), unregistered = manager();
  await unregistered.stop();
  const registry = new Map([['registered-birth', registered]]);
  await Promise.all([...registry.values()].map(m => m.stop()));
  assert.ok([...registry.values()].every(m => !m.child()));
  // No Hub was present at census time. Official activation is independent of
  // Workbench activation/registration, including in a newly opened window.
  // This shows incomplete census, not that every unregistered host starts.
  unregistered.start();
  assert.ok(unregistered.child());
});

test('lease expiry cannot distinguish a dead coordinator from a delayed live writer', async () => {
  const official = manager(), io = deferred(), events = [];
  await official.stop();
  const write = io.promise.then(() => events.push('credential-write-completes'));
  // A paused coordinator or outstanding OS I/O need not refresh a lease.
  official.start();
  events.push('lease-expiry-resume');
  io.resolve();
  await write;
  assert.deepEqual(events, ['lease-expiry-resume', 'credential-write-completes']);
  assert.ok(official.child());
});
