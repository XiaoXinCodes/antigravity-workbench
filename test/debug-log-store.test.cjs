const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { fork } = require('node:child_process');
const { DebugLogStore } = require('../out/debug-log-store');

const enabled = () => true;
const record = (index) => JSON.stringify({ schema: 1, event: 'test', index });
const knownName = (index = 0) => `debug-v1-1700000000000-${'a'.repeat(32)}-${String(index).padStart(8, '0')}.jsonl`;
const generic = (error) => error instanceof Error && error.message === 'DEBUG_STORAGE_UNAVAILABLE' && !error.message.includes(os.tmpdir());
async function fixture(t, options) {
  const parent = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'agw-debug-store-'));
  const directory = path.join(parent, 'private');
  const store = new DebugLogStore(directory, options);
  t.after(async () => { store.dispose(); await store.flush(); await fs.rm(parent, { recursive: true, force: true }); });
  return { parent, directory, store };
}
async function files(directory) { return (await fs.readdir(directory)).filter(name => name.endsWith('.jsonl')).sort(); }

// Every fixture below contains synthetic data only.
test('disabled storage is lazy; enabled records are private and can be read by a later instance', async t => {
  const f = await fixture(t);
  await f.store.append(record(0), () => false);
  assert.deepEqual(await f.store.readLines(), []);
  await assert.rejects(fs.stat(f.directory), { code: 'ENOENT' });
  await f.store.append(record(1), enabled);
  await f.store.append(record(2), enabled);
  assert.deepEqual(await f.store.readLines(), [record(1), record(2)]);
  const later = new DebugLogStore(f.directory);
  assert.deepEqual(await later.readLines(), [record(1), record(2)]);
  later.dispose();
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(f.directory)).mode & 0o777, 0o700);
    for (const name of await files(f.directory)) { assert.equal((await fs.stat(path.join(f.directory, name))).mode & 0o777, 0o600); }
  }
});

test('rolling storage caps aggregate files and each file size', async t => {
  const f = await fixture(t, { maxFileBytes: 100, maxFiles: 3 });
  for (let index = 0; index < 30; index++) { await f.store.append(record(index), enabled); }
  const names = await files(f.directory);
  assert.equal(names.length, 3);
  let bytes = 0;
  for (const name of names) {
    const size = (await fs.stat(path.join(f.directory, name))).size;
    assert.ok(size <= 100);
    bytes += size;
  }
  assert.ok(bytes <= 300);
  const lines = await f.store.readLines();
  assert.equal(lines.at(-1), record(29));
  assert.ok(lines.length < 30);
});

test('concurrent instances own distinct session files and preserve whole JSON records', async t => {
  const f = await fixture(t, { maxFileBytes: 128 });
  const stores = Array.from({ length: 4 }, () => new DebugLogStore(f.directory, { maxFileBytes: 128 }));
  await Promise.all(Array.from({ length: 20 }, (_, index) => stores.map((store, slot) => store.append(record(slot * 20 + index), enabled))).flat());
  await Promise.all(stores.map(store => store.flush()));
  const names = await files(f.directory);
  assert.ok(names.length <= 5);
  assert.ok(new Set(names.map(name => name.split('-')[3])).size > 1);
  for (const name of names) {
    const content = await fs.readFile(path.join(f.directory, name), 'utf8');
    assert.ok(Buffer.byteLength(content) <= 128);
    assert.ok(content.endsWith('\n'));
    for (const line of content.trim().split('\n')) { assert.equal(JSON.parse(line).event, 'test'); }
  }
  stores.forEach(store => store.dispose());
});

test('queued events are cancelled on disable without deleting prior records', async t => {
  const f = await fixture(t);
  await f.store.append(record(0), enabled);
  const before = await f.store.readLines();
  let writing = true;
  const work = Array.from({ length: 20 }, (_, index) => f.store.append(record(index + 1), () => writing));
  writing = false;
  await Promise.all(work);
  await f.store.flush();
  assert.deepEqual(await f.store.readLines(), before);
});

