const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');

// Actual lifecycle/deactivator/restart implementation with synthetic VS Code,
// process births and RPC. No official module, executable or account is used.
let fixtureId = 0;
const linuxFixtureTests = new WeakSet();
function fixture(t, options = {}) {
  // Exercise the synthetic Linux-host model on every CI OS, without /proc reads.
  if (!linuxFixtureTests.has(t)) {
    linuxFixtureTests.add(t);
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    t.after(() => Object.defineProperty(process, 'platform', platform));
  }
  const events = [], config = { autoRecover: options.autoRecover ?? false };
  let serial = 1, current = { pid: 700001, startTicks: '101', parentPid: process.pid }, port = 34567;
  let respawns = options.respawns ?? 0, duringProof, inspectHook, pinnedHook;
  let fileRoute = true, routeReads = 0, requiresRoute = true;
  const api = { get port() { return current ? port : undefined; }, csrfToken: `synthetic-capability-${++fixtureId}` };
  const uri = value => ({ scheme: 'file', authority: '', fsPath: value, toString: () => `file://${value}` });
  const official = { id: 'google.google-antigravity', extensionKind: 2, extensionPath: '/synthetic-lifecycle-official',
    extensionUri: uri('/synthetic-lifecycle-official'), packageJSON: { version: options.version ?? '1.9.0', main: './extension.js' },
    isActive: true, exports: api };
  const context = { extension: { extensionKind: 2 }, extensionUri: uri('/synthetic-workbench'), globalStorageUri: uri('/synthetic-storage'), subscriptions: [] };
  const spawn = (samePort = false, parentPid = process.pid) => {
    serial++; current = { pid: 700000 + serial, startTicks: String(100 + serial), parentPid };
    if (!samePort) port++;
    events.push(`spawn:${current.pid}`);
  };
  const vscode = { UIKind: { Desktop: 1 }, ExtensionKind: { UI: 1, Workspace: 2 }, env: { uiKind: 1, remoteName: 'wsl' },
    workspace: { isTrusted: true, getConfiguration: () => ({ get: (key, fallback) => config[key] ?? fallback }) },
    extensions: { getExtension: id => id === official.id ? official : undefined },
    commands: { getCommands: async () => ['antigravity.reconnect', 'antigravity.panel.focus'], executeCommand: async command => {
      events.push(command); if (command === 'antigravity.reconnect' && !options.noSpawn) spawn();
    } },
  };
  const originalLoad = Module._load, entry = require.resolve('../out/live-ui');
  let resolveOfficialLifecycle, resolveOwnComponent;
  Module._load = function(name, ...args) { return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args); };
  try { delete require.cache[entry]; ({ resolveOfficialLifecycle, resolveOwnComponent } = require(entry)); }
  finally { Module._load = originalLoad; }
  const restore = [];
  const replace = (object, key, value) => { const old = object[key]; object[key] = value; restore.push(() => { object[key] = old; }); };
  if (options.shortRestart) {
    const restart = require('../out/official-restart'), actual = restart.restartOfficialComponent;
    replace(restart, 'restartOfficialComponent', (previous, runtime) => actual(previous, { ...runtime, timeoutMs: 10 }));
  }
  const contract = require('../out/official-contract'), environment = require('../out/live-environment');
  const storage = require('../out/live-storage'), processes = require('../out/official-process');
  const lock = require('../out/live-lock'), hub = require('../out/live-hub');
  replace(contract, 'assertOfficialEntrypoint', async () => {});
  replace(contract, 'assertOfficialWriteContract', async () => '1.9.0');
  replace(environment, 'resolveOfficialStorageMode', async () => options.own ? 'wsl-file' : 'native-keyring');
  if (options.own) {
    const wslProof = require('../out/live-wsl-proof');
    replace(environment, 'assertWslBackendExecutable', async () => {});
    replace(wslProof, 'readPinnedWslProcess', async () => {
      assert.ok(current); const row = { ...current };
      if (pinnedHook && pinnedHook.skip-- === 0) {
        const callback = pinnedHook.callback; pinnedHook = undefined;
        await Promise.resolve(); callback();
      }
      return row;
    });
    replace(wslProof, 'createWslReadGuard', () => async () => { routeReads++; return fileRoute; });
  }
  replace(storage, 'runPrivate', async () => ({ code: 0, stdout: 'agy version 1.4.5', stderr: '' }));
  const executable = path.join(os.homedir(), '.gemini', 'bin', 'agy');
  const stat = fs.stat, access = fs.access;
  replace(fs, 'stat', async (file, ...args) => file === executable ? { isFile: () => true } : stat(file, ...args));
  replace(fs, 'access', async (file, ...args) => file === executable ? undefined : access(file, ...args));
  replace(processes, 'inspectWslProcesses', async (_executable, capability) => {
    if (!current) return { processes: [] };
    const matches = capability?.port === port && capability?.csrfToken === api.csrfToken;
    const row = { ...current, kind: matches ? 'current-hub' : 'unowned-hub', taskState: 'unknown' };
    if (inspectHook && inspectHook.skip-- === 0) {
      const callback = inspectHook.callback; inspectHook = undefined;
      await Promise.resolve(); callback();
    }
    return { processes: [row], ...(matches ? { current: row } : {}) };
  });
  replace(lock, 'probeProcessIdentity', async pid => {
    if (options.own && pid === process.pid) return { state: 'alive', startIdentity: 'linux:synthetic-boot:99' };
    if (current?.pid === pid) return { state: 'alive', startIdentity: `linux:synthetic-boot:${current.startTicks}` };
    events.push(`exit-observed:${pid}`); return { state: 'dead' };
  });
  replace(hub, 'queryFreshIdentity', async capability => {
    const generation = hub.generation(capability);
    if (duringProof) { const callback = duringProof; duringProof = undefined; callback(); }
    return { generation, email: 'synthetic@example.test', authValid: true, quotaSource: 'server', observedAt: new Date().toISOString(), buckets: [] };
  });
  const main = path.join(official.extensionPath, 'extension.js'), oldModule = require.cache[main];
  require.cache[main] = { loaded: true, exports: { deactivate: async () => {
    assert.ok(current, 'stop is not dispatched against an invented Hub');
    events.push(`stop:${current.pid}`); current = undefined;
    if (respawns > 0) { respawns--; spawn(); }
  } } };
  const oldOverride = process.env.ANTIGRAVITY_DISABLE_AUTO_RECOVER;
  delete process.env.ANTIGRAVITY_DISABLE_AUTO_RECOVER;
  t.after(() => {
    restore.reverse().forEach(fn => fn());
    if (oldModule) require.cache[main] = oldModule; else delete require.cache[main];
    if (oldOverride === undefined) delete process.env.ANTIGRAVITY_DISABLE_AUTO_RECOVER; else process.env.ANTIGRAVITY_DISABLE_AUTO_RECOVER = oldOverride;
    delete require.cache[entry];
  });
  return { events, config, spawn, current: () => current, duringProof: callback => { duringProof = callback; },
    duringInspect: (callback, skip = 0) => { inspectHook = { callback, skip }; },
    changePort: () => { port++; },
    setFileRoute: value => { fileRoute = value; }, routeReads: () => routeReads,
    requireRoute: value => { requiresRoute = value; },
    duringPinned: (callback, skip = 0) => { pinnedHook = { callback, skip }; },
    resolveOwn: (recovering = false) => resolveOwnComponent(context, async () => {}, recovering, async () => requiresRoute),
    resolve: () => resolveOfficialLifecycle(context) };
}

