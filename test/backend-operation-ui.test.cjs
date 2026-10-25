const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const fs = require('node:fs');
const output = path.resolve(process.env.BACKEND_UI_MODULE_ROOT || path.join(__dirname, '../out'));
const load = name => require(path.join(output, name));
const INDEX = 'live-switch.accounts.v1';
const ACCOUNT_A = '00000000-0000-4000-8000-000000000001';
const ACCOUNT_B = '00000000-0000-4000-8000-000000000002';
const HOST = 'a'.repeat(64);
const trace = [];
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function waitForStart(promise) { let timer; try { await Promise.race([promise, new Promise((_, reject) => { timer=setTimeout(()=>reject(new Error('The synthetic batch termination did not start')),2000); })]); } finally { clearTimeout(timer); } }
const fileUri = value => ({ scheme: 'file', authority: '', query: '', fragment: '', fsPath: value, toString: () => `file://${value}` });
const detached = (pid, id = `selection-${pid}`) => ({ id, pid, parentPid: 1, startedAt: '2026-10-09T04:00:00Z', owner: 'detached', parentState: 'gone', taskState: 'unknown', canEnd: true, scope: 'detached', credentialScopeVerified: true });

/** VS Code APIs, Hub responses and account tokens are synthetic. The account
 * transaction and UI command implementation are the production modules. */
