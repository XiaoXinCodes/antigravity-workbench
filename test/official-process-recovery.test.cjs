const test = require('node:test');
const assert = require('node:assert/strict');
const { OfficialProcessRecovery, runProcessHelper } = require('../out/official-process-recovery');
const { LiveError } = require('../out/live-storage');
const api = { port: 32123, csrfToken: 'synthetic-capability-not-output' };
const row = (pid = 710, kind = 'unowned-hub', extra = {}) => ({ pid, parentPid: 701, startTicks: '123456', bootId: '11111111-1111-4111-8111-111111111111', commandHash: 'a'.repeat(64), kind, parentState: 'alive', startedAt: '2026-10-08T11:00:00+00:00', canEnd: kind === 'unowned-hub', ...extra });
function fixture(extra = {}) {
  let current = { ...api }, rows = [row(709, 'current-hub'), row()], response = { result: 'exited' };
  const calls = [];
  const recovery = new OfficialProcessRecovery({ platform: 'linux', executable: '/synthetic/bin/agy', ownerPid: 701, api: () => current, assertCurrent() {},
    helper: async request => { calls.push(request); return request.operation === 'scan' ? { supported: true, processes: rows } : response; }, ...extra });
  return { recovery, calls, setApi: value => { current = value; }, setRows: value => { rows = value; }, setResponse: value => { response = value; } };
}
test('process list exposes proof-backed details and one-use opaque selection, never capabilities or proof hashes', async () => {
  const f = fixture(), state = await f.recovery.scan();
  assert.equal(state.phase, 'blocked'); assert.equal(state.processes.length, 1);
  const selected = state.processes[0]; assert.equal(selected.pid, 710); assert.equal(selected.owner, 'other'); assert.equal(selected.parentState, 'alive'); assert.equal(selected.canEnd, true);
  assert.doesNotMatch(JSON.stringify(state), /csrf|synthetic-capability|commandHash|bootId|startTicks|executable/);
  assert.equal(await f.recovery.end(selected.id, new AbortController().signal), 'exited');
  assert.deepEqual(f.calls[1].target, row());
  await assert.rejects(f.recovery.end(selected.id, new AbortController().signal), /SELECTION_STALE/);
  assert.equal(f.calls.filter(call => call.operation === 'end').length, 1);
});
test('arbitrary PID, fabricated token, other user role and current Hub cannot be chosen', async () => {
  const f = fixture(); f.setRows([row(709, 'current-hub'), row(710, 'unverified', { canEnd: true }), row(711, 'unowned-hub', { canEnd: false })]);
  const state = await f.recovery.scan(); assert.ok(state.processes.every(p => !p.canEnd));
  for (const value of [710, { pid: 710 }, '710', 'not-a-selection', ...state.processes.map(p => p.id)]) await assert.rejects(f.recovery.end(value, new AbortController().signal), /SELECTION_STALE/);
  assert.equal(f.calls.filter(call => call.operation === 'end').length, 0);
});
test('rescan invalidates previous selections and reflects an exited or new conflict', async () => {
  const f = fixture(), first = await f.recovery.scan(); f.setRows([row(709, 'current-hub'), row(711)]);
  const second = await f.recovery.scan(); assert.equal(second.processes[0].pid, 711);
  await assert.rejects(f.recovery.end(first.processes[0].id, new AbortController().signal), /SELECTION_STALE/);
  f.setRows([row(709, 'current-hub')]); assert.equal((await f.recovery.scan()).canContinue, true);
  f.setRows([]); assert.equal((await f.recovery.scan()).canContinue, false, 'an advertised running Hub without a matching process is not ready');
  f.setApi(undefined); assert.equal((await f.recovery.scan()).canContinue, true);
});
test('API wrapper is value-based; Hub replacement during scan or before ending rejects the stale proof', async () => {
  let f = fixture(), selected = (await f.recovery.scan()).processes[0]; f.setApi({ ...api }); await f.recovery.end(selected.id, new AbortController().signal);
  f = fixture(); selected = (await f.recovery.scan()).processes[0]; f.setApi({ ...api, port: 32124 });
  await assert.rejects(f.recovery.end(selected.id, new AbortController().signal), /HUB_CHANGED/); assert.equal(f.calls.length, 1);
  let current = api;
  f = fixture({ api: () => current, helper: async () => { current = { ...api, port: 32124 }; return { supported: true, processes: [row()] }; } });
  await assert.rejects(f.recovery.scan(), /HUB_CHANGED/);
});
test('superseded slow scan cannot restore old IDs or overwrite a newer scan', async () => {
  let resolveOld, count = 0;
  const f = fixture({ helper: async () => ++count === 1 ? new Promise(resolve => { resolveOld = resolve; }) : { supported: true, processes: [row(709, 'current-hub'), row(711)] } });
  const old = f.recovery.scan(); const latest = await f.recovery.scan(); resolveOld({ supported: true, processes: [row()] });
  await assert.rejects(old, /SELECTION_STALE/); assert.equal(latest.processes[0].pid, 711);
});
for (const code of ['OFFICIAL_PROCESS_SELECTION_STALE', 'OFFICIAL_PROCESS_END_DENIED', 'OFFICIAL_BACKEND_STOP_TIMEOUT', 'OFFICIAL_PROCESS_END_UNAVAILABLE']) test(`helper ${code} cannot become a successful stop`, async () => {
  const f = fixture(), selection = (await f.recovery.scan()).processes[0]; f.setResponse({ code });
  await assert.rejects(f.recovery.end(selection.id, new AbortController().signal), error => error.code === code);
});
test('gone target is idempotent; aborted and late-disposed operations cannot continue', async () => {
  const f = fixture(), selected = (await f.recovery.scan()).processes[0]; f.setResponse({ result: 'gone' }); assert.equal(await f.recovery.end(selected.id, new AbortController().signal), 'gone');
  const controller = new AbortController(); controller.abort(); await assert.rejects(runProcessHelper({ operation: 'probe' }, controller.signal), /CANCELLED/);
  let resolveEnd; const delayed = fixture({ helper: async request => request.operation === 'scan' ? { supported: true, processes: [row()] } : new Promise(resolve => { resolveEnd = resolve; }) });
  const id = (await delayed.recovery.scan()).processes[0].id, end = delayed.recovery.end(id, new AbortController().signal);
  await assert.rejects(delayed.recovery.end(id, new AbortController().signal), /SELECTION_STALE/);
  await assert.rejects(delayed.recovery.scan(), /SELECTION_STALE/);
  delayed.recovery.invalidate(); resolveEnd({ result: 'exited' }); await assert.rejects(end, /SELECTION_STALE/);
});
for (const platform of ['win32', 'darwin']) test(`${platform} lists actual process metadata but never advertises an unsafe termination adapter`, async () => {
  const calls = [], output = platform === 'win32' ? JSON.stringify([{ pid: 709, parentPid: 701, startedAt: '2026-10-08T11:00:00.000Z' }, { pid: 710, parentPid: 702, startedAt: '2026-10-08T10:00:00.000Z' }]) : ' 709 701 Thu Oct  8 11:00:00 2026 /synthetic/agy\n 710 702 Thu Oct  8 10:00:00 2026 /synthetic/agy\n 999 1 Thu Oct  8 09:00:00 2026 other\n';
  const f = fixture({ platform, nativeRun: async (exe, args) => { calls.push({ exe, args }); return { code: 0, stdout: output, stderr: '' }; }, helper: async () => { throw Error('no Linux helper on native platform'); } });
  const state = await f.recovery.scan(); assert.equal(state.processes.length, 2); assert.deepEqual(state.processes.map(p => p.pid), [709, 710]); assert.equal(state.limitation, 'platform'); assert.ok(state.processes.every(p => !p.canEnd)); assert.equal(calls.length, 1);
});
test('malformed helper output, duplicate PIDs and duplicate current hubs fail closed', async () => {
  for (const rows of [[row(), row()], [row(709, 'current-hub'), row(710, 'current-hub')], [row(710, 'unowned-hub', { bootId: 'wrong' })]]) {
    const f = fixture(); f.setRows(rows); await assert.rejects(f.recovery.scan(), /PROCESS_CHECK_FAILED/);
  }
  const f = fixture({ helper: async () => { throw new LiveError('PROCESS_CHECK_FAILED'); } }); await assert.rejects(f.recovery.scan(), /PROCESS_CHECK_FAILED/);
});
test('missing helper retains read-only process details and provides no termination fallback', async () => {
  const current = { pid: 709, parentPid: 701, startTicks: '1', kind: 'current-hub', taskState: 'unknown' }, foreign = { ...current, pid: 710, parentPid: 702, kind: 'unowned-hub' };
  const f = fixture({ helper: async () => { throw new LiveError('OFFICIAL_PROCESS_END_UNAVAILABLE'); }, inspect: async () => ({ processes: [current, foreign], current }) });
  const state = await f.recovery.scan(); assert.equal(state.processes[0].pid, 710); assert.equal(state.processes[0].canEnd, false); assert.equal(state.limitation, 'helper');
  await assert.rejects(f.recovery.end(state.processes[0].id, new AbortController().signal), /SELECTION_STALE/);
});

