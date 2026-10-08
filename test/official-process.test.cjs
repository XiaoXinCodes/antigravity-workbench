const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { inspectWslProcesses, assertWslProcessExclusivity, sameOfficialProcess, waitForOfficialBackendStop } = require('../out/official-process');
const { LiveError } = require('../out/live-storage');
const api = { port: 32123, csrfToken: 'offline-process-capability' }, owner = 701, executable = '/synthetic-official/bin/agy';
const args = (capability = api) => [executable, '--hub', '--app_data_dir=antigravity', `--hub-port=${capability.port}`, `--csrf_token=${capability.csrfToken}`];
async function fixture(t) {
  if (typeof process.getuid !== 'function' || process.platform === 'win32') { t.skip('WSL proc proof is Linux only'); return; }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agm-process-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  async function add(pid, options = {}) {
    const base = path.join(root, String(pid)); await fs.mkdir(base);
    const fields = ['S', String(options.parent ?? owner), ...Array(17).fill('0'), options.birth ?? '123456'];
    await fs.writeFile(path.join(base, 'stat'), `${pid} (agy) ${fields.join(' ')}`);
    await fs.writeFile(path.join(base, 'comm'), 'agy\n');
    await fs.writeFile(path.join(base, 'cmdline'), (options.args ?? args()).join('\0') + '\0');
    await fs.symlink(options.executable ?? executable, path.join(base, 'exe'));
    return base;
  }
  return { root, add, inspect: () => inspectWslProcesses(executable, api, owner, root) };
}
test('owned current Hub is proven without exposing argv, capability or private paths', async t => {
  const f = await fixture(t); if (!f) return;
  await f.add(710); const snapshot = await f.inspect();
  assert.equal(snapshot.current.pid, 710); assert.equal(snapshot.current.taskState, 'unknown');
  assert.doesNotThrow(() => assertWslProcessExclusivity(snapshot, true));
  const text = JSON.stringify(snapshot); for (const value of [api.csrfToken, executable, '--hub', String(api.port)]) assert.ok(!text.includes(value));
});
test('previous host exit leaving live Hub blocks before mutation even with one current window', async t => {
  const f = await fixture(t); if (!f) return;
  await f.add(710); await f.add(711, { parent: 702, birth: '100', args: args({ port: 32124, csrfToken: 'offline-old-capability' }) });
  const snapshot = await f.inspect(); assert.equal(snapshot.current.pid, 710);
  assert.deepEqual(snapshot.processes.find(p => p.pid === 711), { pid: 711, parentPid: 702, startTicks: '100', kind: 'unowned-hub', taskState: 'unknown' });
  assert.throws(() => assertWslProcessExclusivity(snapshot, true), /OFFICIAL_UNOWNED_HUB_TASK_UNKNOWN/);
});
test('another host with the same capability is never adopted or assumed idle', async t => {
  const f = await fixture(t); if (!f) return;
  await f.add(710, { parent: 702 }); const snapshot = await f.inspect();
  assert.equal(snapshot.current, undefined); assert.equal(snapshot.processes[0].taskState, 'unknown');
  assert.throws(() => assertWslProcessExclusivity(snapshot, true), /OFFICIAL_UNOWNED_HUB_TASK_UNKNOWN/);
});
for (const [label, options] of [
  ['different executable', { executable: '/synthetic-other/bin/agy' }],
  ['CLI task', { args: [executable, 'run', 'synthetic-task'] }],
  ['wrong storage', { args: args().map(arg => arg === '--app_data_dir=antigravity' ? '--app_data_dir=other' : arg) }],
  ['duplicate hub flags', { args: [...args(), '--hub'] }],
  ['missing capability', { args: args().filter(arg => !arg.startsWith('--csrf_token=')) }],
  ['duplicate port flags', { args: [...args(), '--hub-port=32124'] }],
]) test(`${label} remains an unverified mutation blocker`, async t => {
  const f = await fixture(t); if (!f) return;
  await f.add(710, options); const snapshot = await f.inspect();
  assert.equal(snapshot.current, undefined);
  assert.throws(() => assertWslProcessExclusivity(snapshot, true), /OFFICIAL_PROCESS_OWNERSHIP_UNVERIFIED/);
});
test('wrong or repeated capability cannot become current Hub', async t => {
  const f = await fixture(t); if (!f) return;
  await f.add(710, { args: [...args(), '--csrf_token=offline-duplicate'] });
  assert.equal((await f.inspect()).current, undefined);
  assert.throws(() => assertWslProcessExclusivity({ processes: [] }, true), /OFFICIAL_HUB_PROCESS_UNVERIFIED/);
});
test('another port cannot prove the current Hub even with matching parent and capability', async t => {
  const f = await fixture(t); if (!f) return;
  await f.add(710, { args: args({ ...api, port: 32124 }) });
  const snapshot = await f.inspect(); assert.equal(snapshot.current, undefined);
  assert.throws(() => assertWslProcessExclusivity(snapshot, true), /OFFICIAL_UNOWNED_HUB_TASK_UNKNOWN/);
});
test('two matching children fail closed rather than selecting the first', async t => {
  const f = await fixture(t); if (!f) return;
  await f.add(710); await f.add(711); await assert.rejects(f.inspect(), /OFFICIAL_HUB_PROCESS_UNVERIFIED/);
});
test('disappeared process is benign while malformed proof fails closed', async t => {
  const f = await fixture(t); if (!f) return;
  const base = await f.add(710); await fs.unlink(path.join(base, 'stat'));
  assert.deepEqual(await f.inspect(), { processes: [] });
  await fs.writeFile(path.join(base, 'stat'), 'not proc stat'); await assert.rejects(f.inspect(), /PROCESS_CHECK_FAILED/);
});
test('process birth changes during reads are rejected', async t => {
  const f = await fixture(t); if (!f) return;
  await f.add(710); const original = fs.readFile; let reads = 0;
  fs.readFile = async (filename, ...rest) => {
    const value = await original(filename, ...rest);
    if (filename.endsWith('/stat') && ++reads === 2) return value.replace('123456', '123457');
    return value;
  };
  t.after(() => { fs.readFile = original; });
  await assert.rejects(f.inspect(), /HUB_CHANGED_DURING_OPERATION/);
});
test('capability changes during reads are rejected without retaining raw arguments', async t => {
  const f = await fixture(t); if (!f) return;
  await f.add(710); const original = fs.readFile; let reads = 0;
  fs.readFile = async (filename, ...rest) => {
    const value = await original(filename, ...rest);
    if (filename.endsWith('/cmdline') && ++reads === 2) return Buffer.from(value.toString().replace(api.csrfToken, 'offline-changed-capability'));
    return value;
  };
  t.after(() => { fs.readFile = original; });
  await assert.rejects(f.inspect(), /HUB_CHANGED_DURING_OPERATION/);
});
test('inaccessible proof fails closed with a fixed error rather than exception text', async t => {
  const f = await fixture(t); if (!f) return;
  await f.add(710); const original = fs.readFile;
  fs.readFile = async (filename, ...rest) => { if (filename.endsWith('/stat')) throw Object.assign(Error('offline-private-error'), { code: 'EACCES' }); return original(filename, ...rest); };
  t.after(() => { fs.readFile = original; });
  await assert.rejects(f.inspect(), error => error.message === 'PROCESS_CHECK_FAILED');
});
test('PID reuse cannot match the pinned process', () => {
  assert.equal(sameOfficialProcess({ pid: 710, startTicks: '123' }, { pid: 710, startTicks: '124' }), false);
  assert.equal(sameOfficialProcess({ pid: 710, startTicks: '123' }, { pid: 711, startTicks: '123' }), false);
});
function clockRuntime(values) {
  let now = 0, probes = 0, checks = 0;
  return { get probes() { return probes; }, get checks() { return checks; }, runtime: {
    timeoutMs: 1000, now: () => now, wait: async ms => { now += ms; },
    assertCurrent: () => { checks++; }, stopped: async () => values[probes++] ?? false,
  } };
}
test('official hook return waits for two stable observations of actual backend exit', async () => {
  const f = clockRuntime([false, false, true, false, true, true]);
  await waitForOfficialBackendStop(f.runtime); assert.equal(f.probes, 6); assert.equal(f.checks, 12);
});
test('a newer Hub detected after an awaited stop probe blocks further work', async () => {
  let changed = false;
  await assert.rejects(waitForOfficialBackendStop({ assertCurrent() { if (changed) throw new LiveError('HUB_CHANGED_DURING_OPERATION'); }, stopped: async () => { changed = true; return true; } }), /HUB_CHANGED_DURING_OPERATION/);
});
test('backend that stays alive reaches bounded stop failure', async () => {
  const f = clockRuntime([]); await assert.rejects(waitForOfficialBackendStop(f.runtime), /OFFICIAL_BACKEND_STOP_TIMEOUT/);
  assert.equal(f.probes, 10);
});
test('hung stop observation also reaches the hard deadline', async () => {
  await assert.rejects(waitForOfficialBackendStop({ timeoutMs: 15, assertCurrent() {}, stopped: () => new Promise(() => {}) }), /OFFICIAL_BACKEND_STOP_TIMEOUT/);
});
