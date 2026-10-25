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
  const hosts = (options.normal && !options.multi ? [1] : [1, 2, 3]).map(pid => ({ pid, startIdentity: `host-${pid}` }));
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
  const local = { get generation() { return generation; }, restartMode:'component', assertCredentialWriteSafe:async()=>{if(options.version==='1.9.0'){require('../out/official-recovery-policy').assertCurrentRecoveryDisabled(options.autoRecover,options.disableOverride);}}, proof, stop: async () => {events.push('stop:1');hubs.delete(1);if(options.changeRecoveryDuringStop)options.autoRecover=true;}, reload: async () => {generation='normal-'+(++sequence);hubs.set(1,{pid:101,startIdentity:generation});} };
  const routeRecords = new Map();
  const repairedProofs = new Set();
  const stoppedBirths = new Map();
  const actorIds = new Set(); let activeGroupId;
  const components = { host: hosts[0], local: () => local, readFileRoute: async () => hubs.has(1), readCurrent: slots.read,
    census: async () => ({ complete: true, unknown: false, hosts: [...hosts], hubs: [...hubs.values()] }),
    mailbox: { hasRouteRepair:async id=>[...routeRecords.values()].some(r=>!id||r.transaction===id), recoverRoutes:async()=>{if(!options.routeLateReady)throw new LiveError('COMPONENT_ACTION_PENDING');for(const [pid] of routeRecords){hubs.set(pid,{pid:pid+301,startIdentity:'late-ready'});repairedProofs.add(pid);actorIds.delete(pid);routeRecords.delete(pid);}activeGroupId=undefined;}, requiresVerification:async id=>options.multi&&id===activeGroupId,recoveryHosts:async()=>hosts,hasRestoration: async transaction => transaction === undefined ? actorIds.size>0 || hubs.size < hosts.length : transaction === activeGroupId || transaction === seededId, restoreCompleted: async () => {
      if ((await locks.inspectRecovery()).state !== 'absent') throw new LiveError('RECOVERY_CHANGED');
      for (const host of hosts) if (!hubs.has(host.pid)) {
        if (options.resumeFailure === host.pid) throw new LiveError('COMPONENT_ACTION_PENDING');
        hubs.set(host.pid, { pid: host.pid + 200, startIdentity: 'committed-restore' });
      }
      for (const pid of [...actorIds]) {
        if (options.releaseFailure === pid) throw new LiveError('COMPONENT_ACTION_PENDING');
        actorIds.delete(pid);
      }
      if (!actorIds.size) activeGroupId = undefined;
    }, participant: (host,_operation,id) => ({ host,
      prepare: async () => {
        events.push(`prepare:${host.pid}`); if(id){activeGroupId=id;actorIds.add(host.pid);}
        if (options.unsupported === host.pid) throw new LiveError('COMPONENT_CONTRACT_UNSUPPORTED');
        if (options.routeMissing?.includes(host.pid) && !repairedProofs.has(host.pid)) {
          // Every missing participant reads the same startup text overwritten by
          // the last Hub. This exercises the real parser, not an invented code.
          const last=hosts.at(-1),lastHub=hubs.get(last.pid);
          const shared=`I1025 08:00:00.000001  1 server.go:1] Starting language server process with pid ${lastHub.pid}\nI1025 08:00:00.000002  1 server.go:2] Language server listening on random port at ${40000+last.pid} for HTTP\nI1025 08:00:00.000003  1 composite_token_storage.go:3] Using file-based token storage because WSL environment detected\n`;
          const reason=require('../out/live-wsl-proof').explainWslFileRoute(shared,hubs.get(host.pid).pid,40000+host.pid);
          assert.equal(reason,'pid-marker-mismatch');
          throw Object.assign(new LiveError('WSL_FILE_ROUTE_UNVERIFIED'),{fileRouteFailureReason:options.routeReason??reason});
        }
        return { host, hub: hubs.get(host.pid) ?? stoppedBirths.get(host.pid) ?? { pid: host.pid + 10, startIdentity: `hub-${host.pid}` }, contract: '1.8.0', ...(options.multi?{verification:'identity-v1'}:{}), ...(!hubs.has(host.pid) ? { stopped: true } : {}) };
      },
      repairRoute: async () => {
        assert.ok(events.includes('confirmation')); assert.ok(!events.includes('credential-write'));
        const {repairComponentRoute}=require('../out/component-route-repair');
        const {createWslReadGuard}=require('../out/live-wsl-proof');
        const birth=pid=>({pid,startIdentity:`linux:11111111-1111-1111-1111-111111111111:${pid}`});
        let current=birth(hubs.get(host.pid).pid),exited=false;
        const result=await repairComponentRoute(routeRecords.get(host.pid),{transaction:id,host:birth(host.pid),assertOwner:()=>locks.assertOperationHeld(),
          inspectOwned:async()=>{if(!current)throw new LiveError('OFFICIAL_HUB_NOT_READY');return current;},
          save:async record=>{routeRecords.set(host.pid,structuredClone(record));actorIds.add(host.pid);activeGroupId=id;events.push(`repair-save:${host.pid}:${record.phase}`);},
          stop:async()=>{events.push(`repair-stop:${host.pid}`);hubs.delete(host.pid);current=undefined;exited=true;},isStopped:async()=>exited,
          startOnce:async()=>{events.push(`repair-start:${host.pid}`);if(options.routeStartFailure===host.pid)throw new LiveError('OFFICIAL_COMPONENT_RESTART_TIMEOUT');current=birth(host.pid+300);hubs.set(host.pid,current);},
          observeStarted:async()=>{if(!current)throw new LiveError('OFFICIAL_HUB_NOT_READY');return current;},
          proveOwnRoute:async target=>{const port=40000+host.pid;const log=`I1025 08:00:00.000001  1 server.go:1] Starting language server process with pid ${options.routeWrongPid?999:target.pid}\nI1025 08:00:00.000002  1 server.go:2] Language server listening on random port at ${options.routeWrongPort?49999:port} for HTTP\nI1025 08:00:00.000003  1 composite_token_storage.go:3] Using file-based token storage because WSL environment detected\n`;const guard=createWslReadGuard('/synthetic','/synthetic/agy',()=>({port,csrfToken:'synthetic-capability'}),{process:async()=>({pid:target.pid,startTicks:String(target.pid)}),startup:async()=>log});if(!await guard())throw Object.assign(new LiveError('WSL_FILE_ROUTE_UNVERIFIED'),{fileRouteFailureReason:guard.fileRouteFailureReason});}
        });assert.equal(result.phase,'proved');repairedProofs.add(host.pid);if(options.newWindowAfterRepair){hosts.push({pid:99,startIdentity:'new-host'});hubs.set(99,{pid:199,startIdentity:'new-hub'});}if(options.replacedWindowAfterRepair){const at=hosts.findIndex(h=>h.pid===3);hosts[at]={pid:3,startIdentity:'replacement-host'};}
      },
      stop: async () => { events.push(`stop:${host.pid}`); stoppedBirths.set(host.pid,hubs.get(host.pid)); hubs.delete(host.pid); if (options.stopFailure === host.pid) throw new LiveError('OFFICIAL_BACKEND_STOP_TIMEOUT'); },
      resume: async () => { events.push(`resume:${host.pid}`); if (options.resumeFailure === host.pid) throw new LiveError('COMPONENT_ACTION_PENDING'); if (host.pid === 1) generation = `restart-${++sequence}`; hubs.set(host.pid, { pid: host.pid + 100 + sequence, startIdentity: generation }); },
      verify:async challenge=>{events.push(`verify:${host.pid}`);if(options.peerVerifyFailure===host.pid)throw new LiveError('HUB_RPC_FAILED');const email=current.file===token('a')?'a@example.test':'b@example.test';return{host,hub:hubs.get(host.pid),digest:require('node:crypto').createHmac('sha256',challenge).update(email).digest('hex')};},
      release: async () => { const repair=routeRecords.get(host.pid);if(repair&&repair.phase!=='proved')throw new LiveError('COMPONENT_RESTORE_REQUIRED');routeRecords.delete(host.pid); if(options.releaseFailure===host.pid)throw new LiveError('COMPONENT_ACTION_PENDING'); actorIds.delete(host.pid); if(!actorIds.size)activeGroupId=undefined; },
    }) },
  };
  if(options.multi)components.relatedCensus=components.census;
  const official = { id: 'google.google-antigravity', extensionKind: 1, extensionUri: uri('/synthetic-official'), extensionPath: '/synthetic-official', packageJSON: { version: options.version ?? '1.8.0', main: './extension.js' }, isActive: true, exports: { port: 34567, csrfToken: 'synthetic-capability' } };
  const vscode = {
    UIKind: { Desktop: 1 }, ExtensionKind: { UI: 1, Workspace: 2 }, ProgressLocation: { Notification: 1 }, Uri: { file: uri },
    env: { uiKind: 1 }, extensions: { getExtension: id => id === official.id ? official : undefined },
    workspace: { isTrusted: true, getConfiguration: () => ({ get: () => undefined }) },
    commands: { registerCommand: (name, fn) => { commands.set(name, fn); return { dispose() {} }; }, executeCommand: async name => { events.push(name); }, getCommands: async () => [] },
    window: { onDidChangeWindowState: () => ({ dispose() {} }),
      showWarningMessage: async (_message, _options, ...choices) => { events.push('confirmation'); if (options.confirmWait) await options.confirmWait; return options.cancel ? undefined : choices[options.choice ?? 0]; },
      showInformationMessage: async () => {}, showQuickPick: async choices => choices[0],
      showInputBox: async () => { throw Error('Normal flow must not request a password'); },
    },
  };
  const original = Module._load, entry = require.resolve('../out/live-ui');
  Module._load = function(name, ...args) { if(name==='./offline-ui'&&options.version==='1.9.0')return{registerOfflineUi:(_context,dependencies)=>({getStatus:()=>undefined,getHistory:()=>undefined,prepareAutomatic:async id=>{assert.equal(id,account.id);events.push('automatic-offline-prepare');if(options.offlineFailure){dependencies.stage(options.failureStage??'census');throw new LiveError(options.offlineFailure);}return true;}})};return name === 'vscode' ? vscode : original.call(this, name, ...args); };
  let register; try { delete require.cache[entry]; register = require(entry).registerLiveUi; } finally { Module._load = original; }
  const context = { extension: { extensionKind: 1 }, extensionUri: uri(root), globalStorageUri: uri(root), secrets: vault, subscriptions,
    globalState: { get: (key, fallback) => state.has(key) ? state.get(key) : fallback, update: async (key, value) => { state.set(key, value); } } };
  const createController = () => register(context, { changed: () => { if (typeof controller !== 'undefined') options.progress?.(controller.getState()); }, storageMode: 'wsl-file', service, locks, components, ...(options.normal?{lifecycle:async()=>options.practicalRecovery?{...local,get generation(){return hubs.has(1)?generation:'stopped';}}:local}:{}), currentIdentity: async () => undefined,
    processRecovery: { scan: async () => ({ phase: 'clear', processes: options.multi ? hosts.slice(1).filter(h=>hubs.has(h.pid)).map(h=>({id:'peer-'+h.pid,pid:hubs.get(h.pid).pid,parentPid:h.pid,owner:'other',credentialScopeVerified:true,canEnd:false,taskState:'unknown'})) : [], currentCount: 1, totalCount: hosts.length, canContinue: !!options.normal, current:{id:'current',pid:11,parentPid:1,owner:'current',scope:'current-window',credentialScopeVerified:true,parentState:'alive',taskState:'unknown',canEnd:false} }), end: async () => { throw Error('Must not kill peers'); }, invalidate() {} } });
  // Seed a transaction through real legacy coordinator/service, not a removed
  // normal dispatch. The UI below only consumes its existing recovery state.
  let seededGroup, seededId;
  async function seedLegacy() {
    const {ComponentCoordination}=require('../out/component-coordination'),{ComponentSwitch}=require('../out/component-switch');
    let failure;
    await locks.withOperation(async()=>{
      seededId=require('node:crypto').randomUUID();await locks.beginRecovery(seededId);
      seededGroup=new ComponentCoordination({census:components.census,assertOperation:()=>locks.assertOperationHeld(),participant:host=>components.mailbox.participant(host)});
      const driver=new ComponentSwitch({service,group:seededGroup,host:hosts[0],local,readFileRoute:components.readFileRoute,readCurrent:slots.read,assertOperation:()=>locks.assertOperationHeld(),index:{read:()=>state.get('live-switch.accounts.v1'),write:async rows=>state.set('live-switch.accounts.v1',rows)},finalizer:{prepare:(id,b)=>locks.prepareCompletion(id,b),pending:()=>locks.pendingCompletion(),identity:id=>locks.completionIdentity(id),clear:(id,m)=>locks.clearCompletedRecovery(id,m)}});
      try {await seededGroup.prepare();await driver.install(account.id,seededId);await seededGroup.close();}
      catch(error){failure=error;if(!await service.journal()){try{await seededGroup.close();if((await locks.inspectRecovery()).state!=='absent')await locks.clearRecovery(seededId);}catch{ /* Retain real outstanding restoration. */ }}else{try{await driver.restore(seededId);await seededGroup.close();}catch{ /* Preserve failed journal for UI verification. */ }}}
    });await controller.refresh();return failure;
  }
  async function retrySeedCleanup(){await locks.withOperation(async()=>{await seededGroup.close();await locks.clearRecovery(seededId);});await controller.refresh();}
  let controller; controller = createController();
  t.after(async () => { subscriptions.forEach(item => item.dispose()); await fs.rm(root, { recursive: true, force: true }); });
  await controller.refresh();
  return { get controller() { return controller; }, events, account, service, hubs, options, data, locks, state, local, seedLegacy, retrySeedCleanup,
    restartUi: async () => { subscriptions.splice(0).forEach(item => item.dispose()); controller = createController(); await controller.refresh(); },
    setCurrent: name => { current = { ...current, file: token(name) }; }, call: (name, target = account.id) => commands.get(`antigravityAccounts.live.${name}`)(name === 'switch' ? target : undefined),
    captureOther: async () => { const before = current; current = { ...current, file: token('a') }; const other = await service.capture({ label: 'A', expectedEmail: 'a@example.test', identitySource: 'user' }); current = before; state.set('live-switch.accounts.v1', [account, other]); return other; } };
}
test('normal WSL switch uses historical single-component path without cooperative preparation', async t => {
  const f = await fixture(t,{normal:true}); await f.call('switch');
  assert.equal(f.events.filter(value => value === 'confirmation').length, 1);
  assert.equal(f.events.filter(value => value === 'credential-write').length, 1);
  assert.ok(!f.events.some(value => value.includes('offline') || value.includes('reloadWindow')));
  assert.equal(f.hubs.size, 1); assert.equal(await f.service.journal(), null);
  assert.equal(f.controller.getState().activeEmail, 'b@example.test');
});
test('cancel interrupts no component and writes no credentials', async t => {
  const f = await fixture(t, { cancel: true,normal:true }); await f.call('switch');
  assert.ok(!f.events.some(value => value.startsWith('stop:') || value === 'credential-write')); assert.equal(f.hubs.size, 1);
});
test('unsupported participant fails before any stop or credential write', async t => {
  const f = await fixture(t, { unsupported: 2 }); await f.seedLegacy();
  assert.ok(!f.events.some(value => value.startsWith('stop:') || value === 'credential-write')); assert.equal(f.hubs.size, 3);
});
test('partial stop failure restores affected components without writing', async t => {
  const f = await fixture(t, { stopFailure: 2 }); await f.seedLegacy();
  assert.ok(!f.events.includes('credential-write')); assert.equal(f.hubs.size, 3); assert.equal(await f.service.journal(), null);
});
test('repeated switch click during confirmation cannot begin a second operation', async t => {
  let release; const confirmWait = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { confirmWait,normal:true }); const first = f.call('switch');
  for(let i=0;!f.events.includes('confirmation')&&i<200;i++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.ok(f.events.includes('confirmation'), f.controller.getState().error);
  await f.call('switch'); release(); await first;
  assert.equal(f.events.filter(value => value === 'confirmation').length, 1); assert.equal(f.events.filter(value => value === 'credential-write').length, 1);
});
test('pre-write failed legacy restoration retries its retained coordinator before clearing the matching marker', async t => {
  const f = await fixture(t, { stopFailure: 2, resumeFailure: 1 }); await f.seedLegacy();
  assert.ok(!f.events.includes('credential-write')); assert.equal((await f.locks.inspectRecovery()).state, 'active');
  assert.equal(f.controller.getState().pending, true);
  f.options.resumeFailure = undefined; f.options.stopFailure = undefined;
  await f.retrySeedCleanup();
  assert.equal(f.hubs.size, 3); assert.equal((await f.locks.inspectRecovery()).state, 'absent');
  assert.equal(f.controller.getState().recoveryPhase, 'none');
  assert.ok(!f.events.includes('credential-write'));
});
test('verification recovery restarts an adopted stopped verifier and completes the journal', async t => {
  const f = await fixture(t, { rpcFailure: true }); await f.seedLegacy();
  assert.ok(await f.service.journal()); f.options.rpcFailure = false;
  await f.call('verify');
  assert.equal(await f.service.journal(), null); assert.equal(f.hubs.size, 3);
  assert.equal(f.controller.getState().activeEmail, 'a@example.test');
});
test('explicit keep-current recovery preserves unknown credentials and the original encrypted backup', async t => {
  const f = await fixture(t, { rpcFailure: true }); await f.seedLegacy();
  const journal = await f.service.journal(); assert.ok(journal);
  f.setCurrent('external'); f.options.rpcFailure = false; f.options.choice = 2;
  const writes = f.events.filter(value => value === 'credential-write').length;
  await f.call('verify');
  assert.equal(await f.service.journal(), null); assert.equal(f.hubs.size, 3);
  assert.equal(f.events.filter(value => value === 'credential-write').length, writes);
  assert.ok([...f.data.keys()].some(key => key.endsWith(`.retained.${journal.id}`)));
});
test('committed switch with failed peer restoration retries without recreating recovery marker or writing again', async t => {
  const f = await fixture(t, { resumeFailure: 2 }); await f.seedLegacy();
  assert.equal(await f.service.journal(), null); assert.equal((await f.locks.inspectRecovery()).state, 'absent');
  assert.equal(f.hubs.has(2), false);
  assert.equal(f.controller.getState().recoveryPhase, 'cleanup'); assert.equal(f.controller.getState().pending, true);
  f.options.resumeFailure = undefined; await f.call('verify');
  assert.equal(f.hubs.size, 3); assert.equal((await f.locks.inspectRecovery()).state, 'absent');
  assert.equal(f.events.filter(value => value === 'credential-write').length, 1);
});
test('recreated UI discovers persistent component restoration and exposes retry without an in-memory abort', async t => {
  const f = await fixture(t, { resumeFailure: 2 }); await f.seedLegacy();
  await f.restartUi();
  assert.equal(f.controller.getState().componentRestoration, true);
  assert.equal(f.controller.getState().recoveryPhase, 'cleanup');
  f.options.resumeFailure = undefined; await f.call('verify');
  assert.equal(f.controller.getState().recoveryPhase, 'none'); assert.equal(f.hubs.size, 3);
  assert.equal(f.events.filter(value => value === 'credential-write').length, 1);
});

