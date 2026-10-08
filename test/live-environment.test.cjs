const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { LiveError, SystemKeyring } = require('../out/live-storage');
const { resolveOfficialStorageMode, assertWslBackendExecutable, createOfficialTokenSlots, EnvironmentTokenSlots } = require('../out/live-environment');
const { LiveSwitchService, JOURNAL_KEY } = require('../out/live-switch');

const raw = name => JSON.stringify({ token: { refresh_token: `synthetic-${name}` } });
const empty = { keyring: null, file: null };
const fileA = { keyring: null, file: raw('A') };
async function home(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agm-storage-mode-'));
  await fs.mkdir(path.join(root, '.gemini'), { mode: 0o700 });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
const nativeKernel = async () => '6.8.0-generic';
const forbiddenKeyring = () => { throw new Error('A WSL operation must never create or probe a keyring'); };

test('audited WSL predicate matches nonempty environment values without reading the kernel', async () => {
  for (const env of [{ WSL_DISTRO_NAME: 'Ubuntu' }, { WSL_INTEROP: '/run/WSL/123_interop' }, { WSL_DISTRO_NAME: ' ' }]) {
    assert.equal(await resolveOfficialStorageMode('linux', env, async () => { throw new Error('must not read'); }), 'wsl-file');
  }
});
test('WSL kernel fallback matches microsoft or wsl case-insensitively; failed reads stay strict', async () => {
  for (const release of ['6.6.87.2-microsoft-standard-WSL2\n', '5.15.0-WSL2', '4.4.0-Microsoft']) {
    assert.equal(await resolveOfficialStorageMode('linux', { WSL_DISTRO_NAME: '', WSL_INTEROP: '' }, async () => release), 'wsl-file');
  }
  assert.equal(await resolveOfficialStorageMode('linux', {}, nativeKernel), 'native-keyring');
  assert.equal(await resolveOfficialStorageMode('linux', {}, async () => { throw new Error('synthetic unreadable'); }), 'native-keyring');
  for (const platform of ['win32', 'darwin']) assert.equal(await resolveOfficialStorageMode(platform, { WSL_DISTRO_NAME: 'forwarded-env' }, async () => { throw new Error('must not read'); }), 'native-keyring');
});
test('WSL capture reads only the fallback and never permits credential mutation', async t => {
  const root = await home(t);
  const slots = await createOfficialTokenSlots(root, 'linux', { WSL_DISTRO_NAME: 'synthetic' }, { createKeyring: forbiddenKeyring });
  assert.equal(slots.storageMode, 'wsl-file');
  assert.deepEqual(await slots.read(), { ...empty, keyringState: 'unobserved' });
  await fs.writeFile(path.join(root, '.gemini', 'jetski-standalone-oauth-token'), fileA.file, { mode: 0o600 });
  assert.deepEqual(await slots.read(), { ...fileA, keyringState: 'unobserved' });
  if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(root, '.gemini', 'jetski-standalone-oauth-token'))).mode & 0o077, 0);
  await assert.rejects(slots.write(empty, fileA), /OFFICIAL_STORAGE_CAPTURE_ONLY/);
  assert.deepEqual(await slots.read(), { ...fileA, keyringState: 'unobserved' });
});
test('WSL file-only storage refuses both keyring targets and claimed keyring backups', async t => {
  const root = await home(t);
  const slots = await createOfficialTokenSlots(root, 'linux', { WSL_INTEROP: 'synthetic' }, { createKeyring: forbiddenKeyring });
  await fs.writeFile(path.join(root, '.gemini', 'jetski-standalone-oauth-token'), fileA.file, { mode: 0o600 });
  for (const [value, expected] of [[{ keyring: raw('B'), file: raw('B') }, fileA], [empty, { keyring: raw('A'), file: raw('A') }]]) {
    await assert.rejects(slots.write(value, expected), /OFFICIAL_STORAGE_MODE_MISMATCH/);
    assert.deepEqual(await slots.read(), { ...fileA, keyringState: 'unobserved' });
  }
});
test('WSL mutation preserves both actual slots and restores a contradictory original keyring snapshot', async t => {
  const root = await home(t); let keyring = raw('stale-other-account'), reads = 0; const writes = [];
  await fs.writeFile(path.join(root, '.gemini', 'jetski-standalone-oauth-token'), fileA.file, { mode: 0o600 });
  const slots = new EnvironmentTokenSlots(root, 'linux', { WSL_DISTRO_NAME: 'synthetic' }, {
    createKeyring: () => ({ read: async () => { reads++; return keyring; }, write: async value => { writes.push(value); keyring = value; } }),
  }, 'mutation');
  assert.equal(await slots.mode(), 'wsl-file'); assert.equal(reads, 0);
  const backup = await slots.read();
  assert.deepEqual(backup, { keyring: raw('stale-other-account'), file: raw('A') });
  const target = { keyring: null, file: raw('B') };
  await slots.write(target, backup);
  assert.deepEqual(await slots.read(), target);
  await slots.write(backup, target);
  assert.deepEqual(await slots.read(), backup);
  assert.deepEqual(writes, [null, raw('stale-other-account')]);
});
test('WSL mutation cannot write or invent a backup when the keyring is unavailable', async t => {
  const root = await home(t); let writes = 0, reads = 0;
  await fs.writeFile(path.join(root, '.gemini', 'jetski-standalone-oauth-token'), fileA.file, { mode: 0o600 });
  const slots = await createOfficialTokenSlots(root, 'linux', { WSL_INTEROP: 'synthetic' }, {
    createKeyring: () => ({ read: async () => { reads++; throw new LiveError('KEYRING_UNAVAILABLE'); }, write: async () => { writes++; } }),
  }, 'mutation');
  await assert.rejects(slots.read(), /KEYRING_UNAVAILABLE/);
  await assert.rejects(slots.write({ keyring: null, file: raw('B') }, fileA), /KEYRING_UNAVAILABLE/);
  assert.equal(reads, 2); assert.equal(writes, 0);
  assert.equal(await fs.readFile(path.join(root, '.gemini', 'jetski-standalone-oauth-token'), 'utf8'), fileA.file);
});
test('WSL prepareLogin backs up both original slots even when their accounts differ', async t => {
  const root = await home(t), data = new Map(), original = { keyring: raw('other'), file: raw('A') };
  await fs.writeFile(path.join(root, '.gemini', 'jetski-standalone-oauth-token'), original.file, { mode: 0o600 });
  const slots = await createOfficialTokenSlots(root, 'linux', { WSL_DISTRO_NAME: 'synthetic' }, {
    createKeyring: () => ({ read: async () => original.keyring, write: async () => { throw new Error('prepareLogin cannot mutate'); } }),
  }, 'mutation');
  const vault = { get: async key => data.get(key), store: async (key, value) => { data.set(key, value); }, delete: async key => { data.delete(key); } };
  const service = new LiveSwitchService(vault, slots, 'synthetic-wsl-file-host');
  await service.prepareLogin({ generation: 'synthetic-hub-generation', proof:async()=>({email:'other@example.test',generation:'synthetic-hub-generation',authValid:true,quotaSource:'server',observedAt:new Date().toISOString(),buckets:[]}) });
  const journal = [...data.entries()].find(([key]) => key.startsWith(JOURNAL_KEY));
  assert.ok(journal, 'host-scoped encrypted recovery must exist');
  assert.deepEqual(JSON.parse(journal[1]).backup, original);
});
test('non-WSL keeps SystemKeyring strict failures and never turns DBus errors into empty slots', async t => {
  const root = await home(t); let calls = 0;
  const slots = await createOfficialTokenSlots(root, 'linux', {}, {
    readKernelRelease: nativeKernel,
    createKeyring: platform => new SystemKeyring(platform, async () => { calls++; return { code: 1, stdout: '', stderr: 'synthetic unavailable session bus' }; }),
  });
  assert.equal(slots.storageMode, 'native-keyring');
  await assert.rejects(slots.read(), /KEYRING_UNAVAILABLE/);
  assert.equal(calls, 1);
});
test('native keyring error object is preserved rather than treating failure as absence', async t => {
  const root = await home(t), error = new LiveError('NATIVE_HELPER_TIMEOUT_OR_LIMIT');
  const slots = await createOfficialTokenSlots(root, 'linux', {}, {
    readKernelRelease: nativeKernel,
    createKeyring: () => ({ read: async () => { throw error; }, write: async () => { throw error; } }),
  });
  await assert.rejects(slots.read(), actual => actual === error);
});
test('lazy wrapper is passive at construction and refuses mode drift before storage access', async t => {
  const root = await home(t), env = {}; let probes = 0, keyringReads = 0, release = 'synthetic-generic';
  const slots = new EnvironmentTokenSlots(root, 'linux', env, {
    readKernelRelease: async () => { probes++; return release; },
    createKeyring: () => ({ read: async () => { keyringReads++; return null; }, write: async () => {} }),
  });
  assert.equal(probes, 0); assert.equal(keyringReads, 0);
  assert.equal(await slots.mode(), 'native-keyring'); assert.equal(keyringReads, 0);
  release = 'synthetic-Microsoft';
  await assert.rejects(slots.read(), /OFFICIAL_STORAGE_MODE_CHANGED/);
  await assert.rejects(slots.write(fileA, empty), /OFFICIAL_STORAGE_MODE_CHANGED/);
  assert.equal(keyringReads, 0);
});
test('WSL mode drift is rejected without constructing a newly available native keyring', async t => {
  const root = await home(t), env = { WSL_DISTRO_NAME: 'synthetic' };
  const slots = new EnvironmentTokenSlots(root, 'linux', env, { readKernelRelease: nativeKernel, createKeyring: forbiddenKeyring });
  assert.deepEqual(await slots.read(), { ...empty, keyringState: 'unobserved' });
  delete env.WSL_DISTRO_NAME;
  await assert.rejects(slots.write(fileA, empty), /OFFICIAL_STORAGE_MODE_CHANGED/);
  assert.deepEqual(await fs.readdir(path.join(root, '.gemini')), []);
});
test('WSL executable check rejects invalid containers, absent paths, and directories', async t => {
  const root = await home(t), executable = path.join(root, 'agy');
  await assert.rejects(assertWslBackendExecutable(executable), /OFFICIAL_WSL_EXECUTABLE_INVALID/);
  await assert.rejects(assertWslBackendExecutable(root), /OFFICIAL_WSL_EXECUTABLE_INVALID/);
  for (const bytes of [Buffer.from('MZsynthetic Windows executable'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0])]) {
    await fs.writeFile(executable, bytes, { mode: 0o600 });
    await assert.rejects(assertWslBackendExecutable(executable), /OFFICIAL_WSL_EXECUTABLE_INVALID/);
  }
});
test('WSL executable check refuses executable symlinks', { skip: process.platform === 'win32' }, async t => {
  const root = await home(t), target = path.join(root, 'target'), executable = path.join(root, 'agy');
  await fs.writeFile(target, Buffer.from([0x7f, 0x45, 0x4c, 0x46])); await fs.symlink(target, executable);
  await assert.rejects(assertWslBackendExecutable(executable), /OFFICIAL_WSL_EXECUTABLE_INVALID/);
});

