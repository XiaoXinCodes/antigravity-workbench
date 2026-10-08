const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { LiveLocks, probeProcessIdentity } = require('../out/live-lock');
const OWNER = 'a'.repeat(64), OTHER = 'b'.repeat(64);
const operation = '.agm-operation.lock', recovery = '.antigravity-account-manager-switch.lock';
function record(values = {}) { return { schema: 2, owner: OWNER, id: randomUUID(), pid: 41, nonce: randomUUID(), startIdentity: 'old-start', ...values }; }
async function fixture(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agm-auto-lock-'));
  try { await run(dir); } finally { await fs.rm(dir, { recursive: true, force: true }); }
}
async function write(dir, name, value) { await fs.mkdir(path.join(dir, name)); await fs.writeFile(path.join(dir, name, 'owner.json'), JSON.stringify(value), { mode: 0o600 }); }
const read = (dir, name) => fs.readFile(path.join(dir, name, 'owner.json'), 'utf8');
function options(probe = async () => ({ state: 'dead' }), pid = 99) {
  return { pid, probe: async id => id === pid ? { state: 'alive', startIdentity: `self-${pid}` } : probe(id) };
}
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
test('image batches publish purpose while retaining the same cross-host account mutex', async()=>fixture(async dir=>{
 const writer=new LiveLocks(dir,OWNER,{...options(),purpose:'image'}),reader=new LiveLocks(dir,OWNER,options());
 await writer.withOperation(async()=>{
  const marker=await reader.inspectOperation();assert.equal(marker.state,'active');assert.equal(marker.owner.purpose,'image');
  await assert.rejects(reader.withOperation(async()=>assert.fail('must remain locked')),/LIVE_OPERATION_OR_RECOVERY_LOCKED/);
  assert.equal(await reader.hasRecovery(),false);
 });
 assert.equal((await reader.inspectOperation()).state,'absent');
 await reader.withOperation(async()=>assert.equal((await reader.inspectOperation()).owner.purpose,undefined));
}));

test('native process identity is stable for this process; invalid PID is uncertain', async () => {
  const first = await probeProcessIdentity(process.pid), second = await probeProcessIdentity(process.pid);
  assert.equal(first.state, 'alive'); assert.deepEqual(second, first); assert.ok(first.startIdentity);
  assert.deepEqual(await probeProcessIdentity(-1), { state: 'unknown' });
});

test('operation acquisition automatically removes verified dead owner and never changes encrypted backup', async () => fixture(async dir => {
  const old = record(); await write(dir, operation, old);
  const journal = '{"encrypted":"synthetic-backup-preserved"}'; await fs.writeFile(path.join(dir, 'encrypted-journal.fixture'), journal);
  const locks = new LiveLocks(dir, OWNER, options());
  assert.equal((await locks.inspectOperation()).state, 'stale');
  await locks.withOperation(async () => {
    const current = JSON.parse(await read(dir, operation));
    assert.equal(current.schema, 2); assert.equal(current.startIdentity, 'self-99'); assert.notEqual(current.nonce, old.nonce);
    assert.equal((await locks.inspectOperation()).state, 'active');
  });
  assert.equal((await locks.inspectOperation()).state, 'absent');
  assert.equal(await fs.readFile(path.join(dir, 'encrypted-journal.fixture'), 'utf8'), journal);
}));

test('concurrent windows cannot both enter while racing to recover one dead owner', async () => fixture(async dir => {
  await write(dir, operation, record()); const entered = deferred(), finish = deferred(); let count = 0, concurrent = 0, maximum = 0;
  const probe = async pid => pid === 41 ? { state: 'dead' } : { state: 'alive', startIdentity: `self-${pid}` };
  const a = new LiveLocks(dir, OWNER, { pid: 98, probe }), b = new LiveLocks(dir, OWNER, { pid: 99, probe });
  const fn = async () => { count++; concurrent++; maximum = Math.max(maximum, concurrent); entered.resolve(); await finish.promise; concurrent--; };
  const attempts = [a.withOperation(fn), b.withOperation(fn)];
  // Attach rejection handlers before either racing acquisition can reject.
  const settled = Promise.allSettled(attempts); await entered.promise;
  await new Promise(resolve => setImmediate(resolve)); finish.resolve();
  const results = await settled;
  assert.equal(maximum, 1); assert.ok(count >= 1); assert.ok(results.some(r => r.status === 'fulfilled'));
  assert.equal((await a.inspectOperation()).state, 'absent');
  assert.deepEqual(await fs.readdir(dir), []);
}));