test('official 1.9 unsupported component admission never falls back to offline or cooperative switch',async t=>{const f=await fixture(t,{version:'1.9.0',normal:true,autoRecover:true});await f.call('switch');assert.equal(f.events.filter(e=>e==='automatic-offline-prepare').length,0);assert.ok(!f.events.some(e=>e.startsWith('prepare:')||e.startsWith('stop:')||e==='credential-write'));assert.equal(f.hubs.size,1);assert.ok(f.controller.getState().error);});

test('1.9 admission failure retains bounded cause without claiming successful switch',async t=>{const f=await fixture(t,{version:'1.9.0',normal:true,autoRecover:true});await f.call('switch');const failure=f.state.get('live-switch.lastFailure.v1');assert.equal(failure.code,'OFFICIAL_RECOVERY_ENABLED');assert.ok(f.controller.getState().error);assert.ok(!f.events.includes('credential-write'));assert.equal(f.hubs.size,1);});

// Real registerLiveUi + LiveSwitchService + lock/journal; lifecycle and RPC are
// synthetic. Uses the production current-configuration policy, not an always-pass
// 1.9 admission stub. This does not invoke a real official Hub.
test('default-disabled 1.9 completes normal component transaction and fresh identity', async t => {
  const f = await fixture(t, {version:'1.9.0', normal:true, practicalRecovery:true});
  await f.call('switch');
  assert.equal(f.events.filter(e=>e==='confirmation').length,1);
  assert.equal(f.events.filter(e=>e==='credential-write').length,1);
  assert.ok(f.events.indexOf('stop:1') < f.events.indexOf('credential-write'));
  assert.equal(f.controller.getState().activeEmail,'b@example.test');
  assert.equal(await f.service.journal(),null);
  assert.ok(!f.events.some(e=>e.includes('offline')||e.includes('reloadWindow')));
});
test('1.9 configuration change during stop prevents any credential write', async t => {
  const f = await fixture(t, {version:'1.9.0', normal:true, practicalRecovery:true, changeRecoveryDuringStop:true});
  await f.call('switch');
  assert.ok(!f.events.includes('credential-write'));
  assert.ok(f.controller.getState().error);
  assert.equal(f.hubs.size,1);
  assert.equal(await f.service.journal(),null);
  assert.equal(f.controller.getState().activeEmail,'a@example.test');
});
test('default-disabled 1.9 cancellation does not stop or write', async t => {
  const f = await fixture(t, {version:'1.9.0', normal:true, practicalRecovery:true, cancel:true});
  await f.call('switch'); assert.ok(!f.events.includes('stop:1')); assert.ok(!f.events.includes('credential-write'));
});
test('default-disabled 1.9 fresh RPC failure is not reported as successful switch', async t => {
  const f = await fixture(t, {version:'1.9.0', normal:true, practicalRecovery:true, rpcFailure:true});
  await f.call('switch'); assert.notEqual(f.controller.getState().activeEmail,'b@example.test');
  assert.ok(await f.service.journal());
});

