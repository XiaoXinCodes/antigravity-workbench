const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const core = require('../out/core');
const files = require('../out/snapshot-files');
const fixture = identity => ({ product: 'antigravity', email: identity, quota: { weekly: { remaining_fraction: 0.25, reset_time: '2027-01-01T00:00:00Z' } }, transcript_path: 'PRIVATE', token: 'PRIVATE' });
async function temporary(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ag-bridge-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
function runBridge(directory, input, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve(__dirname, '../out/bridge.js'), ...(args ?? ['--dir', directory])], { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', data => stdout += data);
    child.stderr.on('data', data => stderr += data);
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
test('collector stdin → private per-account file → directory read roundtrip', async t => {
  const directory = path.join(await temporary(t), 'snapshots');
  for (const identity of ['one@example.test', 'two@example.test']) {
    const result = await runBridge(directory, JSON.stringify(fixture(identity)));
    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE|example/);
  }
  const names = await fs.readdir(directory);
  assert.equal(names.length, 2);
  assert.ok(names.every(name => /^[a-f0-9]{64}\.json$/.test(name)));
  const result = await files.readSnapshotDirectory(directory);
  assert.equal(result.snapshots.length, 2);
  assert.equal(result.failures, 0);
  for (const name of names) {
    assert.doesNotMatch(await fs.readFile(path.join(directory, name), 'utf8'), /PRIVATE|transcript|token/);
    if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(directory, name))).mode & 0o777, 0o600);
  }
});
test('collector rejects oversized, wrong-product and malformed input without saving it', async t => {
  const directory = path.join(await temporary(t), 'snapshots');
  for (const input of ['PRIVATE{', JSON.stringify({ ...fixture('one'), product: 'other' }), 'x'.repeat(core.LIMITS.inputBytes + 1)]) {
    const result = await runBridge(directory, input);
    assert.equal(result.code, 1);
    assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE|transcript|token/);
  }
  await assert.rejects(fs.access(directory));
});
test('file import blocks oversized files, directories, symlinks, and future dates', async t => {
  const directory = await temporary(t);
  const file = path.join(directory, 'test.json');
  await fs.writeFile(file, 'x'.repeat(core.LIMITS.snapshotBytes + 1));
  await assert.rejects(files.readSnapshotFile(file));
  await assert.rejects(files.readSnapshotFile(directory));
  await fs.writeFile(file, JSON.stringify(core.collectStatusline(fixture('one'), Date.now() + 600_000)));
  await assert.rejects(files.readSnapshotFile(file));
  if (process.platform !== 'win32') {
    const link = path.join(directory, 'link.json');
    await fs.symlink(file, link);
    await assert.rejects(files.readSnapshotFile(link));
    const linkedDir = `${directory}-link`;
    await fs.symlink(directory, linkedDir);
    t.after(() => fs.unlink(linkedDir));
    await assert.rejects(files.ensurePrivateDirectory(linkedDir));
  }
});
test('filename identity mismatches do not get attributed to another account', async t => {
  const directory = await temporary(t);
  const snapshot = core.collectStatusline(fixture('one'));
  await fs.writeFile(path.join(directory, `${core.identityKey('two')}.json`), JSON.stringify(snapshot));
  const result = await files.readSnapshotDirectory(directory);
  assert.equal(result.failures, 1);
  assert.deepEqual(result.snapshots, []);
});
test('unknown files ignored; malformed matching files surface aggregate read errors', async t => {
  const directory = await temporary(t);
  await fs.writeFile(path.join(directory, 'credentials.json'), 'PRIVATE');
  await fs.writeFile(path.join(directory, `${core.identityKey('bad')}.json`), 'PRIVATE');
  const result = await files.readSnapshotDirectory(directory);
  assert.equal(result.failures, 1);
  assert.equal(result.truncated, false);
});
test('repeated collector writes replace atomically and leave no temporary files', async t => {
  const directory = await temporary(t);
  const snapshot = core.collectStatusline(fixture('one'));
  await Promise.all(Array.from({ length: 12 }, () => files.writeSnapshotFile(directory, snapshot)));
  assert.equal((await fs.readdir(directory)).length, 1);
  assert.deepEqual((await files.readSnapshotDirectory(directory)).snapshots, [snapshot]);
});
test('older concurrent captures never regress stored quota', async t => {
  const directory = await temporary(t);
  const now = Date.now();
  const snapshots = Array.from({ length: 16 }, (_, index) => core.collectStatusline({ ...fixture('one'), quota: { b: { remaining_fraction: index / 100 } } }, now - index * 1000));
  await Promise.all(snapshots.map(snapshot => files.writeSnapshotFile(directory, snapshot)));
  assert.deepEqual((await files.readSnapshotDirectory(directory)).snapshots, [snapshots[0]]);
});
test('local writers wait through lock cleanup instead of racing a Windows delete-pending lock', { timeout: 5000 }, async t => {
  const directory = await temporary(t), lock = path.join(directory, '.write.lock');
  const open = fs.open, unlink = fs.unlink, events = [];
  let deleting = false, releaseDelete, denied = 0, pauseOnce = true, first, second;
  fs.open = async function (name, ...args) {
    if (name === lock && deleting) { denied++; throw Object.assign(Error('synthetic delete-pending lock'), { code: 'EPERM' }); }
    return open.call(this, name, ...args);
  };
  fs.unlink = async function (name, ...args) {
    if (name === lock && pauseOnce) {
      pauseOnce = false; deleting = true;
      await new Promise(resolve => { releaseDelete = resolve; });
      deleting = false;
    }
    return unlink.call(this, name, ...args);
  };
  try {
    first = files.withDirectoryLock(directory, async () => { events.push('first'); });
    const until = Date.now() + 2000;
    while (!deleting && Date.now() < until) await new Promise(setImmediate);
    assert.equal(deleting, true);
    second = files.withDirectoryLock(directory, async () => { events.push('second'); });
    void second.catch(() => {});
    await new Promise(setImmediate);
    assert.equal(denied, 0, 'the second local writer must not open during predecessor cleanup');
    assert.deepEqual(events, ['first']);
    releaseDelete(); await Promise.all([first, second]);
    assert.deepEqual(events, ['first', 'second']);
    await assert.rejects(fs.stat(lock), { code: 'ENOENT' });
  } finally {
    releaseDelete?.(); await Promise.allSettled([first, second]);
    fs.open = open; fs.unlink = unlink;
  }
});
test('permission failure never becomes a successful lock or suppresses a later valid retry', async t => {
  const directory = await temporary(t), lock = path.join(directory, '.write.lock');
  const open = fs.open, denied = Object.assign(Error('synthetic access denied'), { code: 'EPERM' });
  let calls = 0;
  fs.open = async function (name, ...args) { if (name === lock) throw denied; return open.call(this, name, ...args); };
  try { await assert.rejects(files.withDirectoryLock(directory, async () => { calls++; }), error => error === denied); }
  finally { fs.open = open; }
  assert.equal(calls, 0);
  await files.withDirectoryLock(directory, async () => { calls++; });
  assert.equal(calls, 1);
});
test('a timed-out local waiter never runs after its predecessor eventually releases the lock', { timeout: 5000 }, async t => {
  const directory = await temporary(t);
  let release, late = 0, first, second;
  try {
    first = files.withDirectoryLock(directory, () => new Promise(resolve => { release = resolve; }));
    const until = Date.now() + 2000;
    while (!release && Date.now() < until) await new Promise(setImmediate);
    assert.equal(typeof release, 'function');
    second = files.withDirectoryLock(directory, async () => { late++; });
    await assert.rejects(second, /STORAGE_BUSY/);
    assert.equal(late, 0);
    release(); await first; await new Promise(setImmediate);
    assert.equal(late, 0, 'deadline must cancel the queued operation rather than only its caller');
    await files.withDirectoryLock(directory, async () => { late++; });
    assert.equal(late, 1);
  } finally { release?.(); await Promise.allSettled([first, second]); }
});
test('concurrent account mutations reload persisted state under a lock', async t => {
  const directory = await temporary(t);
  await Promise.all(Array.from({ length: 12 }, (_, index) => files.mutateAccounts(directory, accounts => core.addAccount(accounts, `account${index}`, `Label${index}`))));
  assert.equal((await files.readAccounts(directory)).length, 12);
  assert.equal((await fs.stat(path.join(directory, 'accounts.json'))).isFile(), true);
});
test('invalid existing account storage is not overwritten', async t => {
  const directory = await temporary(t);
  const file = path.join(directory, 'accounts.json');
  await fs.writeFile(file, 'INVALID');
  await assert.rejects(files.mutateAccounts(directory, () => []));
  assert.equal(await fs.readFile(file, 'utf8'), 'INVALID');
});