test('disabling during awaited directory work prevents file creation and writing', async t => {
  const f = await fixture(t);
  const original = fs.lstat;
  let writing = true;
  let observed = false;
  fs.lstat = async function(name, ...args) {
    const result = await original.call(this, name, ...args);
    if (name === f.parent && !observed) { observed = true; writing = false; }
    return result;
  };
  try { await f.store.append(record(1), () => writing); }
  finally { fs.lstat = original; }
  assert.equal(observed, true);
  await assert.rejects(fs.stat(f.directory), { code: 'ENOENT' });
});

test('disabling after file open prevents a queued event write', async t => {
  const f = await fixture(t);
  const original = fs.open;
  let writing = true;
  fs.open = async function(name, ...args) {
    const handle = await original.call(this, name, ...args);
    if (path.dirname(name) === f.directory) { writing = false; }
    return handle;
  };
  try { await f.store.append(record(1), () => writing); }
  finally { fs.open = original; }
  await f.store.flush();
  assert.deepEqual(await f.store.readLines(), []);
  for (const name of await files(f.directory)) { assert.equal((await fs.stat(path.join(f.directory, name))).size, 0); }
});

test('dispose cancels queued records and permits flush to settle', async t => {
  const f = await fixture(t);
  const pending = f.store.append(record(1), enabled);
  f.store.dispose();
  await pending;
  await f.store.flush();
  await f.store.append(record(2), enabled);
  await assert.rejects(fs.stat(f.directory), { code: 'ENOENT' });
});

test('size, shape, option, and queue limits fail only with a fixed public error', async t => {
  const f = await fixture(t, { maxEventBytes: 64, maxPending: 1 });
  for (const line of ['', 'no json', '[]', 'null', '"string"', '{}\n', '{}\r', '{}\n{}', JSON.stringify({ text: 'x'.repeat(64) }), JSON.stringify({ text: '界'.repeat(30) })]) {
    await assert.rejects(f.store.append(line, enabled), generic);
  }
  const pending = f.store.append(record(1), enabled);
  await assert.rejects(f.store.append(record(2), enabled), generic);
  await pending;
  await f.store.flush();
  assert.deepEqual(await f.store.readLines(), [record(1)]);
  for (const options of [{ maxFiles: 0 }, { maxFileBytes: Infinity }, { maxPending: -1 }, { maxEventBytes: 1.5 }, { maxFiles: 6 }, { maxFileBytes: 64, maxEventBytes: 65 }]) {
    assert.throws(() => new DebugLogStore(f.directory, options), generic);
  }
  await assert.rejects(f.store.append(record(3), () => { throw new Error('private-path-or-secret'); }), generic);
});

test('inaccessible and non-directory storage never exposes OS error messages', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.directory, 'synthetic', { mode: 0o600 });
  await assert.rejects(f.store.append(record(0), enabled), generic);
  await assert.rejects(f.store.readLines(), generic);
  assert.equal(await fs.readFile(f.directory, 'utf8'), 'synthetic');
  await fs.unlink(f.directory);
  // Windows mkdir mode does not set a restrictive ACL; test POSIX permissions only where supported.
  if (process.platform === 'win32') return;
  await fs.mkdir(f.directory, { mode: 0o400 });
  try { await assert.rejects(new DebugLogStore(f.directory).append(record(1), enabled), generic); }
  finally { await fs.chmod(f.directory, 0o700); }
});

test('unrelated files are neither opened nor deleted; incomplete and invalid records are excluded', async t => {
  const f = await fixture(t, { maxFileBytes: 128, maxFiles: 1 });
  await fs.mkdir(f.directory, { mode: 0o700 });
  const unrelated = path.join(f.directory, 'arbitrary-application.log');
  await fs.writeFile(unrelated, 'synthetic-unrelated', { mode: 0o600 });
  await fs.writeFile(path.join(f.directory, knownName()), '{}\nnot-json\n[]\n{"partial":', { mode: 0o600 });
  assert.deepEqual(await f.store.readLines(), ['{}']);
  for (let index = 0; index < 6; index++) { await f.store.append(record(index), enabled); }
  assert.equal(await fs.readFile(unrelated, 'utf8'), 'synthetic-unrelated');
  assert.equal((await files(f.directory)).length, 1);
});