// Practical recovery uses the same real service/lock as the installed path.
async function seedPractical(f) {
  await f.locks.withOperation(async () => {
    const id = require('node:crypto').randomUUID();
    await f.locks.beginRecovery(id);
    await f.service.install(f.account.id, f.local, id);
  });
  await f.controller.refresh();
  return f.service.journal();
}
test('1.9 practical installed pending verifies target without legacy group or rewrite', async t => {
  const f = await fixture(t, {version:'1.9.0',normal:true,practicalRecovery:true});
  const journal = await seedPractical(f); assert.equal(journal.phase,'installed');
  assert.equal((await f.locks.inspectRecovery()).state,'active');
  const writes = f.events.filter(x=>x==='credential-write').length;
  await f.call('verify');
  assert.equal(await f.service.journal(),null);
  assert.equal((await f.locks.inspectRecovery()).state,'absent');
  assert.equal(f.controller.getState().activeEmail,'b@example.test');
  assert.equal(f.events.filter(x=>x==='credential-write').length,writes);
  assert.ok(!f.events.some(x=>x.startsWith('prepare:')));
});
test('1.9 practical failed verify keeps installed target and backup, then retries', async t => {
  const f = await fixture(t, {version:'1.9.0',normal:true,practicalRecovery:true});
  const journal = await seedPractical(f); f.options.rpcFailure=true;
  const writes=f.events.filter(x=>x==='credential-write').length;
  await f.call('verify');
  assert.equal((await f.service.journal()).id,journal.id);
  assert.equal((await f.service.journal()).phase,'installed');
  assert.equal(f.events.filter(x=>x==='credential-write').length,writes);
  assert.equal(f.controller.getState().activeEmail,undefined);
  f.options.rpcFailure=false; await f.call('verify');
  assert.equal(await f.service.journal(),null);
  assert.equal(f.controller.getState().activeEmail,'b@example.test');
});
test('1.9 practical explicit restore uses local lifecycle, not legacy actors', async t => {
  const f=await fixture(t,{version:'1.9.0',normal:true,practicalRecovery:true});
  await seedPractical(f); await f.call('restore');
  assert.equal(await f.service.journal(),null);
  assert.equal(f.controller.getState().activeEmail,'a@example.test');
  assert.ok(!f.events.some(x=>x.startsWith('prepare:')));
});
test('other live host cannot verify or restore practical recovery and poll preserves it',async t=>{
  const f=await fixture(t,{version:'1.9.0',normal:true,practicalRecovery:true});
  const journal=await seedPractical(f), inspect=f.locks.inspectRecovery.bind(f.locks);
  f.locks.inspectRecovery=async()=>{const value=await inspect();return {...value,owner:{...value.owner,pid:process.pid+100000,startIdentity:'other-live-birth'}};};
  const writes=f.events.filter(x=>x==='credential-write').length;
  await f.controller.refresh(); await f.call('verify'); await f.call('restore');
  assert.equal((await f.service.journal()).id,journal.id);
  assert.equal(f.events.filter(x=>x==='credential-write').length,writes);
  assert.equal(f.state.get('live-switch.lastFailure.v1').code,'RECOVERY_LOCK_OWNER_MISMATCH');
});
test('unknown journal is preserved and never sent to legacy actors',async t=>{
  const f=await fixture(t,{version:'1.9.0',normal:true,practicalRecovery:true});
  f.data.set('live-switch.recovery.v1',JSON.stringify({schema:999,id:'unknown'}));
  await f.call('verify'); await f.call('restore');
  assert.equal(f.data.get('live-switch.recovery.v1'),JSON.stringify({schema:999,id:'unknown'}));
  assert.ok(!f.events.some(x=>x.startsWith('prepare:')||x==='credential-write'));
});

