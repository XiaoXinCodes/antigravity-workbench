const test = require('node:test');
const assert = require('node:assert/strict');
const { OfficialProcessRecovery, runProcessHelper } = require('../out/official-process-recovery');
const { LiveError } = require('../out/live-storage');
const api = { port: 32123, csrfToken: 'synthetic-capability-not-output' };
const row = (pid = 710, kind = 'unowned-hub', extra = {}) => ({ pid, parentPid: 701, startTicks: '123456', bootId: '11111111-1111-4111-8111-111111111111', commandHash: 'a'.repeat(64), kind, scope: kind === 'unverified' ? 'unknown' : 'current-window', parentState: 'alive', startedAt: '2026-10-08T11:00:00+00:00', canEnd: kind === 'unowned-hub', ...extra });
function fixture(extra = {}) {
  let current = { ...api }, rows = [row(709, 'current-hub'), row()], response = { result: 'exited' };
  const calls = [];
  const recovery = new OfficialProcessRecovery({ platform: 'linux', executable: '/synthetic/bin/agy', ownerPid: 701, api: () => current, assertCurrent() {},
    helper: async request => { calls.push(request); return request.operation === 'scan' ? { supported: true, processes: rows } : response; }, ...extra });
  return { recovery, calls, setApi: value => { current = value; }, setRows: value => { rows = value; }, setResponse: value => { response = value; } };
}
test('verified scan reports the current Hub separately without exposing its capability', async () => {
  const state = await fixture().recovery.scan();
  assert.equal(state.current.pid, 709); assert.equal(state.currentCount, 1); assert.equal(state.totalCount, 2);
  assert.equal(state.processes[0].scope, 'current-window');
  assert.doesNotMatch(JSON.stringify(state), /csrf|synthetic-capability|commandHash|bootId|startTicks/);
});
test('host-only current identity detects same-capability PID birth replacement and clears on invalidation', async () => {
  const f = fixture({ platform: 'win32' });
  f.setRows([windowsRow(709, 'current-hub')]); await f.recovery.scan();
  const pinned = f.recovery.currentProcessIdentity(); assert.deepEqual(pinned, { pid: 709, startTicks: '123456' });
  const copy = f.recovery.currentProcessIdentity(); copy.startTicks = 'mutated';
  assert.deepEqual(f.recovery.currentProcessIdentity(), pinned);
  f.setRows([windowsRow(709, 'current-hub', { startTicks: '123457' })]);
  await f.recovery.scan(); assert.notDeepEqual(f.recovery.currentProcessIdentity(), pinned);
  f.setApi({ ...api, port: 32124 }); assert.throws(() => f.recovery.currentProcessIdentity(), /HUB_CHANGED/);
  f.recovery.invalidate(); assert.equal(f.recovery.currentProcessIdentity(), undefined);
});
test('an active other-window Hub is a blocker and never an automatic termination target', async () => {
  const f = fixture(); f.setRows([row(709, 'current-hub'), row(710, 'unowned-hub', { parentPid: 702, scope: 'other-window', canEnd: true })]);
  const state = await f.recovery.scan(); assert.equal(state.phase, 'blocked'); assert.equal(state.processes[0].canEnd, false);
  await assert.rejects(f.recovery.end(state.processes[0].id, new AbortController().signal), /SELECTION_STALE/);
  assert.equal(f.calls.filter(call => call.operation === 'end').length, 0);
});
test('one confirmed batch consumes only the selected scan and ends each original proof in order', async () => {
  const f = fixture(); f.setRows([row(709, 'current-hub'), row(710), row(711)]);
  const state = await f.recovery.scan(), ids = state.processes.map(p => p.id);
  assert.deepEqual(await f.recovery.endMany(ids, new AbortController().signal), ids.map(id => ({ id, result: 'exited' })));
  assert.deepEqual(f.calls.filter(call => call.operation === 'end').map(call => call.target.pid), [710, 711]);
  await assert.rejects(f.recovery.endMany(ids, new AbortController().signal), /SELECTION_STALE/);
});
test('a confirmed batch rejects duplicate, fabricated and superseded IDs before any signal', async () => {
  for (const reason of ['duplicate', 'fabricated', 'rescan']) {
    const f = fixture(); f.setRows([row(709, 'current-hub'), row(710), row(711)]);
    const ids = (await f.recovery.scan()).processes.map(p => p.id);
    if (reason === 'duplicate') ids[1] = ids[0];
    if (reason === 'fabricated') ids[1] = 'unconfirmed-pid';
    if (reason === 'rescan') await f.recovery.scan();
    await assert.rejects(f.recovery.endMany(ids, new AbortController().signal), /SELECTION_STALE/);
    assert.equal(f.calls.filter(call => call.operation === 'end').length, 0);
  }
});
test('batch failure, cancellation, invalidation or Hub adoption never starts a later target', async () => {
  for (const reason of ['failure', 'cancel', 'dispose', 'hub']) {
    let current = api, started = [], f; const controller = new AbortController();
    f = fixture({ api: () => current, helper: async (request, _signal, authorize) => {
      if (request.operation === 'scan') return { supported: true, processes: [row(709, 'current-hub'), row(710), row(711)] };
      authorize(); started.push(request.target.pid);
      if (reason === 'cancel') controller.abort();
      if (reason === 'dispose') f.recovery.invalidate();
      if (reason === 'hub') current = { ...api, port: 32124 };
      return reason === 'failure' ? { code: 'OFFICIAL_PROCESS_END_DENIED' } : { result: 'exited' };
    } });
    const ids = (await f.recovery.scan()).processes.map(p => p.id);
    await assert.rejects(f.recovery.endMany(ids, controller.signal), /END_DENIED|CANCELLED|SELECTION_STALE|HUB_CHANGED/);
    assert.deepEqual(started, [710]);
    await assert.rejects(f.recovery.end(ids[1], new AbortController().signal), /SELECTION_STALE/);
  }
});
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
for (const platform of ['darwin']) test(`${platform} lists actual process metadata but never advertises an unsafe termination adapter`, async () => {
  const calls = [], output = platform === 'win32' ? JSON.stringify([{ pid: 709, parentPid: 701, startedAt: '2026-10-08T11:00:00.000Z' }, { pid: 710, parentPid: 702, startedAt: '2026-10-08T10:00:00.000Z' }]) : ' 709 701 Thu Oct  8 11:00:00 2026 /synthetic/agy\n 710 702 Thu Oct  8 10:00:00 2026 /synthetic/agy\n 999 1 Thu Oct  8 09:00:00 2026 other\n';
  const f = fixture({ platform, nativeRun: async (exe, args) => { calls.push({ exe, args }); return { code: 0, stdout: output, stderr: '' }; }, helper: async () => { throw Error('no Linux helper on native platform'); } });
  const state = await f.recovery.scan(); assert.equal(state.processes.length, 2); assert.deepEqual(state.processes.map(p => p.pid), [709, 710]); assert.equal(state.limitation, 'platform'); assert.ok(state.processes.every(p => !p.canEnd)); assert.equal(calls.length, 1);
});
test('malformed helper output, duplicate PIDs and duplicate current hubs fail closed', async () => {
  for (const rows of [[row(), row()], [row(709, 'current-hub'), row(710, 'current-hub')], [row(709, 'current-hub', { scope: 'other-window' })], [row(710, 'unowned-hub', { bootId: 'wrong' })]]) {
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

const windowsRow = (pid = 710, kind = 'unowned-hub', extra = {}) => {
  const value = row(pid, kind); delete value.bootId; return { ...value, platform: 'win32', ...extra };
};
test('Windows holds an opaque single-use force selection with current-host and complete-birth proof', async () => {
  const calls = []; let rows = [windowsRow(709, 'current-hub'), windowsRow()];
  const f = fixture({ platform: 'win32', helper: async (request, _signal, authorize) => {
    calls.push(request); if (request.operation === 'scan') return { supported: true, processes: rows };
    authorize(); return { result: 'forced' };
  } });
  const state = await f.recovery.scan(); assert.equal(state.processes.length, 1);
  const selected = state.processes[0]; assert.equal(selected.endMode, 'force'); assert.equal(selected.canEnd, true);
  assert.doesNotMatch(JSON.stringify(state), /csrf|commandHash|startTicks|platform/);
  assert.equal(await f.recovery.end(selected.id, new AbortController().signal), 'forced');
  assert.deepEqual(calls[1].target, windowsRow());
  await assert.rejects(f.recovery.end(selected.id, new AbortController().signal), /SELECTION_STALE/);
  rows = [windowsRow(709, 'current-hub')]; assert.equal((await f.recovery.scan()).canContinue, true);
  rows = []; assert.equal((await f.recovery.scan()).canContinue, false, 'current Hub needs an identity-backed process');
});
test('Windows helper/capability/permissions missing or malformed identity never enables termination', async () => {
  for (const [supported, processes] of [[false, [windowsRow()]], [true, [windowsRow(710, 'unverified', { canEnd: true, startTicks: null, commandHash: null })]], [true, [windowsRow(710, 'unowned-hub', { canEnd: false })]]]) {
    const f = fixture({ platform: 'win32', helper: async () => ({ supported, processes }) });
    const state = await f.recovery.scan(); assert.equal(state.limitation, 'windows-helper'); assert.ok(state.processes.every(p => !p.canEnd));
    for (const selected of state.processes) await assert.rejects(f.recovery.end(selected.id, new AbortController().signal), /SELECTION_STALE/);
  }
  for (const extra of [{ startTicks: null }, { commandHash: null }, { platform: 'linux' }, { bootId: '11111111-1111-4111-8111-111111111111' }]) {
    const f = fixture({ platform: 'win32', helper: async () => ({ supported: true, processes: [windowsRow(710, 'unowned-hub', extra)] }) });
    await assert.rejects(f.recovery.scan(), /PROCESS_CHECK_FAILED/);
  }
  const f = fixture({ platform: 'win32', helper: async () => ({ code: 'OFFICIAL_PROCESS_END_UNAVAILABLE' }), nativeRun: async () => ({ code: 0, stdout: JSON.stringify([{ pid: 710 }]), stderr: '' }) });
  const state = await f.recovery.scan(); assert.equal(state.processes[0].owner, 'unknown'); assert.equal(state.processes[0].canEnd, false); assert.equal(state.canContinue, false); assert.equal(state.limitation, 'windows-helper');
});
test('failed fallback enumeration cannot claim no conflicts, even with the official Hub stopped', async () => {
  for (const platform of ['win32', 'linux']) {
    const f = fixture({ platform, api: () => undefined, helper: async () => { throw new LiveError('OFFICIAL_PROCESS_END_UNAVAILABLE'); }, nativeRun: async () => { throw new Error('unavailable'); }, inspect: async () => { throw new Error('unavailable'); } });
    const state = await f.recovery.scan(); assert.equal(state.canContinue, false); assert.equal(state.phase, 'blocked'); assert.ok(state.limitation); assert.deepEqual(state.processes, []);
  }
});
test('missing Linux pidfd forces all ending buttons off, even if a malformed helper advertises them', async () => {
  const f = fixture({ helper: async () => ({ supported: false, processes: [row()] }) });
  const state = await f.recovery.scan(); assert.equal(state.limitation, 'helper'); assert.equal(state.processes[0].canEnd, false);
  await assert.rejects(f.recovery.end(state.processes[0].id, new AbortController().signal), /SELECTION_STALE/);
});
test('Windows adoption, invalidation and cancellation refuse the force handshake before any force result', async () => {
  for (const reason of ['hub', 'dispose', 'cancel']) {
    let current = api, forced = 0; const controller = new AbortController(); let f;
    f = fixture({ platform: 'win32', api: () => current, helper: async (request, _signal, authorize) => {
      if (request.operation === 'scan') return { supported: true, processes: [windowsRow()] };
      if (reason === 'hub') current = { ...api, port: 32124 };
      if (reason === 'dispose') f.recovery.invalidate();
      if (reason === 'cancel') controller.abort();
      authorize(); forced++; return { result: 'forced' };
    } });
    const selected = (await f.recovery.scan()).processes[0];
    await assert.rejects(f.recovery.end(selected.id, controller.signal), /HUB_CHANGED|SELECTION_STALE|CANCELLED/);
    assert.equal(forced, 0);
  }
});
test('Windows transport uses the system helper, short constant argv and stdin source, with a force-only authorization', async t => {
  const { runWindowsProcessHelper } = require('../out/official-process-recovery');
  const { WINDOWS_PROCESS_BOOTSTRAP, WINDOWS_PROCESS_HELPER } = require('../out/official-process-windows');
  const childProcess = require('node:child_process'), { EventEmitter } = require('node:events'), { PassThrough, Writable } = require('node:stream');
  let child, spawnArgs, writes = [], authorizations = 0;
  t.mock.method(childProcess, 'spawn', (...args) => {
    spawnArgs = args; child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null;
    child.stdin = new Writable({ write(chunk, _encoding, done) { writes.push(chunk.toString()); done(); } });
    child.kill = () => { child.exitCode = -1; queueMicrotask(() => child.emit('close', -1)); return true; }; return child;
  });
  let result = runWindowsProcessHelper({ operation: 'end', csrfToken: 'synthetic-capability' }, undefined, () => { authorizations++; });
  assert.match(spawnArgs[0], /System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/);
  assert.equal(spawnArgs[2].shell, false); assert.equal(Buffer.from(spawnArgs[1].at(-1), 'base64').toString('utf16le'), WINDOWS_PROCESS_BOOTSTRAP);
  assert.ok(spawnArgs[1].join(' ').length < 4096, 'bootstrap stays well below the Windows argv limit; helper source is on stdin'); assert.doesNotMatch(spawnArgs[1].join(' '), /synthetic-capability|ExecutionPolicy|RunAs/);
  const frames = writes[0].trim().split('\n'); assert.equal(Buffer.from(frames[0], 'base64').toString(), WINDOWS_PROCESS_HELPER); assert.equal(JSON.parse(frames[1]).csrfToken, 'synthetic-capability');
  child.stdout.write('{"authorize":"force"}\n'); assert.equal(authorizations, 1); assert.equal(writes[1], 'continue\n');assert.equal(child.stdin.writableEnded,false);
  child.stdout.write('{"result":"forced"}\n');assert.equal(child.stdin.writableEnded,true); child.exitCode = 0; child.emit('close', 0); assert.deepEqual(await result, { result: 'forced' });
  writes = []; result = runWindowsProcessHelper({ operation: 'end' }, undefined, () => {});
  child.stdout.write('{"authorize":"term"}\n'); await assert.rejects(result, /PROCESS_CHECK_FAILED/); assert.equal(writes.length, 1);
});
test('Windows system PowerShell compiles the shipped native adapter without touching any target', { skip: process.platform !== 'win32' }, async t => {
  const { runWindowsProcessHelper, windowsPowerShell } = require('../out/official-process-recovery');
  try {
    const result = await runWindowsProcessHelper({ operation: 'probe' });
    assert.equal(typeof result.supported, 'boolean');
  } catch(error) {
    // Only a synthetic capability probe: report fixed milestones, never raw
    // helper output, environment, argv, identity or compiler exceptions.
    const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{spawn}=require('node:child_process');
    const {WINDOWS_PROCESS_BOOTSTRAP,WINDOWS_PROCESS_HELPER}=require('../out/official-process-windows');
    const bootstrap=WINDOWS_PROCESS_BOOTSTRAP.replace('try {',"[Console]::Error.WriteLine('agw-start')\ntry {").replace(' & ([ScriptBlock]'," [Console]::Error.WriteLine('agw-source-read')\n & ([ScriptBlock]");
    const source=WINDOWS_PROCESS_HELPER.replace('Add-Type -TypeDefinition',"[Console]::Error.WriteLine('agw-before-compile')\nAdd-Type -TypeDefinition").replace('$line=[Console]',"[Console]::Error.WriteLine('agw-after-compile')\n$line=[Console]").replace('$r=$line',"[Console]::Error.WriteLine('agw-request-read')\n$r=$line");
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'agw-probe-transport-'));try{
      const file=path.join(dir,'probe.ps1');await fs.writeFile(file,bootstrap);
      for(const mode of ['encoded','file','inherited'])await new Promise(resolve=>{
        const args=['-NoLogo','-NoProfile','-NonInteractive',...(mode==='file'?['-File',file]:['-EncodedCommand',Buffer.from(bootstrap,'utf16le').toString('base64')])];
        const env={};for(const name of ['SystemRoot','WINDIR','TEMP','TMP','USERPROFILE','HOMEDRIVE','HOMEPATH'])if(process.env[name])env[name]=process.env[name];
        const child=spawn(windowsPowerShell(),args,{stdio:['pipe','pipe','pipe'],windowsHide:true,env:mode==='inherited'?process.env:env});let stdout='',stderr='',before=[];
        const milestones=()=>['agw-start','agw-source-read','agw-before-compile','agw-after-compile','agw-request-read'].filter(x=>stderr.includes(x));
        child.stdout.on('data',b=>{stdout+=b.toString();});child.stderr.on('data',b=>{stderr+=b.toString();});child.stdin.on('error',()=>{});
        const eof=setTimeout(()=>{before=milestones();child.stdin.end();},5000),limit=setTimeout(()=>child.kill(),15000);
        child.once('close',code=>{clearTimeout(eof);clearTimeout(limit);t.diagnostic(JSON.stringify({mode,beforeEOF:before,afterEOF:milestones(),resultSeen:stdout.includes('supported'),exitCode:code}));resolve();});
        child.stdin.write(Buffer.from(source).toString('base64')+'\n'+JSON.stringify({operation:'probe'})+'\n');
      });
    }finally{await fs.rm(dir,{recursive:true,force:true});}
    throw error;
  }
});

test('Windows validates synthetic child identity and force-ends only a separately created fixture child', { skip: process.platform !== 'win32' }, async t => {
  const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), { spawn } = require('node:child_process');
  const { runWindowsProcessHelper } = require('../out/official-process-recovery');
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agw-win-process-fixture-'));
  const executable = path.join(home, '.gemini', 'bin', 'agy.exe'); await fs.mkdir(path.dirname(executable), { recursive: true }); await fs.copyFile(process.execPath, executable);
  t.after(() => fs.rm(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const inspectChild = async (profile, flags, endFixture=false) => {
    // libuv restores missing HOMEDRIVE/HOMEPATH from the parent on Windows.
    // Set the whole synthetic scope explicitly rather than mixing two homes.
    const child = spawn(executable, ['-e', 'setInterval(()=>{},1000)', '--', '--hub', '--app_data_dir=antigravity', ...flags], { env: { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, USERPROFILE: profile, HOMEDRIVE:home.slice(0,2),HOMEPATH:home.slice(2) }, stdio: 'ignore', windowsHide: true });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    const closed = new Promise(resolve => child.once('close', resolve));
    try {
      const request = { operation: 'inspect', pid: child.pid, executable, home, ownerPid: process.pid, port: 32123, csrfToken: 'synthetic-current-capability' };
      const result = await runWindowsProcessHelper(request);
      assert.equal(child.exitCode, null, 'read-only fixture inspection must not terminate its target');
      if(endFixture){
        assert.equal(result.code,undefined,JSON.stringify({code:result.code,stage:result.stage}));
        let checks=0;const ended=await runWindowsProcessHelper({...request,operation:'end',target:result},undefined,()=>{checks++;});
        assert.deepEqual(ended,{result:'forced'});assert.ok(checks>0,'test host must authorize the force handshake');
        await closed;assert.equal(child.exitCode,1,'held HANDLE termination completes before success');
      }
      return { result, pid: child.pid };
    } finally { if(child.exitCode===null)child.kill(); await closed; } // Only our own synthetic Node child.
  };
  const normalFlags = ['--hub-port=32124', '--csrf_token=synthetic-foreign-capability'];
  let inspected = await inspectChild(home, normalFlags);
  assert.equal(inspected.result.code,undefined,JSON.stringify({code:inspected.result.code,stage:inspected.result.stage}));
  assert.equal(inspected.result.pid, inspected.pid); assert.equal(inspected.result.parentPid, process.pid); assert.equal(inspected.result.kind, 'unowned-hub');
  assert.match(inspected.result.startTicks, /^\d+$/); assert.match(inspected.result.commandHash, /^[a-f0-9]{64}$/); assert.ok(Number.isFinite(Date.parse(inspected.result.startedAt)));
  assert.doesNotMatch(JSON.stringify(inspected.result), /synthetic-foreign-capability|USERPROFILE|--csrf_token/);
  for (const [profile, flags] of [['.', normalFlags], ['C:relative', normalFlags], [home, ['--hub-port=32124\n', normalFlags[1]]], [home, [normalFlags[0], '--csrf_token=synthetic-foreign-capability\n']], [home, [...normalFlags, '--hub']]]) {
    inspected = await inspectChild(profile, flags); assert.ok(inspected.result.code, 'relative scope and malformed argv must fail closed');
  }
  await inspectChild(home,normalFlags,true);
});
