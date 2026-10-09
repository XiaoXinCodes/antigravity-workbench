const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const fs = require('node:fs');
const output = path.resolve(process.env.ACCOUNT_BACKEND_UI_MODULE_ROOT || path.join(__dirname, '../out'));
const load = name => require(path.join(output, name));
const INDEX = 'live-switch.accounts.v1';
const ACCOUNT_A = '00000000-0000-4000-8000-000000000001';
const ACCOUNT_B = '00000000-0000-4000-8000-000000000002';
const HOST = 'a'.repeat(64);
const trace = [];
const fileUri = value => ({ scheme: 'file', authority: '', query: '', fragment: '', fsPath: value, toString: () => `file://${value}` });
const detached = (pid, id = `selection-${pid}`) => ({ id, pid, parentPid: 1, startedAt: '2026-10-09T04:00:00Z', owner: 'detached', parentState: 'gone', taskState: 'unknown', canEnd: true, scope: 'detached', credentialScopeVerified: true });

/** VS Code APIs, Hub responses and account tokens are synthetic. The account
 * transaction and UI command implementation are the production modules. */
function fixture(t, options = {}) {
  const { LiveError } = load('live-storage');
  const { LiveSwitchService, ACCOUNT_PREFIX } = load('live-switch');
  const events = [], warnings = [], notifications = [], commands = new Map(), state = new Map(), data = new Map();
  const ui = { consent: true, inputs: ['synthetic-password-long', 'synthetic-password-long'], open: undefined, folder: [fileUri('/synthetic-export')], filename: 'accounts.agwenc' };
  let rows = options.rows || [], running = true, serial = 0, currentEmail = 'a@example.test', currentSlots;
  let generation = load('live-hub').generation({port:34567,csrfToken:'synthetic-official-csrf'});
  const token = email => JSON.stringify({ token: { refresh_token: `synthetic-refresh-${email}`, access_token: `synthetic-access-${email.replace('@','-')}`, expiry: '2099-01-01T00:00:00Z', token_type: 'Bearer' }, id_token: `e30.${Buffer.from(JSON.stringify({email})).toString('base64url')}.synthetic` });
  currentSlots = { keyring: token(currentEmail), file: token(currentEmail) };
  const record = (event, detail) => { const entry = { step: events.length, event, ...(detail === undefined ? {} : {detail}) }; events.push(entry); return entry; };
  const proof = () => ({ email: currentEmail, generation, authValid: true, observedAt: new Date().toISOString(), quotaSource: 'server', buckets: [] });
  const official = { id: 'google.google-antigravity', extensionKind: 1, extensionUri: fileUri('/synthetic-official-extension'), extensionPath: '/synthetic-official-extension', packageJSON: { version: '1.6.0', main: './extension.js' }, isActive: true, exports: { port: 34567, csrfToken: 'synthetic-official-csrf' } };
  const vscode = {
    UIKind: { Desktop: 1 }, ExtensionKind: { UI: 1, Workspace: 2 }, ProgressLocation: { Notification: 1 }, Uri: { file: fileUri },
    env: { uiKind: 1 }, extensions: { getExtension: id => id === official.id ? official : undefined },
    workspace: { isTrusted: true, getConfiguration: () => ({ get: () => undefined }) },
    commands: { registerCommand: (name, fn) => { commands.set(name, fn); return { dispose() {} }; }, getCommands: async () => [], executeCommand: async name => { record('command', name); } },
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
  const entry = path.join(output, 'live-ui.js'), originalLoad = Module._load;
  Module._load = function(name, ...args) { return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args); };
  let api; try { delete require.cache[entry]; api = require(entry); } finally { Module._load = originalLoad; }
  const vault = { get: async key => data.get(key), store: async(key, value) => { data.set(key, value); record('vault-write', key); }, delete: async key => { data.delete(key); record('vault-delete', key); } };
  const context = { extension: { extensionKind: 1 }, extensionUri: fileUri('/synthetic-workbench'), globalStorageUri: fileUri('/synthetic-storage'), globalState: { get: (key, fallback) => state.has(key) ? state.get(key) : fallback, update: async(key, value) => { state.set(key, value); record('state-write', key); } }, secrets: vault, subscriptions: [] };
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
    async hasRecovery() { return false; }, async beginRecovery() { record('begin-recovery'); }, async clearRecovery() { record('clear-recovery'); }, async assertRecovery() {}
  };
  const backend = {
    get generation() { return generation; }, restartMode: 'component',
    async stop() { record('stop-hub'); running = false; },
    async reload() { record('reload-hub'); running = true; ++serial; official.exports = {...official.exports, csrfToken: `synthetic-csrf-${serial}`}; generation = load('live-hub').generation(official.exports); ui.afterReload?.(); },
    async proof() { if (!running) throw new LiveError('OFFICIAL_HUB_NOT_READY'); record('proof', currentEmail); if (ui.proofFailure) throw ui.proofFailure; return proof(); },
    async quota() { return proof(); }, async login() { record('oauth'); }
  };
  let selections = new Set();
  const recovery = {
    async scan() { record('scan-processes', rows.map(row => row.pid)); selections = new Set(rows.filter(row => row.canEnd).map(row => row.id)); return {
      phase: rows.length ? 'blocked' : 'clear', processes: structuredClone(rows), canContinue: !rows.length,
      currentCount: running ? 1 : 0, totalCount: rows.length + (running ? 1 : 0),
      ...(running ? {current: {id:'current-selection', pid:1001, parentPid:process.pid, owner:'current', parentState:'alive', taskState:'unknown', canEnd:false, scope:'current-window',credentialScopeVerified:true}} : {})
    }; },
    async end(id) { record('end-one', id); throw new LiveError('OFFICIAL_PROCESS_END_UNAVAILABLE'); },
    async endMany(ids, signal) { record('end-many', [...ids]); if (ids.some(id => !selections.has(id)) || rows.some(row => !ids.includes(row.id))) throw new LiveError('OFFICIAL_PROCESS_SELECTION_STALE'); if (ui.endMany) return ui.endMany(ids, signal); rows = []; return ids.map(() => 'exited'); },
    invalidate() { selections.clear(); }
  };
  const controller = api.registerLiveUi(context, { service, locks, lifecycle: async() => {
    record('resolve-lifecycle'); if (rows.length) throw new LiveError('OFFICIAL_UNOWNED_HUB_TASK_UNKNOWN');
    return running ? backend : {...backend, generation:'stopped'};
  }, currentIdentity: async() => proof(), currentQuota: async() => proof(), processRecovery: recovery, changed: () => record('ui-state') });
  t.after(() => { context.subscriptions.forEach(subscription => subscription.dispose()); trace.push({ test: t.name, synthetic: true, events, warnings, final: controller.getState() }); });
  return { accounts, events, warnings, notifications, ui, state, data, context, controller, backend, service, locks, recovery, record, current: () => structuredClone(currentSlots), email: () => currentEmail, rows: () => rows, setRows: value => { rows = value; }, activity: value => { activity = value; }, call: (name, argument) => commands.get(`antigravityAccounts.live.${name}`)(argument) };
}
const count = (f, name) => f.events.filter(row => row.event === name).length;
const order = (f, before, after) => assert.ok(f.events.findIndex(row => row.event === before) < f.events.findIndex(row => row.event === after), `${before} must precede ${after}`);
function noBackendMutation(f) { for (const name of ['stop-hub','reload-hub','credential-write','begin-recovery','end-many','end-one']) assert.equal(count(f,name),0,name); }