test('verify after completed 1.9 practical switch keeps current login without group preparation',async t=>{
 const f=await fixture(t,{version:'1.9.0',normal:true,practicalRecovery:true});
 await f.call('switch');const writes=f.events.filter(x=>x==='credential-write').length;
 await f.call('verify');
 assert.equal(f.controller.getState().activeEmail,'b@example.test');
 assert.equal(f.controller.getState().error,undefined);
 assert.equal(f.events.filter(x=>x==='credential-write').length,writes);
 assert.ok(!f.events.some(x=>x.startsWith('prepare:')));
});
test('normal multi-window switch stops all, writes once and verifies every restored host without killing peers',async t=>{
 const f=await fixture(t,{normal:true,multi:true});await f.call('switch');
 assert.equal(f.events.filter(x=>x==='confirmation').length,1);assert.equal(f.events.filter(x=>x==='credential-write').length,1);
 const write=f.events.indexOf('credential-write');for(const pid of [1,2,3]){assert.ok(f.events.indexOf('stop:'+pid)<write);assert.ok(f.events.indexOf('resume:'+pid)>write);assert.ok(f.events.includes('verify:'+pid));}
 assert.equal(f.hubs.size,3);assert.equal(await f.service.journal(),null);assert.equal(f.controller.getState().pending,false);assert.equal(f.controller.getState().activeEmail,'b@example.test');
});
test('multi-window unsupported participant fails before any stop or credential write',async t=>{
 const f=await fixture(t,{normal:true,multi:true,unsupported:2});await f.call('switch');assert.ok(!f.events.some(x=>x.startsWith('stop:')||x==='credential-write'));assert.equal(f.hubs.size,3);
});
test('multi-window fresh peer failure retains installed target and verify retries without another write',async t=>{
 const f=await fixture(t,{normal:true,multi:true,peerVerifyFailure:2});await f.call('switch');assert.equal((await f.service.journal()).phase,'installed');assert.equal(f.events.filter(x=>x==='credential-write').length,1);assert.equal(f.controller.getState().pending,true);assert.notEqual(f.controller.getState().activeEmail,'b@example.test');
 f.options.peerVerifyFailure=undefined;await f.call('verify');assert.equal(await f.service.journal(),null,JSON.stringify({events:f.events,state:f.controller.getState()}));assert.equal(f.events.filter(x=>x==='credential-write').length,1);assert.equal(f.hubs.size,3);
});
test('multi-window cancellation causes no stop and no write',async t=>{
 const f=await fixture(t,{normal:true,multi:true,cancel:true});await f.call('switch');assert.ok(!f.events.some(x=>x.startsWith('stop:')||x==='credential-write'));assert.equal(f.hubs.size,3);
});
test('multi-host installed resume failure keeps target and retry verifies without another write', async t => {
 const f=await fixture(t,{normal:true,multi:true,version:'1.9.0',resumeFailure:2});
 await f.call('switch');
 assert.equal((await f.service.journal()).phase,'installed');assert.equal(f.controller.getState().pending,true);
 assert.equal(f.events.filter(e=>e==='credential-write').length,1);
 const failure=f.state.get('live-switch.lastFailure.v1');
 assert.equal(failure.code,'COMPONENT_RESTORE_FAILED');assert.equal(failure.componentFailures[0].hostPid,2);
 f.options.resumeFailure=undefined;await f.call('verify');
 assert.equal(await f.service.journal(),null);assert.equal(f.controller.getState().pending,false);
 assert.equal(f.events.filter(e=>e==='credential-write').length,1);
});