function fixture(t, options = {}) {
  // WSL cases model a Linux extension host, even when this suite runs on macOS.
  // All lifecycle, storage and process dependencies below are synthetic.
  if (options.wsl) {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    t.after(() => Object.defineProperty(process, 'platform', platform));
  }
  const { LiveError } = load('live-storage');
  const { LiveSwitchService, ACCOUNT_PREFIX } = load('live-switch');
  const events = [], warnings = [], notifications = [], commands = new Map(), state = new Map(), data = new Map();
  const ui = { config: {}, consent: true, inputs: ['synthetic-password-long', 'synthetic-password-long'], open: undefined, folder: [fileUri('/synthetic-export')], filename: 'accounts.agwenc' };
  let rows = options.rows || [], running = true, serial = 0, currentEmail = 'a@example.test', currentSlots;
  let generation = 'synthetic-generation-0';
  const token = email => JSON.stringify({ token: { refresh_token: `synthetic-refresh-${email}`, access_token: `synthetic-access-${email}`, expiry: '2099-01-01T00:00:00Z', token_type: 'Bearer' }, id_token: `e30.${Buffer.from(JSON.stringify({email})).toString('base64url')}.synthetic` });
  currentSlots = { keyring: token(currentEmail), file: token(currentEmail) };
  const record = (event, detail) => { const entry = { step: events.length, event, ...(detail === undefined ? {} : {detail}) }; events.push(entry); return entry; };
  const proof = () => ({ email: currentEmail, generation, authValid: true, observedAt: new Date().toISOString(), quotaSource: 'server', buckets: [] });
  const official = { id: 'google.google-antigravity', extensionKind: options.wsl ? 2 : 1, extensionUri: fileUri('/synthetic-official-extension'), extensionPath: '/synthetic-official-extension', packageJSON: { version: options.officialVersion || '1.6.0', main: './extension.js' }, isActive: true, exports: { port: 34567, csrfToken: 'synthetic-official-csrf' } };
  const vscode = {
    UIKind: { Desktop: 1 }, ExtensionKind: { UI: 1, Workspace: 2 }, ProgressLocation: { Notification: 1 }, Uri: { file: fileUri },
    env: { uiKind: 1, ...(options.wsl ? {remoteName:'wsl'} : {}) }, extensions: { getExtension: id => id === official.id ? official : undefined },
    workspace: { isTrusted: true, getConfiguration: () => ({ get: key => ui.config[key] }) },
    commands: { registerCommand: (name, fn) => { commands.set(name, fn); return { dispose() {} }; }, getCommands: async () => ui.commandList || [], executeCommand: async name => { record('command', name); return ui.execute?.(name); } },
    window: {
      onDidChangeWindowState: () => ({ dispose() {} }),
      async showWarningMessage(message, options, action) { warnings.push({message, options, action}); record('confirmation', {message, action}); if (ui.warning) return ui.warning(message, action); return ui.consent ? action : undefined; },
      async showInformationMessage(message) { notifications.push(message); },
      async showQuickPick(choices, options) { record('pick'); return options?.canPickMany ? choices : choices[0]; },
      async showOpenDialog(options) { record('open-dialog'); return options.canSelectFolders ? ui.folder : ui.open; },
      async showInputBox(options) { record(options.password ? 'password' : 'filename'); return options.password ? ui.inputs.shift() : ui.filename; },
      async withProgress(_options, fn) { return fn({}, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }); }
    }
  };
  const codec = {
    async prepareMigrationExport(filename) { record('prepare-export'); return { filename, exists: false }; },
    async encryptAccountArchive(accounts) { assert.equal(accounts.length, 2); record('encrypt'); return Buffer.from('synthetic ciphertext'); },
    async writeMigrationArchive() { record('write-export'); }
  };
  const entry = path.join(output, 'live-ui.js'), originalLoad = Module._load;
  Module._load = function(name, ...args) {
    if(options.forbidWindowPath && name === './offline-ui') return {registerOfflineUi:()=>({getStatus:()=>undefined,getHistory:()=>undefined,prepareAutomatic:async()=>{record('forbidden-offline-prepare');throw Error('OFFLINE_PATH_FORBIDDEN');}})};
    if(options.forbidWindowPath && ['automatic-window-entry','window-runtime-channel','window-group-reopen','wsl-window-launcher'].some(part=>name.endsWith('/'+part))) throw Error('WINDOW_PATH_FORBIDDEN');
    return name === 'vscode' ? vscode : name === './account-migration' && args[0]?.filename === entry ? codec : originalLoad.call(this, name, ...args); };
  let api; try { delete require.cache[entry]; api = require(entry); } finally { Module._load = originalLoad; }
  const vault = { get: async key => data.get(key), store: async(key, value) => { data.set(key, value); record('vault-write', key); }, delete: async key => { data.delete(key); record('vault-delete', key); } };
  const context = { extension: { extensionKind: options.wsl ? 2 : 1 }, extensionUri: fileUri('/synthetic-workbench'), globalStorageUri: fileUri('/synthetic-storage'), globalState: { get: (key, fallback) => state.has(key) ? state.get(key) : fallback, update: async(key, value) => { state.set(key, value); record('state-write', key); } }, secrets: vault, subscriptions: [] };
  const accounts = [ACCOUNT_A, ACCOUNT_B].map((id, n) => ({ id, label: n ? 'B' : 'A', expectedEmail: n ? 'b@example.test' : 'a@example.test', capturedAt: '2026-10-01T00:00:00.000Z', identitySource: 'hub', hostId: HOST }));
  state.set(INDEX, accounts);
  for (const account of accounts) data.set(ACCOUNT_PREFIX + account.id, JSON.stringify({...account, slots: { keyring: token(account.expectedEmail), file: token(account.expectedEmail) }}));
  const slots = { read: async() => structuredClone(currentSlots), write: async(next, expected) => {
    assert.deepEqual(currentSlots, expected); record('credential-write', load('live-storage').tokenAccountHint(next.file || next.keyring).email);
    if (ui.writeFailure) { const error = ui.writeFailure; ui.writeFailure = undefined; throw error; }
    currentSlots = structuredClone(next); currentEmail = load('live-storage').tokenAccountHint(currentSlots.file || currentSlots.keyring).email;
  } };
  const service = new LiveSwitchService(vault, slots, HOST);
  let activity;
  const locks = {
    async inspectOperationActivity() { record('inspect-lock'); return activity || { state: 'absent', kind: 'unknown', scope: 'unknown' }; },
    async isOperationCurrent(expected) { return activity === expected; },
    async withOperation(fn) { if (activity) throw new LiveError('LIVE_OPERATION_OR_RECOVERY_LOCKED'); record('lock'); try { return await fn(); } finally { record('unlock'); } },
    async hasRecovery() { return !!ui.offlineMarker; }, async inspectRecovery(){return ui.offlineMarker ? {state:'active',owner:ui.offlineMarker}:{state:'absent'};}, async beginRecovery() { record('begin-recovery'); }, async clearRecovery() { record('clear-recovery'); }, async assertRecovery() {}
  };
  const backend = {
    get generation() { return generation; }, restartMode: 'component',
    async assertCredentialWriteSafe() { if(ui.barrierFailure) throw ui.barrierFailure; },
    async stop() { record('stop-hub'); running = false; },
    async reload() { record('reload-hub'); running = true; generation = `synthetic-generation-${++serial}`; official.exports = {...official.exports, csrfToken: `synthetic-csrf-${serial}`}; ui.afterReload?.(); },
    async proof() { if (!running) throw new LiveError('OFFICIAL_HUB_NOT_READY'); record('proof', currentEmail); if (ui.proofFailure) throw ui.proofFailure; return proof(); },
    async quota() { return proof(); }, async login() { record('oauth'); }
  };
  let selections = new Set();
  const recovery = {
    async scan() { record('scan-processes', rows.map(row => row.pid)); selections = new Set(rows.filter(row => row.canEnd).map(row => row.id)); return {
      phase: rows.length ? 'blocked' : 'clear', processes: structuredClone(rows), canContinue: !rows.length,
      currentCount: running ? 1 : 0, totalCount: rows.length + (running ? 1 : 0),
      ...(running ? {current: {id:'current-selection', pid:1001, parentPid:process.pid, owner:'current', parentState:'alive', taskState:'unknown', canEnd:false, scope:'current-window', credentialScopeVerified:true}} : {})
    }; },
    async end(id) { record('end-one', id); throw new LiveError('OFFICIAL_PROCESS_END_UNAVAILABLE'); },
    async endMany(ids, signal) { record('end-many', [...ids]); if (ids.some(id => !selections.has(id)) || rows.some(row => !ids.includes(row.id))) throw new LiveError('OFFICIAL_PROCESS_SELECTION_STALE'); if (ui.endMany) return ui.endMany(ids, signal); rows = []; return ids.map(() => 'exited'); },
    invalidate() { selections.clear(); }
  };
  const controller = api.registerLiveUi(context, { service, locks, ...(options.storageMode ? {storageMode:options.storageMode}:{}), ...(options.publicLifecycle ? {} : { lifecycle: async() => {
    record('resolve-lifecycle'); if (rows.length) throw new LiveError('OFFICIAL_UNOWNED_HUB_TASK_UNKNOWN');
    return running ? backend : {...backend, generation:'stopped'};
  } }), currentIdentity: async() => ({...proof(),generation:load('live-hub').generation(official.exports)}), currentQuota: async() => proof(), processRecovery: recovery, changed: () => { record('ui-state'); ui.onChanged?.(); } });
  t.after(() => { context.subscriptions.forEach(subscription => subscription.dispose()); trace.push({ test: t.name, synthetic: true, events, warnings, final: controller.getState() }); });
  return { official, accounts, events, warnings, notifications, ui, state, data, context, controller, backend, service, locks, recovery, record, current: () => structuredClone(currentSlots), email: () => currentEmail, rows: () => rows, setRows: value => { rows = value; }, activity: value => { activity = value; }, call: (name, argument) => commands.get(`antigravityAccounts.live.${name}`)(argument) };
}
const count = (f, name) => f.events.filter(row => row.event === name).length;
const order = (f, before, after) => assert.ok(f.events.findIndex(row => row.event === before) < f.events.findIndex(row => row.event === after), `${before} must precede ${after}`);
function noBackendMutation(f) { for (const name of ['stop-hub','reload-hub','credential-write','begin-recovery','end-many','end-one']) assert.equal(count(f,name),0,name); }
async function establishVerifiedA(f) {
  // Verify reconciles recovery journals only. Initial identity comes from the
  // same production refresh path used when the sidebar opens.
  await f.controller.refresh();await f.call('verify');
  assert.equal(f.controller.getState().activeEmail,'a@example.test');
}
// Characterize the reported state without assuming why the native helper failed.
// These tests preserve the mutation guard; they do not certify official 1.9.0.
for (const countUnknown of [0, 1, 4]) test(`verified login with ${countUnknown} unknown processes and no current Hub blocks before mutation`, async t => {
  const f = fixture(t);
  await establishVerifiedA(f);
  f.events.length = 0;
  f.recovery.scan = async () => ({
    phase: 'blocked', canContinue: false, currentCount: 0, totalCount: countUnknown,
    processes: Array.from({ length: countUnknown }, (_, index) => ({
      id: `unknown-${index}`, pid: 2000 + index, owner: 'unknown', scope: 'unknown',
      parentState: 'unknown', taskState: 'unknown', canEnd: false,
      credentialScopeVerified: false, credentialScopeReason: 'process-identity-unverified'
    })), limitation: 'ownership'
  });
  await f.call('switch', ACCOUNT_B);
  const state = f.controller.getState();
  assert.equal(state.activeEmail, 'a@example.test');
  assert.equal(state.lastFailure.code, 'OFFICIAL_HUB_PROCESS_UNVERIFIED');assert.match(state.error,/当前窗口的 Hub 进程无法核验/);
  assert.equal(state.processConflicts.processes.length, countUnknown);
  assert.ok(state.processConflicts.processes.every(row => row.owner === 'unknown'));
  assert.equal(f.warnings.length, 0);
  noBackendMutation(f);
  assert.equal(count(f, 'lock'), 0);
});
test('stale active exports with three live peer Hubs cannot recover through repeated rescans or create a pending transaction', async t => {
  const f = fixture(t);
  await establishVerifiedA(f);
  f.events.length = 0;
  let scans = 0;
  f.recovery.scan = async () => {
    scans++;
    return { phase: 'blocked', canContinue: false, currentCount: 0, totalCount: 3,
      processes: [710, 711, 712].map(pid => ({ ...detached(pid), owner: 'other', scope: 'other-window', parentState: 'alive' })) };
  };
  await f.call('switch', ACCOUNT_B);
  assert.equal(f.controller.getState().lastFailure.code,'OFFICIAL_HUB_PROCESS_UNVERIFIED');
  await f.call('processEndAll');
  assert.match(f.controller.getState().error, /当前窗口的 Hub 进程无法核验/);
  for (let attempt = 0; attempt < 3; attempt++) await f.call('processScan');
  await f.call('processContinue');
  const state = f.controller.getState();
  assert.ok(scans >= 5);
  assert.equal(state.processConflicts.currentCount, 0);
  assert.equal(state.processConflicts.canContinue, false);
  assert.equal(state.pending, false);
  assert.equal(state.busy, false);
  assert.equal(await f.service.journal(), null);
  assert.equal(f.warnings.length, 0);
  noBackendMutation(f);
});
for (const scenario of ['failed', 'timeout', 'exports-cleared', 'exports-invalid', 'late-revision', 'late-generation']) test(`passive Hub probe ${scenario} cannot leave stale verification or erase a newer proof`, async t => {
  let probe;
  const originalInterval = global.setInterval;
  global.setInterval = (callback, ms, ...rest) => {
    if (ms === 5000) { probe = callback; return originalInterval(() => {}, ms); }
    return originalInterval(callback, ms, ...rest);
  };
  let f;
  try { f = fixture(t); } finally { global.setInterval = originalInterval; }
  await establishVerifiedA(f);
  const hub = load('live-hub'), originalQuery = hub.queryHub;
  let reject;
  hub.queryHub = () => new Promise((_resolve, fail) => { reject = fail; });
  t.after(() => { hub.queryHub = originalQuery; });
  if (scenario === 'exports-cleared') f.official.exports = {};
  if (scenario === 'exports-invalid') f.official.exports = { port: -1 };
  const observed = []; f.ui.onChanged = () => observed.push(f.controller.getState().activeEmail);
  probe(); await new Promise(setImmediate);
  if (scenario.startsWith('exports-')) { assert.ok(observed.includes(undefined)); return; }
  assert.equal(typeof reject, 'function');
  if (scenario === 'late-generation') f.official.exports = { ...f.official.exports, port: 34568 };
  if (scenario.startsWith('late')) await f.controller.recheck();
  reject(new (load('live-storage').LiveError)(scenario === 'timeout' ? 'HUB_RPC_TIMEOUT' : 'HUB_RPC_FAILED'));
  await new Promise(setImmediate);
  if (scenario.startsWith('late')) assert.equal(f.controller.getState().activeEmail, 'a@example.test');
  else {
    // The failed generation must be invalidated synchronously before any retry.
    assert.ok(observed.includes(undefined), 'failed probe must remove active identity before any retry');
  }
});
test('hidden identity masks the native switch consent without changing the target or credentials', async t => {
  const privacy=load('identity-presentation');privacy.setIdentityHidden(true);t.after(()=>privacy.setIdentityHidden(false));
  const f=fixture(t);f.ui.consent=false;await f.call('switch',ACCOUNT_B);
  assert.equal(f.warnings.length,1);assert.ok(f.warnings[0].message.includes(privacy.identityAlias(ACCOUNT_B)));
  assert.doesNotMatch(f.warnings[0].message,/b@example\.test/);noBackendMutation(f);assert.equal(f.email(),'a@example.test');
});
test('hidden identity masks a blocked-switch process confirmation before any process action', async t => {
  const privacy=load('identity-presentation');privacy.setIdentityHidden(true);t.after(()=>privacy.setIdentityHidden(false));
  const f=fixture(t,{rows:[verifiedPeer(710,'unknown',{credentialScopeVerified:false,canEnd:false})]});await f.call('switch',ACCOUNT_B);
  assert.equal(f.warnings.length,0);assert.equal(f.controller.getState().processSwitchTarget,'b@example.test');
  f.setRows([verifiedPeer(710,'unknown')]);await f.call('processScan');f.ui.consent=false;await f.call('processEndAll');
  assert.equal(f.warnings.length,1);assert.ok(f.warnings[0].message.includes(privacy.identityAlias(ACCOUNT_B)));
  assert.doesNotMatch(f.warnings[0].message,/b@example\.test/);noBackendMutation(f);
});
test('hidden identity keeps the deleted custom label masked after its account leaves the index', async t => {
  const privacy=load('identity-presentation');privacy.setIdentityHidden(true);t.after(()=>privacy.setIdentityHidden(false));
  const f=fixture(t);f.accounts[1].label='Private synthetic customer name';await f.call('remove',ACCOUNT_B);
  assert.equal(f.state.get(INDEX).some(a=>a.id===ACCOUNT_B),false);assert.equal(f.controller.getState().error,undefined);
  assert.ok(f.controller.getState().status.includes(privacy.identityAlias(ACCOUNT_B)));
  assert.doesNotMatch(f.controller.getState().status,/Private synthetic customer name|b@example\.test/);noBackendMutation(f);
});
test('verified current login plus an unknown-scope extra Hub reports ownership before consent and retains the login', async t => {
  const f=fixture(t); await establishVerifiedA(f);
  f.setRows([{id:'unknown-scope-conflict',pid:710,parentPid:702,owner:'other',scope:'unknown',parentState:'alive',taskState:'unknown',canEnd:false,credentialScopeVerified:false}]);
  await f.call('switch',ACCOUNT_B);
  assert.equal(f.warnings.length,0);noBackendMutation(f);assert.equal(f.email(),'a@example.test');
  assert.equal(f.controller.getState().activeEmail,'a@example.test');
  assert.equal(f.controller.getState().lastFailure.code,'OFFICIAL_PROCESS_OWNERSHIP_UNVERIFIED');
  assert.equal(f.controller.getState().processConflicts.current.pid,1001);
  assert.equal(f.controller.getState().processConflicts.processes[0].pid,710);
});