test('symlink directories and known-name symlinks are rejected without touching targets', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  const target = path.join(f.parent, 'target');
  await fs.mkdir(target, { mode: 0o700 });
  await fs.symlink(target, f.directory);
  await assert.rejects(f.store.append(record(1), enabled), generic);
  await assert.rejects(f.store.readLines(), generic);
  assert.deepEqual(await fs.readdir(target), []);
  await fs.unlink(f.directory);
  await fs.mkdir(f.directory, { mode: 0o700 });
  const targetFile = path.join(target, 'target.log');
  await fs.writeFile(targetFile, 'synthetic-target', { mode: 0o600 });
  await fs.symlink(targetFile, path.join(f.directory, knownName()));
  const nextStore = new DebugLogStore(f.directory);
  await assert.rejects(nextStore.readLines(), generic);
  await assert.rejects(nextStore.append(record(2), enabled), generic);
  nextStore.dispose();
  assert.equal(await fs.readFile(targetFile, 'utf8'), 'synthetic-target');
  assert.equal((await fs.lstat(path.join(f.directory, knownName()))).isSymbolicLink(), true);
});

test('known-name hardlinks, directories, and broad permissions are rejected', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  await fs.mkdir(f.directory, { mode: 0o700 });
  const name = path.join(f.directory, knownName());
  const target = path.join(f.parent, 'target.log');
  await fs.writeFile(target, '{}\n', { mode: 0o600 });
  await fs.link(target, name);
  await assert.rejects(f.store.readLines(), generic);
  await assert.rejects(f.store.append(record(1), enabled), generic);
  assert.equal(await fs.readFile(target, 'utf8'), '{}\n');
  await fs.unlink(name);
  await fs.mkdir(name, { mode: 0o700 });
  await assert.rejects(new DebugLogStore(f.directory).readLines(), generic);
  await fs.rmdir(name);
  await fs.writeFile(name, '{}\n', { mode: 0o644 });
  await assert.rejects(new DebugLogStore(f.directory).readLines(), generic);
  await fs.unlink(name);
  await fs.chmod(f.directory, 0o755);
  await assert.rejects(new DebugLogStore(f.directory).append(record(2), enabled), generic);
  await fs.chmod(f.directory, 0o700);
  await fs.chmod(f.parent, 0o770);
  try { await assert.rejects(new DebugLogStore(f.directory).append(record(3), enabled), generic); }
  finally { await fs.chmod(f.parent, 0o700); }
});

test('foreign file ownership is rejected where uid metadata is available', { skip: typeof process.getuid !== 'function' }, async t => {
  const f = await fixture(t);
  await f.store.append(record(1), enabled);
  const original = fs.lstat;
  fs.lstat = async function(name, ...args) {
    const stat = await original.call(this, name, ...args);
    if (path.dirname(name) === f.directory) { stat.uid = process.getuid() + 1; }
    return stat;
  };
  try { await assert.rejects(f.store.readLines(), generic); await assert.rejects(f.store.append(record(2), enabled), generic); }
  finally { fs.lstat = original; }
});

test('replacing an initialized directory or current file cannot redirect subsequent IO', async t => {
  const f = await fixture(t);
  await f.store.append(record(1), enabled);
  const moved = path.join(f.parent, 'moved');
  await fs.rename(f.directory, moved);
  await fs.mkdir(f.directory, { mode: 0o700 });
  await assert.rejects(f.store.append(record(2), enabled), generic);
  await assert.rejects(f.store.readLines(), generic);
  assert.deepEqual(await fs.readdir(f.directory), []);
  await fs.rmdir(f.directory);
  await fs.rename(moved, f.directory);
  const nextStore = new DebugLogStore(f.directory);
  await nextStore.append(record(2), enabled);
  const name = (await files(f.directory)).at(-1);
  const location = path.join(f.directory, name);
  await fs.rename(location, `${location}.old`);
  await fs.writeFile(location, '{}\n', { mode: 0o600 });
  await assert.rejects(nextStore.append(record(3), enabled), generic);
  assert.equal(await fs.readFile(location, 'utf8'), '{}\n');
  nextStore.dispose();
});

