const test = require('node:test');
const assert = require('node:assert/strict');
const { WindowSwitchProtocol, WindowSwitchError } = require('../out/window-switch-protocol');

function fixture(options = {}) {
  const windows = [1, 2, 3].map(pid => ({ window: `w${pid}`, host: { pid, startIdentity: `birth${pid}` }, scope: 'scope',
    launcher: 'validated-launcher-capability', profile: 'profile-capability', authority: 'wsl+synthetic', workspace: { kind: 'folder', uri: `vscode-remote://wsl+synthetic/project${pid}` } }));
  const state = { record: undefined, time: 0, cancel: false, held: false, events: [], gone: new Set(), reopened: new Set(), outcome: 'original', writes: 0, ready: true, complete: true, windows };
  const runtime = {
    async exclusive(fn) { if (state.held) throw new WindowSwitchError('WINDOW_BUSY'); state.held = true; try { return await fn(); } finally { state.held = false; } },
    async read() { return structuredClone(state.record); },
    async save(next, expected) { assert.deepEqual(state.record, expected); state.record = structuredClone(next); state.events.push(next.phase); },
    now: () => state.time,
    cancelled: async () => state.cancel,
    participants: async () => ({ complete: state.complete, windows: structuredClone(state.windows) }),
    canReopen: async () => state.ready,
    async saveWindow(w) { state.events.push(`save:${w.window}`); return options.saveCancel !== w.window; },
    async handoff(r) { state.events.push('handoff'); if (options.lostAck) throw Error('synthetic IPC loss'); return { id: r.id, attempt: options.wrongAck ? 'other' : r.attempt, executor: { pid: 99, startIdentity: 'independent-birth' } }; },
    async assertExecutor(e) { assert.deepEqual(e, { pid: 99, startIdentity: 'independent-birth' }); },
    async requestClose(w) { assert.equal(state.record.phase, 'closing'); assert.ok(state.record.executor); state.events.push(`close:${w.window}`); if (options.veto !== w.window) state.gone.add(w.window); if (options.cancelAfterClose === w.window) state.cancel = true; },
    exited: async w => state.gone.has(w.window),
    settleClose: async w => options.closePending === w.window ? 'pending' : state.gone.has(w.window) ? 'closed' : 'open',
    async wait() { state.time += 10; },
    async switchAccount() { assert.equal(state.gone.size, 3); state.events.push('write'); if (options.beforeWrite) throw new WindowSwitchError('OFFLINE_NEW_INSTANCE'); state.writes++; state.outcome = 'target'; if (options.lateAck) throw Error('lost commit ACK'); },
    async settle() { state.events.push('settle'); if (options.unsettled) throw new WindowSwitchError('WRITER_PENDING'); return options.unknown ? 'unknown' : state.outcome; },
    async reopen(w, attempt) { assert.equal(attempt, 'attempt'); state.events.push(`reopen:${w.window}`); if (options.reopenFailure === w.window) throw Error('native launch failed'); state.reopened.add(w.window); },
    async verify(r, outcome) { state.events.push('verify'); assert.equal(r.outcome, outcome); return !options.wrongIdentity; },
  };
  const protocol = new WindowSwitchProtocol(runtime);
  return { state, runtime, protocol, prepare: () => protocol.prepare({ id: 'transaction', attempt: 'attempt', scope: 'scope', confirmed: true, deadline: 100 }) };
}

