const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { createHash, randomUUID } = require('node:crypto');
const uri = value => ({scheme:'file',authority:'',query:'',fragment:'',fsPath:value,toString:()=>`file://${value}`});

// Exercise the registered product commands and native componentReady branch.
// Native IPC, durable core state and credentials are synthetic boundaries here;
// requestHostRecovery/observeHostRecovery are the real live-ui implementations.
async function fixture(t, options={}) {
  const events=[], commands=new Map(), subscriptions=[], state=new Map();
  const host={pid:process.pid,startIdentity:'linux:00000000-0000-0000-0000-000000000000:100'};
  const peer={pid:process.pid+100000,startIdentity:'linux:00000000-0000-0000-0000-000000000000:200'};
  const workspaceKey=createHash('sha256').update(JSON.stringify(['wsl','file:///synthetic/workspace'])).digest('hex');
  const journalId=randomUUID();
  let result=options.result?{id:journalId,targetId:'target',account:options.result,components:'pending',verifiedAt:new Date().toISOString()}:null;
  let markerCreated=false;
  let journal=options.phase==='none'||options.phase==='cleanup'?undefined:{id:journalId,phase:'installed',target:{id:'target'},backup:{keyring:null,file:'synthetic',keyringState:'unobserved'}};
  const rows=[{host,workspaceKey,lastHub:{pid:10001,startIdentity:'hub-one'}},{host:peer,workspaceKey:'b'.repeat(64),lastHub:{pid:10002,startIdentity:'hub-two'}}];
  let handoff=options.handoff?{attempt:randomUUID(),journalId,targetId:'target',phase:options.handoffPhase??'dispatched',originalOwner:peer,owner:peer,participants:rows.map(r=>({...r,hubs:[r.lastHub]})),claims:[],dispatched:[]}:undefined;
  if(handoff&&options.postRestart){handoff.owner=host;handoff.claims=rows.map(r=>({workspaceKey:r.workspaceKey,host:r.host}));markerCreated=true;}
  const retired={pid:process.pid+200000,startIdentity:'linux:00000000-0000-0000-0000-000000000000:300'};
  if(handoff&&options.retired)handoff.retiredBirths=[retired];
  let held=false, nativeStarted=false, completionPending=options.phase==='cleanup', finishArgs, markerAbsent=false, changedBirth=false;

  const operation=()=>({state:'active',owner:{id:'operation',owner:'owner',...host}});
  const locks={withOperation:async fn=>{held=true;try{return await fn();}finally{held=false;}},inspectOperation:async()=>held?operation():{state:'absent'},
    inspectRecovery:async()=>(journal||markerCreated)&&!markerAbsent?{state:'active',owner:{schema:2,id:journalId,...host}}:{state:'absent'},
    ownsOperation:()=>held,isOperationCurrent:async()=>held,assertRecovery:async()=>{},hasRecovery:async()=>!!journal,
    hasCompletionFence:async()=>completionPending,prepareCompletion:async()=>{},pendingCompletion:async()=>undefined,
    completionIdentity:async()=>undefined,clearCompletedRecovery:async()=>{events.push('completion-clear');completionPending=false;},
    ...((options.completionReceipt||options.result)?{reconcileRecovery:async id=>{events.push('reconcile');if(id){assert.equal(id,journalId);markerCreated=true;events.push('marker-create');}}}:{}),clearRecovery:async id=>{assert.equal(id,journalId);events.push('marker-clear');markerCreated=false;}};
  class SyntheticService {
    journal=async()=>journal;hasCompletion=async()=>completionPending;hostIsCurrent=()=>true;
    accountResult=async()=>structuredClone(result);
    markComponentsComplete=async()=>{events.push('components-complete');result={...result,components:'complete'};};
    verifyCommitted=async(lifecycle,id)=>{assert.equal(id,journalId);events.push('verify-committed');const proof=await lifecycle.proof();assert.equal(proof.email,'synthetic@example.test');return proof;};
    account=async()=>({id:'target',expectedEmail:'synthetic@example.test'});
    finishVerified=async()=>{events.push('finish-verified');throw Error('ACK must never finish identity verification');};
    resumeCompletion=async finalizer=>{if(!options.completionReceipt||!completionPending)return false;events.push('completion-resume');await finalizer.clear(journalId,'synthetic-receipt-marker');return true;};
  }
  class SyntheticSlots {
    mode=async()=> 'wsl-file';read=async()=>{events.push('slot-read');throw Error('Unexpected credential read');};
    write=async()=>{events.push('slot-write');throw Error('Unexpected credential write');};
  }
  class CoreState {
    read=async()=>structuredClone(handoff);
    prepare=async value=>{events.push('handoff-prepare');handoff={...value,journalId:value.journal.id,targetId:'target',originalOwner:value.owner,phase:'prepared',claims:[],dispatched:[]};};
    markDispatchOnce=async(_attempt,key)=>{if(handoff.dispatched.includes(key))return false;handoff.dispatched.push(key);return true;};
    claim=async()=>{events.push('claim');throw Error('Alive original owner cannot be claimed');};
    verifyAll=async()=>{events.push('handoff-verify');if(!options.postRestart)throw Error('Not all new hosts exist');};
    complete=async()=>{events.push('complete');handoff={...handoff,phase:'complete'};};
  }
  let restartOptions;
  class SyntheticMailbox {
    constructor(_directory,_host,_locks,_create,_state,_inspect,restart){restartOptions=restart;}
    start=async()=>{nativeStarted=true;};dispose=()=>{};
    finishHostRecovery=async(...args)=>{finishArgs=args;events.push('finish-host-recovery');};
    recoveryParticipants=async(id,includeReleased)=>{assert.equal(id,journalId);if(options.result)assert.equal(includeReleased,true);return rows;};
    rebindReleased=async(id,op,selected)=>{assert.equal(id,journalId);assert.equal(op.state,'active');assert.ok(rows.some(r=>r.host.pid===selected.pid&&r.host.startIdentity===selected.startIdentity));events.push(`rebind:${selected.pid}`);};
    hasRestoration=async()=>false;
    participant=(selected)=>({requestRestart:async()=>{
      events.push(`restart-request:${selected.pid}`);
      if(selected.pid===host.pid){const dispatch=await restartOptions.restartHost(journalId);
        if(options.beforeEffect)await options.beforeEffect({
          releaseOperation:()=>{held=false;events.push('operation-released');},
          changeAttempt:()=>{handoff={...handoff,attempt:randomUUID()};},
          changeJournal:patch=>{journal={...journal,...patch};},
          removeMarker:()=>{markerAbsent=true;},expire:()=>{handoff={...handoff,deadline:Date.now()-1};},
          changeBirth:()=>{changedBirth=true;},changeResult:patch=>{result={...result,...patch};},
        });
        await dispatch();}
      else {handoff.dispatched.push(rows[1].workspaceKey);events.push('peer-ack');}
    },prepare:async()=>{events.push('automatic-prepare');throw Error('No automatic fallback');},stop:async()=>{events.push('automatic-stop');},resume:async()=>{events.push('automatic-resume');}});
  }
  const official={id:'google.google-antigravity',isActive:true,extensionKind:2,extensionUri:uri('/synthetic/official'),extensionPath:'/synthetic/official',packageJSON:{version:'1.9.0',main:'extension.js'},exports:{port:45678,csrfToken:'synthetic-capability'}};
  const vscode={UIKind:{Desktop:1},ExtensionKind:{UI:1,Workspace:2},ProgressLocation:{Notification:1},Uri:{file:uri},env:{uiKind:1,remoteName:'wsl'},
    extensions:{getExtension:id=>id===official.id?official:undefined},workspace:{isTrusted:true,workspaceFolders:[{uri:uri('/synthetic/workspace')}],textDocuments:[],
      getConfiguration:()=>({get:()=>undefined,update:async()=>{events.push('configuration-write');throw Error('No profile/settings changes permitted');}}),saveAll:async()=>{events.push('save');return !options.cancelSave;}},
    commands:{registerCommand:(name,fn)=>{commands.set(name,fn);return{dispose(){}};},getCommands:async()=>['workbench.action.restartExtensionHost'],executeCommand:async name=>{events.push(name);}},
    window:{onDidChangeWindowState:()=>({dispose(){}}),showWarningMessage:async(_m,_o,...choices)=>{events.push('confirmation');return options.cancel?undefined:choices[0];},showInformationMessage:async()=>{events.push('information');}}};
  const original=Module._load, entry=require.resolve('../out/live-ui');
  Module._load=function(name,...args){
    if(name==='vscode')return vscode;
    if(name==='./live-switch')return {...original.call(this,name,...args),LiveSwitchService:SyntheticService};
    if(name==='./live-environment')return {...original.call(this,name,...args),EnvironmentTokenSlots:SyntheticSlots};
    if(name==='./native-host')return {...original.call(this,name,...args),resolveCredentialHostId:async()=> 'synthetic-binding',assertNativeHost:()=>{},nativeHostStatus:()=>({available:true})};
    if(name==='./official-process')return {...original.call(this,name,...args),inspectWslProcesses:async()=>({processes:[]})};
    if(name==='./live-lock')return {...original.call(this,name,...args),probeProcessIdentity:async pid=>({state:'alive',startIdentity:pid===host.pid?(changedBirth?'linux:00000000-0000-0000-0000-000000000000:101':host.startIdentity):peer.startIdentity})};
    if(name==='./official-process')return {...original.call(this,name,...args),inspectWslProcesses:async()=>({processes:[]})};
    if(name==='./live-wsl-proof')return {...original.call(this,name,...args),readPinnedWslProcess:async()=>({pid:10001,startTicks:'200'}),createWslReadGuard:()=>async()=>true};
    if(name==='./live-hub'){const actual=original.call(this,name,...args);return {...actual,queryFreshIdentity:async api=>{events.push('fresh-rpc');return{email:'synthetic@example.test',generation:actual.generation(api),authValid:true,quotaSource:'server',observedAt:new Date().toISOString(),buckets:[]};}};}
    if(name==='./component-mailbox')return {ComponentMailbox:SyntheticMailbox};
    if(name==='./component-host-recovery')return {...original.call(this,name,...args),ComponentHostRecovery:CoreState};
    if(name==='./offline-ui')return {registerOfflineUi:()=>({getStatus:()=>undefined,getHistory:()=>undefined})};
    return original.call(this,name,...args);
  };
  let register;try{delete require.cache[entry];register=require(entry).registerLiveUi;}finally{Module._load=original;}
  const context={extension:{extensionKind:2},extensionUri:uri('/synthetic/extension'),globalStorageUri:uri('/synthetic/storage'),subscriptions,
    secrets:{get:async()=>undefined,store:async()=>{events.push('secret-write');},delete:async()=>{events.push('secret-delete');}},
    globalState:{get:(key,fallback)=>state.has(key)?state.get(key):fallback,update:async(key,value)=>state.set(key,value)}};
  const controller=register(context,{locks,currentIdentity:async()=>undefined,processRecovery:{invalidate(){},scan:async()=>({phase:'clear',processes:[],currentCount:1,totalCount:1,canContinue:true})}});
  t.after(()=>subscriptions.forEach(s=>s.dispose()));
  await controller.refresh();assert.equal(nativeStarted,true,'exercise real componentReady native registration');
  return {events,controller,call:async name=>{const fn=commands.get(`antigravityAccounts.live.${name}`);assert.equal(typeof fn,'function');await fn();},getHandoff:()=>handoff,getFinishArgs:()=>finishArgs,retired};
}
function noWritesOrWindowActions(f){assert.ok(!f.events.some(e=>['slot-write','secret-write','secret-delete','configuration-write','workbench.action.reloadWindow','workbench.action.closeWindow','workbench.action.quit'].includes(e)),JSON.stringify(f.events));}
for(const phase of ['none','cleanup'])test(`recoverHosts ${phase} refuses before confirmation or restart`,async t=>{
  const f=await fixture(t,{phase});await f.call('recoverHosts');
  assert.ok(f.controller.getState().error);assert.ok(!f.events.some(e=>e==='confirmation'||e.startsWith('restart-request:')));noWritesOrWindowActions(f);
});
test('installed recovery cancelled confirmation dispatches zero restart requests',async t=>{
  const f=await fixture(t,{cancel:true});await f.call('recoverHosts');
  assert.equal(f.events.filter(e=>e==='confirmation').length,1);assert.ok(!f.events.some(e=>e.startsWith('restart-request:')));assert.equal(f.getHandoff(),undefined);noWritesOrWindowActions(f);
});
test('installed two-peer acknowledgements stay pending, never report verified success',async t=>{
  const f=await fixture(t);await f.call('recoverHosts');
  assert.equal(f.events.filter(e=>e.startsWith('restart-request:')).length,2);
  assert.ok(f.events.indexOf('peer-ack')<f.events.indexOf('workbench.action.restartExtensionHost'));
  assert.equal(f.events.filter(e=>e==='save').length,1);
  assert.ok(!f.events.includes('finish-verified')&&!f.events.includes('complete'));
  assert.equal(f.controller.getState().error,undefined);assert.equal(f.controller.getState().pending,true);assert.equal(f.controller.getState().activeEmail,undefined);noWritesOrWindowActions(f);
});
for(const command of ['restore','verify'])test(`${command} with live handoff observes instead of automatic stop/resume`,async t=>{
  const f=await fixture(t,{handoff:true});await f.call(command);
  assert.ok(!f.events.some(e=>e.startsWith('automatic-')||e.startsWith('restart-request:')));
  assert.equal(f.controller.getState().pending,true);assert.equal(f.controller.getState().activeEmail,undefined);noWritesOrWindowActions(f);
});