const linux = {}; // Synthetic Linux model; no native OS eligibility restriction.
test('already-active default-disabled 1.9 uses real component stop/reconnect/fresh proof without history', linux, async t => {
  const f = fixture(t), backend = await f.resolve();
  await backend.assertCredentialWriteSafe(); await backend.stop(); await backend.assertCredentialWriteSafe();
  assert.equal(f.current(), undefined);
  await backend.reload(); const proof = await backend.proof();
  assert.equal(proof.email, 'synthetic@example.test');
  assert.ok(f.events.includes('antigravity.reconnect')); assert.ok(f.events.includes('antigravity.panel.focus'));
  assert.equal(f.events.filter(e => e.startsWith('stop:')).length, 1);
});
test('late owned replacement is retried only after old birth exit is observed', linux, async t => {
  const f = fixture(t, { respawns: 1 }), backend = await f.resolve();
  await backend.assertCredentialWriteSafe(); await backend.stop();
  assert.equal(f.current(), undefined);
  assert.ok(f.events.indexOf('exit-observed:700001') < f.events.indexOf('stop:700002'));
  assert.equal(f.events.filter(e => e.startsWith('stop:')).length, 2);
});
test('repeated respawn exhausts three stop attempts without silently accepting a running Hub', linux, async t => {
  const f = fixture(t, { respawns: 9 }), backend = await f.resolve();
  await backend.assertCredentialWriteSafe();
  await assert.rejects(backend.stop(), /OFFICIAL_BACKEND_RESTARTING/);
  assert.equal(f.events.filter(e => e.startsWith('stop:')).length, 3); assert.ok(f.current());
});
test('late own spawn before write is stopped and retry budget is shared across checkpoints', linux, async t => {
  const f = fixture(t), backend = await f.resolve();
  await backend.assertCredentialWriteSafe(); await backend.stop();
  f.spawn(); await backend.assertCredentialWriteSafe(); assert.equal(f.current(), undefined);
  f.spawn(); await backend.assertCredentialWriteSafe(); assert.equal(f.current(), undefined);
  f.spawn(); await assert.rejects(backend.assertCredentialWriteSafe(), /OFFICIAL_BACKEND_RESTARTING/);
  assert.equal(f.events.filter(e => e.startsWith('stop:')).length, 3);
});
test('fresh identity cannot approve same-port replacement with a different process birth', linux, async t => {
  const f = fixture(t), backend = await f.resolve();
  await backend.assertCredentialWriteSafe(); await backend.stop(); await backend.reload();
  f.duringProof(() => f.spawn(true));
  await assert.rejects(backend.proof(), /HUB_CHANGED_DURING_QUERY/);
});
test('a replacement exported under a different parent is not adopted or stopped', linux, async t => {
  const f = fixture(t), backend = await f.resolve();
  await backend.assertCredentialWriteSafe(); await backend.stop();
  f.spawn(false, process.pid + 10000);
  await assert.rejects(backend.assertCredentialWriteSafe(), /OFFICIAL_PROCESS_OWNERSHIP_UNVERIFIED/);
  assert.equal(f.events.filter(e => e.startsWith('stop:')).length, 1);
});
for (const skip of [0, 1]) test(`dynamic exports changing during ${skip ? 'last pre-stop' : 'initial stop'} scan never dispatch deactivate`, linux, async t => {
  const f = fixture(t), backend = await f.resolve();
  await backend.assertCredentialWriteSafe();
  // Keep the same exports object and process birth. Only its dynamic port getter
  // changes while inspection is awaiting, exposing same-object comparisons.
  f.duringInspect(f.changePort, skip);
  await assert.rejects(backend.stop(), skip ? /HUB_CHANGED_DURING_OPERATION/ : /OFFICIAL_HUB_PROCESS_UNVERIFIED/);
  assert.equal(f.events.filter(e => e.startsWith('stop:')).length, 0);
  assert.ok(f.current());
});