test('three windows save, durable handoff, actual exit, switch, reopen and fresh verify in order', async () => {
  const f = fixture(); await f.prepare();
  assert.equal(f.state.record.phase, 'armed'); assert.equal(f.state.gone.size, 0);
  await f.protocol.execute('attempt');
  assert.equal(f.state.record.phase, 'verified'); assert.equal(f.state.writes, 1); assert.equal(f.state.reopened.size, 3);
  assert.ok(f.state.events.indexOf('save:w3') < f.state.events.indexOf('handoff'));
  assert.ok(f.state.events.indexOf('handoff') < f.state.events.indexOf('close:w1'));
  assert.ok(f.state.events.indexOf('close:w3') < f.state.events.indexOf('write'));
  assert.ok(f.state.events.indexOf('settle') < f.state.events.indexOf('reopen:w1'));
  assert.ok(f.state.events.indexOf('reopen:w3') < f.state.events.indexOf('verify'));
});
test('missing launcher refuses before durable preparation, saves or closes', async () => {
  const f = fixture(); f.state.ready = false;
  await assert.rejects(f.prepare(), { code: 'WINDOW_REOPEN_UNAVAILABLE' }); assert.deepEqual(f.state.events, []); assert.equal(f.state.record, undefined);
});
for (const options of [{ saveCancel: 'w2' }, { lostAck: true }, { wrongAck: true }]) test('cancel/failed handoff never arms or closes: ' + JSON.stringify(options), async () => {
  const f = fixture(options); await assert.rejects(f.prepare());
  assert.equal(f.state.record.phase, 'cancelled'); assert.equal(f.state.gone.size, 0); assert.equal(f.state.writes, 0);
  await assert.rejects(f.protocol.execute('attempt'), { code: 'WINDOW_ATTEMPT_NOT_ARMED' });
});
test('unknown participant refuses; added window between preparation and execution prevents close', async () => {
  const f = fixture(); f.state.complete = false;
  await assert.rejects(f.prepare(), { code: 'WINDOW_PARTICIPANTS_UNVERIFIED' });
  f.state.complete = true; await f.prepare(); f.state.windows.pop();
  await assert.rejects(f.protocol.execute('attempt'), { code: 'WINDOW_PARTICIPANTS_CHANGED' });
  assert.equal(f.state.gone.size, 0); assert.equal(f.state.writes, 0);
});
test('native close veto times out without write and reopens only actually closed windows', async () => {
  const f = fixture({ veto: 'w2' }); await f.prepare();
  await assert.rejects(f.protocol.execute('attempt'), { code: 'WINDOW_TIMEOUT' });
  assert.equal(f.state.writes, 0); assert.deepEqual([...f.state.reopened], ['w1']); assert.equal(f.state.record.phase, 'cancelled');
  assert.ok(!f.state.events.includes('close:w3'));
});
test('cancel after partial closure settles before reopening and does not write', async () => {
  const f = fixture({ cancelAfterClose: 'w1' }); await f.prepare();
  await assert.rejects(f.protocol.execute('attempt'), { code: 'WINDOW_CANCELLED' });
  assert.equal(f.state.writes, 0); assert.deepEqual([...f.state.reopened], ['w1']); assert.equal(f.state.record.outcome, 'original');
});
test('pending native close cannot be mistaken for veto; late exit remains recoverable', async () => {
  const options = { veto: 'w2', closePending: 'w2' }; const f = fixture(options); await f.prepare();
  await assert.rejects(f.protocol.execute('attempt'), { code: 'WINDOW_CLOSE_PENDING' });
  assert.equal(f.state.record.phase, 'recovery-required'); assert.equal(f.state.writes, 0);
  f.state.gone.add('w2'); options.closePending = undefined; await f.protocol.recover('attempt');
  assert.deepEqual([...f.state.reopened], ['w1', 'w2']); assert.equal(f.state.record.phase, 'cancelled');
});
test('new instance rejection restores closed windows without credential write', async () => {
  const f = fixture({ beforeWrite: true }); await f.prepare();
  await assert.rejects(f.protocol.execute('attempt'), { code: 'OFFLINE_NEW_INSTANCE' });
  assert.equal(f.state.writes, 0); assert.equal(f.state.reopened.size, 3); assert.equal(f.state.record.phase, 'cancelled');
});
test('late commit ACK settles target once, never repeats write or restores original blindly', async () => {
  const f = fixture({ lateAck: true }); await f.prepare(); await assert.rejects(f.protocol.execute('attempt'));
  assert.equal(f.state.writes, 1); assert.equal(f.state.record.phase, 'verified'); assert.equal(f.state.record.outcome, 'target');
});
test('unsettled writer prevents reopening and retains recovery record', async () => {
  const f = fixture({ unsettled: true }); await f.prepare();
  await assert.rejects(f.protocol.execute('attempt'), { code: 'WRITER_PENDING' });
  assert.equal(f.state.reopened.size, 0); assert.equal(f.state.record.phase, 'recovery-required');
});
for (const options of [{ unknown: true }, { wrongIdentity: true }, { reopenFailure: 'w2' }]) test('unknown identity or reopen failure cannot report success: ' + JSON.stringify(options), async () => {
  const f = fixture(options); await f.prepare(); await assert.rejects(f.protocol.execute('attempt'));
  assert.equal(f.state.record.phase, 'recovery-required'); assert.equal(f.state.writes, 1);
  if (options.reopenFailure) assert.equal(f.state.events.filter(x => x === 'reopen:w2').length, 1);
});
test('crash after native close before exit ACK recovers only closed windows, never resumes mutation', async () => {
  const f = fixture(); await f.prepare();
  f.state.record.phase = 'closing'; f.state.record.closeRequested = ['w1', 'w2']; f.state.gone.add('w1');
  await f.protocol.recover('attempt');
  assert.deepEqual([...f.state.reopened], ['w1']); assert.equal(f.state.writes, 0); assert.equal(f.state.record.phase, 'cancelled');
});
test('recovery after lost reopen receipt relies on idempotent registration, preserves prior receipts', async () => {
  const options = { reopenFailure: 'w2' }; const f = fixture(options); await f.prepare(); await assert.rejects(f.protocol.execute('attempt'));
  options.reopenFailure = undefined; await f.protocol.recover('attempt');
  assert.equal(f.state.events.filter(x => x === 'reopen:w1').length, 1); assert.equal(f.state.writes, 1); assert.equal(f.state.record.phase, 'verified');
});
test('duplicate clicks and wrong attempt never supersede existing or legacy transactions', async () => {
  const f = fixture(); await f.prepare();
  await assert.rejects(f.prepare(), { code: 'WINDOW_ATTEMPT_EXISTS' }); await assert.rejects(f.protocol.execute('other'), { code: 'WINDOW_ATTEMPT_NOT_ARMED' });
  assert.equal(f.state.gone.size, 0);
  f.state.record = { schema: 4, id: 'legacy' };
  await assert.rejects(f.prepare(), { code: 'WINDOW_ATTEMPT_EXISTS' }); assert.deepEqual(f.state.record, { schema: 4, id: 'legacy' });
});
test('concurrent preparation uses shared exclusion rather than two handoffs', async () => {
  const f = fixture(); let release;
  f.runtime.saveWindow = async () => new Promise(resolve => { release = resolve; });
  const first = f.prepare(); while (!release) await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(f.prepare(), { code: 'WINDOW_BUSY' });
  f.runtime.saveWindow = async () => true; release(true); await first;
  assert.equal(f.state.events.filter(x => x === 'handoff').length, 1);
});
test('durable descriptors survive fresh journal instance; stale CAS and descriptor replacement reject', async t => {
  const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
  const { WindowSwitchJournal } = require('../out/window-switch-journal');
  const dir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'window-journal-fixture-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const f = fixture(); await f.prepare(); const original = structuredClone(f.state.record);
  const first = new WindowSwitchJournal(path.join(dir, 'state')); await first.save(original, undefined);
  const second = new WindowSwitchJournal(path.join(dir, 'state')); assert.deepEqual(await second.read(), original);
  await assert.rejects(second.save(original, undefined), { code: 'WINDOW_JOURNAL_CHANGED' });
  const altered = structuredClone(original); altered.windows[0].profile = 'different-profile';
  await assert.rejects(second.save(altered, original), { code: 'WINDOW_JOURNAL_CHANGED' });
  const next = { ...original, phase: 'closing', closeRequested: ['w1'] }; await second.save(next, original);
  assert.deepEqual(await first.read(), next);
  const savedFile = await fs.stat(path.join(dir, 'state', 'state.json'));
  assert.equal(savedFile.isFile(), true);
  // Node Windows mode bits are synthesized, not POSIX access permissions.
  if (process.platform !== 'win32') assert.equal(savedFile.mode & 0o077, 0);
});
test('journal rejects raw commands, tokens, URI secrets, old schemas and fabricated reopen receipts', async () => {
  const { validateWindowSwitchRecord } = require('../out/window-switch-journal');
  const f = fixture(); await f.prepare();
  for (const mutate of [
    r => { r.token = 'synthetic'; }, r => { r.windows[0].argv = ['arbitrary']; },
    r => { r.windows[0].workspace.uri += '?token=synthetic'; }, r => { r.schema = 4; },
    r => { r.reopened = ['w1']; }, r => { r.windows[0].workspace.uri = 'command:arbitrary'; },
  ]) { const r = structuredClone(f.state.record); mutate(r); assert.throws(() => validateWindowSwitchRecord(r), { code: 'WINDOW_JOURNAL_INVALID' }); }
});
test('durable participant registry uses runtime births and includes hosts with no Hub', async t => {
  const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
  const { WindowParticipants } = require('../out/window-participants');
  const dir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'window-registry-fixture-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const registry = new WindowParticipants(path.join(dir, 'registry')); const f = fixture(); const [a, b, c] = f.state.windows;
  const register = w => registry.register({ self: async () => w.host, capture: async () => w });
  await register(a); await register(b);
  assert.equal((await registry.snapshot('scope', { complete: true, unknown: false, hosts: [a.host, b.host, c.host] })).complete, false);
  await register(c); const fresh = new WindowParticipants(path.join(dir, 'registry'));
  assert.equal((await fresh.snapshot('scope', { complete: true, unknown: false, hosts: [a.host, b.host, c.host] })).complete, true);
  assert.equal((await fresh.snapshot('scope', { complete: true, unknown: false, hosts: [{ ...a.host, startIdentity: 'new-birth' }] })).complete, false);
  assert.equal((await fresh.snapshot('unrelated', { complete: true, unknown: false, hosts: [a.host] })).complete, false);
  await register(a); // Exact same live binding is idempotent.
  await assert.rejects(register({ ...a, profile: 'changed-live-profile' }), { code: 'WINDOW_ALREADY_REGISTERED' });
  await assert.rejects(registry.register({ self: async () => a.host, capture: async () => b }), { code: 'WINDOW_HOST_BINDING_UNVERIFIED' });
  await assert.rejects(registry.register({ self: async () => a.host, capture: async () => undefined }), { code: 'WINDOW_HOST_BINDING_UNVERIFIED' });
  await registry.pruneExited(async h => h.pid === a.host.pid ? 'exited' : 'unknown');
  const replacement = { ...a, host: { ...a.host, startIdentity: 'next-birth' } }; await register(replacement);
  assert.equal((await registry.snapshot('scope', { complete: true, unknown: false, hosts: [replacement.host, b.host, c.host] })).complete, true);
});

test('pending close does not block recovery of independently closed later participants',async()=>{const f=fixture({closePending:'w1'});await f.prepare();f.state.record.phase='recovery-required';f.state.record.closeRequested=['w1','w2','w3'];f.state.gone.add('w2');f.state.gone.add('w3');await assert.rejects(f.protocol.recover('attempt'),{code:'WINDOW_CLOSE_PENDING'});assert.deepEqual([...f.state.reopened],['w2','w3']);assert.equal(f.state.writes,0);assert.equal(f.state.record.phase,'recovery-required');f.runtime.settleClose=async w=>f.state.gone.has(w.window)?'closed':'pending';f.state.gone.add('w1');await f.protocol.recover('attempt');assert.deepEqual([...f.state.reopened],['w2','w3','w1']);assert.equal(f.state.record.phase,'cancelled');assert.equal(f.state.writes,0);});
