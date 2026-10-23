const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { LiveLocks } = require('../out/live-lock');
const { LiveSwitchService } = require('../out/live-switch');
const { LiveError } = require('../out/live-storage');
const uri = value => ({ scheme: 'file', authority: '', query: '', fragment: '', fsPath: value, toString: () => `file://${value}` });
const token = name => JSON.stringify({ token: { access_token: `synthetic-${name}`, refresh_token: `synthetic-refresh-${name}`, token_type: 'Bearer' }, auth_method: 'oauth' });
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'component-ui-'));
  const data = new Map(), state = new Map(), commands = new Map(), events = [], subscriptions = [];
  let current = { keyring: null, file: token('b'), keyringState: 'unobserved' }, generation = 'initial', sequence = 0;
  const hosts = [1, 2, 3].map(pid => ({ pid, startIdentity: `host-${pid}` }));
  const hubs = new Map(hosts.map(host => [host.pid, { pid: host.pid + 10, startIdentity: `hub-${host.pid}` }]));
  const vault = { get: async key => data.get(key), store: async (key, value) => { data.set(key, value); }, delete: async key => { data.delete(key); } };
  const slots = { read: async () => structuredClone(current), write: async (next, expected) => {
    assert.equal(hubs.size, 0); assert.deepEqual(current, expected); events.push('credential-write'); current = structuredClone(next);
  } };
  const service = new LiveSwitchService(vault, slots);
  const account = await service.capture({ label: 'B', expectedEmail: 'b@example.test', identitySource: 'user' });
  current = { ...current, file: token('a') }; state.set('live-switch.accounts.v1', [account]);
  const locks = new LiveLocks(root, 'a'.repeat(64));
  const proof = async () => {
    if (!hubs.has(1) || options.rpcFailure && events.includes('credential-write')) throw new LiveError('HUB_RPC_FAILED');
    events.push('fresh-proof');
    return { email: current.file === token('a') ? 'a@example.test' : 'b@example.test', generation, authValid: true, quotaSource: 'server', observedAt: new Date().toISOString(), buckets: [] };
  };
  const local = { get generation() { return generation; }, proof, stop: async () => {}, reload: async () => {} };
  const components = { host: hosts[0], local: () => local, readFileRoute: async () => hubs.has(1), readCurrent: slots.read,
    census: async () => ({ complete: true, unknown: false, hosts, hubs: [...hubs.values()] }),
    mailbox: { hasRestoration: async () => hubs.size < hosts.length, restoreCompleted: async () => {
      if ((await locks.inspectRecovery()).state !== 'absent') throw new LiveError('RECOVERY_CHANGED');
      for (const host of hosts) if (!hubs.has(host.pid)) {
        if (options.resumeFailure === host.pid) throw new LiveError('COMPONENT_ACTION_PENDING');
        hubs.set(host.pid, { pid: host.pid + 200, startIdentity: 'committed-restore' });
      }
    }, participant: host => ({ host,
      prepare: async () => {
        events.push(`prepare:${host.pid}`);
        if (options.unsupported === host.pid) throw new LiveError('COMPONENT_CONTRACT_UNSUPPORTED');
        return { host, hub: hubs.get(host.pid) ?? { pid: host.pid + 10, startIdentity: `hub-${host.pid}` }, contract: '1.8.0', ...(!hubs.has(host.pid) ? { stopped: true } : {}) };
      },
      stop: async () => { events.push(`stop:${host.pid}`); hubs.delete(host.pid); if (options.stopFailure === host.pid) throw new LiveError('OFFICIAL_BACKEND_STOP_TIMEOUT'); },
      resume: async () => { events.push(`resume:${host.pid}`); if (options.resumeFailure === host.pid) throw new LiveError('COMPONENT_ACTION_PENDING'); if (host.pid === 1) generation = `restart-${++sequence}`; hubs.set(host.pid, { pid: host.pid + 100 + sequence, startIdentity: generation }); },
      release: async () => {},
    }) },
  };
  const official = { id: 'google.google-antigravity', extensionKind: 1, extensionUri: uri('/synthetic-official'), extensionPath: '/synthetic-official', packageJSON: { version: options.version ?? '1.8.0', main: './extension.js' }, isActive: true, exports: { port: 34567, csrfToken: 'synthetic-capability' } };
  const vscode = {
    UIKind: { Desktop: 1 }, ExtensionKind: { UI: 1, Workspace: 2 }, ProgressLocation: { Notification: 1 }, Uri: { file: uri },
    env: { uiKind: 1 }, extensions: { getExtension: () => official },
    workspace: { isTrusted: true, getConfiguration: () => ({ get: () => undefined }) },
    commands: { registerCommand: (name, fn) => { commands.set(name, fn); return { dispose() {} }; }, executeCommand: async name => { events.push(name); }, getCommands: async () => [] },
    window: { onDidChangeWindowState: () => ({ dispose() {} }),
      showWarningMessage: async (_message, _options, ...choices) => { events.push('confirmation'); if (options.confirmWait) await options.confirmWait; return options.cancel ? undefined : choices[options.choice ?? 0]; },
      showInformationMessage: async () => {}, showQuickPick: async choices => choices[0],
      showInputBox: async () => { throw Error('Normal flow must not request a password'); },
    },
  };
  const original = Module._load, entry = require.resolve('../out/live-ui');
  Module._load = function(name, ...args) { if(name==='./offline-ui'&&options.version==='1.9.0')return{registerOfflineUi:(_context,dependencies)=>({getStatus:()=>undefined,prepareAutomatic:async id=>{assert.equal(id,account.id);events.push('automatic-offline-prepare');if(options.offlineFailure){dependencies.stage(options.failureStage??'census');throw new LiveError(options.offlineFailure);}return true;}})};return name === 'vscode' ? vscode : original.call(this, name, ...args); };
  let register; try { delete require.cache[entry]; register = require(entry).registerLiveUi; } finally { Module._load = original; }
  const context = { extension: { extensionKind: 1 }, extensionUri: uri(root), globalStorageUri: uri(root), secrets: vault, subscriptions,
    globalState: { get: (key, fallback) => state.has(key) ? state.get(key) : fallback, update: async (key, value) => { state.set(key, value); } } };
  const createController = () => register(context, { storageMode: 'wsl-file', service, locks, components, currentIdentity: async () => undefined,
    processRecovery: { scan: async () => ({ phase: 'clear', processes: [], currentCount: 1, totalCount: 3, canContinue: false }), end: async () => { throw Error('Must not kill peers'); }, invalidate() {} } });
  let controller = createController();
  t.after(async () => { subscriptions.forEach(item => item.dispose()); await fs.rm(root, { recursive: true, force: true }); });
  await controller.refresh();
  return { get controller() { return controller; }, events, account, service, hubs, options, data, locks, state,
    restartUi: async () => { subscriptions.splice(0).forEach(item => item.dispose()); controller = createController(); await controller.refresh(); },
    setCurrent: name => { current = { ...current, file: token(name) }; }, call: name => commands.get(`antigravityAccounts.live.${name}`)(name === 'switch' ? account.id : undefined) };
}
test('default WSL switch uses one confirmation and automatic components, never offline UI', async t => {
  const f = await fixture(t); await f.call('switch');
  assert.equal(f.events.filter(value => value === 'confirmation').length, 1);
  assert.equal(f.events.filter(value => value === 'credential-write').length, 1);
  assert.ok(!f.events.some(value => value.includes('offline') || value.includes('reloadWindow')));
  assert.equal(f.hubs.size, 3); assert.equal(await f.service.journal(), null);
  assert.equal(f.controller.getState().activeEmail, 'b@example.test');
});
test('cancel interrupts no component and writes no credentials', async t => {
  const f = await fixture(t, { cancel: true }); await f.call('switch');
  assert.ok(!f.events.some(value => value.startsWith('stop:') || value === 'credential-write')); assert.equal(f.hubs.size, 3);
});
test('unsupported participant fails before any stop or credential write', async t => {
  const f = await fixture(t, { unsupported: 2 }); await f.call('switch');
  assert.ok(!f.events.some(value => value.startsWith('stop:') || value === 'credential-write')); assert.equal(f.hubs.size, 3);
});
test('partial stop failure restores affected components without writing', async t => {
  const f = await fixture(t, { stopFailure: 2 }); await f.call('switch');
  assert.ok(!f.events.includes('credential-write')); assert.equal(f.hubs.size, 3); assert.equal(await f.service.journal(), null);
});
test('repeated switch click during confirmation cannot begin a second operation', async t => {
  let release; const confirmWait = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { confirmWait }); const first = f.call('switch');
  for(let i=0;!f.events.includes('confirmation')&&i<200;i++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.ok(f.events.includes('confirmation'), f.controller.getState().error);
  await f.call('switch'); release(); await first;
  assert.equal(f.events.filter(value => value === 'confirmation').length, 1); assert.equal(f.events.filter(value => value === 'credential-write').length, 1);
});
test('pre-write failed restoration can be retried in the same window without deleting a live marker', async t => {
  const f = await fixture(t, { stopFailure: 2, resumeFailure: 1 }); await f.call('switch');
  assert.ok(!f.events.includes('credential-write')); assert.equal((await f.locks.inspectRecovery()).state, 'active');
  assert.equal(f.controller.getState().recoveryPhase, 'cleanup'); assert.equal(f.controller.getState().pending, true);
  f.options.resumeFailure = undefined; f.options.stopFailure = undefined;
  await f.call('verify');
  assert.equal(f.hubs.size, 3); assert.equal((await f.locks.inspectRecovery()).state, 'absent');
  assert.equal(f.controller.getState().recoveryPhase, 'none');
  assert.ok(!f.events.includes('credential-write'));
});
test('verification recovery restarts an adopted stopped verifier and completes the journal', async t => {
  const f = await fixture(t, { rpcFailure: true }); await f.call('switch');
  assert.ok(await f.service.journal()); f.options.rpcFailure = false;
  await f.call('verify');
  assert.equal(await f.service.journal(), null); assert.equal(f.hubs.size, 3);
  assert.equal(f.controller.getState().activeEmail, 'a@example.test');
});
test('explicit keep-current recovery preserves unknown credentials and the original encrypted backup', async t => {
  const f = await fixture(t, { rpcFailure: true }); await f.call('switch');
  const journal = await f.service.journal(); assert.ok(journal);
  f.setCurrent('external'); f.options.rpcFailure = false; f.options.choice = 2;
  const writes = f.events.filter(value => value === 'credential-write').length;
  await f.call('verify');
  assert.equal(await f.service.journal(), null); assert.equal(f.hubs.size, 3);
  assert.equal(f.events.filter(value => value === 'credential-write').length, writes);
  assert.ok([...f.data.keys()].some(key => key.endsWith(`.retained.${journal.id}`)));
});
test('committed switch with failed peer restoration retries without recreating recovery marker or writing again', async t => {
  const f = await fixture(t, { resumeFailure: 2 }); await f.call('switch');
  assert.equal(await f.service.journal(), null); assert.equal((await f.locks.inspectRecovery()).state, 'absent');
  assert.equal(f.hubs.has(2), false);
  assert.equal(f.controller.getState().recoveryPhase, 'cleanup'); assert.equal(f.controller.getState().pending, true);
  f.options.resumeFailure = undefined; await f.call('verify');
  assert.equal(f.hubs.size, 3); assert.equal((await f.locks.inspectRecovery()).state, 'absent');
  assert.equal(f.events.filter(value => value === 'credential-write').length, 1);
});
test('recreated UI discovers persistent component restoration and exposes retry without an in-memory abort', async t => {
  const f = await fixture(t, { resumeFailure: 2 }); await f.call('switch');
  await f.restartUi();
  assert.equal(f.controller.getState().componentRestoration, true);
  assert.equal(f.controller.getState().recoveryPhase, 'cleanup');
  f.options.resumeFailure = undefined; await f.call('verify');
  assert.equal(f.controller.getState().recoveryPhase, 'none'); assert.equal(f.hubs.size, 3);
  assert.equal(f.events.filter(value => value === 'credential-write').length, 1);
});

test('official 1.9 normal switch dispatches to automatic offline preparation, never 1.8 stop hooks',async t=>{const f=await fixture(t,{version:'1.9.0'});await f.call('switch');assert.equal(f.events.filter(e=>e==='automatic-offline-prepare').length,1);assert.ok(!f.events.some(e=>e.startsWith('stop:')||e==='credential-write'));assert.equal(f.hubs.size,3);});

test('1.9 preflight failure retains bounded cause and stage without claiming a successful switch',async t=>{const f=await fixture(t,{version:'1.9.0',offlineFailure:'OFFLINE_CENSUS_UNVERIFIED'});await f.call('switch');const failure=f.state.get('live-switch.lastFailure.v1');assert.equal(failure.code,'OFFLINE_CENSUS_UNVERIFIED');assert.equal(failure.stage,'census');assert.match(f.controller.getState().error,/准备切换失败/);assert.doesNotMatch(f.controller.getState().error,/UNCLASSIFIED_ERROR|OFFLINE_CENSUS/);assert.ok(!f.events.includes('credential-write'));assert.equal(f.hubs.size,3);});