test('same runtime lifecycle accepts a changed release string through stop and fresh proof', linux, async t=>{
 const f=fixture(t,{version:'99.12.0-preview'});
 const lifecycle=await f.resolve();await lifecycle.assertCredentialWriteSafe();await lifecycle.stop();await lifecycle.assertCredentialWriteSafe();await lifecycle.reload();
 assert.equal((await lifecycle.proof()).email,'synthetic@example.test');
});


test('own component caches positive route only for the same birth and generation despite shared log overwrite', linux, async t => {
  const f = fixture(t, { own: true }), actor = await f.resolveOwn();
  await actor.prepare(); assert.equal(f.routeReads(), 1);
  f.setFileRoute(false);
  assert.equal((await actor.proof()).email, 'synthetic@example.test');
  await actor.describe(); await actor.stop();
  assert.equal(f.routeReads(), 1);
  assert.equal(f.events.filter(e => e.startsWith('stop:')).length, 1);
});

test('own component replacement birth cannot inherit a cached file-route proof', linux, async t => {
  const f = fixture(t, { own: true }), actor = await f.resolveOwn();
  await actor.prepare(); f.setFileRoute(false); f.spawn(true);
  await assert.rejects(actor.proof(), /WSL_FILE_ROUTE_UNVERIFIED/);
  assert.equal(f.routeReads(), 2);
  assert.equal(f.events.filter(e => e.startsWith('stop:')).length, 0);
});