test('changed ELF contents pass without a release fingerprint; broken header is rejected', async t => {
  const root = await home(t), executable = path.join(root, 'agy');
  for (const elfClass of [1, 2]) {
    const bytes = Buffer.alloc(256, 0x37);
    bytes.set([0x7f, 0x45, 0x4c, 0x46, elfClass, 1, 1]);
    bytes.writeUInt16LE(2, 16); bytes.writeUInt16LE(62, 18);
    bytes.writeUInt16LE(elfClass === 1 ? 52 : 64, elfClass === 1 ? 40 : 52);
    await fs.writeFile(executable, bytes, { mode: 0o700 });
    await assertWslBackendExecutable(executable);
    bytes[200] = 0x99;
    await fs.writeFile(executable, bytes); await assertWslBackendExecutable(executable);
    bytes[4] = 0;
    await fs.writeFile(executable, bytes);
    await assert.rejects(assertWslBackendExecutable(executable), /OFFICIAL_WSL_EXECUTABLE_INVALID/);
  }
});

const { parseWslFileRoute, createWslFileGuard, createWslReadGuard, readWslProcess, readPinnedWslProcess, readWslStartup } = require('../out/live-wsl-proof');
const fileScope = value => ({ keyring: null, file: value, keyringState: 'unobserved' });
const startup = (pid = 42, port = 45678) => `I1001 12:34:56.000001      52 server.go:1586] Starting language server process with pid ${pid}\nI1001 12:34:56.000002      52 server.go:640] Language server listening on random port at ${port} for HTTP\nI1001 12:34:56.000003      52 composite_token_storage.go:123] Using file-based token storage because WSL environment detected\n`;
const api = { port: 45678, csrfToken: 'synthetic-nonsecret-csrf' };