test('adoption during the TERM wait refuses authorization for force', async () => {
  let current = api; const signals = [];
  const f = fixture({ api: () => current, helper: async (request, signal, authorize) => {
    if (request.operation === 'scan') return { supported: true, processes: [row()] };
    authorize(); signals.push('term');
    current = { ...api, port: 32124 };
    authorize(); signals.push('force');
    return { result: 'forced' };
  } });
  const selected = (await f.recovery.scan()).processes[0];
  await assert.rejects(f.recovery.end(selected.id, new AbortController().signal), /HUB_CHANGED/);
  assert.deepEqual(signals, ['term']);
});

test('helper handshake validates every signal and watchdog cancels a stale exit wait', async t => {
  const childProcess = require('node:child_process');
  const { EventEmitter } = require('node:events');
  const { PassThrough, Writable } = require('node:stream');
  let child, writes = [], killed = 0, stale = false;
  t.mock.method(childProcess, 'spawn', () => {
    child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null;
    child.stdin = new Writable({ write(chunk, encoding, done) { writes.push(chunk.toString()); done(); } });
    child.kill = () => { killed++; child.exitCode = -1; queueMicrotask(() => child.emit('close', -1)); return true; };
    return child;
  });
  const authorize = () => { if (stale) throw new LiveError('HUB_CHANGED_DURING_OPERATION'); };
  let result = runProcessHelper({ operation: 'end' }, undefined, authorize);
  child.stdout.write('{"authorize":"term"}\n');
  assert.deepEqual(writes.slice(1), ['continue\n']);
  stale = true;
  await assert.rejects(result, /HUB_CHANGED/);
  assert.equal(killed, 1); assert.deepEqual(writes.slice(1), ['continue\n'], 'no force authorization after adoption');
  writes = []; stale = false;
  result = runProcessHelper({ operation: 'end' }, undefined, authorize);
  child.stdout.write('{"authorize":"term"}\n{"authorize":"force"}\n{"result":"forced"}\n');
  child.exitCode = 0; child.emit('close', 0);
  assert.deepEqual(await result, { result: 'forced' }); assert.deepEqual(writes.slice(1), ['continue\n', 'continue\n']);
  writes = [];
  result = runProcessHelper({ operation: 'end' }, undefined, authorize);
  child.stdout.write('{"authorize":"force"}\n');
  await assert.rejects(result, /PROCESS_CHECK_FAILED/); assert.deepEqual(writes.slice(1), []);
});