test('peer readiness without a route proof cannot authorize later coordinator takeover', linux, async t => {
  const f = fixture(t, { own: true }); f.requireRoute(false); f.setFileRoute(false);
  const actor = await f.resolveOwn(); await actor.prepare();
  assert.equal(f.routeReads(), 0);
  f.requireRoute(true);
  await assert.rejects(actor.proof(), /WSL_FILE_ROUTE_UNVERIFIED/);
  assert.equal(f.routeReads(), 1);
  assert.equal(f.events.filter(e => e.startsWith('stop:')).length, 0);
});

for (const change of ['generation', 'birth']) test(`own component rechecks ${change} after awaiting own process count`, linux, async t => {
  const f = fixture(t, { own: true }), actor = await f.resolveOwn(); await actor.prepare();
  f.duringInspect(change === 'generation' ? f.changePort : () => f.spawn(true));
  await assert.rejects(actor.stop(), /HUB_CHANGED_DURING_OPERATION/);
  assert.equal(f.events.filter(e => e.startsWith('stop:')).length, 0);
});

for (const change of ['generation', 'birth']) test(`own component rechecks ${change} at final asynchronous pre-stop pin`, linux, async t => {
  const f = fixture(t, { own: true }), actor = await f.resolveOwn(); await actor.prepare();
  // The first pin belongs to assertReady; the second is immediately before deactivate.
  f.duringPinned(change === 'generation' ? f.changePort : () => f.spawn(true), 1);
  await assert.rejects(actor.stop(), /HUB_CHANGED_DURING_OPERATION/);
  assert.equal(f.events.filter(e => e.startsWith('stop:')).length, 0);
});

for (const moment of ['before prepare', 'after prepare', 'during final pin']) test(`own component rejects image activity ${moment} without stopping`, linux, async t => {
  const f = fixture(t, { own: true }), actor = await f.resolveOwn();
  const { enterImageOperation } = require('../out/image-activity');
  const start = () => { const release = enterImageOperation('synthetic-lifecycle-image'); t.after(release); };
  if (moment !== 'before prepare') await actor.prepare();
  if (moment === 'during final pin') f.duringPinned(start, 1); else start();
  await assert.rejects(moment === 'before prepare' ? actor.prepare() : actor.stop(), /ACCOUNT_SWITCH_IMAGE_RUNNING/);
  assert.equal(f.events.filter(e => e.startsWith('stop:')).length, 0);
});

test('adapter recreation observes the same pending setup instead of refreshing again',linux,async t=>{
 const options={own:true,noSpawn:true,shortRestart:true},f=fixture(t,options);
 const first=await f.resolveOwn();await first.prepare();await first.stop();
 await assert.rejects(first.reload(),{code:'OFFICIAL_COMPONENT_RESTART_TIMEOUT'});
 assert.equal(f.events.filter(e=>e==='antigravity.reconnect').length,1);
 await assert.rejects(f.resolveOwn(true),{code:'OFFICIAL_COMPONENT_RESTART_TIMEOUT'});
 assert.equal(f.events.filter(e=>e==='antigravity.reconnect').length,1);
 // A late ready result is observed, never fabricated by the command mock.
 f.spawn();const next=await f.resolveOwn(true);await next.prepare();
 options.noSpawn=false;await next.stop();await next.reload();
 assert.equal(f.events.filter(e=>e==='antigravity.reconnect').length,2);
});

test('proved A survives B shared-log overwrite across adapter recreation, not across generation change',linux,async t=>{
 const f=fixture(t,{own:true});const first=await f.resolveOwn();await first.prepare();assert.equal(f.routeReads(),1);
 f.setFileRoute(false);const recreated=await f.resolveOwn();await recreated.prepare();assert.equal(f.routeReads(),1);assert.equal((await recreated.proof()).email,'synthetic@example.test');
 f.changePort();const changed=await f.resolveOwn();await assert.rejects(changed.prepare(),/WSL_FILE_ROUTE_UNVERIFIED/);assert.equal(f.routeReads(),2);assert.ok(!f.events.some(e=>e.startsWith('stop:')));
});
test('adapter recreation cannot transfer proved A to a replacement birth with reused capability',linux,async t=>{
 const f=fixture(t,{own:true});await (await f.resolveOwn()).prepare();f.setFileRoute(false);f.spawn(true);await assert.rejects((await f.resolveOwn()).prepare(),/WSL_FILE_ROUTE_UNVERIFIED/);assert.equal(f.routeReads(),2);assert.ok(!f.events.some(e=>e.startsWith('stop:')));
});