// Window ancestry is risk information. The native helper separately verifies
// executable, user, launch and credential scope before offering an opaque ID.
function verifiedPeer(pid, scope, extra = {}) {
  return {...detached(pid), parentPid:702, owner:'other', parentState:'alive', scope, credentialScopeVerified:true, ...extra};
}
for (const scope of ['other-window','unknown']) test(`new policy: verified credential scope with ${scope} gets one risk consent before the exact batch and account transaction`, async t => {
  const f=fixture(t,{rows:[verifiedPeer(710,scope)]});
  await f.call('switch',ACCOUNT_B);
  assert.equal(f.warnings.length,1);assert.equal(f.warnings[0].options.modal,true);
  assert.match(f.warnings[0].message,/PID 710/);assert.match(f.warnings[0].message,/PID 1001/);
  assert.match(f.warnings[0].message,/其他窗口|other windows?|another window/i);
  assert.match(f.warnings[0].message,/中断|interrupt/i);
  assert.deepEqual(f.events.filter(row=>row.event==='end-many').map(row=>row.detail),[['selection-710']]);
  assert.equal(count(f,'end-one'),0);assert.equal(count(f,'stop-hub'),1);assert.equal(count(f,'credential-write'),1);
  order(f,'confirmation','end-many');order(f,'end-many','resolve-lifecycle');order(f,'resolve-lifecycle','stop-hub');
  order(f,'stop-hub','vault-write');order(f,'vault-write','credential-write');order(f,'credential-write','reload-hub');
  assert.ok(f.events.some(row=>row.event==='proof'&&row.detail==='b@example.test'));
  assert.equal(f.email(),'b@example.test');assert.equal(f.controller.getState().activeEmail,'b@example.test');
  assert.equal(f.controller.getState().processConflicts,undefined);assert.equal(await f.service.journal(),null);
});
for (const verified of [false,undefined]) test(`new policy: credential scope ${String(verified)} rejects a helper's optimistic canEnd before consent or any stop`, async t => {
  const f=fixture(t);await establishVerifiedA(f);
  const credentials=f.current(),index=structuredClone(f.state.get(INDEX));
  f.setRows([verifiedPeer(710,'unknown',{credentialScopeVerified:verified})]);
  await f.call('switch',ACCOUNT_B);
  assert.equal(f.warnings.length,0);noBackendMutation(f);
  assert.deepEqual(f.current(),credentials);assert.deepEqual(f.state.get(INDEX),index);assert.equal(f.email(),'a@example.test');
  assert.equal(f.controller.getState().activeEmail,'a@example.test');assert.ok(f.controller.getState().error);
});
test('new policy: cancelling the foreign-window risk consent leaves every backend and the login untouched',async t=>{
  const f=fixture(t,{rows:[verifiedPeer(710,'other-window'),verifiedPeer(711,'unknown')]});f.ui.consent=false;
  const credentials=f.current(),index=structuredClone(f.state.get(INDEX));
  await f.call('switch',ACCOUNT_B);
  assert.equal(f.warnings.length,1);assert.match(f.warnings[0].message,/PID 710/);assert.match(f.warnings[0].message,/PID 711/);
  assert.match(f.warnings[0].message,/其他窗口|other windows?|another window/i);noBackendMutation(f);
  assert.deepEqual(f.current(),credentials);assert.deepEqual(f.state.get(INDEX),index);assert.equal(f.email(),'a@example.test');
  assert.deepEqual(f.rows().map(row=>row.pid),[710,711]);
});
test('new policy: one unknown credential scope blocks the whole proposed batch before any confirmation or target stop',async t=>{
  const f=fixture(t,{rows:[verifiedPeer(710,'other-window'),verifiedPeer(711,'unknown',{credentialScopeVerified:false})]});
  const credentials=f.current();await f.call('switch',ACCOUNT_B);
  assert.equal(f.warnings.length,0);noBackendMutation(f);assert.deepEqual(f.current(),credentials);
  assert.deepEqual(f.rows().map(row=>row.pid),[710,711]);assert.equal(f.email(),'a@example.test');assert.ok(f.controller.getState().error);
});
test('new policy: an optimistic clear scan cannot bypass an unverified current Hub credential scope',async t=>{
  const f=fixture(t);await establishVerifiedA(f);
  const originalScan=f.recovery.scan.bind(f.recovery),credentials=f.current(),index=structuredClone(f.state.get(INDEX));
  t.mock.method(f.recovery,'scan',async()=>{const state=await originalScan();state.current.credentialScopeVerified=false;state.canContinue=true;state.phase='clear';return state;});
  await f.call('switch',ACCOUNT_B);
  assert.equal(f.warnings.length,0);noBackendMutation(f);assert.deepEqual(f.current(),credentials);assert.deepEqual(f.state.get(INDEX),index);
  assert.equal(f.controller.getState().activeEmail,'a@example.test');assert.equal(f.email(),'a@example.test');assert.ok(f.controller.getState().error);
});
test('new policy: a live official API cannot use an optimistic clear scan with no verified current process',async t=>{
  const f=fixture(t);await establishVerifiedA(f);
  const originalScan=f.recovery.scan.bind(f.recovery),credentials=f.current();
  t.mock.method(f.recovery,'scan',async()=>{const state=await originalScan();delete state.current;state.canContinue=true;state.phase='clear';return state;});
  await f.call('switch',ACCOUNT_B);
  assert.equal(f.warnings.length,0);noBackendMutation(f);assert.deepEqual(f.current(),credentials);
  assert.equal(f.controller.getState().activeEmail,'a@example.test');assert.equal(f.email(),'a@example.test');assert.ok(f.controller.getState().error);
});
test('new policy: one consent fixes two explicitly identified foreign or unknown-window targets and never sends the current Hub through manual end',async t=>{
  const f=fixture(t,{rows:[verifiedPeer(710,'other-window'),verifiedPeer(711,'unknown')]});
  await f.call('switch',ACCOUNT_B);
  assert.equal(f.warnings.length,1);assert.match(f.warnings[0].message,/PID 710/);assert.match(f.warnings[0].message,/PID 711/);
  const selected=f.events.filter(row=>row.event==='end-many').map(row=>row.detail);
  assert.deepEqual(selected,[['selection-710','selection-711']]);assert.ok(selected.flat().every(id=>id!=='current-selection'));
  assert.equal(f.email(),'b@example.test');assert.equal(count(f,'stop-hub'),1);assert.equal(count(f,'end-one'),0);
});
test('new policy: replacing the second selected backend during consent never adopts its new PID or writes credentials',async t=>{
  const f=fixture(t,{rows:[verifiedPeer(710,'other-window'),verifiedPeer(711,'unknown')]});
  f.ui.warning=(_message,action)=>{f.setRows([verifiedPeer(710,'other-window'),verifiedPeer(712,'unknown')]);return action;};
  await f.call('switch',ACCOUNT_B);
  assert.equal(f.warnings.length,1);
  assert.deepEqual(f.events.filter(row=>row.event==='end-many').map(row=>row.detail),[['selection-710','selection-711']]);
  for(const name of ['stop-hub','credential-write','reload-hub'])assert.equal(count(f,name),0,name);
  assert.equal(f.email(),'a@example.test');assert.ok(f.controller.getState().error);
});
test('new policy: native proof refusal after consent prevents target signalling and every account mutation',async t=>{
  const f=fixture(t,{rows:[verifiedPeer(710,'other-window')]});
  f.ui.warning=(_message,action)=>{f.setRows([verifiedPeer(710,'other-window',{credentialScopeVerified:false})]);return action;};
  f.ui.endMany=async(ids)=>{assert.deepEqual(ids,['selection-710']);assert.equal(f.rows()[0].credentialScopeVerified,false);f.record('native-proof-refused-without-signal');throw new (load('live-storage').LiveError)('OFFICIAL_PROCESS_SELECTION_STALE');};
  await f.call('switch',ACCOUNT_B);
  assert.equal(f.warnings.length,1);assert.equal(count(f,'native-proof-refused-without-signal'),1);
  for(const name of ['stop-hub','credential-write','reload-hub'])assert.equal(count(f,name),0,name);
  assert.equal(f.email(),'a@example.test');assert.ok(f.controller.getState().error);
});
test('new policy: a new backend arriving after the confirmed batch is surfaced and never included in a second automatic end',async t=>{
  const f=fixture(t,{rows:[verifiedPeer(710,'other-window')]});
  f.ui.endMany=async(ids)=>{assert.deepEqual(ids,['selection-710']);f.setRows([verifiedPeer(711,'unknown')]);return ['exited'];};
  await f.call('switch',ACCOUNT_B);
  assert.equal(f.warnings.length,1);assert.equal(count(f,'end-many'),1);assert.equal(count(f,'credential-write'),0);assert.equal(count(f,'stop-hub'),0);
  assert.equal(f.controller.getState().processConflicts.processes[0].pid,711);assert.equal(f.email(),'a@example.test');
});