test('ancestor symlinks are rejected before any log directory is created', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  const target = path.join(f.parent, 'target');
  const alias = path.join(f.parent, 'alias');
  await fs.mkdir(target, { mode: 0o700 });
  await fs.symlink(target, alias);
  const store = new DebugLogStore(path.join(alias, 'private'));
  await assert.rejects(store.append(record(1), enabled), generic);
  assert.deepEqual(await fs.readdir(target), []);
  store.dispose();
});

test('no-follow file opens reject a symlink swapped in immediately before read or append', { skip: process.platform === 'win32' }, async t => {
  for (const action of ['read', 'append']) {
    const f = await fixture(t);
    await f.store.append(record(1), enabled);
    const location = path.join(f.directory, (await files(f.directory))[0]);
    const target = path.join(f.parent, 'target.log');
    await fs.writeFile(target, 'synthetic-target', { mode: 0o600 });
    const original = fs.open;
    let swapped = false;
    fs.open = async function(name, flags, ...args) {
      if (name === location && !swapped) {
        swapped = true;
        assert.ok(flags & require('node:fs').constants.O_NOFOLLOW);
        await fs.rename(location, `${location}.original`);
        await fs.symlink(target, location);
      }
      return original.call(this, name, flags, ...args);
    };
    try {
      await assert.rejects(action === 'read' ? f.store.readLines() : f.store.append(record(2), enabled), generic);
    } finally { fs.open = original; }
    assert.equal(swapped, true);
    assert.equal(await fs.readFile(target, 'utf8'), 'synthetic-target');
    assert.equal(await fs.readFile(`${location}.original`, 'utf8'), `${record(1)}\n`);
  }
});

test('default bounds apply to persisted files and scans are finite', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.directory, { mode: 0o700 });
  await fs.writeFile(path.join(f.directory, knownName()), 'x'.repeat(65537), { mode: 0o600 });
  await assert.rejects(f.store.readLines(), generic);
  await fs.unlink(path.join(f.directory, knownName()));
  await Promise.all(Array.from({ length: 1025 }, (_, index) => fs.writeFile(path.join(f.directory, `unrelated-${index}`), '', { mode: 0o600 })));
  await assert.rejects(f.store.readLines(), generic);
});

test('scan and cleanup failures latch writes without growing storage on retries', async t => {
  const f = await fixture(t, { maxFileBytes: 64, maxFiles: 1 });
  await f.store.append(record(1), enabled);
  const beforeNames = await files(f.directory);
  const before = await fs.readFile(path.join(f.directory, beforeNames[0]));
  const original = fs.unlink;
  let attempts = 0;
  fs.unlink = async function(name, ...args) {
    if (path.dirname(name) === f.directory) { attempts++; throw new Error('synthetic denied cleanup'); }
    return original.call(this, name, ...args);
  };
  try {
    for (let index = 0; index < 10; index++) { await assert.rejects(f.store.append(record(index + 2), enabled), generic); }
  } finally { fs.unlink = original; }
  assert.equal(attempts, 1);
  assert.deepEqual(await files(f.directory), beforeNames);
  assert.deepEqual(await fs.readFile(path.join(f.directory, beforeNames[0])), before);
  await assert.rejects(f.store.append(record(99), enabled), generic);
  const fresh = new DebugLogStore(f.directory, { maxFileBytes: 64, maxFiles: 1 });
  await fresh.append(record(100), enabled);
  assert.deepEqual(await fresh.readLines(), [record(100)]);
  fresh.dispose();
  const g = await fixture(t);
  await fs.mkdir(g.directory, { mode: 0o700 });
  await Promise.all(Array.from({ length: 1025 }, (_, index) => fs.writeFile(path.join(g.directory, `unrelated-${index}`), '', { mode: 0o600 })));
  for (let index = 0; index < 10; index++) { await assert.rejects(g.store.append(record(index), enabled), generic); }
  assert.deepEqual(await files(g.directory), []);
});

