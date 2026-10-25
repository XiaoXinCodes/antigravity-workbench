const test = require('node:test');
const assert = require('node:assert/strict');
const { repairComponentRoute, validateRouteRepairRecord } = require('../out/component-route-repair');
const { LiveError } = require('../out/live-storage');
const b = pid => ({ pid, startIdentity: `linux:11111111-1111-1111-1111-111111111111:${pid}` });
function fixture() {
  let record, current = b(2), owner = true, stopped = false;
  const events = [], faults = {};
  const runtime = { transaction: '11111111-1111-1111-1111-111111111111', host: b(1),
    assertOwner: async () => { if (!owner) throw new LiveError('LOCK_OWNERSHIP_CHANGED'); },
    inspectOwned: async () => { if (!current) throw new LiveError('OFFICIAL_HUB_NOT_READY'); return { ...current }; },
    save: async next => { events.push(`save:${next.phase}`); if (faults.save) throw Error('SAVE_FAILED'); record = structuredClone(next); if (faults.loseOnSave === next.phase) owner = false; },
    stop: async old => { assert.deepEqual(old, b(2)); events.push('stop'); if (faults.stop) throw Error('STOP_FAILED'); if (!faults.noExit) { stopped = true; current = undefined; } },
    isStopped: async () => stopped,
    startOnce: async () => { events.push('start'); if (faults.start) throw Error('START_FAILED'); current = b(3); },
    observeStarted: async () => { events.push('observe'); if (!current) throw new LiveError('COMPONENT_ACTION_PENDING'); return { ...current }; },
    proveOwnRoute: async hub => { events.push('prove'); assert.deepEqual(current, hub); if (faults.proof) throw new LiveError('WSL_FILE_ROUTE_UNVERIFIED'); if (faults.replaceOnProof) current = b(4); },
  };
  return { runtime, events, faults, record: () => structuredClone(record), current: value => { current = value; }, lose: () => { owner = false; },
    exit: () => { stopped = true; current = undefined; }, run: () => repairComponentRoute(record, runtime) };
}
test('missing shared-log proof is repaired using one controlled restart and owned new proof', async () => {
  const f = fixture(); f.faults.proof = true;
  await assert.rejects(f.runtime.proveOwnRoute(b(2)), /WSL_FILE_ROUTE_UNVERIFIED/);
  f.faults.proof = false; assert.equal((await f.run()).phase, 'proved');
  assert.ok(f.events.indexOf('save:prepared') < f.events.indexOf('stop'));
  assert.ok(f.events.indexOf('save:starting') < f.events.indexOf('start'));
  assert.equal(f.events.filter(e => e === 'start').length, 1);
  await f.run(); assert.equal(f.events.filter(e => e === 'start').length, 1);
});
test('initial durable save failure prevents stop and start', async () => {
  const f = fixture(); f.faults.save = true; await assert.rejects(f.run(), /SAVE_FAILED/);
  assert.ok(!f.events.includes('stop')); assert.ok(!f.events.includes('start'));
});
for (const failure of ['stop','noExit']) test(`stop ${failure} retains stopping obligation and cannot start before exit`, async () => {
  const f = fixture(); f.faults[failure] = true;
  await assert.rejects(f.run(), /STOP_FAILED|OFFICIAL_BACKEND_NOT_STOPPED/);
  assert.equal(f.record().phase, 'stopping'); assert.ok(!f.events.includes('start'));
  f.exit(); f.faults[failure] = false; await f.run();
  assert.equal(f.events.filter(e => e === 'stop').length, 1);
});
test('failed start is never redispatched; late observation recovers same starting obligation', async () => {
  const f = fixture(); f.faults.start = true; await assert.rejects(f.run(), /START_FAILED/);
  assert.equal(f.record().phase, 'starting'); await assert.rejects(f.run(), /COMPONENT_ACTION_PENDING/);
  f.current(b(3)); assert.equal((await f.run()).phase, 'proved');
  assert.equal(f.events.filter(e => e === 'start').length, 1);
});
test('new birth cannot be stopped in place of failed original stop', async () => {
  const f = fixture(); f.faults.stop = true; await assert.rejects(f.run(), /STOP_FAILED/);
  f.current(b(4)); await assert.rejects(f.run(), /HUB_CHANGED_DURING_OPERATION/);
  assert.equal(f.events.filter(e => e === 'stop').length, 1);
});
test('proof failure pins new birth and refuses replacement on retry', async () => {
  const f = fixture(); f.faults.proof = true; await assert.rejects(f.run(), /WSL_FILE_ROUTE_UNVERIFIED/);
  assert.equal(f.record().phase, 'starting'); assert.deepEqual(f.record().newHub, b(3));
  f.current(b(4)); f.faults.proof = false; await assert.rejects(f.run(), /HUB_CHANGED_DURING_OPERATION/);
  assert.equal(f.events.filter(e => e === 'start').length, 1);
});
test('unknown ownership and replacement across proof never produce proved record', async () => {
  const f = fixture(); f.current(undefined); await assert.rejects(f.run(), /OFFICIAL_HUB_NOT_READY/); assert.equal(f.record(), undefined);
  const g = fixture(); g.faults.replaceOnProof = true; await assert.rejects(g.run(), /HUB_CHANGED_DURING_OPERATION/);
  assert.equal(g.record().phase, 'starting');
});
for (const phase of ['prepared','stopping','starting']) test(`owner loss after ${phase} save fences subsequent effects`, async () => {
  const f = fixture(); f.faults.loseOnSave = phase; await assert.rejects(f.run(), /LOCK_OWNERSHIP_CHANGED/);
  assert.equal(f.record().phase, phase); assert.ok(!f.events.includes('start'));
  if (phase !== 'starting') assert.ok(!f.events.includes('stop'));
});
test('multiple missing-evidence components can repair serially without shared lifecycle effects', async () => {
  const a = fixture(), c = fixture(); c.runtime.transaction = '22222222-2222-2222-2222-222222222222';
  await a.run(); assert.deepEqual(c.events, []); await c.run();
  assert.equal(a.record().phase, 'proved'); assert.equal(c.record().phase, 'proved');
});

test('durable record validator rejects malformed phase, extra capability fields and invalid birth', async () => {
  const f = fixture(); const r = await f.run(); assert.equal(validateRouteRepairRecord(r), true);
  for (const bad of [{ ...r, capability: 'forbidden' }, { ...r, newHub: undefined }, { ...r, oldHub: b(-1) },
    { ...r, transaction: 'not-uuid' }, { ...r, phase: 'stopped' }, { ...r, newHub: r.oldHub },
    { ...r, host: { pid: 1, startIdentity: 'unknown' } }]) assert.equal(validateRouteRepairRecord(bad), false);
});
