const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assertCurrentRecoveryDisabled, settleOwnedBackend } = require('../out/official-recovery-policy');
const { admitReadyOfficialWrite } = require('../out/official-write-admission');

test('current default disabled 1.9 is admitted with no historical observation', async () => {
  let checks = 0;
  const policy = () => assertCurrentRecoveryDisabled(undefined, undefined);
  assert.equal(await admitReadyOfficialWrite('1.9.0', async () => { checks++; return 'owned-birth'; },
    () => { throw Error('No fixed sleep admission'); }, undefined, policy), 'owned-birth');
  assert.equal(checks, 2);
});
test('current effective enable blocks and disable-only override is honored without historical claims', () => {
  assert.throws(() => assertCurrentRecoveryDisabled(true, undefined), /OFFICIAL_RECOVERY_ENABLED/);
  assertCurrentRecoveryDisabled(true, '1');
  assertCurrentRecoveryDisabled(false, undefined);
  assertCurrentRecoveryDisabled(undefined, undefined);
});
test('configuration enabled during readiness rejects before write', async () => {
  let enabled = false;
  await assert.rejects(admitReadyOfficialWrite('1.9.0', async () => { enabled = true; return 'owned-birth'; },
    undefined, undefined, () => assertCurrentRecoveryDisabled(enabled)), /OFFICIAL_RECOVERY_ENABLED/);
});
test('stop must observe exact birth exit, then a late replacement gets a bounded stop', async () => {
  const events = []; let birth = 'first', exits = 0;
  await settleOwnedBackend({ assertCurrent() {}, inspect: async () => birth,
    stop: async expected => { assert.equal(expected,birth); events.push('stop:'+expected); },
    waitForExit: async expected => { events.push('exit:'+expected); birth = ++exits === 1 ? 'late' : undefined; } });
  assert.deepEqual(events,['stop:first','exit:first','stop:late','exit:late']);
});
test('late spawn between empty observations is stopped before returning', async () => {
  let reads = 0, stopped = false;
  await settleOwnedBackend({ assertCurrent() {}, inspect: async () => ++reads === 1 || stopped ? undefined : 'late',
    stop: async value => { assert.equal(value,'late'); stopped = true; }, waitForExit: async () => {} });
  assert.equal(stopped,true);
});
test('continuous respawn exhausts three attempts and never authorizes writing', async () => {
  let stops = 0;
  await assert.rejects(settleOwnedBackend({ assertCurrent() {}, inspect: async () => 'birth:'+stops,
    stop: async () => { stops++; }, waitForExit: async () => {} }), /OFFICIAL_BACKEND_RESTARTING/);
  assert.equal(stops,3);
});
test('unknown ownership and uncertain exit cannot be retried as a guessed kill', async () => {
  let stops = 0;
  await assert.rejects(settleOwnedBackend({ assertCurrent() {}, inspect: async () => { throw Error('OWNERSHIP_UNKNOWN'); },
    stop: async () => { stops++; }, waitForExit: async () => {} }), /OWNERSHIP_UNKNOWN/);
  assert.equal(stops,0);
  await assert.rejects(settleOwnedBackend({ assertCurrent() {}, inspect: async () => 'pinned',
    stop: async () => { stops++; }, waitForExit: async () => { throw Error('EXIT_UNKNOWN'); } }), /EXIT_UNKNOWN/);
  assert.equal(stops,1);
});
test('counterexample: spawn after final observation remains possible, not a proven pause', async () => {
  let birth;
  await settleOwnedBackend({ assertCurrent() {}, inspect: async () => birth,
    stop: async () => { throw Error('unexpected'); }, waitForExit: async () => {} });
  birth = 'unobserved-late';
  // A post-write reader/identity check must reject a wrong identity. This model
  // deliberately does not claim the finite scanner prevents this interleaving.
  assert.equal(birth,'unobserved-late');
});