// The selection lifecycle and birth proof are production code. Only the native
// process helper's scan/end replies are synthetic; no OS process is signalled.
function realRecovery(f, onScan) {
  const { OfficialProcessRecovery } = load('official-process-recovery');
  let scans = 0, currentPid = 1001, currentStart = '10001';
  const recovery = new OfficialProcessRecovery({ platform: 'linux',
    api: () => ({port:34567, csrfToken:'synthetic-official-csrf'}), assertCurrent() {},
    helper: async (request, _signal, authorize) => {
      if (request.operation === 'scan') {
        ++scans; onScan?.({scans, replaceCurrent: (pid, start) => {currentPid=pid;currentStart=start;}});
        f.record('native-helper-scan', {scans, currentPid, currentStart, pids:f.rows().map(row=>row.pid)});
        return {supported:true, processes:[
          {pid:currentPid,parentPid:process.pid,startTicks:currentStart,bootId:'00000000-0000-4000-8000-000000000000',commandHash:'a'.repeat(64),kind:'current-hub',scope:'current-window',credentialScopeVerified:true,parentState:'alive',canEnd:false},
          ...f.rows().map(row=>({pid:row.pid,parentPid:1,startTicks:String(row.pid),bootId:'00000000-0000-4000-8000-000000000000',commandHash:'b'.repeat(64),kind:'unowned-hub',scope:'detached',credentialScopeVerified:true,parentState:'gone',canEnd:true,startedAt:row.startedAt}))
        ]};
      }
      authorize?.(); f.record('native-helper-end', {pid:request.target.pid});
      f.setRows(f.rows().filter(row=>row.pid!==request.target.pid)); authorize?.(); return {result:'exited'};
    }
  });
  for (const name of ['scan','endMany','end','invalidate','currentProcessIdentity']) f.recovery[name]=recovery[name].bind(recovery);
  return recovery;
}