test('local save cancellation after peer ACK retains pending handoff without local restart',async t=>{
  const f=await fixture(t,{cancelSave:true});await f.call('recoverHosts');
  assert.ok(f.events.includes('peer-ack'));assert.ok(f.events.includes('save'));
  assert.ok(!f.events.includes('workbench.action.restartExtensionHost'));
  assert.ok(!f.events.includes('finish-verified'));assert.ok(f.getHandoff());
  assert.equal(f.controller.getState().pending,true);noWritesOrWindowActions(f);
});

test('cancelled undispatched handoff does not block real completion finalizer clear',async t=>{
  const f=await fixture(t,{phase:'cleanup',handoff:true,handoffPhase:'cancelled',completionReceipt:true});
  assert.deepEqual(f.getHandoff().dispatched,[]);assert.deepEqual(f.getHandoff().claims,[]);
  assert.ok(f.events.includes('completion-resume'));
  assert.equal(f.events.filter(e=>e==='completion-clear').length,1);
  assert.ok(!f.events.includes('handoff-verify'));assert.ok(!f.events.includes('complete'));
  assert.equal(f.controller.getState().pending,false);assert.equal(f.controller.getState().error,undefined);
  assert.ok(!f.events.some(e=>e.startsWith('restart-request:')));noWritesOrWindowActions(f);
});
test('complete handoff cleanup includes retired births without fresh verification or restart',async t=>{
  const f=await fixture(t,{phase:'cleanup',handoff:true,handoffPhase:'complete',completionReceipt:true,retired:true});
  const args=f.getFinishArgs();assert.ok(args,'native observe complete path invoked mailbox cleanup');
  const handoff=f.getHandoff();
  assert.equal(args[0],handoff.journalId);
  assert.deepEqual(args[2],[...handoff.participants.map(p=>p.host),f.retired]);
  assert.deepEqual(args[3],handoff.claims.map(c=>c.host));
  assert.equal(f.events.filter(e=>e==='completion-clear').length,1);
  assert.ok(!f.events.some(e=>e==='handoff-verify'||e==='finish-verified'||e.startsWith('restart-request:')||e==='workbench.action.restartExtensionHost'));
  assert.equal(f.controller.getState().pending,false);assert.equal(f.controller.getState().activeEmail,undefined);
  assert.equal(f.controller.getState().error,undefined);noWritesOrWindowActions(f);
});