test('A to B to A uses one explicit current-window scope confirmation per operation and hides routine process checks', async t => {
  const f = fixture(t);
  const index = JSON.stringify(f.state.get(INDEX));
  for (const [id, email] of [[ACCOUNT_B,'b@example.test'],[ACCOUNT_A,'a@example.test'],[ACCOUNT_B,'b@example.test'],[ACCOUNT_A,'a@example.test']]) {
    const before = f.warnings.length; await f.call('switch', id);
    assert.equal(f.warnings.length, before+1); assert.match(f.warnings.at(-1).message,/PID 1001/); assert.match(f.warnings.at(-1).message,/中断任务|interrupt tasks/);
    assert.equal(f.email(),email); assert.equal(f.controller.getState().activeEmail,email); assert.equal(f.controller.getState().processConflicts,undefined); assert.equal(f.controller.getState().pending,false);
  }
  assert.equal(count(f,'stop-hub'),4); assert.equal(count(f,'reload-hub'),4); assert.equal(count(f,'credential-write'),4); assert.equal(JSON.stringify(f.state.get(INDEX)),index);
  order(f,'confirmation','stop-hub'); order(f,'stop-hub','credential-write'); order(f,'credential-write','reload-hub');
});
test('multiple verified leftover backends are listed in one consent and ended once as its exact selected set', async t => {
  const f = fixture(t,{rows:[detached(710),detached(711)]}); await f.call('switch',ACCOUNT_B);
  assert.equal(f.warnings.length,1); assert.match(f.warnings[0].message,/PID 710/); assert.match(f.warnings[0].message,/PID 711/); assert.match(f.warnings[0].message,/PID 1001/);
  assert.deepEqual(f.events.filter(row=>row.event==='end-many').map(row=>row.detail),[['selection-710','selection-711']]); assert.equal(count(f,'end-one'),0);
  assert.equal(f.email(),'b@example.test'); assert.equal(f.controller.getState().processConflicts,undefined); order(f,'confirmation','end-many'); order(f,'lock','end-many');
});
test('cancelled consent preserves current credentials, account index and recovery history', async t => {
  const f=fixture(t,{rows:[detached(710)]}); f.ui.consent=false;
  const credentials=f.current(),index=structuredClone(f.state.get(INDEX));f.state.set('live-switch.lastFailure.v1',{schema:1,at:'2026-10-09T04:00:00Z',action:'switch',stage:'preflight',phase:'none',code:'PROCESS_CHECK_FAILED'});
  const history=structuredClone(f.state.get('live-switch.lastFailure.v1'));await f.call('switch',ACCOUNT_B);noBackendMutation(f);
  assert.deepEqual(f.current(),credentials);assert.deepEqual(f.state.get(INDEX),index);assert.deepEqual(f.state.get('live-switch.lastFailure.v1'),history);assert.equal(await f.service.journal(),null);
});
test('other active window and unverified process expose an exception without asking to stop or ending either', async t => {
  for(const row of [{...detached(710),owner:'other',parentState:'alive',canEnd:false,scope:'other-window'},{...detached(712),owner:'unknown',canEnd:false,scope:'unknown'}]) {
    const f=fixture(t,{rows:[row]});await f.call('switch',ACCOUNT_B);noBackendMutation(f);assert.equal(f.warnings.length,0);assert.equal(f.controller.getState().processConflicts.processes[0].pid,row.pid);assert.ok(f.controller.getState().error);
  }
});
test('a replacement PID after consent is not added to the selected set and blocks credential writes', async t => {
  const f=fixture(t,{rows:[detached(710)]});f.ui.warning=(_message,action)=>{f.setRows([detached(711)]);return action;};await f.call('switch',ACCOUNT_B);
  assert.deepEqual(f.events.filter(row=>row.event==='end-many').map(row=>row.detail),[['selection-710']]);assert.equal(count(f,'stop-hub'),0);assert.equal(count(f,'credential-write'),0);assert.equal(f.email(),'a@example.test');assert.ok(f.controller.getState().error);
});
test('a new leftover appearing after the confirmed batch is not auto-ended or switched through', async t => {
  const f=fixture(t,{rows:[detached(710)]});f.ui.endMany=async()=>{f.setRows([detached(711)]);return ['exited'];};await f.call('switch',ACCOUNT_B);
  assert.equal(count(f,'end-many'),1);assert.equal(count(f,'credential-write'),0);assert.equal(f.controller.getState().processConflicts.processes[0].pid,711);
});
test('a changed saved account while consent is open invalidates the pending switch', async t => {
  const f=fixture(t,{rows:[detached(710)]});f.ui.warning=(_message,action)=>{f.state.set(INDEX,f.state.get(INDEX).map(row=>row.id===ACCOUNT_B?{...row,expectedEmail:'replacement@example.test'}:row));return action;};await f.call('switch',ACCOUNT_B);noBackendMutation(f);assert.ok(f.controller.getState().error);
});
test('repeated clicks share one in-flight confirmation and batch termination; disposal blocks late install', async t => {
  const f=fixture(t,{rows:[detached(710)]}),wait=deferred(),started=deferred();f.ui.endMany=async()=>{started.resolve();await wait.promise;f.setRows([]);return ['exited'];};
  const pending=f.call('switch',ACCOUNT_B);t.after(async()=>{wait.resolve();await pending;});await waitForStart(started.promise);await f.call('switch',ACCOUNT_B);assert.equal(f.warnings.length,1);assert.equal(count(f,'end-many'),1);
  f.context.subscriptions.forEach(subscription=>subscription.dispose());wait.resolve();await pending;assert.equal(count(f,'credential-write'),0);assert.equal(count(f,'stop-hub'),0);
});
test('clearing an unsafe conflict then continuing obtains the first real scope consent before stopping', async t => {
  const f=fixture(t,{rows:[{...detached(710),owner:'other',parentState:'alive',canEnd:false,scope:'other-window'}]});await f.call('switch',ACCOUNT_B);assert.equal(f.warnings.length,0);
  f.setRows([]);await f.call('processContinue');assert.equal(f.warnings.length,1);assert.match(f.warnings[0].message,/PID 1001/);assert.equal(f.email(),'b@example.test');order(f,'confirmation','stop-hub');
});
test('failed target credential write restores the original session and saved accounts without erasing failure history', async t => {
  const f=fixture(t),before=f.current(),index=structuredClone(f.state.get(INDEX));f.ui.writeFailure=new(load('live-storage').LiveError)('KEYRING_WRITE_FAILED');await f.call('switch',ACCOUNT_B);
  assert.deepEqual(f.current(),before);assert.equal(f.email(),'a@example.test');assert.deepEqual(f.state.get(INDEX),index);assert.equal(f.controller.getState().pending,false);assert.ok(f.controller.getState().error);assert.ok(f.controller.getState().lastFailure);assert.equal(await f.service.journal(),null);assert.equal(f.warnings.length,1);
});
test('failed verification keeps the durable original backup when restoration cannot be reverified', async t => {
  const f=fixture(t),before=f.current(),index=structuredClone(f.state.get(INDEX));f.ui.afterReload=()=>{f.ui.proofFailure=new(load('live-storage').LiveError)('HUB_RPC_FAILED');};await f.call('switch',ACCOUNT_B);
  const journal=await f.service.journal();assert.ok(journal);assert.equal(journal.phase,'restored');assert.deepEqual(journal.backup,before);assert.deepEqual(f.current(),before);assert.deepEqual(f.state.get(INDEX),index);assert.equal(f.controller.getState().pending,true);assert.ok(f.controller.getState().lastFailure);assert.ok(f.controller.getState().error);assert.equal(f.warnings.length,1);
});
test('switch consent covers both current Hub and the exact local image task set in one modal', async t=>{
  const f=fixture(t),imageActivity=load('image-activity');let release;release=imageActivity.enterImageOperation('synthetic-switch-image',{cancel:()=>{f.record('cancel-image');setImmediate(()=>release());}});t.after(()=>release());await f.call('switch',ACCOUNT_B);
  assert.equal(f.warnings.length,1);assert.match(f.warnings[0].message,/PID 1001/);assert.match(f.warnings[0].message,/图片任务|Image tasks/);assert.equal(count(f,'cancel-image'),1);assert.equal(f.email(),'b@example.test');order(f,'confirmation','cancel-image');order(f,'cancel-image','lock');order(f,'lock','stop-hub');
});
test('replaced local image work after consent is never cancelled under an old snapshot', async t=>{
  const f=fixture(t),imageActivity=load('image-activity'),release=imageActivity.enterImageOperation('synthetic-old-image',{cancel:()=>f.record('cancel-old-image')});let releaseNew;
  t.after(()=>{release();releaseNew?.();});f.ui.warning=(_message,action)=>{release();releaseNew=imageActivity.enterImageOperation('synthetic-new-image',{cancel:()=>f.record('cancel-new-image')});return action;};await f.call('switch',ACCOUNT_B);
  assert.equal(count(f,'cancel-old-image'),0);assert.equal(count(f,'cancel-new-image'),0);noBackendMutation(f);assert.ok(f.controller.getState().error);
});
test('import and export stop only a confirmed local image task, await lock release and never stop the Hub', async t => {
  const imageActivity=load('image-activity');
  for(const action of ['import','export']) {
    const f=fixture(t),wait=deferred();const occupant={state:'active',kind:'image',scope:'this-process',owner:{schema:2,owner:HOST,id:'local-image-lock',pid:process.pid,nonce:'synthetic-nonce',startIdentity:'synthetic-start',purpose:'image'}};f.activity(occupant);
    let release;release=imageActivity.enterImageOperation(`synthetic-${action}`,{cancel:()=>{f.record('cancel-image');setImmediate(()=>{f.activity(undefined);release();wait.resolve();});}});
    t.after(()=>release());await f.call(action);
    assert.equal(count(f,'cancel-image'),1);await wait.promise;assert.match(f.warnings[0].message,/图片任务|image tasks/i);order(f,'confirmation','cancel-image');order(f,'cancel-image','lock');
    for(const name of ['stop-hub','reload-hub','end-many','end-one','credential-write'])assert.equal(count(f,name),0,name);
    assert.equal(count(f,'scan-processes'),0);if(action==='export')assert.equal(count(f,'write-export'),1);else assert.equal(count(f,'open-dialog'),1);
  }
});
test('import occupation cancellation or foreign/unknown lock never cancels local work or mutates accounts', async t => {
  const imageActivity=load('image-activity');
  for(const scope of ['this-process','other-process','unknown']) {
    const f=fixture(t);f.ui.consent=false;f.activity({state:'active',kind:'image',scope,owner:{schema:2,owner:HOST,id:'lock',pid:scope==='this-process'?process.pid:9999,purpose:'image'}});
    const release=imageActivity.enterImageOperation(`synthetic-cancel-${scope}`,{cancel:()=>f.record('cancel-image')});try{await f.call('import');assert.equal(count(f,'cancel-image'),0);noBackendMutation(f);assert.equal(count(f,'open-dialog'),0);assert.equal(f.warnings.length,scope==='this-process'?1:0);}finally{release();}
  }
});
test('English consent retains selected PID scope and an explicit interruption warning',async t=>{
  const i18n=load('i18n');i18n.setLanguage('en');t.after(()=>i18n.setLanguage('zh-CN'));const f=fixture(t,{rows:[detached(710)]});f.ui.consent=false;await f.call('switch',ACCOUNT_B);
  assert.equal(f.warnings.length,1);assert.match(f.warnings[0].message,/This window/);assert.match(f.warnings[0].message,/PID 1001/);assert.match(f.warnings[0].message,/PID 710/);assert.match(f.warnings[0].message,/interrupt tasks/);noBackendMutation(f);
});