for (const leftover of [false,true]) test(`delete current A switches to usable B before deleting A (verified leftover: ${leftover})`, async t => {
  const f=fixture(t,{rows:leftover?[detached(710)]:[]});realRecovery(f);
  assert.equal(await f.service.savedLoginUsable(f.accounts[1]),true,'synthetic B must pass the real local readiness check');
  await f.call('remove',ACCOUNT_A);
  assert.equal(f.email(),'b@example.test');assert.deepEqual(f.controller.getAccounts().map(row=>row.id),[ACCOUNT_B]);
  assert.equal(count(f,'stop-hub'),1);assert.equal(count(f,'credential-write'),1);assert.equal(count(f,'native-helper-end'),leftover?1:0);
  assert.equal(f.warnings.length,2);assert.match(f.warnings[1].message,/PID 1001/);if(leftover)assert.match(f.warnings[1].message,/PID 710/);
  assert.equal(f.controller.getState().pending,false);assert.equal(f.controller.getState().processConflicts,undefined);
  order(f,'credential-write','vault-delete');assert.equal(f.data.has('live-switch.account.v1.'+ACCOUNT_A),false);
});

test('cancelling replacement scope after current-account delete confirmation preserves both copies and the official session', async t => {
  const f=fixture(t,{rows:[detached(710)]});realRecovery(f);const credentials=f.current(),index=structuredClone(f.state.get(INDEX));
  let confirmations=0;f.ui.warning=(_message,action)=>++confirmations===1?action:undefined;
  await f.call('remove',ACCOUNT_A);
  assert.equal(f.warnings.length,2);assert.equal(f.email(),'a@example.test');assert.deepEqual(f.current(),credentials);assert.deepEqual(f.state.get(INDEX),index);
  for(const event of ['stop-hub','credential-write','native-helper-end','vault-delete','begin-recovery'])assert.equal(count(f,event),0,event);
});

test('deleting the only current saved copy keeps the official login and the observer does not restore the deleted copy', async t => {
  const f=fixture(t);f.state.set(INDEX,[f.accounts[0]]);const credentials=f.current();
  await f.call('remove',ACCOUNT_A);
  assert.equal(f.email(),'a@example.test');assert.deepEqual(f.current(),credentials);assert.equal(f.controller.getAccounts().length,0);
  assert.equal(f.warnings.length,1);noBackendMutation(f);assert.equal(count(f,'scan-processes'),0);
  assert.ok(f.state.get('live-switch.removed-current.v1.'+HOST));await f.controller.refresh();assert.equal(f.controller.getAccounts().length,0);
});

test('same-capability current Hub replacement after detached batch completion blocks stop and credential writes', async t => {
  const f=fixture(t,{rows:[detached(710)]});realRecovery(f,({scans,replaceCurrent})=>{if(scans===2)replaceCurrent(2002,'20002');});
  await f.call('switch',ACCOUNT_B);assert.equal(count(f,'native-helper-end'),1);assert.equal(count(f,'stop-hub'),0);assert.equal(count(f,'credential-write'),0);
  assert.equal(f.email(),'a@example.test');assert.ok(f.controller.getState().error);assert.match(f.warnings[0].message,/PID 1001/);
});

test('same-capability current Hub replacement during lifecycle resolution is rejected by the final scan', async t => {
  const f=fixture(t,{rows:[detached(710)]});realRecovery(f,({scans,replaceCurrent})=>{if(scans===3)replaceCurrent(2002,'20002');});
  await f.call('switch',ACCOUNT_B);assert.equal(count(f,'native-helper-end'),1);assert.equal(count(f,'resolve-lifecycle'),1);
  assert.equal(count(f,'stop-hub'),0);assert.equal(count(f,'credential-write'),0);assert.equal(f.email(),'a@example.test');assert.ok(f.controller.getState().error);
});

test('cancelling a hidden switch preflight keeps existing conflict buttons bound to current production selection IDs', async t => {
  const f=fixture(t,{rows:[detached(710)]});realRecovery(f);
  await f.call('processScan');const old=f.controller.getState().processConflicts.processes[0].id;
  f.ui.consent=false;await f.call('switch',ACCOUNT_B);
  const displayed=f.controller.getState().processConflicts.processes[0];assert.equal(displayed.pid,710);assert.notEqual(displayed.id,old,'a hidden scan invalidated the old selection; the visible card must be refreshed');
  f.ui.consent=true;await f.call('processEnd',displayed.id);
  assert.equal(f.rows().length,0);assert.equal(count(f,'native-helper-end'),1);assert.equal(f.email(),'a@example.test');assert.equal(count(f,'credential-write'),0);
});

test.after(()=>{
  if(process.env.ACCOUNT_BACKEND_UI_TIMELINE){fs.mkdirSync(path.dirname(process.env.ACCOUNT_BACKEND_UI_TIMELINE),{recursive:true});fs.writeFileSync(process.env.ACCOUNT_BACKEND_UI_TIMELINE,JSON.stringify({moduleRoot:output,synthetic:true,realGoogleCalls:false,productionUi:true,productionAccountService:true,productionProcessRecovery:true,nativeProcessHelperSimulated:true,traces:trace},null,2)+'\n');}
});