test('ACK effect permits released operation only while exact durable recovery authority remains',async t=>{
  const f=await fixture(t,{beforeEffect:async hook=>hook.releaseOperation()});await f.call('recoverHosts');
  assert.ok(f.events.includes('operation-released'));
  assert.equal(f.events.filter(e=>e==='workbench.action.restartExtensionHost').length,1);
  assert.equal(f.controller.getState().error,undefined);noWritesOrWindowActions(f);
});
for(const [name,change] of [
  ['attempt',h=>h.changeAttempt()],
  ['journal target',h=>h.changeJournal({target:{id:'different-target'}})],
  ['journal phase',h=>h.changeJournal({phase:'prepared'})],
  ['journal id',h=>h.changeJournal({id:randomUUID()})],
  ['absent recovery marker',h=>h.removeMarker()],
  ['expired consent',h=>h.expire()],
  ['host birth',h=>h.changeBirth()],
])test(`ACK effect refuses changed ${name} before executing restart`,async t=>{
  const f=await fixture(t,{beforeEffect:async hook=>{hook.releaseOperation();change(hook);}});await f.call('recoverHosts');
  assert.ok(f.events.includes('operation-released'));
  assert.equal(f.events.filter(e=>e==='workbench.action.restartExtensionHost').length,0);
  assert.ok(f.controller.getState().error);noWritesOrWindowActions(f);
});