test('primary prepare failure survives cleanup failure in final persisted UI record',async t=>{
 const f=await fixture(t,{normal:true,multi:true,unsupported:2,releaseFailure:1});
 await f.call('switch');
 const record=f.state.get('live-switch.lastFailure.v1');
 assert.equal(record.code,'COMPONENT_CONTRACT_UNSUPPORTED');assert.equal(record.recoveryCode,'COMPONENT_RESTORE_FAILED');
 assert.equal(f.events.includes('credential-write'),false);assert.equal(f.controller.getState().pending,true);
});


function assertCommittedPending(f) {
  const state = f.controller.getState();
  assert.equal(state.accountResult.account, 'committed'); assert.equal(state.accountResult.components, 'pending');
  assert.equal(state.accountCommitted, true); assert.equal(state.pending, true);
  assert.equal(state.activeEmail, undefined);
  assert.match(state.status, /verified and committed|核验并提交/);
  assert.match(state.status, /cleanup is incomplete|收尾尚未完成/);
  assert.doesNotMatch(state.status, /switch failed|切号失败|切换失败/i);
}
for (const recreate of [false, true]) test(`real UI retains committed account across failed release and read-only cleanup retry${recreate ? ' after UI recreation' : ''}`, async t => {
  const f = await fixture(t, { normal: true, multi: true, releaseFailure: 2 });
  await f.call('switch');
  assert.equal(await f.service.journal(), null);
  assert.equal((await f.service.accountResult()).account, 'committed');
  assert.equal((await f.service.accountResult()).components, 'pending');
  assert.equal(f.events.filter(e => e === 'credential-write').length, 1);
  assertCommittedPending(f);
  if (recreate) { await f.restartUi(); assertCommittedPending(f); }
  f.options.releaseFailure = undefined;
  await f.call('verify');
  assert.equal((await f.service.accountResult()).components, 'complete');
  assert.equal(f.controller.getState().pending, false);
  assert.equal(f.events.filter(e => e === 'credential-write').length, 1);
  assert.equal(await f.service.journal(), null);
});