test('file proof binds explicit OS PID, HTTP port and exact WSL storage decision in startup order', () => {
  assert.equal(parseWslFileRoute(startup(), 42, api.port), true);
  for (const content of [startup(41), startup(42, 12345), startup().replace('WSL environment', 'container environment'), startup() + startup(), startup().slice(0, -1), startup().split('\n').reverse().join('\n')]) assert.equal(parseWslFileRoute(content, 42, api.port), false);
  assert.equal(parseWslFileRoute(startup(), 52, api.port), false, 'glog column is not an OS PID');
});
test('WSL guard rejects mismatched generation, process restart, mixed PID and concurrent backends', async () => {
  for (const drift of ['generation', 'pid', 'start', 'count']) {
    let current = api, inspections = 0, counts = 0;
    const guard = createWslFileGuard('/synthetic', '/synthetic/agy', () => current, async () => ++counts > 1 && drift === 'count' ? 2 : 1, {
      process: async () => ({ pid: ++inspections > 1 && drift === 'pid' ? 99 : 42, startTicks: inspections > 1 && drift === 'start' ? '2' : '1' }),
      startup: async () => { if (drift === 'generation') current = { ...api, csrfToken: 'synthetic-another-csrf' }; return startup(); },
    });
    await assert.rejects(guard(false), /WSL_FILE_ROUTE_UNVERIFIED/);
  }
});
test('WSL guard rechecks live proof on every call and permits only explicit stopped recovery', async () => {
  let current = api, count = 1, text = startup();
  const guard = createWslFileGuard('/synthetic', '/synthetic/agy', () => current, async () => count, { process: async () => ({ pid: 42, startTicks: '1' }), startup: async () => text });
  assert.equal(await guard(false), true);
  text = ''; assert.equal(await guard(false), false);
  current = undefined; count = 0;
  assert.equal(await guard(false), false); assert.equal(await guard(true), true);
  count = 1; assert.equal(await guard(true), false);
});
test('proof read failures do not return credentials or raw log/error content', async () => {
  const guard = createWslFileGuard('/synthetic', '/synthetic/agy', () => api, async () => 1, { process: async () => ({ pid: 42, startTicks: '1' }), startup: async () => { throw new Error('synthetic-private-log-content'); } });
  await assert.rejects(guard(false), e => e.code === 'WSL_FILE_ROUTE_UNVERIFIED' && !String(e).includes('private-log'));
});
async function proofFixture(t) {
  const root = await home(t), procRoot = path.join(root, 'proc'), directory = path.join(root, '.gemini', 'antigravity', 'log');
  await fs.mkdir(path.join(procRoot, '42', 'fd'), { recursive: true, mode: 0o700 }); await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, 'cli-20261001_123456.log'); await fs.writeFile(filename, startup(), { mode: 0o600 });
  await fs.symlink(filename, path.join(procRoot, '42/fd/1')); await fs.symlink(filename, path.join(procRoot, '42/fd/2'));
  const executable = path.join(root, 'agy'); await fs.writeFile(executable, 'synthetic-no-executable');
  await fs.symlink(executable, path.join(procRoot, '42/exe'));
  await fs.writeFile(path.join(procRoot, '42/comm'), 'agy\n');
  await fs.writeFile(path.join(procRoot, '42/cmdline'), [executable, '--hub', `--hub-port=${api.port}`, `--csrf_token=${api.csrfToken}`, '--app_data_dir=antigravity', ''].join('\0'));
  await fs.writeFile(path.join(procRoot, '42/stat'), `42 (agy) ${Array.from({length: 20}, (_, i) => i === 19 ? '12345' : '0').join(' ')}\n`);
  return { root, procRoot, directory, filename, executable };
}
test('real proof reader selects only the currently open log, accepting duplicated stdout/stderr descriptors', { skip: process.platform === 'win32' }, async t => {
  const f = await proofFixture(t);
  assert.deepEqual(await readWslProcess(f.executable, api, f.procRoot), { pid: 42, startTicks: '12345' });
  assert.equal(await readWslStartup(f.root, { pid: 42, startTicks: '12345' }, f.procRoot), startup());
  await fs.writeFile(path.join(f.directory, 'cli-20260901_111111.log'), startup(99));
  assert.equal(await readWslStartup(f.root, { pid: 42, startTicks: '12345' }, f.procRoot), startup(), 'stale unopened log never wins');
  await fs.writeFile(f.filename, 'truncated'); assert.equal(parseWslFileRoute(await readWslStartup(f.root, { pid: 42, startTicks: '12345' }, f.procRoot), 42, api.port), false);
});
test('real proof reader rejects ambiguous open logs, replaced symlinks and unsafe directories', { skip: process.platform === 'win32' }, async t => {
  const f = await proofFixture(t), other = path.join(f.directory, 'cli-20261001_123457.log'), fd = path.join(f.procRoot, '42/fd/3');
  await fs.writeFile(other, startup(), { mode: 0o600 }); await fs.symlink(other, fd);
  await assert.rejects(readWslStartup(f.root, { pid: 42 }, f.procRoot), /WSL_FILE_ROUTE_UNVERIFIED/); await fs.unlink(fd);
  await fs.unlink(f.filename); await fs.symlink(other, f.filename);
  await assert.rejects(readWslStartup(f.root, { pid: 42 }, f.procRoot), /WSL_FILE_ROUTE_UNVERIFIED/);
  await fs.unlink(f.filename); await fs.writeFile(f.filename, startup(), { mode: 0o600 }); await fs.chmod(f.directory, 0o777);
  await assert.rejects(readWslStartup(f.root, { pid: 42 }, f.procRoot), /WSL_FILE_ROUTE_UNVERIFIED/);
});
test('real process proof rejects another agy, mismatched argv and binary path', { skip: process.platform === 'win32' }, async t => {
  const f = await proofFixture(t);
  await assert.rejects(readWslProcess(f.executable, { ...api, port: 22 }, f.procRoot), /WSL_FILE_ROUTE_UNVERIFIED/);
  await assert.rejects(readWslProcess(f.executable + '-wrong', api, f.procRoot), /WSL_FILE_ROUTE_UNVERIFIED/);
  await fs.mkdir(path.join(f.procRoot, '43')); await fs.writeFile(path.join(f.procRoot, '43/comm'), 'agy\n');
  await assert.rejects(readWslProcess(f.executable, api, f.procRoot), /WSL_FILE_ROUTE_UNVERIFIED/);
});

