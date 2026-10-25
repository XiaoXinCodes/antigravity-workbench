const test=require('node:test'),assert=require('node:assert/strict'),Module=require('node:module');
const token=JSON.stringify({token:{refresh_token:'synthetic-ui-private'}}),scope={keyring:null,file:token,keyringState:'unobserved'};
const birth='linux:11111111-1111-4111-8111-111111111111:123';
function fixture(options={}){
 const commands=new Map(),state=options.state??{record:undefined,marker:undefined,errors:[],information:[],documents:[],proofs:0,clears:0,confirmed:true,scope,inputCalls:0,launches:0,locked:false};
 const proof=()=>({email:'fixture@example.test',generation:'fixture-generation',authValid:true});
 const vscode={env:{uiKind:1,remoteName:'wsl'},UIKind:{Desktop:1},workspace:{isTrusted:true,openTextDocument:async v=>{state.documents.push(v.content);return v;}},
 commands:{registerCommand:(id,fn)=>{commands.set(id,fn);return{dispose(){}};}},
 window:{showQuickPick:async items=>items[0],showWarningMessage:async(_m,_o,yes)=>state.confirmed?yes:undefined,
 showInputBox:async()=> {state.inputCalls++;return 'synthetic-ui-password';},showErrorMessage:async m=>state.errors.push(m),showInformationMessage:async m=>state.information.push(m),showTextDocument:async()=>{}}};
 class Locks{async withOperation(fn){if(state.writerHeld)throw new (require('../out/live-storage').LiveError)('LIVE_OPERATION_OR_RECOVERY_LOCKED');assert.equal(state.locked,false);state.locked=true;try{return await fn();}finally{state.locked=false;if(state.afterUnlock)await state.afterUnlock();}}async hasRecovery(){return !!state.marker;}async beginOfflineRecovery(id){state.marker={schema:4,id,owner:'a'.repeat(64)};}async inspectRecovery(){return{state:state.marker?'active':'absent',owner:state.marker};}async assertOfflineRecovery(id){assert.equal(state.marker.id,id);}async clearOfflineRecovery(){state.clears++;state.marker=undefined;}}
 class Store{async save(v,expected){assert.deepEqual(state.record,expected);state.record=structuredClone(v);}async read(){return structuredClone(state.record);}}
 const mocks={vscode,'./automatic-window-entry':{hasAutomaticWindowAttempt:async()=>!!state.windowRegistered||!!state.pendingWindowAttempt,assertNoPendingWindowAttempt:async()=>{if(state.pendingWindowAttempt)throw new (require('../out/live-storage').LiveError)('OFFLINE_REOPEN_REQUIRED');},completeWindowReopenIfPresent:async()=>{},automaticWindowContext:async()=>{if(state.autoUnavailable)throw new (require('../out/live-storage').LiveError)('OFFLINE_AUTOMATIC_WINDOW_UNAVAILABLE');return{};},assertSingleWindow:()=>{if(state.multipleWindows)throw new (require('../out/live-storage').LiveError)('OFFLINE_AUTOMATIC_WINDOWS_UNSUPPORTED');},saveAutomaticWindow:async()=>!state.saveCancelled,prepareWindowReopen:async()=>{state.reopenPrepared=true;},closeAutomaticWindow:async()=>{assert.ok(state.launches);assert.ok(state.reopenPrepared);state.closeRequested=true;}},
 './offline-automatic':{AutomaticOfflineKey:class{async read(){return state.autoKey;}async create(){state.autoKey='a'.repeat(64);return state.autoKey;}},AutomaticOfflineControl:class{async read(){return{status:state.controlStatus??'PREPARED',cancelled:!!state.cancelled,attempt:state.attempt};}async reset(){state.controlStatus='PREPARED';state.cancelled=false;state.attempt=require('node:crypto').randomUUID();return state.attempt;}async status(code){state.controlStatus=code;}async cancel(){state.cancelled=true;}},launchAutomaticOfflineHelper:async(...args)=>{assert.equal(state.locked,false);assert.ok(state.marker);assert.ok(state.autoKey);state.launches++;if(state.verifyAttempt&&args[6]!==state.attempt)throw new (require('../out/live-storage').LiveError)('OFFLINE_ATTEMPT_CHANGED');state.executed??=[];state.executed.push(args[5]);if(state.launchFailure)throw Error('synthetic launch failure');}},'./live-lock':{LiveLocks:Locks,probeProcessIdentity:async()=>({state:'alive',startIdentity:birth})},
 './live-environment':{EnvironmentTokenSlots:class{async read(){return state.scope;}},resolveOfficialStorageMode:async()=> 'wsl-file'},
 './native-host':{assertNativeHost(){},resolveCredentialHostId:async()=> 'b'.repeat(64)},
 './live-wsl-proof':{wslFileRouteError:require('../out/live-wsl-proof').wslFileRouteError,createWslReadGuard:()=>Object.assign(async()=>!state.badScope,{fileRouteFailureReason:'pid-marker-mismatch'})},'./official-contract':{assertOfficialWriteContract:async()=>{}},
 './offline-recovery-store':{OfflineRecoveryStore:Store},'./offline-process-census':{inspectOfflineLinuxProcesses:async({knownHosts})=>({complete:!state.incompleteCensus,unknown:!!state.unknownCensus,hosts:knownHosts,hubs:[]})}};
 const id=require.resolve('../out/offline-ui'),old=Module._load;delete require.cache[id];Module._load=function(name,...args){return mocks[name]??old.call(this,name,...args);};
 let register;try{register=require(id).registerOfflineUi;}finally{Module._load=old;delete require.cache[id];}
 const nativeInterval=global.setInterval;if(options.manualTimer)global.setInterval=fn=>{state.poll=fn;return{unref(){}};};
 const controller=register({globalState:{get:key=>state.pointer?.[key],update:async(key,value)=>{state.pointer??={};state.pointer[key]=value;}},extensionPath:'/synthetic/path with quote\'/extension',extension:{extensionKind:2},subscriptions:[]},{stage:stage=>{state.stages??=[];state.stages.push(stage);},owner:'a'.repeat(64),accounts:()=>[{id:'target',label:'fixture'}],account:async()=>({slots:options.targetSlots??scope,expectedEmail:'fixture@example.test'}),official:()=>({}),proof:async()=>{state.proofs++;return {quotaSource:'server',authValid:true,...(state.proofOverride?state.proofOverride(state.proofs):proof())};},changed(){}});
 global.setInterval=nativeInterval;
 return{state,controller,run:name=>commands.get('antigravityAccounts.live.'+name)()};
}
test('WSL product entry prepares encrypted journal and offers external command without exposing secrets',{skip:process.platform!=='linux'},async()=>{
 const {state,run}=fixture();await run('offlinePrepare');assert.deepEqual(state.errors,[]);assert.equal(state.record.phase,'prepared');assert.equal(state.marker.schema,4);
 assert.equal(state.documents.length,1);assert.match(state.documents[0],/offline-cli\.js/);assert.match(state.documents[0],/install/);
 assert.doesNotMatch(state.documents[0],/synthetic-ui-private|synthetic-ui-password|fixture@example.test/);
 assert.match(state.documents[0],/'\\''/);assert.equal(state.clears,0);
 await run('offlineContinue');assert.equal(state.documents.length,2);
});
test('cancelled product consent neither captures nor prepares offline credentials',{skip:process.platform!=='linux'},async()=>{
 const {state,run}=fixture();state.confirmed=false;await run('offlinePrepare');assert.equal(state.record,undefined);assert.equal(state.marker,undefined);assert.equal(state.proofs,0);
});
test('completion requires installed record, exact bytes and fresh matching identity',{skip:process.platform!=='linux'},async()=>{
 const {state,run}=fixture();await run('offlinePrepare');await run('offlineComplete');assert.equal(state.clears,0);assert.equal(state.record.phase,'prepared');
 state.record.phase='installed';state.proofOverride=()=>({email:'other@example.test',generation:'fixture-generation'});await run('offlineComplete');assert.equal(state.clears,0);
 state.proofOverride=undefined;await run('offlineComplete');assert.equal(state.clears,1);assert.equal(state.record.phase,'verified');
});
test('late generation change after durable verification retains fence for retry',{skip:process.platform!=='linux'},async()=>{
 const {state,run}=fixture();await run('offlinePrepare');state.record.phase='installed';state.proofs=0;
 state.proofOverride=n=>({email:'fixture@example.test',generation:n===1?'before':'after'});await run('offlineComplete');assert.equal(state.clears,0);assert.equal(state.record.phase,'verified');assert.ok(state.marker);
});
test('access-token refresh with the same refresh credential completes; a different refresh credential does not',{skip:process.platform!=='linux'},async()=>{
 for(const changedRefresh of [false,true]){const {state,run}=fixture();await run('offlinePrepare');state.record.phase='installed';
 state.scope={...scope,file:JSON.stringify({token:{refresh_token:changedRefresh?'unrelated':'synthetic-ui-private',access_token:'rotated'}})};
 await run('offlineComplete');assert.equal(state.clears,changedRefresh?0:1);}
});
test('restored bytes keep protection until the original account is freshly verified',{skip:process.platform!=='linux'},async()=>{
 const {state,run}=fixture();await run('offlinePrepare');state.record.phase='restored';
 state.record.originalEmail='original@example.test';await run('offlineComplete');assert.equal(state.clears,0);
 state.proofOverride=()=>({email:'original@example.test',generation:'restored-hub'});await run('offlineComplete');assert.equal(state.clears,1);assert.equal(state.record.phase,'restored-verified');
});
test('keep current settles rotated or external login without overwriting or removing backup',async()=>{
 for(const email of ['fixture@example.test','external@example.test']){const {state,run}=fixture();await run('offlinePrepare');state.record.phase='installed';const backup=structuredClone(state.record.backup);
 state.scope={...scope,file:JSON.stringify({token:{refresh_token:'new-refresh'}})};state.proofOverride=()=>({email,generation:'new-generation'});
 await run('offlineKeepCurrent');assert.equal(state.clears,1);assert.equal(state.record.phase,'kept-current');assert.deepEqual(state.record.backup,backup);assert.match(state.scope.file,/new-refresh/);}
});
test('keep current cancellation and unstable generation retain transaction',async()=>{
 for(const cancel of [true,false]){const {state,run}=fixture();await run('offlinePrepare');state.confirmed=!cancel;state.proofs=0;state.proofOverride=n=>({email:'fixture@example.test',generation:String(n)});
 await run('offlineKeepCurrent');assert.equal(state.clears,0);assert.ok(state.marker);assert.equal(state.information.length,0);}
});
test('keep current rejects foreign marker and never clears old-schema transactions',async()=>{
 for(const change of [{schema:3},{owner:'c'.repeat(64)}]){const {state,run}=fixture();await run('offlinePrepare');Object.assign(state.marker,change);await run('offlineKeepCurrent');assert.equal(state.clears,0);assert.equal(state.record.phase,'prepared');}
});
test('keep current requires authenticated server proof and stable bytes through consent',async()=>{
 for(const fault of ['auth','source','bytes']){const {state,run}=fixture();await run('offlinePrepare');state.proofs=0;
 state.proofOverride=n=>{if(fault==='bytes'&&n===2)state.scope={...scope,file:JSON.stringify({token:{refresh_token:'changed-during-consent'}})};return{email:'fixture@example.test',generation:'stable',authValid:fault!=='auth',quotaSource:fault==='source'?undefined:'server'};};
 await run('offlineKeepCurrent');assert.equal(state.clears,0);assert.equal(state.record.phase,'prepared');}
});
test('late failure after kept-current persistence retains fence and retries fresh acceptance',async()=>{
 const {state,run}=fixture();await run('offlinePrepare');state.proofs=0;
 state.proofOverride=n=>({email:'fixture@example.test',generation:n===3?'changed':'stable'});
 await run('offlineKeepCurrent');assert.equal(state.record.phase,'kept-current');assert.equal(state.clears,0);
 state.proofOverride=()=>({email:'different@example.test',generation:'new'});
 await run('offlineKeepCurrent');assert.equal(state.clears,1);assert.equal(state.record.keptEmail,'different@example.test');
});

test('automatic UI prepares once without password or external command and releases lock before helper ACK',async()=>{
 const {state,controller,run}=fixture();assert.equal(await controller.prepareAutomatic('target'),true);assert.equal(state.inputCalls,0);assert.equal(state.documents.length,0);assert.equal(state.launches,1);assert.equal(state.record.phase,'prepared');assert.equal(state.marker.schema,4);assert.equal(state.information.length,0);assert.match(controller.getStatus(),/not yet verified|尚未核验/);
 state.record.phase='installed';await run('offlineComplete');assert.equal(state.inputCalls,0);assert.equal(state.clears,1);
});
test('automatic UI cancellation has no key, marker, helper or password',async()=>{
 const {state,controller}=fixture();state.confirmed=false;assert.equal(await controller.prepareAutomatic('target'),false);assert.equal(state.autoKey,undefined);assert.equal(state.record,undefined);assert.equal(state.launches,0);assert.equal(state.inputCalls,0);
});
test('automatic helper uncertain launch preserves original recovery and permits explicit keep without password',async()=>{
 const {state,controller,run}=fixture();state.launchFailure=true;await assert.rejects(controller.prepareAutomatic('target'));assert.equal(state.clears,0);assert.ok(state.marker);const backup=structuredClone(state.record.backup);await run('offlineKeepCurrent');assert.equal(state.clears,1);assert.equal(state.inputCalls,0);assert.deepEqual(state.record.backup,backup);
});
test('automatic cancel requests cancellation without clearing protection or rewriting login',async()=>{
 const {state,controller,run}=fixture();await controller.prepareAutomatic('target');await run('offlineAutomaticCancel');assert.equal(state.cancelled,true);assert.equal(state.clears,0);assert.equal(state.record.phase,'prepared');assert.equal(state.inputCalls,0);
});
test('automatic retry refreshes host participants only while original bytes match',async()=>{
 const {state,controller,run}=fixture();await controller.prepareAutomatic('target');await run('offlineAutomaticRetry');assert.equal(state.launches,2);state.scope={...scope,file:JSON.stringify({token:{refresh_token:'unknown'}})};await run('offlineAutomaticRetry');assert.equal(state.launches,2);assert.equal(state.clears,0);assert.ok(state.errors.length);
});

test('reopen poll automatically verifies key-backed installed login without password',async()=>{
 const {state,controller}=fixture({manualTimer:true});await controller.prepareAutomatic('target');state.record.phase='installed';state.poll();for(let i=0;i<50&&state.clears===0;i++)await new Promise(r=>setTimeout(r,1));assert.equal(state.clears,1);assert.equal(state.inputCalls,0);assert.equal(state.record.phase,'verified');
});
test('reopen poll never clears a pending transaction on wrong or unauthenticated identity',async()=>{
 for(const fault of ['wrong','unauthenticated']){const {state,controller}=fixture({manualTimer:true});await controller.prepareAutomatic('target');state.record.phase='installed';state.proofOverride=()=>({email:fault==='wrong'?'other@example.test':'fixture@example.test',generation:'fresh',authValid:fault!=='unauthenticated'});state.poll();await new Promise(r=>setTimeout(r,10));assert.equal(state.clears,0);assert.equal(state.inputCalls,0);assert.ok(state.marker);}
});

async function pollOnce(state){state.poll();await new Promise(r=>setTimeout(r,15));}
test('early reopen joins writer before automatically retaining verified original without writing',async()=>{
 const {state,controller}=fixture({manualTimer:true});await controller.prepareAutomatic('target');state.record.execution.initialHosts=[{pid:99999,startIdentity:birth}];state.writerHeld=true;await pollOnce(state);assert.equal(state.cancelled,true);assert.equal(state.clears,0);assert.match(controller.getStatus(),/joining|等待后台/);state.writerHeld=false;await pollOnce(state);assert.equal(state.clears,1);assert.equal(state.record.phase,'restored-verified');assert.equal(state.controlStatus,'VERIFIED_ORIGINAL');assert.equal(state.inputCalls,0);assert.match(controller.getHistory().message,/original login|原登录/);assert.deepEqual(state.scope,scope);
});
test('existing peer membership never cancels a normal wait',async()=>{
 const {state,controller}=fixture({manualTimer:true});await controller.prepareAutomatic('target');state.record.execution.knownHosts=[{pid:99999,startIdentity:birth}];state.controlStatus='WAITING_FOR_CLOSE';await pollOnce(state);assert.equal(state.cancelled,false);assert.equal(state.clears,0);assert.match(controller.getStatus(),/Waiting|等待相关/);
});
test('cancel timeout and helper crash settle known original automatically while preserving backup',async()=>{
 for(const code of ['CANCELLED','OFFLINE_CLOSE_TIMEOUT','OFFLINE_OPERATION_FAILED']){const {state,controller}=fixture({manualTimer:true});await controller.prepareAutomatic('target');const backup=structuredClone(state.record.backup);state.controlStatus=code;await pollOnce(state);assert.equal(state.clears,1);assert.equal(state.controlStatus,'VERIFIED_ORIGINAL');assert.deepEqual(state.record.backup,backup);assert.equal(state.inputCalls,0);}
});
test('late committed target with prepared journal is verified without repeating credential writes',async()=>{
 const {state,controller}=fixture({manualTimer:true});await controller.prepareAutomatic('target');state.record.target={...scope,file:JSON.stringify({token:{refresh_token:'synthetic-target'}})};state.scope=structuredClone(state.record.target);state.record.execution.initialHosts=[{pid:99999,startIdentity:birth}];await pollOnce(state);assert.equal(state.clears,1);assert.equal(state.record.phase,'verified');assert.equal(state.controlStatus,'VERIFIED_TARGET');assert.match(controller.getHistory().message,/target identity|目标身份/);
});
test('early reopen preserves unknown rotated refresh credentials and shows actionable error',async()=>{
 const {state,controller}=fixture({manualTimer:true});await controller.prepareAutomatic('target');state.record.execution.initialHosts=[{pid:99999,startIdentity:birth}];state.scope={...scope,file:JSON.stringify({token:{refresh_token:'unknown-new-refresh'}})};await pollOnce(state);assert.equal(state.clears,0);assert.equal(state.record.phase,'prepared');assert.match(controller.getStatus(),/VERIFICATION_STORAGE_MISMATCH/);assert.match(state.scope.file,/unknown-new-refresh/);
});
test('legacy automatic record does not misclassify an existing peer as reopened',async()=>{
 const {state,controller}=fixture({manualTimer:true});await controller.prepareAutomatic('target');delete state.record.execution.initialHosts;state.record.execution.knownHosts=[{pid:99999,startIdentity:birth}];await pollOnce(state);assert.equal(state.cancelled,false);assert.equal(state.clears,0);
});

test('persistent verified result is shown by a newly created UI after marker clearing',async()=>{const f=fixture({manualTimer:true});await f.controller.prepareAutomatic('target');f.state.controlStatus='OFFLINE_CLOSE_TIMEOUT';await pollOnce(f.state);assert.equal(f.state.clears,1);const reopened=fixture({manualTimer:true,state:f.state});assert.equal(reopened.controller.getStatus(),undefined);await pollOnce(reopened.state);assert.equal(reopened.controller.getStatus(),undefined);assert.match(reopened.controller.getHistory().message,/original login|原登录/);assert.equal(reopened.state.inputCalls,0);});
test('same PID with a different start identity is a reopened host',async()=>{const f=fixture({manualTimer:true});await f.controller.prepareAutomatic('target');f.state.record.execution.initialHosts=[{pid:process.pid,startIdentity:birth.replace(':123',':122')}];await pollOnce(f.state);assert.equal(f.state.cancelled,true);assert.equal(f.state.clears,1);});

test('delayed restore launch keeps its own epoch and cannot borrow another windows retry epoch',async()=>{const f=fixture({manualTimer:true});await f.controller.prepareAutomatic('target');f.state.verifyAttempt=true;f.state.afterUnlock=async()=>{f.state.afterUnlock=undefined;f.state.attempt=require('node:crypto').randomUUID();};await f.run('offlineAutomaticRestore');assert.deepEqual(f.state.executed,['install']);assert.match(f.state.errors.at(-1),/OFFLINE_ATTEMPT_CHANGED/);assert.equal(f.state.clears,0);});

test('automatic preparation identifies census and scope rejection before durable state',async()=>{for(const fault of ['incompleteCensus','unknownCensus','badScope']){const {state,controller}=fixture();state[fault]=true;await assert.rejects(controller.prepareAutomatic('target'),{code:fault==='badScope'?'WSL_FILE_ROUTE_UNVERIFIED':'OFFLINE_CENSUS_UNVERIFIED'});assert.equal(state.stages.at(-1),fault==='badScope'?'scope':'census');assert.equal(state.marker,undefined);assert.equal(state.record,undefined);assert.equal(state.launches??0,0);}});
test('automatic preparation records fixed stages through helper launch',async()=>{const {state,controller}=fixture();await controller.prepareAutomatic('target');assert.deepEqual(state.stages,['route','args','confirm','lock','contract','scope','census','scope','prepare','helper']);});

test('scope rejection retains file route reason before credentials or helper',async()=>{const {state,controller}=fixture();state.badScope=true;await assert.rejects(controller.prepareAutomatic('target'),{code:'WSL_FILE_ROUTE_UNVERIFIED',fileRouteFailureReason:'pid-marker-mismatch'});assert.equal(state.stages.at(-1),'scope');assert.equal(state.proofs,0);assert.equal(state.marker,undefined);assert.equal(state.launches,0);});

for(const targetSlots of [{keyring:null,file:token},{keyring:token,file:token}])test('automatic preparation projects historical native target into verified file scope '+(targetSlots.keyring===null?'file-only':'dual-slot'),async()=>{
 const {state,controller}=fixture({targetSlots});const original=structuredClone(targetSlots);
 await controller.prepareAutomatic('target');assert.equal(state.launches,1);assert.deepEqual(state.record.target,scope);assert.deepEqual(state.record.backup,scope);assert.deepEqual(targetSlots,original);
 require('../out/offline-switch').validateOfflineJournal(state.record,'b'.repeat(64));
});
for(const automatic of [true,false])test('target projection also covers '+(automatic?'automatic':'legacy manual')+' prepare without changing saved slots',async()=>{
 const targetSlots={keyring:token,file:token};const {state,controller,run}=fixture({targetSlots});
 if(automatic)await controller.prepareAutomatic('target');else await run('offlinePrepare','target');
 assert.deepEqual(state.record.target,scope);assert.deepEqual(targetSlots,{keyring:token,file:token});assert.equal(state.errors.length,0);
});
for(const [name,targetSlots] of [
 ['keyring only',{keyring:token,file:null}],
 ['malformed file',{keyring:null,file:'not JSON'}],
 ['unknown scope',{keyring:null,file:token,keyringState:'invalid'}],
 ['false unobserved scope',{keyring:token,file:token,keyringState:'unobserved'}],
 ['different slot identity',{keyring:JSON.stringify({token:{refresh_token:'different'}}),file:token}],
 ['wrong email',{keyring:null,file:JSON.stringify({token:{refresh_token:'synthetic'},id_token:'x.'+Buffer.from(JSON.stringify({email:'other@example.test'})).toString('base64url')+'.x'})}],
])test('target projection refuses '+name+' before recovery state or helper',async()=>{
 const {state,controller}=fixture({targetSlots});await assert.rejects(controller.prepareAutomatic('target'));
 assert.equal(state.record,undefined);assert.equal(state.marker,undefined);assert.equal(state.autoKey,undefined);assert.equal(state.launches,0);
});
test('target projection never downgrades a native backup',async()=>{
 const {state,controller}=fixture({targetSlots:{keyring:token,file:token}});state.scope={keyring:token,file:token};
 await assert.rejects(controller.prepareAutomatic('target'),{code:'OFFLINE_SCOPE_UNVERIFIED'});assert.equal(state.record,undefined);assert.equal(state.launches,0);
});
test('journal validator still rejects mismatched scopes directly',()=>{
 const {validateOfflineJournal}=require('../out/offline-switch');
 assert.throws(()=>validateOfflineJournal({schema:1,hostId:'synthetic',id:'11111111-1111-4111-8111-111111111111',phase:'prepared',backup:scope,target:{keyring:null,file:token},expectedEmail:'fixture@example.test'},'synthetic'),{code:'OFFLINE_RECOVERY_INVALID'});
});
test('automatic window capability, save cancellation and unsupported peers stop before helper or closing',async()=>{
 for(const flag of ['autoUnavailable','saveCancelled','multipleWindows']){const {state,controller}=fixture();state[flag]=true;
  if(flag==='saveCancelled')assert.equal(await controller.prepareAutomatic('target'),false);else await assert.rejects(controller.prepareAutomatic('target'));
  assert.equal(state.marker,undefined);assert.equal(state.record,undefined);assert.equal(state.launches,0);assert.equal(state.closeRequested,undefined);
 }
});
test('automatic window close follows durable account and reopen preparation and helper acknowledgment',async()=>{
 const {state,controller}=fixture();await controller.prepareAutomatic('target');assert.equal(state.reopenPrepared,true);assert.equal(state.closeRequested,true);assert.equal(state.launches,1);
 const failed=fixture();failed.state.launchFailure=true;await assert.rejects(failed.controller.prepareAutomatic('target'));assert.equal(failed.state.closeRequested,undefined);assert.equal(failed.state.cancelled,true);assert.ok(failed.state.record.backup);
});
test('retry and restore cannot orphan an unresolved window attempt by resetting its epoch',async()=>{
 for(const command of ['offlineAutomaticRetry','offlineAutomaticRestore']){const f=fixture();await f.controller.prepareAutomatic('target');const attempt=f.state.attempt;f.state.pendingWindowAttempt=true;
  await f.run(command);assert.equal(f.state.attempt,attempt);assert.equal(f.state.launches,1);assert.match(f.state.errors.at(-1),/OFFLINE_REOPEN_REQUIRED/);assert.ok(f.state.record.backup);
 }
});
test('registered window with failed target auth can prepare automatic restore without authenticating target',async()=>{
 const f=fixture();await f.controller.prepareAutomatic('target');const oldAttempt=f.state.attempt;const backup=structuredClone(f.state.record.backup);
 f.state.windowRegistered=true;f.state.record.phase='installed';f.state.proofOverride=()=>({email:'fixture@example.test',generation:'fixture-generation',authValid:false});
 const reads=f.state.proofs;await f.run('offlineAutomaticRestore');assert.deepEqual(f.state.errors,[]);assert.notEqual(f.state.attempt,oldAttempt);assert.deepEqual(f.state.executed,['install','restore']);assert.equal(f.state.proofs,reads);assert.deepEqual(f.state.record.backup,backup);assert.equal(f.state.closeRequested,true);
});
test('settled offline result is history only, preserves backup, and active retry remains visible',async()=>{
 const f=fixture({manualTimer:true});await f.controller.prepareAutomatic('target');const backup=structuredClone(f.state.record.backup);
 f.state.controlStatus='OFFLINE_CLOSE_TIMEOUT';await pollOnce(f.state);
 assert.equal(f.controller.getStatus(),undefined);assert.ok(Number.isFinite(Date.parse(f.controller.getHistory().observedAt)));assert.deepEqual(f.state.record.backup,backup);
 f.state.marker={schema:4,id:f.state.record.id,owner:'a'.repeat(64)};f.state.record.phase='prepared';f.state.controlStatus='WAITING_FOR_CLOSE';f.state.cancelled=false;
 await pollOnce(f.state);assert.equal(f.controller.getHistory(),undefined);assert.ok(f.controller.getStatus());assert.ok(f.state.marker);
});
test('terminal presentation cannot borrow another transaction record from a historical pointer',async()=>{
 const f=fixture({manualTimer:true});await f.controller.prepareAutomatic('target');f.state.controlStatus='OFFLINE_CLOSE_TIMEOUT';await pollOnce(f.state);
 const saved=structuredClone(f.state.record);f.state.pointer['automatic-offline.last.v1'].id=require('node:crypto').randomUUID();
 const reopened=fixture({manualTimer:true,state:f.state});await pollOnce(reopened.state);
 assert.equal(reopened.controller.getStatus(),undefined);assert.equal(reopened.controller.getHistory(),undefined);assert.deepEqual(f.state.record,saved);
});