test('committed pending result with no journal rebinds exact released participants only after consent',async t=>{
  const f=await fixture(t,{phase:'none',result:'committed'});await f.call('recoverHosts');
  assert.equal(f.events.filter(e=>e==='marker-create').length,1);
  assert.equal(f.events.filter(e=>e.startsWith('rebind:')).length,2);
  assert.ok(f.events.indexOf('confirmation')<f.events.indexOf('marker-create'));
  assert.ok(f.events.findLastIndex(e=>e.startsWith('rebind:'))<f.events.findIndex(e=>e.startsWith('restart-request:')));
  assert.equal(f.events.filter(e=>e==='workbench.action.restartExtensionHost').length,1);
  assert.equal(f.controller.getState().error,undefined);noWritesOrWindowActions(f);
});
test('verified but not committed no-journal evidence refuses restart',async t=>{
  const f=await fixture(t,{phase:'none',result:'verified'});await f.call('recoverHosts');
  assert.ok(f.controller.getState().error);assert.ok(!f.events.includes('confirmation'));
  assert.ok(!f.events.includes('marker-create'));assert.ok(!f.events.some(e=>e.startsWith('restart-request:')));noWritesOrWindowActions(f);
});
test('committed recovery cancelled confirmation does not create marker or rebind',async t=>{
  const f=await fixture(t,{phase:'none',result:'committed',cancel:true});await f.call('recoverHosts');
  assert.ok(f.events.includes('confirmation'));assert.ok(!f.events.includes('marker-create'));
  assert.ok(!f.events.some(e=>e.startsWith('rebind:')||e.startsWith('restart-request:')));noWritesOrWindowActions(f);
});
for(const patch of [{targetId:'changed'},{account:'verified'},{components:'complete'}])test(`committed ACK effect refuses changed evidence ${JSON.stringify(patch)}`,async t=>{
  const f=await fixture(t,{phase:'none',result:'committed',beforeEffect:async h=>{h.releaseOperation();h.changeResult(patch);}});await f.call('recoverHosts');
  assert.equal(f.events.filter(e=>e==='workbench.action.restartExtensionHost').length,0);
  assert.ok(f.controller.getState().error);noWritesOrWindowActions(f);
});
test('postrestart committed recovery uses read-only verifyCommitted without stop or write',async t=>{
  const f=await fixture(t,{phase:'none',result:'committed',handoff:true,postRestart:true});
  assert.ok(f.events.includes('verify-committed'),JSON.stringify({events:f.events,state:f.controller.getState()}));assert.ok(f.events.includes('fresh-rpc'));
  assert.ok(f.events.includes('handoff-verify'));assert.ok(f.events.includes('components-complete'));
  assert.ok(!f.events.some(e=>e.startsWith('automatic-')||e.startsWith('restart-request:')||e==='slot-read'));
  assert.equal(f.controller.getState().error,undefined);assert.equal(f.controller.getState().pending,false);noWritesOrWindowActions(f);
});