test('independent processes rotate the same directory without corrupting another session', async t => {
  const f = await fixture(t);
  const jobs = Array.from({ length: 3 }, () => new Promise((resolve, reject) => {
    let failure = '', operation = '';
    const child = fork(path.join(__dirname, 'fixtures/debug-store-worker.cjs'), [], { execArgv: [], env: { ...process.env, TEST_STORE: f.directory }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    child.on('message', value => {
      if (['open', 'lstat', 'unlink', 'mkdir', 'opendir'].includes(value?.operation) && ['EPERM', 'EACCES'].includes(value.rawCode) && /^[a-zA-Z]+$/.test(value.method ?? '')) operation = `${value.operation}/${value.method}/${value.rawCode}`;
      if (/^DEBUG_STORAGE_[A-Z_]+$/.test(value?.code) && ['start', 'append', 'read'].includes(value?.phase)) failure = `${value.phase}/${value.code}`;
    });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`synthetic child failure ${failure} ${operation}`)));
  }));
  // Do not delete the fixture while sibling processes are still using it after one fails.
  const results = await Promise.allSettled(jobs);
  assert.deepEqual(results.filter(x => x.status === 'rejected').map(x => x.reason.message), []);
  await f.store.append(record(99), enabled);
  assert.ok((await files(f.directory)).length <= 5);
  assert.ok((await f.store.readLines()).length > 0);
  for (const name of await files(f.directory)) {
    const content = await fs.readFile(path.join(f.directory, name), 'utf8');
    assert.ok(Buffer.byteLength(content) <= 128);
    for (const line of content.trim().split('\n')) { assert.equal(JSON.parse(line).event, 'test'); }
  }
});

for (const phase of ['scan', 'retain', 'verifyHandle', 'writeRecord']) test(`concurrent retention after pathname lookup in ${phase} is not a path attack`, async t => {
  const f = await fixture(t);
  await f.store.append(record(1), enabled);
  const target = path.join(f.directory, (await files(f.directory))[0]);
  const original = fs.lstat;
  let raced = false;
  fs.lstat = async function (name, ...args) {
    const caller = new Error().stack.split('\n')[2];
    if (!raced && name === target && caller.includes(`DebugLogStore.${phase} `)) {
      raced = true;
      const handle = await fs.open(target, 'r');
      try {
        await fs.unlink(target);
        const stat = await handle.stat();
        assert.equal(stat.nlink, 0); assert.equal(stat.isFile(), true);
        return stat;
      } finally { await handle.close(); }
    }
    return original.call(this, name, ...args);
  };
  try {
    if (phase === 'scan' || phase === 'verifyHandle') await f.store.readLines();
    else if (phase === 'retain') {
      // Force retention to revisit the oldest scanned file.
      await fs.writeFile(path.join(f.directory, knownName()), record(0)+'\n', { mode: 0o600 });
      const extra = Array.from({ length: 5 }, (_, i) => fs.writeFile(path.join(f.directory, knownName(i + 1)), record(i)+'\n', { mode: 0o600 }));
      await Promise.all(extra);
      // A far-future private file sorts after the current session, making target evictable.
      for (const n of await files(f.directory)) if (n !== path.basename(target)) await fs.rename(path.join(f.directory, n), path.join(f.directory, n.replace('1700000000000', '9999999999999')));
      await f.store.append(record(2), enabled);
    } else await f.store.append(record(2), enabled);
  } finally { fs.lstat = original; }
  assert.equal(raced, true, phase);
  await f.store.append(record(3), enabled);
  assert.ok((await f.store.readLines()).includes(record(3)));
});