test('live owners remain locked regardless of age and without mutating their nonce', async () => fixture(async dir => {
  const owner = record(); await write(dir, operation, owner); const before = await read(dir, operation);
  await fs.utimes(path.join(dir, operation), new Date(0), new Date(0));
  const locks = new LiveLocks(dir, OWNER, options(async () => ({ state: 'alive', startIdentity: 'old-start' })));
  assert.equal((await locks.inspectOperation()).state, 'active');
  await assert.rejects(locks.withOperation(async () => assert.fail('must not enter')), /LIVE_OPERATION_OR_RECOVERY_LOCKED/);
  await assert.rejects(locks.recoverAbandonedOperation(), /LOCK_PROCESS_STILL_ALIVE/);
  assert.equal(await read(dir, operation), before);
}));

test('reused PID only permits old lock recovery when process start identity differs', async () => fixture(async dir => {
  await write(dir, operation, record());
  const locks = new LiveLocks(dir, OWNER, options(async () => ({ state: 'alive', startIdentity: 'different-incarnation' })));
  assert.equal((await locks.inspectOperation()).state, 'stale'); await locks.withOperation(async () => {});
  assert.equal((await locks.inspectOperation()).state, 'absent');
}));

for (const [name, probe] of [
  ['unknown permission status', async () => ({ state: 'unknown' })],
  ['permission denied by process probe', async () => { throw Object.assign(new Error('private details'), { code: 'EPERM' }); }],
]) test(`${name} preserves the lock and reports safe uncertainty`, async () => fixture(async dir => {
  await write(dir, operation, record()); const before = await read(dir, operation);
  const locks = new LiveLocks(dir, OWNER, options(probe));
  assert.equal((await locks.inspectOperation()).state, 'uncertain');
  await assert.rejects(locks.withOperation(async () => assert.fail('must not enter')), /LOCK_PROCESS_STATUS_UNKNOWN/);
  assert.equal(await read(dir, operation), before);
}));

test('alive legacy PID and missing process-start metadata remain fail closed', async () => fixture(async dir => {
  const locks = new LiveLocks(dir, OWNER, options(async () => ({ state: 'alive', startIdentity: 'reused-or-original' })));
  for (const owner of [{ schema: 1, owner: OWNER, id: randomUUID(), pid: 41 }, record({ startIdentity: null })]) {
    await write(dir, operation, owner); const before = await read(dir, operation);
    assert.equal((await locks.inspectOperation()).reason, 'LOCK_PROCESS_IDENTITY_UNAVAILABLE');
    await assert.rejects(locks.recoverAbandonedOperation(), /LOCK_PROCESS_IDENTITY_UNAVAILABLE/);
    assert.equal(await read(dir, operation), before); await fs.rm(path.join(dir, operation), { recursive: true });
  }
}));

test('another profile dead owner is never reclaimed', async () => fixture(async dir => {
  await write(dir, operation, record({ owner: OTHER })); const before = await read(dir, operation);
  const locks = new LiveLocks(dir, OWNER, options());
  assert.equal((await locks.inspectOperation()).reason, 'LOCK_BELONGS_TO_OTHER_PROFILE');
  await assert.rejects(locks.recoverAbandonedOperation(), /LOCK_BELONGS_TO_OTHER_PROFILE/);
  assert.equal(await read(dir, operation), before);
}));