// Match the observed WSL topology; all capabilities and file contents are synthetic.
async function topologyFixture(t, extra) {
  const f = await proofFixture(t), ownerPid = 184101, currentPid = 184372;
  await fs.rename(path.join(f.procRoot, '42'), path.join(f.procRoot, String(currentPid)));
  const writeStat = (pid, parent, start) => fs.writeFile(path.join(f.procRoot, String(pid), 'stat'),
    `${pid} (agy) ${Array.from({ length: 20 }, (_, i) => i === 0 ? 'S' : i === 1 ? String(parent) : i === 19 ? String(start) : '0').join(' ')}\n`);
  await writeStat(currentPid, ownerPid, 3841755);
  await fs.writeFile(f.filename, startup(currentPid), { mode: 0o600 });
  if (extra) {
    const pid = extra === 'orphan' ? 157997 : 194372;
    await fs.mkdir(path.join(f.procRoot, String(pid)));
    await fs.writeFile(path.join(f.procRoot, String(pid), 'comm'), 'agy\n');
    await fs.symlink(f.executable, path.join(f.procRoot, String(pid), 'exe'));
    await writeStat(pid, extra === 'orphan' ? 21094 : 194101, 3206621);
    const args = extra === 'cli' ? ['--task=synthetic'] : ['--hub', '--hub-port=46415', '--csrf_token=synthetic-other-capability', '--app_data_dir=antigravity'];
    await fs.writeFile(path.join(f.procRoot, String(pid), 'cmdline'), [f.executable, ...args, ''].join('\0'));
  }
  return { ...f, ownerPid, currentPid, writeStat,
    dependencies: { process: (exe, current) => readPinnedWslProcess(exe, current, ownerPid, f.procRoot),
      startup: (root, current) => readWslStartup(root, current, f.procRoot) } };
}
for (const extra of [undefined, 'orphan', 'other-window', 'cli']) {
  test(`read-only current Hub proof with ${extra ?? 'no extra process'} preserves exclusive mutation guard`, { skip: process.platform === 'win32' }, async t => {
    const f = await topologyFixture(t, extra);
    const read = createWslReadGuard(f.root, f.executable, () => api, f.dependencies);
    assert.equal(await read(), true);
    const mutate = createWslFileGuard(f.root, f.executable, () => api, async () => (await fs.readdir(f.procRoot)).length, {
      process: (exe, current) => readWslProcess(exe, current, f.procRoot), startup: f.dependencies.startup,
    });
    if (extra) {
      await assert.rejects(mutate(false), /WSL_FILE_ROUTE_UNVERIFIED/);
      await assert.rejects(mutate(true), /WSL_FILE_ROUTE_UNVERIFIED/);
    } else assert.equal(await mutate(false), true);
    assert.equal(await read(), true);
  });
}
test('read-only process proof cannot adopt an orphan, wrong executable, changed capability or duplicate capability', { skip: process.platform === 'win32' }, async t => {
  const f = await topologyFixture(t, 'orphan');
  for (const [exe, current, owner] of [[f.executable + '-wrong', api, f.ownerPid], [f.executable, { ...api, port: 22 }, f.ownerPid],
    [f.executable, { ...api, csrfToken: 'synthetic-wrong' }, f.ownerPid], [f.executable, api, 21094]]) {
    await assert.rejects(readPinnedWslProcess(exe, current, owner, f.procRoot), /WSL_FILE_ROUTE_UNVERIFIED/);
  }
  const command = path.join(f.procRoot, String(f.currentPid), 'cmdline');
  const raw = await fs.readFile(command);
  await fs.appendFile(command, '--hub-port=1234\0');
  await assert.rejects(readPinnedWslProcess(f.executable, api, f.ownerPid, f.procRoot), /WSL_FILE_ROUTE_UNVERIFIED/);
  await fs.writeFile(command, raw);
  await fs.writeFile(path.join(f.procRoot, '157997/cmdline'), raw);
  await assert.rejects(readPinnedWslProcess(f.executable, api, f.ownerPid, f.procRoot), /WSL_FILE_ROUTE_UNVERIFIED/);
  await fs.rm(path.join(f.procRoot, String(f.currentPid)), { recursive: true });
  await assert.rejects(readPinnedWslProcess(f.executable, api, f.ownerPid, f.procRoot), /WSL_FILE_ROUTE_UNVERIFIED/);
});
test('read-only guard pins process lifetime and generation across reads and never permits stopped recovery', async () => {
  for (const change of ['pid', 'start', 'generation', 'stopped', 'route']) {
    let current = api, pid = 42, startTicks = '1', log = startup();
    const guard = createWslReadGuard('/synthetic', '/synthetic/agy', () => current, {
      process: async () => ({ pid, startTicks }), startup: async () => log,
    });
    assert.equal(await guard(), true);
    if (change === 'pid') pid++;
    if (change === 'start') startTicks = '2';
    if (change === 'generation') current = { ...api, csrfToken: 'synthetic-new' };
    if (change === 'stopped') current = undefined;
    if (change === 'route') log = startup(43);
    if (change === 'route') assert.equal(await guard(), false);
    else await assert.rejects(guard(), /WSL_FILE_ROUTE_UNVERIFIED/);
  }
});
test('read-only guard rejects process and generation drift during startup read without leaking capability', async () => {
  for (const change of ['pid', 'start', 'generation', 'read-error']) {
    let current = api, inspections = 0;
    const guard = createWslReadGuard('/synthetic', '/synthetic/agy', () => current, {
      process: async () => ({ pid: ++inspections > 1 && change === 'pid' ? 99 : 42, startTicks: inspections > 1 && change === 'start' ? '2' : '1' }),
      startup: async () => { if (change === 'read-error') throw new Error(api.csrfToken); if (change === 'generation') current = { ...api, port: 1234 }; return startup(); },
    });
    await assert.rejects(guard(), e => e.code === 'WSL_FILE_ROUTE_UNVERIFIED' && !String(e).includes(api.csrfToken));
  }
});
test('proven WSL mutation never constructs keyring, preserves unknown versus absent, and supports file absence', async t => {
  const root = await home(t), calls = [];
  const slots = await createOfficialTokenSlots(root, 'linux', { WSL_DISTRO_NAME: 'synthetic' }, { createKeyring: forbiddenKeyring, fileOnlyGuard: async stopped => { calls.push(stopped); return true; } }, 'mutation');
  assert.deepEqual(await slots.read(), fileScope(null));
  await slots.write(fileScope(raw('A')), fileScope(null)); assert.deepEqual(await slots.read(), fileScope(raw('A')));
  await slots.write(fileScope(null), fileScope(raw('A'))); assert.deepEqual(await slots.read(), fileScope(null));
  assert.ok(calls.length >= 8); assert.ok(calls.includes(false)); assert.ok(calls.includes(true));
  await assert.rejects(slots.write(empty, fileScope(null)), /OFFICIAL_STORAGE_SCOPE_MISMATCH/);
});
test('WSL proof loss blocks mutation and leaves original file and unknown keyring intact', async t => {
  const root = await home(t); let proof = true;
  await fs.writeFile(path.join(root, '.gemini', 'jetski-standalone-oauth-token'), raw('A'), { mode: 0o600 });
  const slots = await createOfficialTokenSlots(root, 'linux', { WSL_DISTRO_NAME: 'synthetic' }, { createKeyring: forbiddenKeyring, fileOnlyGuard: async () => proof }, 'mutation');
  const backup = await slots.read(); proof = false;
  await assert.rejects(slots.write(fileScope(raw('B')), backup), /WSL_FILE_ROUTE_UNVERIFIED/);
  assert.equal(await fs.readFile(path.join(root, '.gemini', 'jetski-standalone-oauth-token'), 'utf8'), raw('A'));
});
test('proven file mode cannot downgrade old native keyring recovery snapshots or invent unavailable absence', async t => {
  const root = await home(t), nativeError = new LiveError('KEYRING_UNAVAILABLE');
  const slots = await createOfficialTokenSlots(root, 'linux', { WSL_DISTRO_NAME: 'synthetic' }, { createKeyring: () => ({ read: async () => { throw nativeError; }, write: async () => { throw nativeError; } }), fileOnlyGuard: async () => true }, 'mutation');
  assert.deepEqual(await slots.read(), fileScope(null));
  await assert.rejects(slots.read(empty), e => e === nativeError);
  await assert.rejects(slots.write(fileA, empty), e => e === nativeError);
});
test('file-scoped login cancellation, reload restore, import switching and history preserve rollback scope', async t => {
  const root = await home(t), filename = path.join(root, '.gemini', 'jetski-standalone-oauth-token'), history = path.join(root, '.gemini', 'history.txt'), data = new Map();
  await fs.writeFile(filename, raw('A'), { mode: 0o600 }); await fs.writeFile(history, 'synthetic-original-history');
  const vault = { get: async k => data.get(k), store: async (k,v) => data.set(k,v), delete: async k => data.delete(k) };
  const create = () => new LiveSwitchService(vault, new EnvironmentTokenSlots(root, 'linux', { WSL_DISTRO_NAME: 'synthetic' }, { createKeyring: forbiddenKeyring, fileOnlyGuard: async () => true }, 'mutation'), 'synthetic-wsl-host');
  let service = create(), stopped = 0, reloads = 0;
  const life = { generation: 'old', stop: async () => { stopped++; }, reload: async () => { reloads++;life.generation='new-'+reloads }, proof: async () => ({ authValid: true, generation: life.generation, email: (await fs.readFile(filename,'utf8'))===raw('A')?'a@example.test':'b@example.test',quotaSource:'server',observedAt:new Date().toISOString(),buckets:[] }) };
  await service.prepareLogin(life); assert.deepEqual((await service.journal()).backup, fileScope(raw('A')));
  await fs.writeFile(filename, raw('B'), { mode: 0o600 }); await service.restore(life);
  assert.equal(await fs.readFile(filename, 'utf8'), raw('A')); assert.deepEqual((await service.journal()).backup, fileScope(raw('A'))); await service.finish();
  await service.prepareLogin(life); await fs.writeFile(filename, raw('B'), { mode: 0o600 });
  const saved = await service.captureLogin({label:'B',expectedEmail:'b@example.test',identitySource:'hub'}); await service.installLogin(saved.id, life);
  service = create(); await service.finishVerified(life);
  assert.equal(await fs.readFile(filename, 'utf8'), raw('A'));
  let index = []; const imported = await service.importAccounts([{ label: 'C', expectedEmail: 'c@example.test', capturedAt: new Date().toISOString(), token: raw('C') }], {read:()=>index,write:async value=>{index=value;}});
  await service.install(imported[0].id, life); assert.equal(await fs.readFile(filename,'utf8'),raw('C')); await service.restore(life);
  assert.equal(await fs.readFile(filename,'utf8'),raw('A')); assert.equal(await fs.readFile(history,'utf8'),'synthetic-original-history'); assert.ok(stopped>=4); assert.ok(reloads>=4);
});
test('journal rejects forged unobserved state with keyring bytes and preserves unknown future scopes', () => {
  const { parseJournal } = require('../out/live-switch');
  const base = {schema:1,id:'synthetic',phase:'prepared',target:{id:'synthetic'},oldGeneration:'old',backup:fileScope(null)};
  assert.equal(parseJournal(JSON.stringify(base)).backup.keyringState,'unobserved');
  for (const backup of [{...fileScope(null),keyring:raw('A')},{keyring:null,file:null,keyringState:'unknown-new-scope'}]) assert.throws(()=>parseJournal(JSON.stringify({...base,backup})),/RECOVERY_RECORD_INVALID/);
});
test('file-scoped recovery can stop a hub whose startup proof disappeared, then restore only its file', async t => {
  const root=await home(t), filename=path.join(root,'.gemini','jetski-standalone-oauth-token'), data=new Map(); let running=true, readable=true;
  await fs.writeFile(filename,raw('A'),{mode:0o600});
  const vault={get:async k=>data.get(k),store:async(k,v)=>data.set(k,v),delete:async k=>data.delete(k)};
  const slots=new EnvironmentTokenSlots(root,'linux',{WSL_DISTRO_NAME:'synthetic'},{createKeyring:forbiddenKeyring,fileOnlyGuard:async allowStopped=>running?readable:allowStopped},'mutation');
  const service=new LiveSwitchService(vault,slots), life={generation:'old',stop:async()=>{running=false},reload:async()=>{},proof:async()=>({authValid:true,generation:'old',email:'a@example.test',quotaSource:'server',observedAt:new Date().toISOString(),buckets:[]})};
  await service.prepareLogin(life); await fs.writeFile(filename,raw('B'),{mode:0o600}); readable=false;
  await service.restore(life); assert.equal(await fs.readFile(filename,'utf8'),raw('A'));assert.equal((await service.journal()).phase,'restored');
});
test('large imported tokens use only proven WSL file scope and do not inherit native keyring size limits', async t => {
  const root=await home(t),data=new Map(),token=JSON.stringify({token:{refresh_token:'synthetic-'+ 'x'.repeat(9000)}});let index=[];
  const vault={get:async k=>data.get(k),store:async(k,v)=>data.set(k,v),delete:async k=>data.delete(k)};
  const slots=new EnvironmentTokenSlots(root,'linux',{WSL_DISTRO_NAME:'synthetic'},{createKeyring:forbiddenKeyring,fileOnlyGuard:async()=>true},'mutation');
  const service=new LiveSwitchService(vault,slots),entries=await service.importAccounts([{label:'large',expectedEmail:'large@example.test',capturedAt:new Date().toISOString(),token}],{read:()=>index,write:async v=>{index=v}});
  await service.install(entries[0].id,{generation:'old',stop:async()=>{},reload:async()=>{},signedOutProof:async()=>({generation:'old',authValid:false})});
  assert.deepEqual(await slots.read(),fileScope(token));
});
test('startup reader rejects in-place edits and inode replacement during the bounded read', {skip:process.platform==='win32'}, async t=>{
  const f=await proofFixture(t), original=fs.open;
  for(const change of ['content','inode']) {
    await fs.writeFile(f.filename,startup(),{mode:0o600});let triggered=false;
    fs.open=async(...args)=>{const handle=await original(...args); if(args[0]!==f.filename)return handle;
      return {stat:()=>handle.stat(),close:()=>handle.close(),read:async(...readArgs)=>{const result=await handle.read(...readArgs);if(!triggered){triggered=true;if(change==='inode'){await fs.rename(f.filename,f.filename+'.old');await fs.writeFile(f.filename,startup(),{mode:0o600});}else await fs.writeFile(f.filename,startup(43),{mode:0o600});}return result;}};};
    try{await assert.rejects(readWslStartup(f.root,{pid:42},f.procRoot),/WSL_FILE_ROUTE_UNVERIFIED/);}finally{fs.open=original;}
  }
});
test('old full-slot journal remains strict even when the new hub is proven file-only',async t=>{
  const root=await home(t),data=new Map();let stopped=0;
  const vault={get:async k=>data.get(k),store:async(k,v)=>data.set(k,v),delete:async k=>data.delete(k)};
  const old={schema:1,id:'synthetic',phase:'installed',oldGeneration:'old',target:{id:'synthetic'},backup:{keyring:raw('original-native'),file:raw('A')}};data.set(JOURNAL_KEY,JSON.stringify(old));
  const slots=new EnvironmentTokenSlots(root,'linux',{WSL_DISTRO_NAME:'synthetic'},{fileOnlyGuard:async()=>true,createKeyring:()=>({read:async()=>{throw new LiveError('KEYRING_UNAVAILABLE')},write:async()=>{throw new Error('must not write')}})},'mutation');
  const service=new LiveSwitchService(vault,slots);
  await assert.rejects(service.restore({generation:'current',stop:async()=>{stopped++},reload:async()=>{}}),/KEYRING_UNAVAILABLE/);
  assert.equal(stopped,0);assert.deepEqual(await service.journal(),old);
});
test('WSL proof checks generation again after the final awaited process count',async()=>{
 let current=api,calls=0;
 const guard=createWslFileGuard('/synthetic','/synthetic/agy',()=>current,async()=>{if(++calls===2)current={...api,csrfToken:'synthetic-drift-during-count'};return 1;},{process:async()=>({pid:42,startTicks:'1'}),startup:async()=>startup()});
 await assert.rejects(guard(false),/WSL_FILE_ROUTE_UNVERIFIED/);
 let stoppedApi,count=0;
 const stopped=createWslFileGuard('/synthetic','/synthetic/agy',()=>stoppedApi,async()=>{if(++count===2)stoppedApi=api;return 0;});
 assert.equal(await stopped(true),false);
});