test('a later different account transaction failure is not described as the previous committed success', async t => {
  const f = await fixture(t, { normal: true, multi: true }); const other = await f.captureOther();
  await f.call('switch');
  const previous = await f.service.accountResult(); assert.equal(previous.account, 'committed');
  f.options.unsupported = 2;
  await f.call('switch', other.id);
  const state = f.controller.getState();
  assert.ok(state.error); assert.equal(f.state.get('live-switch.lastFailure.v1').code, 'COMPONENT_CONTRACT_UNSUPPORTED');
  assert.doesNotMatch(state.error, /verified and committed|核验并提交/);
  assert.doesNotMatch(state.status, /verified and committed|核验并提交/);
  assert.notEqual(state.accountCommitted, true);
  assert.equal(f.events.filter(e => e === 'credential-write').length, 1);
});

for (const phase of ['restored', 'absent']) test(`historical verified archive does not project verified-pending after journal is ${phase}`, async t => {
  const f = await fixture(t, { normal: true, version: '1.9.0', practicalRecovery: true });
  const journal = await seedPractical(f);
  await f.locks.withOperation(async () => {
    // Real service persists verified evidence before a synthetic finalizer
    // preparation failure; no completion receipt or account commit is produced.
    await assert.rejects(f.service.finishVerified(f.local, undefined, undefined, {
      prepare: async () => { throw Error('SYNTHETIC_PREPARE_FAILURE'); },
      pending: async () => null, identity: async () => null,
      clear: async () => { throw Error('UNEXPECTED_CLEAR'); },
    }), /RECOVERY_CLEANUP_PENDING/);
    assert.equal((await f.service.accountResult(journal.id)).account, 'verified');
    assert.equal(await f.service.hasCompletion(), false);
    await f.service.restore(f.local);
    assert.equal((await f.service.journal()).phase, 'restored');
    if (phase === 'absent') {
      await f.service.finishVerified(f.local);
      await f.locks.clearRecovery(journal.id);
      assert.equal(await f.service.journal(), null);
    }
  });
  const writes = f.events.filter(e => e === 'credential-write').length;
  assert.equal(writes, 2); // One install and one explicit fixture restore.
  await f.controller.refresh();
  await f.restartUi();
  assert.equal((await f.service.accountResult(journal.id)).account, 'verified');
  const state = f.controller.getState();
  assert.notEqual(state.accountCommitted, true);
  assert.doesNotMatch(state.status, /verified.*commit|目标账号已于.*核验|提交收尾尚未完成/i);
  assert.equal(f.events.filter(e => e === 'credential-write').length, writes);
});