test('partial owner write and ownerless directory stay uncertain and are never discarded by age', async () => fixture(async dir => {
  const locks = new LiveLocks(dir, OWNER, options());
  await fs.mkdir(path.join(dir, operation)); await fs.utimes(path.join(dir, operation), new Date(0), new Date(0));
  assert.equal((await locks.inspectOperation()).state, 'uncertain');
  await assert.rejects(locks.withOperation(async () => assert.fail('must not enter')), /LOCK_RECORD_REQUIRES_MANUAL_CHECK/);
  await fs.writeFile(path.join(dir, operation, 'owner.json'), '{"schema":2,');
  await assert.rejects(locks.recoverAbandonedOperation(), /LOCK_RECORD_REQUIRES_MANUAL_CHECK/);
  assert.equal(await read(dir, operation), '{"schema":2,');
}));

test('nonce and start-identity are revalidated after dead-process probe before removal', async () => fixture(async dir => {
  const original = record(); await write(dir, operation, original); const newer = record({ pid: 99, startIdentity: 'self-99' }); let probes = 0;
  const locks = new LiveLocks(dir, OWNER, options(async () => {
    if (++probes === 2) await fs.writeFile(path.join(dir, operation, 'owner.json'), JSON.stringify(newer));
    return { state: 'dead' };
  }));
  await assert.rejects(locks.recoverAbandonedOperation(), /LOCK_OWNERSHIP_CHANGED/);
  assert.deepEqual(JSON.parse(await read(dir, operation)), newer);
  assert.deepEqual(await fs.readdir(path.join(dir, operation)), ['owner.json']);
}));

test('interrupted or competing cleanup is never overridden', async () => fixture(async dir => {
  await write(dir, operation, record()); await fs.writeFile(path.join(dir, operation, '.release'), 'another-cleanup');
  const before = await read(dir, operation), locks = new LiveLocks(dir, OWNER, options());
  await assert.rejects(locks.recoverAbandonedOperation(), /LOCK_CLEANUP_STATUS_UNKNOWN/);
  assert.equal(await read(dir, operation), before); assert.equal(await fs.readFile(path.join(dir, operation, '.release'), 'utf8'), 'another-cleanup');
}));

test('orphan recovery auto-clears only when dead and no journal exists', async () => fixture(async dir => {
  await write(dir, recovery, record()); const locks = new LiveLocks(dir, OWNER, options());
  await assert.rejects(locks.reconcileRecovery(null), /LOCK_OPERATION_REQUIRED/);
  await locks.withOperation(async () => assert.equal(await locks.reconcileRecovery(null), 'cleared'));
  assert.equal(await locks.hasRecovery(), false);
  await locks.withOperation(async () => assert.equal(await locks.reconcileRecovery(null), 'absent'));
}));

test('live orphan recovery cannot be cleared through the old manual override', async () => fixture(async dir => {
  await write(dir, recovery, record()); const before = await read(dir, recovery);
  const locks = new LiveLocks(dir, OWNER, options(async () => ({ state: 'alive', startIdentity: 'old-start' })));
  await assert.rejects(locks.clearAbandonedRecovery(), /LOCK_PROCESS_STILL_ALIVE/);
  await assert.rejects(locks.withOperation(() => locks.reconcileRecovery(null)), /LOCK_PROCESS_STILL_ALIVE/);
  assert.equal(await read(dir, recovery), before);
}));

test('already restored/cancelled journal keeps exact matching recovery marker, including legacy format', async () => fixture(async dir => {
  const locks = new LiveLocks(dir, OWNER, options());
  for (const phase of ['restored', 'authorizing', 'prepared', 'installed']) {
    const marker = { schema: 1, owner: OWNER, id: randomUUID(), pid: 41 }, journal = { id: marker.id, phase, backup: 'encrypted-synthetic-value' };
    await write(dir, recovery, marker); const before = await read(dir, recovery), journalBefore = JSON.stringify(journal);
    await locks.withOperation(async () => {
      assert.equal(await locks.reconcileRecovery(journal.id), 'preserved'); await locks.assertRecovery(journal.id);
    });
    assert.equal(await read(dir, recovery), before); assert.equal(JSON.stringify(journal), journalBefore);
    // Only the transaction service's explicit verified completion may clear it.
    await locks.withOperation(() => locks.clearRecovery(journal.id));
  }
}));