test.after(()=>{
  if(process.env.BACKEND_UI_TIMELINE){fs.mkdirSync(path.dirname(process.env.BACKEND_UI_TIMELINE),{recursive:true});fs.writeFileSync(process.env.BACKEND_UI_TIMELINE,JSON.stringify({moduleRoot:output,synthetic:true,realGoogleCalls:false,traces:trace},null,2)+'\n');}
});
for (const scenario of ['success', 'cancel', 'journal', 'lock', 'double-click']) test(`component recovery command ${scenario} never stops a backend or writes credentials`, async t => {
  const f = fixture(t), contract = load('official-contract'), hub = load('live-hub');
  const oldEntry = contract.assertOfficialEntrypoint, oldProof = hub.queryFreshIdentity;
  contract.assertOfficialEntrypoint = async () => {};
  hub.queryFreshIdentity = async () => ({ generation: hub.generation(f.official.exports) });
  t.after(() => { contract.assertOfficialEntrypoint = oldEntry; hub.queryFreshIdentity = oldProof; });
  await establishVerifiedA(f); f.events.length = 0;
  f.official.packageJSON.version = '1.8.0';
  f.ui.commandList = ['antigravity.reconnect', 'antigravity.panel.focus'];
  let started = false;
  f.recovery.scan = async () => ({ phase: started ? 'clear' : 'blocked', canContinue: started, currentCount: started ? 1 : 0, totalCount: started ? 1 : 0, processes: [], ...(started ? {current:{pid:1001,owner:'current',credentialScopeVerified:true}} : {}) });
  f.recovery.currentProcessIdentity = () => started ? { pid: 1001, startTicks: '999999' } : undefined;
  f.ui.execute = async name => { if (name === 'antigravity.panel.focus') started = true; };
  if (scenario === 'cancel') f.ui.consent = false;
  if (scenario === 'journal') f.service.journal = async () => ({ phase: 'installed' });
  if (scenario === 'lock') f.activity({ state: 'active', kind: 'switch', scope: 'other' });
  const first = f.call('hubRecover');
  if (scenario === 'double-click') await f.call('hubRecover');
  await first;
  noBackendMutation(f);
  const commands = f.events.filter(row => row.event === 'command').map(row => row.detail);
  if (['success', 'double-click'].includes(scenario)) {
    assert.deepEqual(commands, f.ui.commandList);
    assert.equal(f.controller.getState().error, undefined);
  } else assert.deepEqual(commands, []);
});
test('ending observation during reconnect retains the operation until actual component verification', async t => {
  const f = fixture(t), contract = load('official-contract'), oldEntry = contract.assertOfficialEntrypoint;
  contract.assertOfficialEntrypoint = async () => {}; t.after(() => { contract.assertOfficialEntrypoint = oldEntry; });
  await establishVerifiedA(f); f.events.length = 0;
  f.official.packageJSON.version = '1.8.0';
  f.ui.commandList = ['antigravity.reconnect', 'antigravity.panel.focus'];
  let started = false;
  f.recovery.scan = async () => ({ phase:'blocked',canContinue:false,currentCount:started?1:0,totalCount:started?1:0,processes:[],...(started?{current:{credentialScopeVerified:true}}:{}) });
  f.recovery.currentProcessIdentity = () => started ? {pid:1001,startTicks:'999'} : undefined;
  const hub = load('live-hub'), oldProof = hub.queryFreshIdentity;
  hub.queryFreshIdentity = async () => ({generation:hub.generation(f.official.exports)}); t.after(()=>{hub.queryFreshIdentity=oldProof;});
  const began = deferred(), finish = deferred();
  f.ui.execute = async command => { if(command==='antigravity.reconnect'){began.resolve(); await finish.promise;} else started=true; };
  const first = f.call('hubRecover'); await waitForStart(began.promise);
  await f.call('hubRecoverCancel'); await first;
  assert.equal(count(f, 'unlock'), 0);
  await f.call('hubRecover');
  assert.match(f.controller.getState().error, /组件恢复仍在进行/);
  finish.resolve(); await f.call('processScan');
  assert.equal(count(f, 'unlock'), 1);
  assert.deepEqual(f.events.filter(row=>row.event==='command').map(row=>row.detail), ['antigravity.reconnect','antigravity.panel.focus']);
  noBackendMutation(f);
});
for(const scenario of ['success','cancel','replaced','unknown-peer']) test(`restart current component with peers: ${scenario}`,async t=>{
 const f=fixture(t),contract=load('official-contract'),hub=load('live-hub');
 const oldEntry=contract.assertOfficialEntrypoint,oldProof=hub.queryFreshIdentity;
 contract.assertOfficialEntrypoint=async()=>{};hub.queryFreshIdentity=async()=>({generation:hub.generation(f.official.exports)});
 t.after(()=>{contract.assertOfficialEntrypoint=oldEntry;hub.queryFreshIdentity=oldProof;});
 await establishVerifiedA(f);f.events.length=0;f.official.packageJSON.version='1.8.0';
 f.ui.commandList=['antigravity.reconnect','antigravity.panel.focus'];
 const peers=[800,801,802].map(pid=>verifiedPeer(pid,'other-window'));
 if(scenario==='unknown-peer')peers[0].scope='unknown';
 let running=true,birth='old',stops=0,starts=0;
 f.recovery.scan=async()=>({phase:'blocked',canContinue:false,currentCount:running?1:0,totalCount:peers.length+(running?1:0),processes:peers,...(running?{current:{pid:1001,credentialScopeVerified:true}}:{})});
 f.recovery.currentProcessIdentity=()=>running?{pid:1001,startTicks:birth}:undefined;
 f.recovery.recoveryPeerIdentity=()=>JSON.stringify(peers.map(p=>({...p,startTicks:'peer-birth',commandHash:'synthetic'})));
 f.recovery.assertCurrentProcess=async expected=>{assert.deepEqual(expected,{pid:1001,startTicks:birth});};
 const main=path.join(f.official.extensionPath,'extension.js'),previous=require.cache[main];
 require.cache[main]={loaded:true,exports:{deactivate:async()=>{++stops;f.record('component-stop',1001);running=false;f.official.exports={csrfToken:'synthetic-official-csrf'};}}};
 t.after(()=>{if(previous)require.cache[main]=previous;else delete require.cache[main];});
 f.ui.execute=async command=>{if(command==='antigravity.reconnect'){++starts;running=true;birth='new';f.official.exports={port:34568,csrfToken:'synthetic-official-csrf'};}};
 if(scenario==='cancel')f.ui.consent=false;
 if(scenario==='replaced')f.ui.warning=async(_message,action)=>{birth='reused';return action;};
 await f.call('hubRestart');
 assert.equal(stops,scenario==='success'?1:0);assert.equal(starts,scenario==='success'?1:0);
 assert.equal(count(f,'credential-write'),0);assert.equal(count(f,'end-many'),0);assert.equal(count(f,'end-one'),0);
 assert.equal(peers.length,3);
 if(scenario==='success'){assert.equal(f.controller.getState().error,undefined);assert.match(f.warnings.at(-1).message,/任务会中断/);}
});