test('multi-window switch exposes actual phases/counts and stores bounded monotonic timing without account data',async t=>{
 const {DebugRecorder,installDebugRecorder}=require('../out/debug-events');
 const recorder=new DebugRecorder({append:async()=>{},readLines:async()=>[],flush:async()=>{},dispose(){}},{version:'0.1.18',platform:'linux',host:'wsl'});await recorder.setEnabled(true);const registration=installDebugRecorder(recorder);t.after(()=>registration.dispose());
 const observations=[];const f=await fixture(t,{multi:true,progress:state=>{if(state.switchProgress)observations.push(structuredClone(state.switchProgress));}});
 await f.call('switch');
 for(const stage of ['prepare','confirm','stop','write','resume','verify','cleanup'])assert.ok(observations.some(p=>p.stage===stage),stage);
 assert.ok(observations.some(p=>p.stage==='resume'&&p.completed===3&&p.total===3));
 assert.ok(observations.some(p=>p.stage==='verify'&&p.completed===3&&p.total===3));
 assert.equal(f.controller.getState().switchProgress,undefined);
 const timing=f.state.get('live-switch.timing.v1');assert.equal(timing.outcome,'completed');assert.ok(Number.isInteger(timing.elapsedMs)&&timing.elapsedMs>=0);
 assert.ok(timing.stages.every(p=>Number.isInteger(p.elapsedMs)&&p.elapsedMs>=0));
 assert.ok(timing.waits.some(w=>w.wait==='fresh-identity-ack'&&w.total===3));
 assert.ok(timing.waits.some(w=>w.wait==='backend-ready-ack'&&w.total===3));
 assert.doesNotMatch(JSON.stringify(timing),/example|synthetic-|token|csrf|accountId|pid|path/);
});