test('missing journal marker is recreated under operation lock and mismatched transaction remains intact', async () => fixture(async dir => {
  const locks = new LiveLocks(dir, OWNER, options()), id = randomUUID();
  await locks.withOperation(async () => assert.equal(await locks.reconcileRecovery(id), 'created'));
  const before = await read(dir, recovery);
  await assert.rejects(locks.withOperation(() => locks.reconcileRecovery(randomUUID())), /RECOVERY_LOCK_OWNER_MISMATCH/);
  assert.equal(await read(dir, recovery), before);
  await locks.withOperation(() => locks.clearRecovery(id));
}));

test('cancellation releases its operation mutex without discarding durable recovery marker', async () => fixture(async dir => {
  const locks = new LiveLocks(dir, OWNER, options()), id = randomUUID();
  await assert.rejects(locks.withOperation(async () => { await locks.beginRecovery(id); throw new Error('LOGIN_CANCELLED'); }), /LOGIN_CANCELLED/);
  assert.equal((await locks.inspectOperation()).state, 'absent'); await locks.assertRecovery(id);
  await locks.withOperation(async () => { assert.equal(await locks.reconcileRecovery(id), 'preserved'); await locks.clearRecovery(id); });
  assert.deepEqual(await fs.readdir(dir), []);
}));

test('Linux process probe parses comm containing parentheses and binds boot identity', async () => {
  const boot = randomUUID(), fields = ['S', ...Array(18).fill('0'), '123456', '0'];
  const result = await probeProcessIdentity(123, { platform: 'linux', signal() {}, read: async file => file.endsWith('/stat') ? `123 (name ) ( with spaces) ${fields.join(' ')}` : boot + '\n' });
  assert.deepEqual(result, { state: 'alive', startIdentity: `linux:${boot}:123456` });
  const invalid = await probeProcessIdentity(123, { platform: 'linux', signal() {}, read: async () => 'bad-data' });
  assert.deepEqual(invalid, { state: 'unknown' });
});

test('macOS identity uses fixed locale/timezone and validates real ps output', async () => {
  const result = await probeProcessIdentity(123, { platform: 'darwin', signal() {}, run: async (executable, args, options) => {
    assert.equal(executable, '/bin/ps'); assert.deepEqual(args, ['-p', '123', '-o', 'lstart=']);
    assert.equal(options.env.LC_ALL, 'C'); assert.equal(options.env.TZ, 'UTC'); assert.equal(options.timeout, 3000);
    return { stdout: 'Thu Oct  1 05:24:00 2026\n' };
  } });
  assert.deepEqual(result, { state: 'alive', startIdentity: 'darwin:Thu Oct  1 05:24:00 2026' });
  assert.deepEqual(await probeProcessIdentity(123, { platform: 'darwin', signal() {}, run: async () => ({ stdout: '' }) }), { state: 'unknown' });
});