for(const action of ['switch','login']) test(`public lifecycle ${action} reports missing entry capability before stopping peers or starting OAuth`,async t=>{
 const f=fixture(t,{publicLifecycle:true,rows:[verifiedPeer(710),verifiedPeer(711)]});
 const before=f.current();await f.call(action,action==='switch'?ACCOUNT_B:undefined);
 assert.equal(f.controller.getState().lastFailure.code,'OFFICIAL_ENTRY_UNAVAILABLE');
 noBackendMutation(f);assert.equal(count(f,'oauth'),0);assert.equal(f.warnings.length,0);
 assert.equal(await f.service.journal(),null);assert.deepEqual(f.current(),before);
});

// Dispatch regression: real UI/LiveSwitchService; lifecycle/process proof/RPC and
// native slots are synthetic. This does not certify official 1.9 stop semantics.
for(const version of ['1.8.0','1.9.0'])test('WSL '+version+' synthetic lifecycle routes normal switch through historical transaction without window prerequisites',async t=>{
 const f=fixture(t,{officialVersion:version,wsl:true,storageMode:'wsl-file',forbidWindowPath:true});
 await f.call('switch',ACCOUNT_B);
 assert.equal(count(f,'forbidden-offline-prepare'),0);assert.equal(count(f,'credential-write'),1);
 assert.equal(f.email(),'b@example.test');assert.equal(f.controller.getState().pending,false);
 for(const event of ['scan-processes','confirmation','stop-hub','reload-hub','proof'])assert.ok(count(f,event)>0,event);
 order(f,'scan-processes','confirmation');order(f,'confirmation','stop-hub');order(f,'stop-hub','credential-write');order(f,'credential-write','reload-hub');
 const reload=f.events.findIndex(e=>e.event==='reload-hub');assert.ok(f.events.slice(reload+1).some(e=>e.event==='proof'&&e.detail==='b@example.test'));
 assert.equal(f.warnings.length,1);assert.equal(count(f,'password'),0);
 assert.ok(!f.events.some(e=>e.event==='command'&&/close|reloadWindow|openFolder|profile|sync/i.test(e.detail)));
 assert.equal(await f.service.journal(),null);
});
test('WSL 1.9 existing schema4 recovery remains protected on normal switch dispatch',async t=>{
 const f=fixture(t,{officialVersion:'1.9.0',wsl:true,storageMode:'wsl-file',forbidWindowPath:true});
 const marker={schema:4,id:'11111111-1111-4111-8111-111111111111',owner:require('node:crypto').createHash('sha256').update(f.context.globalStorageUri.toString()).digest('hex')};
 f.ui.offlineMarker=marker;await f.controller.refresh();f.events.length=0;
 await f.call('switch',ACCOUNT_B);noBackendMutation(f);assert.equal(count(f,'forbidden-offline-prepare'),0);assert.equal(count(f,'clear-recovery'),0);
 assert.deepEqual(f.ui.offlineMarker,marker);assert.equal(f.email(),'a@example.test');assert.equal(f.controller.getState().offlinePending,true);assert.equal(f.controller.getState().pending,true);
});