test('ordinary successful switch retains inline progress but does not persist performance sampling',async t=>{const seen=[];const f=await fixture(t,{multi:true,progress:s=>{if(s.switchProgress)seen.push(s.switchProgress.stage);}});await f.call('switch');assert.ok(seen.includes('verify'));assert.equal(f.state.has('live-switch.timing.v1'),false);});

for(const missing of [[1],[2],[1,2]])test('confirmed switch repairs missing own proof before write: '+missing.join(','),async t=>{
 const f=await fixture(t,{multi:true,routeMissing:missing});await f.call('switch');
 assert.equal(f.events.filter(e=>e==='credential-write').length,1);assert.equal(f.controller.getState().pending,false);
 for(const pid of missing){assert.equal(f.events.filter(e=>e===`repair-start:${pid}`).length,1);assert.ok(f.events.indexOf(`repair-save:${pid}:prepared`)<f.events.indexOf(`repair-stop:${pid}`));assert.ok(f.events.indexOf(`repair-save:${pid}:proved`)<f.events.indexOf('credential-write'));}
});
test('cancelled switch never repairs missing proof or writes',async t=>{const f=await fixture(t,{multi:true,routeMissing:[1,2],cancel:true});await f.call('switch');assert.ok(!f.events.some(e=>e.startsWith('repair-')||e==='credential-write'));});
for(const fault of [{routeStartFailure:2},{routeWrongPid:true},{routeWrongPort:true},{routeReason:'inode-mismatch'},{routeReason:'host-mismatch'}])test('route repair failure cannot reach write '+JSON.stringify(fault),async t=>{const f=await fixture(t,{multi:true,routeMissing:[2],...fault});await f.call('switch');assert.ok(!f.events.includes('credential-write'));assert.ok(f.controller.getState().error);if(fault.routeStartFailure||fault.routeWrongPid||fault.routeWrongPort)assert.notEqual((await f.locks.inspectRecovery()).state,'absent');else assert.ok(!f.events.some(e=>e.startsWith('repair-stop')));});

test('route repair timeout survives UI recreation with reachable no-journal recovery and no rewrite',async t=>{
 const f=await fixture(t,{multi:true,routeMissing:[2],routeStartFailure:2});await f.call('switch');assert.equal(await f.service.journal(),null);await f.restartUi();
 assert.equal(f.controller.getState().componentRestoration,true);assert.equal(f.controller.getState().recoveryPhase,'cleanup');assert.equal(f.controller.getState().pending,true);
 f.options.routeLateReady=true;await f.call('verify');assert.ok(!f.events.includes('credential-write'));assert.equal(f.events.filter(e=>e==='repair-start:2').length,1);assert.equal(f.controller.getState().pending,false);
});
test('route recovery followed by peer release failure remains reachable after a second UI recreation',async t=>{
 const f=await fixture(t,{multi:true,routeMissing:[2],routeStartFailure:2,releaseFailure:1});await f.call('switch');await f.restartUi();
 f.options.routeLateReady=true;await f.call('verify');assert.ok(!f.events.includes('credential-write'));await f.restartUi();assert.equal(f.controller.getState().componentRestoration,true);assert.equal(f.controller.getState().recoveryPhase,'cleanup');
 f.options.releaseFailure=undefined;await f.call('verify');assert.equal(f.controller.getState().pending,false);assert.ok(!f.events.includes('credential-write'));assert.equal(f.events.filter(e=>e==='repair-start:2').length,1);
});

for(const change of ['newWindowAfterRepair','replacedWindowAfterRepair'])test('post-repair census refuses unconfirmed window '+change,async t=>{
 const f=await fixture(t,{multi:true,routeMissing:[1],[change]:true});await f.call('switch');assert.ok(!f.events.includes('credential-write'));assert.ok(!f.events.some(e=>e==='stop:99'||e==='stop:3'));assert.equal(f.state.get('live-switch.lastFailure.v1').code,'COMPONENT_PARTICIPANTS_CHANGED');
});