test('Windows identity queries exact PID start ticks with bounded no-shell helper', async () => {
  const result = await probeProcessIdentity(123, { platform: 'win32', signal() {}, run: async (executable, args, options) => {
    assert.match(executable, /System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/);
    assert.deepEqual(args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
    assert.match(Buffer.from(args[4], 'base64').toString('utf16le'), /Get-Process -Id 123 -ErrorAction Stop/);
    assert.equal(options.timeout, 3000); assert.equal(options.windowsHide, true); assert.equal(options.shell, undefined);
    return { stdout: '639264578400000000' };
  } });
  assert.deepEqual(result, { state: 'alive', startIdentity: 'win32:639264578400000000' });
  assert.deepEqual(await probeProcessIdentity(123, { platform: 'win32', signal() {}, run: async () => ({ stdout: 'Access is denied' }) }), { state: 'unknown' });
});

test('OS probe distinguishes ESRCH from EPERM and never assumes failed helper means dead', async () => {
  const failure = code => () => { throw Object.assign(new Error('synthetic OS error'), { code }); };
  for (const platform of ['linux', 'darwin', 'win32']) {
    assert.deepEqual(await probeProcessIdentity(123, { platform, signal: failure('ESRCH') }), { state: 'dead' });
    assert.deepEqual(await probeProcessIdentity(123, { platform, signal: failure('EPERM') }), { state: 'unknown' });
    assert.deepEqual(await probeProcessIdentity(123, { platform, signal() {}, read: async () => { throw new Error('read denied'); }, run: async () => { throw new Error('helper denied'); } }), { state: 'unknown' });
  }
  let signals = 0;
  assert.deepEqual(await probeProcessIdentity(123, { platform: 'win32', signal: () => { if (++signals === 2) failure('ESRCH')(); }, run: async () => { throw new Error('process exited during read'); } }), { state: 'dead' });
});

test('legacy pre-upgrade record safely auto-recovers only after repeated confirmed PID absence', async () => fixture(async dir => {
  const owner = { schema: 1, owner: OWNER, id: randomUUID(), pid: 41 }; let probes = 0;
  await write(dir, operation, owner);
  const locks = new LiveLocks(dir, OWNER, options(async () => { probes++; return { state: 'dead' }; }));
  await locks.withOperation(async () => {}); assert.ok(probes >= 2); assert.equal((await locks.inspectOperation()).state, 'absent');
  await write(dir, operation, owner); probes = 0;
  const changed = new LiveLocks(dir, OWNER, options(async () => ++probes === 1 ? { state: 'dead' } : { state: 'alive', startIdentity: 'new-pid-owner' }));
  await assert.rejects(changed.recoverAbandonedOperation(), /LOCK_PROCESS_IDENTITY_UNAVAILABLE/);
  assert.deepEqual(JSON.parse(await read(dir, operation)), owner);
}));

for (const chain of [['.release'], ['.release', '.release.next'], ['.release.next'], ['.release.next', '.release.next.next']]) {
  test(`crash-safe claim recovery handles ${chain.join(' + ')} without touching journal`, async () => fixture(async dir => {
    await write(dir, operation, record());
    for (const name of chain) await fs.writeFile(path.join(dir, operation, name), JSON.stringify(record({ pid: 42, startIdentity: 'dead-reaper' })));
    const journal = 'encrypted-backup-original'; await fs.writeFile(path.join(dir, 'backup.fixture'), journal);
    const locks = new LiveLocks(dir, OWNER, options());
    await locks.withOperation(async () => {});
    assert.equal((await locks.inspectOperation()).state, 'absent'); assert.equal(await fs.readFile(path.join(dir, 'backup.fixture'), 'utf8'), journal);
    assert.deepEqual(await fs.readdir(dir), ['backup.fixture']);
  }));
}

test('alive and inaccessible durable cleanup claims are preserved with exact ownership', async () => fixture(async dir => {
  for (const state of ['alive', 'unknown']) {
    await write(dir, operation, record()); const marker = record({ pid: 42, startIdentity: 'claim-owner' });
    await fs.writeFile(path.join(dir, operation, '.release'), JSON.stringify(marker));
    const locks = new LiveLocks(dir, OWNER, options(async pid => pid === 41 ? { state: 'dead' } : state === 'alive' ? { state: 'alive', startIdentity: 'claim-owner' } : { state: 'unknown' }));
    await assert.rejects(locks.recoverAbandonedOperation(), state === 'alive' ? /LOCK_CLEANUP_IN_PROGRESS/ : /LOCK_CLEANUP_STATUS_UNKNOWN/);
    assert.equal(await fs.readFile(path.join(dir, operation, '.release'), 'utf8'), JSON.stringify(marker));
    await fs.rm(path.join(dir, operation), { recursive: true });
  }
}));

test('claim with changed nonce during dead probe is preserved and its temporary guard released', async () => fixture(async dir => {
  await write(dir, operation, record()); const claim = record({ pid: 42 }), changed = record({ pid: 98, startIdentity: 'self-98' }); let probes = 0;
  const location = path.join(dir, operation, '.release'); await fs.writeFile(location, JSON.stringify(claim));
  const locks = new LiveLocks(dir, OWNER, options(async pid => {
    if (pid === 42 && ++probes === 2) await fs.writeFile(location, JSON.stringify(changed));
    return { state: 'dead' };
  }));
  await assert.rejects(locks.recoverAbandonedOperation(), /LOCK_OWNERSHIP_CHANGED/);
  assert.deepEqual(JSON.parse(await fs.readFile(location, 'utf8')), changed);
  assert.deepEqual((await fs.readdir(path.join(dir, operation))).sort(), ['.release', 'owner.json']);
}));

test('two stale-claim reapers cannot enter the unlink-to-guard-release gap or remove fresh ownership', async () => fixture(async dir => {
  await write(dir, operation, record()); const release = path.join(dir, operation, '.release');
  await fs.writeFile(release, JSON.stringify(record({ pid: 42, startIdentity: 'dead-claim' })));
  const probe = async pid => [41, 42].includes(pid) ? { state: 'dead' } : { state: 'alive', startIdentity: `self-${pid}` };
  const a = new LiveLocks(dir, OWNER, { pid: 99, probe }), b = new LiveLocks(dir, OWNER, { pid: 98, probe });
  const unlinked = deferred(), resume = deferred(), original = fs.unlink; let paused = false;
  fs.unlink = async file => { await original(file); if (file === release && !paused) { paused = true; unlinked.resolve(); await resume.promise; } };
  try {
    const recovering = a.recoverAbandonedOperation(); await unlinked.promise;
    await assert.rejects(b.withOperation(async () => assert.fail('must not enter another reaper guard')), /LOCK_CLEANUP_IN_PROGRESS/);
    resume.resolve(); await recovering;
  } finally { fs.unlink = original; resume.resolve(); }
  await b.withOperation(async () => {
    const fresh = await read(dir, operation); await assert.rejects(a.recoverAbandonedOperation(), /LOCK_PROCESS_STILL_ALIVE/);
    assert.equal(await read(dir, operation), fresh);
  });
  assert.deepEqual(await fs.readdir(dir), []);
}));

test('crashed unpublished staging and already-retired directories do not block a new operation', async () => fixture(async dir => {
  const staging = path.join(dir, '.agm-claim-abandoned-stage'), retired = operation + '.retired.' + randomUUID();
  await fs.writeFile(staging, '{partial-stage'); await write(dir, retired, record());
  const locks = new LiveLocks(dir, OWNER, options()); await locks.withOperation(async () => {});
  assert.equal((await locks.inspectOperation()).state, 'absent');
  assert.equal(await fs.readFile(staging, 'utf8'), '{partial-stage'); assert.ok(await read(dir, retired));
}));

test('real killed extension-host process is recovered automatically with no manual unlock', { timeout: 20000 }, async () => fixture(async dir => {
  const { spawn } = require('node:child_process');
  const script = `const {LiveLocks}=require(${JSON.stringify(require.resolve('../out/live-lock'))}); new LiveLocks(process.argv[1], ${JSON.stringify(OWNER)}).withOperation(async()=>{process.stdout.write('locked\\n');await new Promise(()=>{});});setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['-e', script, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise(resolve => child.once('close', resolve));
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('test child did not acquire synthetic lock')), 8000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.stdout.once('data', data => { clearTimeout(timer); if (data.toString().includes('locked')) resolve(); else reject(new Error('unexpected test child output')); });
      child.once('close', () => { clearTimeout(timer); reject(new Error('test child exited before lock acquisition')); });
    });
    const locks = new LiveLocks(dir, OWNER); assert.equal((await locks.inspectOperation()).state, 'active');
    child.kill('SIGKILL'); await exited;
    assert.equal((await locks.inspectOperation()).state, 'stale'); await locks.withOperation(async () => {});
    assert.deepEqual(await fs.readdir(dir), []);
  } finally { child.kill('SIGKILL'); await exited; }
}));