test('injected 1.9 unprovable write barrier fails before stop journal or credential writes',async t=>{
 const f=fixture(t,{officialVersion:'1.9.0',wsl:true,storageMode:'wsl-file',forbidWindowPath:true});
 f.ui.barrierFailure=new(load('live-storage').LiveError)('OFFICIAL_CREDENTIAL_WRITE_UNSUPPORTED');
 await f.call('switch',ACCOUNT_B);noBackendMutation(f);assert.equal(count(f,'forbidden-offline-prepare'),0);assert.equal(count(f,'clear-recovery'),0);assert.equal(await f.service.journal(),null);assert.equal(f.email(),'a@example.test');
});

// Only exact installed-source recognition is injected; the public UI pause
// admission is real and must reject unobserved 1.9 before consent/process mutation.
test('public WSL 1.9 with enabled auto recovery rejects before consent stop and journal',async t=>{
 const f=fixture(t,{publicLifecycle:true,officialVersion:'1.9.0',wsl:true,storageMode:'wsl-file',forbidWindowPath:true});
 const contract=load('official-contract'),old=contract.assertOfficialWriteContract;
 contract.assertOfficialWriteContract=async()=> '1.9.0';
 f.ui.config.autoRecover=true;
 try{await f.call('switch',ACCOUNT_B);}finally{contract.assertOfficialWriteContract=old;}
 assert.equal(f.controller.getState().lastFailure.code,'OFFICIAL_RECOVERY_ENABLED');
 noBackendMutation(f);assert.equal(count(f,'forbidden-offline-prepare'),0);assert.equal(f.warnings.length,0);assert.equal(await f.service.journal(),null);
});
