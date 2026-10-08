const test=require('node:test');
const assert=require('node:assert/strict');
const Module=require('node:module');
const entry=require.resolve('../out/live-ui');
const settle=()=>new Promise(setImmediate);
function setup(options={}){
 const commands=new Map(),events=[],state=options.state??new Map(),warnings=[],notifications=[];
 const ui={answer:undefined,trusted:true,selected:undefined,remoteName:undefined,official:undefined,config:{}};
 const vscode={UIKind:{Desktop:1},ExtensionKind:{UI:1,Workspace:2},env:{uiKind:1,get remoteName(){return ui.remoteName;}},extensions:{getExtension(id){return id==='google.google-antigravity'?ui.official:undefined;}},workspace:{get isTrusted(){return ui.trusted;},getConfiguration(){return{get:key=>ui.config[key]};}},commands:{async getCommands(){return ui.commandIds||[];},registerCommand(n,fn){commands.set(n,fn);return {dispose(){}};},async executeCommand(n){events.push(n);if(ui.execute)await ui.execute(n);}},window:{onDidChangeWindowState(fn){ui.focus=fn;return{dispose(){}};},async showWarningMessage(text){warnings.push(text);return ui.answer;},async showQuickPick(){return ui.selected;},async showInformationMessage(text){notifications.push(text);return undefined;}}};
 const original=Module._load;Module._load=function(n,...args){return n==='vscode'?vscode:original.call(this,n,...args);};
 let api;try{delete require.cache[entry];api=require(entry);}finally{Module._load=original;}
 const context={secrets:{get:async()=>undefined},globalState:{get(k,d){return state.has(k)?state.get(k):d;},async update(k,v){state.set(k,v);}},extension:{extensionKind:1},extensionUri:{scheme:'file',authority:''},globalStorageUri:{scheme:'file',authority:'',toString:()=> 'file:///synthetic-private-home'},subscriptions:[]};
 const service={journal:async()=>null,async install(){events.push('install');},};
 const locks=options.locks??{withOperation:async fn=>{events.push('locked');try{return await fn();}finally{events.push('unlocked');}},hasRecovery:async()=>false,async beginRecovery(){events.push('recovery');},async clearRecovery(){events.push('clear');}};
 const backend={generation:'old',async stop(){events.push('stop');},async reload(){events.push('bad-direct-reload');},async proof(){events.push('proof');return{email:'personal@example.test',generation:'old',authValid:true,observedAt:'2026-10-01T00:00:00.000Z',buckets:[{label:'Gemini',remaining:0.5,resetAt:null}]}}};
 backend.quota=async()=>({...await backend.proof(),quotaSource:'server'});
 service.account=async id=>({...state.get('live-switch.accounts.v1').find(a=>a.id===id),slots:{keyring:null,file:'synthetic'}});
 const lifecycle=async(running,login)=>ui.resolveLifecycle?ui.resolveLifecycle(running,login):backend;
 const diag=api.registerLiveUi(context,{changed:()=>ui.changed?.(),verificationClock:options.verificationClock,...(options.processRecovery?{processRecovery:options.processRecovery}:{}),service,locks,lifecycle,processCount:async()=>0,savedQuota:async(account,signal,options)=>ui.savedQuota?ui.savedQuota(account,signal,options):backend.quota(account.expectedEmail,signal),currentIdentity:async signal=>ui.currentIdentity?ui.currentIdentity(signal):ui.currentProof,currentQuota:async(email,signal)=>backend.quota(email,signal)});
 return{api,commands,events,state,ui,service,locks,lifecycle,context,warnings,notifications,backend,diag,call:(s,arg)=>commands.get('antigravityAccounts.live.'+s)(arg)};
}

function officialSyncFixture(t){
 const f=setup(),official=officialFixture(f),{LiveSwitchService}=require('../out/live-switch'),data=new Map();official.isActive=true;
 let email='a@example.test',current;
 const token=value=>JSON.stringify({token:{refresh_token:'synthetic-refresh-'+Buffer.from(value).toString('base64url'),access_token:'synthetic-access-'+Buffer.from(value).toString('base64url'),expiry:'2099-01-01T00:00:00Z',token_type:'Bearer'},id_token:'e30.'+Buffer.from(JSON.stringify({email:value.split(':')[0]})).toString('base64url')+'.synthetic'});
 const set=value=>{email=value;const raw=token(value);current={keyring:raw,file:raw}};
 set(email);const vault={get:async key=>data.get(key),store:async(key,value)=>data.set(key,value),delete:async key=>data.delete(key)};
 const slots={read:async()=>structuredClone(current),write:async(next,expected)=>{assert.deepEqual(current,expected);f.events.push('credential-write');current=structuredClone(next);email=require('../out/live-storage').tokenAccountHint(current.file||current.keyring).email}};
 const real=new LiveSwitchService(vault,slots,'a'.repeat(64));Object.assign(f.context.secrets,vault);
 for(const method of ['journal','account','hostIsCurrent','credentialHostIdentity','captureCurrent','savedLoginUsable','install','finishVerified','restore','restoreLogin','recoverLogin'])f.service[method]=real[method].bind(real);
 const proof=()=>({email,generation:require('../out/live-hub').generation(official.exports),observedAt:new Date().toISOString(),authValid:true,quotaSource:'server',buckets:[]});
 f.ui.currentIdentity=async()=>proof();f.backend.restartMode='component';f.backend.generation=proof().generation;f.backend.proof=async()=>proof();f.backend.reload=async()=>{f.events.push('reload');official.exports={...official.exports,csrfToken:official.exports.csrfToken+'x'};f.backend.generation=proof().generation};f.locks.assertRecovery=async()=>{};
 t.after(()=>f.context.subscriptions.forEach(sub=>sub.dispose()));
 return{...f,real,data,slots,proof,set,current:()=>current,official,token};
}

function processRecoveryFixture(t) {
 const {t:tr}=require('../out/i18n'),{LiveError}=require('../out/live-storage');
 let rows=[{id:'synthetic-process-selection',pid:710,parentPid:702,startedAt:'2026-10-08T11:00:00Z',owner:'other',parentState:'alive',taskState:'unknown',canEnd:true}],endHook;
 const scans=[],ends=[];
 const recovery={async scan(){scans.push(rows.map(p=>p.pid));return{phase:rows.length?'blocked':'clear',processes:rows.map(p=>({...p})),canContinue:!rows.length};},async end(id,signal){ends.push(id);if(endHook)return endHook(id,signal);rows=[];return'exited';},invalidate(){}};
 const f=setup({processRecovery:recovery});
 const account={id:'11111111-1111-4111-8111-111111111111',label:'Saved target',expectedEmail:'target@example.test',capturedAt:'2026-10-01T00:00:00Z',identitySource:'hub'};
 f.state.set('live-switch.accounts.v1',[account]); f.ui.answer=tr('liveUi.e0351ba254');
 f.ui.resolveLifecycle=async()=>{if(rows.length)throw new LiveError('OFFICIAL_UNOWNED_HUB_TASK_UNKNOWN');return f.backend;};
 t.after(()=>f.context.subscriptions.forEach(s=>s.dispose()));
 return{...f,account,scans,ends,rows:()=>rows,setRows:value=>{rows=value;},setEnd:value=>{endHook=value;},confirm:()=>{f.ui.answer=tr('officialProcess.endConfirm');}};
}

test('blocked switch retains selected account; one task-risk confirmation ends one backend, rescans and resumes existing switch',async t=>{
 const f=processRecoveryFixture(t);await f.call('switch',f.account.id);
 assert.equal(f.diag.getState().processConflicts.processes[0].pid,710);assert.equal(f.diag.getState().processSwitchTarget,f.account.expectedEmail);assert.ok(!f.events.includes('install')&&!f.events.includes('recovery'));
 const index=JSON.stringify(f.state.get('live-switch.accounts.v1')),history=f.state.get('live-switch.lastFailure.v1');
 f.confirm();await f.call('processEnd','synthetic-process-selection');
 assert.deepEqual(f.ends,['synthetic-process-selection']);assert.ok(f.scans.length>=3);assert.equal(f.events.filter(x=>x==='install').length,1);
 assert.equal(f.warnings.filter(x=>/任务状态未知/.test(x)).length,1);assert.match(f.warnings.at(-1),/710/);assert.match(f.warnings.at(-1),/target@example.test/);
 assert.equal(JSON.stringify(f.state.get('live-switch.accounts.v1')),index);assert.deepEqual(f.state.get('live-switch.lastFailure.v1'),history);assert.equal(f.diag.getState().processSwitchTarget,undefined);
});
test('cancelling process confirmation or supplying an arbitrary selection never terminates or writes',async t=>{
 const f=processRecoveryFixture(t);await f.call('switch',f.account.id);f.ui.answer=undefined;await f.call('processEnd','synthetic-process-selection');
 assert.deepEqual(f.ends,[]);assert.ok(!f.events.includes('install'));f.confirm();
 for(const arg of [710,{pid:710},'fake-selection'])await f.call('processEnd',arg);
 assert.deepEqual(f.ends,[]);assert.ok(!f.events.includes('install'));
});
test('recheck really rescans process conflicts; cleared conflict has an explicit continuation without a second task confirmation',async t=>{
 const f=processRecoveryFixture(t);await f.call('switch',f.account.id);const before=f.scans.length;f.setRows([]);
 await f.diag.recheck();assert.ok(f.scans.length>before);assert.equal(f.diag.getState().processConflicts.canContinue,true);assert.equal(f.diag.getState().error,undefined);
 await f.call('processContinue');assert.equal(f.events.filter(x=>x==='install').length,1);assert.deepEqual(f.ends,[]);
});
test('a new conflict after ending the selected backend is shown instead of batch-ending or switching',async t=>{
 const f=processRecoveryFixture(t);await f.call('switch',f.account.id);f.confirm();
 f.setEnd(async()=>{f.setRows([{...f.rows()[0],id:'new-selection',pid:711}]);return'exited';});
 await f.call('processEnd','synthetic-process-selection');assert.deepEqual(f.ends,['synthetic-process-selection']);assert.ok(!f.events.includes('install'));assert.equal(f.diag.getState().processConflicts.processes[0].pid,711);
});
test('changed account under the same ID invalidates continuation and termination consent',async t=>{
 const f=processRecoveryFixture(t);await f.call('switch',f.account.id);f.confirm();f.state.set('live-switch.accounts.v1',[{...f.account,expectedEmail:'replacement@example.test'}]);
 await f.call('processEnd','synthetic-process-selection');assert.deepEqual(f.ends,[]);assert.ok(!f.events.includes('install'));
});
test('repeated process-end clicks share the in-flight command and a late disposed result never resumes switching',async t=>{
 const f=processRecoveryFixture(t);await f.call('switch',f.account.id);f.confirm();let finish;
 f.setEnd((_id,signal)=>new Promise(resolve=>{finish=()=>resolve('exited');signal.addEventListener('abort',()=>finish());}));
 const pending=f.call('processEnd','synthetic-process-selection');for(let n=0;n<30&&!finish;n++)await new Promise(resolve=>setImmediate(resolve));assert.ok(finish);
 await f.call('processEnd','synthetic-process-selection');assert.equal(f.ends.length,1);
 f.context.subscriptions.forEach(s=>s.dispose());finish();await pending;assert.ok(!f.events.includes('install'));
});
test('pending recovery, image activity and active operation lock block process termination',async t=>{
 const f=processRecoveryFixture(t);await f.call('switch',f.account.id);f.confirm();
 f.service.journal=async()=>({id:'pending',phase:'prepared'});await f.call('processEnd','synthetic-process-selection');assert.deepEqual(f.ends,[]);
 f.service.journal=async()=>null;const release=require('../out/image-activity').enterImageOperation('synthetic-recovery-test');
 try{await f.call('processEnd','synthetic-process-selection');assert.deepEqual(f.ends,[]);}finally{release();}
 f.locks.withOperation=async()=>{throw new(require('../out/live-storage').LiveError)('LIVE_OPERATION_OR_RECOVERY_LOCKED');};
 await f.call('processEnd','synthetic-process-selection');assert.deepEqual(f.ends,[]);assert.ok(!f.events.includes('install'));
});
test('window recreation keeps process details; a new controller has no persisted automatic switch intent',async t=>{
 const f=processRecoveryFixture(t);await f.call('switch',f.account.id);const before=f.scans.length;await f.diag.ensureIdentity();assert.equal(f.diag.getState().processConflicts.processes[0].pid,710);assert.equal(f.scans.length,before);
 const replacement=processRecoveryFixture(t);replacement.state.set('live-switch.lastFailure.v1',f.state.get('live-switch.lastFailure.v1'));await replacement.call('processScan');
 assert.equal(replacement.diag.getState().processSwitchTarget,undefined);assert.ok(!replacement.events.includes('install'));
});
test('external official login on the same Hub immediately refreshes, saves and deduplicates without another OAuth or official write',async t=>{
 const f=officialSyncFixture(t);await f.diag.refresh();assert.equal(f.diag.getState().activeEmail,'a@example.test');assert.equal(f.diag.getAccounts().length,1);const first=f.diag.getAccounts()[0].id;
 f.set('b@example.test');f.ui.focus({focused:true});await f.diag.refresh();assert.equal(f.diag.getState().activeEmail,'b@example.test');assert.equal(f.diag.getAccounts().length,2);assert.equal(f.diag.getAccounts()[0].id,first);assert.equal(f.diag.getAccounts()[1].active,true);
 const second=f.diag.getAccounts()[1].id;f.ui.focus({focused:true});await f.diag.refresh();assert.equal(f.diag.getAccounts().length,2);assert.equal(f.diag.getAccounts()[1].id,second);assert.ok(!f.events.includes('stop')&&!f.events.includes('reload')&&!f.events.includes('credential-write'));assert.deepEqual(f.warnings,[]);assert.deepEqual(f.notifications,[]);
});
test('automatic save updates a new same-identity authorization under the original id and keeps the user label',async t=>{
 const f=officialSyncFixture(t);await f.diag.refresh();const saved=f.diag.getAccounts()[0];f.state.set('live-switch.accounts.v1',[{...saved,label:'Personal label'}]);
 const raw=f.token('a@example.test:second-authorization');Object.assign(f.current(),{keyring:raw,file:raw});f.ui.focus({focused:true});await f.diag.refresh();
 assert.equal(f.diag.getAccounts().length,1);assert.equal(f.diag.getAccounts()[0].id,saved.id);assert.equal(f.diag.getAccounts()[0].label,'Personal label');assert.equal((await f.real.account(saved.id)).slots.file,raw);assert.ok(!f.events.includes('credential-write'));
});
test('automatic save failure retains the verified official current identity and reports saving separately',async t=>{
 const f=officialSyncFixture(t);f.service.captureCurrent=async()=>{throw new (require('../out/live-storage').LiveError)('SECURE_SAVE_NOT_VERIFIED')};await f.diag.refresh();
 assert.equal(f.diag.getState().activeEmail,'a@example.test');assert.equal(f.diag.getAccounts().length,0);assert.match(f.diag.getState().status,/当前账号已核实.*自动保存未完成/);assert.ok(!f.events.includes('stop'));
});
test('pending old add journal does not hide or overwrite a separately verified official login',async t=>{
 const f=officialSyncFixture(t);await f.diag.refresh();await f.real.prepareLogin(f.backend,'00000000-0000-4000-8000-000000000081');const before=JSON.stringify(await f.real.journal());f.set('c@example.test');
 f.ui.focus({focused:true});await f.diag.refresh();assert.equal(f.diag.getState().activeEmail,'c@example.test');assert.equal(f.diag.getAccounts().at(-1).expectedEmail,'c@example.test');assert.equal(JSON.stringify(await f.real.journal()),before);assert.equal(f.diag.getState().pending,true);assert.ok(!f.events.includes('stop')&&!f.events.includes('credential-write'));
});
test('idle loopback candidate change triggers fresh official verification and automatic save within one probe interval',async t=>{
 const f=officialSyncFixture(t),hub=require('../out/live-hub'),old=hub.queryHub;hub.queryHub=async()=>f.proof();t.after(()=>hub.queryHub=old);await f.diag.refresh();f.set('b@example.test');
 await new Promise(resolve=>setTimeout(resolve,5300));await f.diag.refresh();assert.equal(f.diag.getState().activeEmail,'b@example.test');assert.equal(f.diag.getAccounts().length,2);assert.ok(!f.events.includes('stop')&&!f.events.includes('credential-write'));
});
test('remove current switches to the first usable different account before deleting its copy',async t=>{
 const f=officialSyncFixture(t);await f.diag.refresh();f.set('b@example.test');f.ui.focus({focused:true});await f.diag.refresh();f.set('a@example.test');f.ui.focus({focused:true});await f.diag.refresh();
 const a=f.diag.getAccounts().find(item=>item.expectedEmail==='a@example.test'),b=f.diag.getAccounts().find(item=>item.expectedEmail==='b@example.test');f.ui.answer='删除保存副本';await f.call('remove',a.id);
 assert.equal(f.diag.getState().activeEmail,'b@example.test');assert.deepEqual(f.diag.getAccounts().map(item=>item.id),[b.id]);assert.equal(f.data.has('live-switch.account.v1.'+a.id),false);assert.equal(f.events.filter(e=>e==='credential-write').length,1);assert.equal(f.warnings.length,1);assert.equal(await f.real.journal(),null);
});
test('remove the only current copy keeps official login and suppresses same-identity readding until an identity change',async t=>{
 const f=officialSyncFixture(t);await f.diag.refresh();const a=f.diag.getAccounts()[0];const before=structuredClone(f.current());f.ui.answer='删除保存副本';await f.call('remove',a.id);assert.equal(f.diag.getAccounts().length,0);assert.deepEqual(f.current(),before);assert.ok(!f.events.includes('stop')&&!f.events.includes('credential-write'));
 f.ui.focus({focused:true});await f.diag.refresh();assert.equal(f.diag.getAccounts().length,0);assert.equal(f.diag.getState().activeEmail,'a@example.test');
 f.set('b@example.test');f.ui.focus({focused:true});await f.diag.refresh();assert.equal(f.diag.getAccounts().length,1);f.set('a@example.test');f.ui.focus({focused:true});await f.diag.refresh();assert.equal(f.diag.getAccounts().length,2);
});
test('remove a noncurrent copy does not switch; failed current replacement retains its saved copy',async t=>{
 const f=officialSyncFixture(t);await f.diag.refresh();f.set('b@example.test');f.ui.focus({focused:true});await f.diag.refresh();const [a,b]=f.diag.getAccounts();f.ui.answer='删除保存副本';await f.call('remove',a.id);assert.equal(f.diag.getState().activeEmail,'b@example.test');assert.ok(!f.events.includes('stop')&&!f.events.includes('credential-write'));
 f.set('a@example.test');f.ui.focus({focused:true});await f.diag.refresh();f.service.install=async()=>{throw new (require('../out/live-storage').LiveError)('OFFICIAL_UNOWNED_HUB_TASK_UNKNOWN')};await f.call('remove',f.diag.getAccounts().find(item=>item.expectedEmail==='a@example.test').id);
 assert.equal(f.diag.getAccounts().length,2);assert.equal(f.data.has('live-switch.account.v1.'+b.id),true);assert.match(f.diag.getState().error,/查看下方进程/);assert.ok(!f.events.includes('credential-write'));
});
test('activation registers real commands but reads no credentials and starts no backend',()=>{const f=setup();assert.equal(f.commands.size,15);assert.deepEqual(f.events,[]);assert.match(f.diag.getStatus(),/尚未操作/);});
test('read-only quota preserves a freshly verified official badge while an older add journal remains pending',async t=>{
 const f=officialSyncFixture(t);await f.diag.refresh();await f.real.prepareLogin(f.backend,'00000000-0000-4000-8000-000000000080');f.set('c@example.test');f.ui.focus({focused:true});await f.diag.refresh();const account=f.diag.getAccounts().find(item=>item.expectedEmail==='c@example.test');
 assert.equal(account.active,true);await f.call('quota',account.id);assert.equal(f.diag.getAccounts().find(item=>item.id===account.id).active,true);assert.equal(f.diag.getState().identityVerifiedDuringRecovery,true);assert.equal(f.diag.getState().pending,true);assert.ok(!f.events.includes('stop')&&!f.events.includes('credential-write'));
});

test('deleting a foreign-host copy of the current email never switches the local official login',async t=>{
 const f=officialSyncFixture(t);await f.diag.refresh();const local=f.diag.getAccounts()[0];f.set('b@example.test');f.ui.focus({focused:true});await f.diag.refresh();f.set('a@example.test');f.ui.focus({focused:true});await f.diag.refresh();
 const foreign={...local,id:'00000000-0000-4000-8000-000000000088',hostId:'b'.repeat(64)};f.state.set('live-switch.accounts.v1',[...f.state.get('live-switch.accounts.v1'),foreign]);f.data.set('live-switch.account.v1.'+foreign.id,JSON.stringify({...foreign,slots:f.current()}));
 f.ui.answer='删除保存副本';await f.call('remove',foreign.id);assert.equal(f.diag.getState().activeEmail,'a@example.test');assert.ok(f.diag.getAccounts().some(item=>item.id===local.id&&item.active));assert.ok(!f.events.includes('stop')&&!f.events.includes('credential-write'));assert.equal(f.state.get('live-switch.removed-current.v1'),undefined);
});
test('a verified replacement switch lets a later official login re-add the removed identity immediately',async t=>{
 const f=officialSyncFixture(t);await f.diag.refresh();const a=f.diag.getAccounts()[0];f.set('b@example.test');f.ui.focus({focused:true});await f.diag.refresh();f.set('a@example.test');f.ui.focus({focused:true});await f.diag.refresh();
 f.ui.answer='删除保存副本';await f.call('remove',a.id);assert.equal(f.diag.getState().activeEmail,'b@example.test');f.set('a@example.test');f.ui.focus({focused:true});await f.diag.refresh();
 assert.equal(f.diag.getState().activeEmail,'a@example.test');assert.equal(f.diag.getAccounts().filter(item=>item.expectedEmail==='a@example.test').length,1);assert.equal(f.diag.getAccounts().length,2);
});
test('idle official sign-out invalidates the same-Hub current badge instead of swallowing its fixed auth error',async t=>{
 const f=officialSyncFixture(t),hub=require('../out/live-hub'),old=hub.queryHub;let signedOut=false;
 hub.queryHub=async()=>{if(signedOut)throw new (require('../out/live-storage').LiveError)('HUB_AUTH_INVALID');return f.proof()};t.after(()=>hub.queryHub=old);
 f.ui.currentIdentity=async()=>{if(signedOut)throw new (require('../out/live-storage').LiveError)('HUB_AUTH_INVALID');return f.proof()};await f.diag.refresh();signedOut=true;await new Promise(resolve=>setTimeout(resolve,5300));
 assert.equal(f.diag.getState().activeEmail,undefined);assert.ok(f.diag.getAccounts().every(item=>!item.active));assert.ok(!f.events.includes('stop')&&!f.events.includes('credential-write'));
});
test('explicit verify resumes a stopped installed transaction, repins the lifecycle and then verifies under its lock',async()=>{
 const f=setup();await f.diag.refresh();let journal={id:'resume-transaction',phase:'installed',target:{expectedEmail:'a@example.test'}};
 f.service.journal=async()=>journal;f.locks.assertRecovery=async()=>{};f.backend.restartMode='component';f.backend.generation='stopped';
 const resolutions=[];f.ui.resolveLifecycle=async running=>{resolutions.push(running);if(running&&f.backend.generation==='stopped')throw new (require('../out/live-storage').LiveError)('OFFICIAL_HUB_NOT_READY');return f.backend;};
 f.service.resumeStoppedVerification=async(backend,guard)=>{assert.equal(guard.id,journal.id);assert.equal(f.events.at(-1),'locked');guard.assertCurrent();f.events.push('resume');backend.generation='resumed';};
 f.service.finishVerified=async()=>{assert.equal(f.backend.generation,'resumed');f.events.push('verify');journal=null;return{email:'a@example.test',generation:'resumed',observedAt:new Date().toISOString()};};
 f.events.length=0;await f.call('verify');assert.deepEqual(resolutions,[false,true]);assert.ok(f.events.indexOf('resume')<f.events.indexOf('verify'));assert.ok(f.events.indexOf('verify')<f.events.indexOf('unlocked'));
 assert.equal(f.diag.getState().pending,false);assert.equal(f.diag.getState().activeEmail,'a@example.test');assert.ok(!f.events.includes('workbench.action.reloadWindow'));
});
test('debug-OFF preserves primary switch stage and secondary recovery error instead of a generic wrapper',async()=>{
 const f=setup();await f.diag.refresh();let journal;const {LiveError}=require('../out/live-storage');
 f.service.journal=async()=>journal;f.ui.selected={account:{id:'fixture-id',expectedEmail:'a@example.test'}};f.ui.answer='切换账号';f.backend.restartMode='component';
 f.ui.resolveLifecycle=async running=>{if(journal&&running)throw new LiveError('OFFICIAL_HUB_NOT_READY');return f.backend;};
 f.service.install=async(_id,_backend,id,stage)=>{stage('journal-installed');journal={id,phase:'installed',target:{expectedEmail:'a@example.test'}};throw new LiveError('RECOVERY_SAVE_NOT_VERIFIED');};
 await f.call('switch');const failure=f.state.get('live-switch.lastFailure.v1');
 assert.equal(failure.code,'RECOVERY_SAVE_NOT_VERIFIED');assert.equal(failure.recoveryCode,'OFFICIAL_HUB_NOT_READY');assert.equal(failure.stage,'journal-installed');assert.equal(failure.phase,'installed');assert.equal(failure.action,'switch');
 assert.deepEqual(f.diag.getState().lastFailure,failure);assert.match(f.diag.getState().error,/RECOVERY_SAVE_NOT_VERIFIED/);assert.doesNotMatch(JSON.stringify(failure),/example|fixture|credential|token/);
 assert.ok(journal);assert.ok(!f.events.includes('workbench.action.reloadWindow'));
});
test('persisted account failure rejects getters and arbitrary credential-like fields',()=>{
 const {readLastAccountFailure}=require('../out/last-account-failure');let called=0;
 const valid={schema:1,at:'2026-10-03T16:00:00.000Z',action:'switch',stage:'reconnect',phase:'installed',code:'OFFICIAL_COMPONENT_RECONNECT_FAILED'};
 assert.deepEqual(readLastAccountFailure({...valid,message:'synthetic-secret',token:'synthetic-secret'}),valid);
 assert.equal(readLastAccountFailure({...valid,code:'SYNTHETIC_PRIVATE_TOKEN'}),undefined);
 assert.equal(readLastAccountFailure({...valid,get code(){called++;return 'OFFICIAL_COMPONENT_RECONNECT_FAILED';}}),undefined);assert.equal(called,0);
});
test('a stale installed readback settles before reconnect and finishes the target once under the original lock',async()=>{
 const f=setup();await f.diag.refresh();const {LiveSwitchService}=require('../out/live-switch'),{LiveError}=require('../out/live-storage');
 const values=new Map(),a={keyring:JSON.stringify({token:{refresh_token:'synthetic-a'}}),file:null},b={keyring:JSON.stringify({token:{refresh_token:'synthetic-b'}}),file:null};
 let current=a,writes=0,restarts=0,stale,failNext=false;
 const vault={get:async key=>{if(stale?.key===key){const value=stale.value;stale=undefined;return value;}return values.get(key);},store:async(key,value)=>{const prior=values.get(key);values.set(key,value);if(failNext&&JSON.parse(value).phase==='installed'){failNext=false;stale={key,value:prior};}},delete:async key=>{values.delete(key);}};
 const real=new LiveSwitchService(vault,{read:async()=>({...current}),write:async(next,expected)=>{assert.deepEqual(current,expected);current={...next};writes++;}});
 const savedA=await real.capture({label:'A',expectedEmail:'a@example.test',identitySource:'hub'});current=b;const savedB=await real.capture({label:'B',expectedEmail:'b@example.test',identitySource:'hub'});current=a;
 f.state.set('live-switch.accounts.v1',[savedA,savedB]);
 for(const name of ['journal','account','install','finishVerified','resumeStoppedVerification','restore','recoverImport','recoverLogin'])f.service[name]=real[name].bind(real);
 f.locks.assertRecovery=async()=>{};f.ui.answer='切换账号';f.backend.restartMode='component';f.backend.generation='cold';
 f.backend.stop=async()=>{f.events.push('stop');f.backend.generation='stopped';};
 f.backend.reload=async()=>{assert.equal(f.events.at(-1),'stop');restarts++;f.backend.generation='started-'+restarts;};
 f.backend.proof=async()=>({email:current.keyring===a.keyring?'a@example.test':'b@example.test',generation:f.backend.generation,authValid:true,quotaSource:'server',observedAt:new Date().toISOString(),buckets:[]});
 f.ui.resolveLifecycle=async running=>{if(running&&f.backend.generation==='stopped')throw new LiveError('OFFICIAL_HUB_NOT_READY');return f.backend;};
 await f.call('switch',savedB.id);assert.equal(restarts,1);assert.equal(writes,1);assert.equal(await real.journal(),null);assert.equal(f.diag.getState().activeEmail,'b@example.test');
 failNext=true;await f.call('switch',savedA.id);
 assert.equal(restarts,2);assert.equal(writes,2);assert.equal(await real.journal(),null);assert.equal(f.diag.getState().pending,false);assert.equal(f.diag.getState().activeEmail,'a@example.test');
 assert.equal(f.state.get('live-switch.lastFailure.v1'),undefined);assert.equal(f.events.filter(x=>x==='stop').length,2);assert.ok(!f.events.includes('workbench.action.reloadWindow'));
 for(const sub of f.context.subscriptions)sub.dispose();
});
test('timed-out installed acknowledgement starts only the exact target and focus cannot clear pending recovery',async()=>{
 const {verificationClock,settle}=require('./fixtures/verification-clock.cjs'),clock=verificationClock(),f=setup({verificationClock:clock});await f.diag.refresh();
 const {LiveSwitchService}=require('../out/live-switch'),{LiveError}=require('../out/live-storage'),values=new Map();
 const a={keyring:JSON.stringify({token:{refresh_token:'synthetic-a'}}),file:null},b={keyring:JSON.stringify({token:{refresh_token:'synthetic-b'}}),file:null};
 let current=a,writes=0,restarts=0,delayed;
 const vault={get:async key=>values.get(key),store:async(key,value)=>{if(key==='live-switch.recovery.v1'&&JSON.parse(value).phase==='installed'&&JSON.parse(value).verification.attempts===0){delayed=value;return;}values.set(key,value);},delete:async key=>values.delete(key)};
 const real=new LiveSwitchService(vault,{read:async()=>({...current}),write:async(next,expected)=>{assert.deepEqual(current,expected);current={...next};writes++;}},undefined,{clock,timeoutMs:1000});
 current=b;const saved=await real.capture({label:'B',expectedEmail:'b@example.test',identitySource:'hub'});current=a;f.state.set('live-switch.accounts.v1',[saved]);
 for(const name of ['journal','account','install','finishVerified','resumeStoppedVerification','resumeUnconfirmedInstall','restore','recoverImport','recoverLogin'])f.service[name]=real[name].bind(real);
 f.locks.assertRecovery=async()=>{};f.ui.answer='切换账号';f.backend.restartMode='component';f.backend.generation='before';
 f.backend.stop=async()=>{f.backend.generation='stopped'};f.backend.reload=async()=>{restarts++;f.backend.generation='started'};
 f.backend.proof=async()=>({email:current.keyring===a.keyring?'a@example.test':'b@example.test',generation:f.backend.generation,authValid:true,quotaSource:'server',observedAt:new Date().toISOString(),buckets:[]});
 f.ui.resolveLifecycle=async running=>{if(running&&f.backend.generation==='stopped')throw new LiveError('OFFICIAL_HUB_NOT_READY');return f.backend};
 const action=f.call('switch',saved.id);await settle();await clock.advance(1000);await action;
 assert.equal(restarts,1);assert.equal(writes,1);assert.equal(f.diag.getState().pending,true);assert.equal(f.diag.getState().activeEmail,undefined);assert.equal(f.state.get('live-switch.lastFailure.v1').code,'RECOVERY_SAVE_NOT_VERIFIED');
 values.set('live-switch.recovery.v1',delayed);await f.diag.refresh();await clock.advance(2000);
 assert.ok(await real.journal());assert.equal(f.diag.getState().pending,true);assert.equal(restarts,1);assert.equal(writes,1);
 await f.call('verify');assert.equal(await real.journal(),null);assert.equal(f.diag.getState().activeEmail,'b@example.test');assert.equal(restarts,1);assert.equal(writes,1);
 for(const sub of f.context.subscriptions)sub.dispose();
});
test('journal conflict never triggers automatic rollback even with a running backend',async()=>{
 const f=setup();await f.diag.refresh();const {LiveError}=require('../out/live-storage');let journal,restores=0;
 f.service.journal=async()=>journal;f.ui.selected={account:{id:'selected',expectedEmail:'a@example.test'}};f.ui.answer='切换账号';f.backend.restartMode='component';
 f.service.install=async(_id,_backend,id,stage)=>{stage('journal-installed');journal={id,phase:'installed',target:{id:'selected'}};throw new LiveError('RECOVERY_CHANGED')};
 f.service.restore=async()=>{restores++};await f.call('switch');assert.equal(restores,0);assert.ok(journal);assert.equal(f.diag.getState().pending,true);
 for(const sub of f.context.subscriptions)sub.dispose();
});
test('automatic stopped completion is unavailable after reconnect dispatch or for an uncommitted/different target',async()=>{
 const {LiveError}=require('../out/live-storage');
 for(const mode of ['reconnect-dispatched','prepared','different-target','different-code','verification-started','external-change']){
  const f=setup();await f.diag.refresh();let journal,resumes=0;
  f.service.journal=async()=>journal;f.ui.selected={account:{id:'selected',expectedEmail:'a@example.test'}};f.ui.answer='切换账号';f.backend.restartMode='component';f.backend.generation='stopped';f.locks.assertRecovery=async()=>{};
  f.ui.resolveLifecycle=async running=>{if(journal&&running)throw new LiveError('OFFICIAL_HUB_NOT_READY');return f.backend;};
  f.service.install=async(_id,_backend,id,stage)=>{stage(mode==='reconnect-dispatched'?'reconnect':'journal-installed');journal={id,phase:mode==='prepared'?'prepared':'installed',verification:{state:'pending',attempts:mode==='verification-started'?1:0},target:{id:mode==='different-target'?'other':'selected',expectedEmail:'a@example.test'}};throw new LiveError(mode==='different-code'?'EXTERNAL_CHANGE':'RECOVERY_SAVE_NOT_VERIFIED');};
  f.service.resumeStoppedVerification=async()=>{resumes++;throw new LiveError('EXTERNAL_CHANGE');};
  await f.call('switch');assert.equal(resumes,mode==='external-change'?1:0);assert.ok(journal);assert.equal(f.diag.getState().pending,true);assert.ok(!f.events.includes('stop')&&!f.events.includes('bad-direct-reload'));
  for(const sub of f.context.subscriptions)sub.dispose();
 }
});
test('a focus refresh during another image batch does not invent account recovery',async()=>{
 const f=setup();f.locks.reconcileRecovery=async()=>assert.fail('must not mutate recovery');
 f.locks.inspectRecovery=async()=>({state:'absent'});
 f.locks.inspectOperation=async()=>({state:'active',owner:{purpose:'image'}});
 await f.diag.refresh();assert.equal(f.diag.getState().pending,false);assert.notEqual(f.state.get('live-switch.pending.v1'),true);
 assert.deepEqual(f.events,[]);
});
test('capture dismissal and untrusted calls perform no credential work',async()=>{const f=setup();await f.call('capture');assert.deepEqual(f.events,['locked','unlocked']);f.events.length=0;f.ui.trusted=false;await f.call('capture');assert.deepEqual(f.events,[]);assert.match(f.diag.getState().error,/受信任|信任/);});
test('real switch command defers window reload until after releasing operation mutex',async()=>{
 const f=setup();f.ui.selected={account:{id:'fixture-id',expectedEmail:'b@example.test'}};f.ui.answer='切换账号';
 f.service.install=async(_id,backend,transaction)=>{assert.match(transaction,/^[a-f0-9-]{36}$/);f.events.push('install');await backend.reload();};
 await f.call('switch');assert.deepEqual(f.events,['locked','recovery','install','unlocked','workbench.action.reloadWindow']);
});
test('component switch verifies inside operation lock and never reloads the window', async () => {
 const f=setup(); f.ui.selected={account:{id:'fixture-id',expectedEmail:'b@example.test'}}; f.ui.answer='切换账号';
 f.backend.restartMode='component'; let journal;
 f.service.journal=async()=>journal;
 f.locks.assertRecovery=async()=>{};
 f.service.install=async(_id,backend,id)=>{journal={id,phase:'installed',target:{expectedEmail:'b@example.test'}};f.events.push('install');await backend.reload();};
 f.service.finishVerified=async()=>{f.events.push('verified');journal=null;return{email:'b@example.test',generation:'new',observedAt:new Date().toISOString()};};
 await f.call('switch');
 assert.deepEqual(f.events,['locked','recovery','install','bad-direct-reload','verified','clear','unlocked']);
 assert.equal(f.diag.getState().pending,false); assert.equal(f.diag.getState().activeEmail,'b@example.test');
 assert.ok(!f.events.includes('workbench.action.reloadWindow'));
});
test('failed target verification rolls back only through guarded storage and verifies original session', async () => {
 const f=setup(); f.ui.selected={account:{id:'fixture-id',expectedEmail:'b@example.test'}}; f.ui.answer='切换账号';
 f.backend.restartMode='component'; let journal, checks=0;
 f.service.journal=async()=>journal; f.locks.assertRecovery=async()=>{};
 f.service.install=async(_id,backend,id)=>{journal={id,phase:'installed',target:{expectedEmail:'b@example.test'}};await backend.reload();};
 f.service.finishVerified=async()=>{if(++checks===1)throw Error('synthetic mismatch');journal=null;return{email:'a@example.test',generation:'restored',observedAt:new Date().toISOString()};};
 f.service.restore=async(_backend,options)=>{assert.equal(options.guardInstalled,true);journal.phase='restored';f.events.push('guarded-restore');};
 await f.call('switch');
 assert.equal(checks,2);assert.ok(f.events.includes('guarded-restore'));assert.equal(f.diag.getState().activeEmail,'a@example.test');
 assert.equal(f.diag.getState().pending,false);assert.match(f.diag.getState().error,/已恢复并核验原账号/);
 assert.ok(!f.events.includes('workbench.action.reloadWindow'));
});
test('missing component capabilities and pending images stop before credential mutation', async () => {
 const f=setup(); f.ui.selected={account:{id:'fixture-id',expectedEmail:'b@example.test'}}; f.ui.answer='切换账号';f.backend.restartMode='unavailable';
 await f.call('switch');assert.ok(!f.events.includes('install'));assert.ok(!f.events.includes('recovery'));assert.match(f.diag.getState().error,/组件重连能力/);
 f.events.length=0;f.backend.restartMode='component';
 const release=require('../out/image-activity').enterImageOperation('offline-confirmation');
 try {await f.call('switch');assert.deepEqual(f.events,[]);assert.match(f.diag.getState().error,/图片任务或生图确认/);} finally {release();}
});
test('loaded lifecycle uses only exact loaded cache entry, never loads second official instance',async()=>{
 const f=setup();let n=0;const file='/synthetic/official/extension.js';const cached={loaded:true,exports:{deactivate:async()=>{n++;}}};
 assert.equal(f.api.loadedDeactivator(file,{}),null);assert.equal(f.api.loadedDeactivator(file,{[file]:{...cached,loaded:false}}),null);
 await f.api.loadedDeactivator(file,{[file]:cached})();assert.equal(n,1);
});
test('concurrent repeated switch clicks are coalesced while confirmation is pending',async()=>{
 const f=setup();let resolve;const wait=new Promise(r=>{resolve=r});f.locks.withOperation=async fn=>{f.events.push('locked');await wait;return fn();};
 const first=f.call('capture');await f.call('capture');await new Promise(setImmediate);assert.deepEqual(f.events,['locked']);resolve();await first;
});

test('loaded cache entry may use canonical real path instead of requested alias',async t=>{
 const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');const dir=await fs.mkdtemp(path.join(os.tmpdir(),'agm-cache-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'extension.js');await fs.writeFile(file,'exports.deactivate=()=>{}');const actual=require('node:fs').realpathSync.native(file);const f=setup();const cached={loaded:true,exports:{deactivate:async()=>{}}};
 const requested=process.platform==='win32'?actual.replace(/^[A-Z]:/,d=>d.toLowerCase()):path.join(dir,'..',path.basename(dir),'extension.js');
 assert.equal(typeof f.api.loadedDeactivator(requested,{[actual]:cached}),'function');
});

test('WSL workspace does not reject a verified local UI extension host',async()=>{
 const f=setup();await f.call('capture');assert.equal(f.diag.getState().environment.available,true);
 const {nativeHostStatus}=require('../out/native-host');
 for(const remoteName of ['wsl','ssh-remote','dev-container']){
  // remoteName describes the workspace and deliberately is not part of the host verdict.
  f.ui.remoteName=remoteName;f.events.length=0;await f.call('capture');
  assert.deepEqual(f.events,['locked','unlocked']);assert.equal(nativeHostStatus(f.context,true,true).available,true);
 }
});
test('invalid execution kind, remote storage and non-file extension fail before locks or credential access',async()=>{
 for(const change of [f=>{f.context.extension.extensionKind=99},f=>{f.context.extensionUri.scheme='vscode-remote'},f=>{f.context.globalStorageUri.scheme='vscode-remote'},f=>{f.context.globalStorageUri.authority='other-machine'}]){
  const f=setup();change(f);await f.call('capture');assert.deepEqual(f.events,[]);assert.match(f.diag.getState().error,/当前原生宿主/);assert.equal(f.diag.getState().environment.available,false);
 }
 const {nativeHostStatus}=require('../out/native-host');assert.equal(nativeHostStatus(setup().context,true,false).code,'NATIVE_DESKTOP_REQUIRED');
});
const saved={id:'00000000-0000-4000-8000-000000000001',label:'Personal',expectedEmail:'personal@example.test',capturedAt:'2026-10-01T00:00:00.000Z',identitySource:'hub'};
test('per-account switch resolves only a stored ID and still asks for confirmation',async()=>{
 const f=setup();f.state.set('live-switch.accounts.v1',[saved]);
 await f.commands.get('antigravityAccounts.live.switch')(saved.id);assert.ok(!f.events.includes('install'));
 f.ui.answer='切换账号';let id;
 f.service.install=async value=>{id=value;f.events.push('install');f.service.journal=async()=>({id:'synthetic-switch',phase:'installed'})};
 await f.commands.get('antigravityAccounts.live.switch')(saved.id);assert.equal(id,saved.id);
 assert.equal(f.diag.getState().pending,true);assert.match(f.warnings.at(-1),/personal@example.test/);
});
test('invalid or stale direct IDs do not fall back to arbitrary selected records',async()=>{
 for(const argument of [{id:saved.id},'../../secret','00000000-0000-4000-8000-000000000002']){
  const f=setup();f.state.set('live-switch.accounts.v1',[saved]);f.ui.selected={account:saved};f.ui.answer='切换账号';
  await f.commands.get('antigravityAccounts.live.switch')(argument);assert.ok(!f.events.includes('install'));assert.match(f.diag.getState().error,/刷新账户列表/);
 }
});
test('per-account remove requires confirmation, deletes only selected SecretStorage copy and updates state',async()=>{
 const f=setup(),deleted=[];f.context.secrets.delete=async key=>deleted.push(key);f.state.set('live-switch.accounts.v1',[saved]);
 await f.commands.get('antigravityAccounts.live.remove')(saved.id);assert.deepEqual(deleted,[]);
 f.ui.answer='删除保存副本';await f.commands.get('antigravityAccounts.live.remove')(saved.id);
 assert.deepEqual(deleted,['live-switch.account.v1.'+saved.id,'live-switch.quota-refresh.v1.'+saved.id,'live-switch.quota-pending.v1.'+saved.id]);assert.deepEqual(f.diag.getAccounts(),[]);assert.match(f.diag.getState().status,/已删除/);
});
test('structured busy state spans confirmation and clears after dismissal',async()=>{
 const f=setup();let release;f.locks.withOperation=async fn=>{await new Promise(r=>release=r);return fn()};
 const first=f.call('capture');assert.equal(f.diag.getState().busy,true);await new Promise(setImmediate);release();await first;assert.equal(f.diag.getState().busy,false);
});
test('known blockers have actionable wording and unknown errors never echo native data',async()=>{
 const f=setup();for(const code of ['OFFICIAL_EXTENSION_MISSING','OFFICIAL_HOST_MISMATCH','OFFICIAL_WSL_EXECUTABLE_INVALID','HUB_RPC_TIMEOUT','LOGIN_FAILED_RECOVERY_REQUIRED','KEYRING_UNAVAILABLE']){
  assert.match(f.api.liveErrorMessage(code),/[\u4e00-\u9fff]/);assert.ok(!f.api.liveErrorMessage(code).includes(code));
 }
 f.locks.withOperation=async()=>{throw new Error('raw-secret')};await f.call('capture');assert.ok(!f.diag.getState().error.includes('raw-secret'));assert.match(f.diag.getState().error,/失败详情/);
});

function officialFixture(f){
 const path=require('node:path');const extensionPath=path.resolve('/synthetic-official-extension');
 f.ui.official={id:'google.google-antigravity',extensionKind:1,extensionUri:{scheme:'file',authority:'',toString:()=>`file://${extensionPath}`},extensionPath,packageJSON:{version:'1.6.0',main:'./extension.js'},isActive:false,exports:{port:34567,csrfToken:'synthetic-official-csrf'},async activate(){f.events.push('activate-official');this.isActive=true;return this.exports}};
 return f.ui.official;
}
test('official remote host, custom release and invalid entrypoint reject before activation',async()=>{
 for(const [change,code] of [
  [x=>{x.ui.official.extensionKind=2},'OFFICIAL_HOST_MISMATCH'],
  [x=>{x.ui.official.extensionUri.scheme='vscode-remote'},'OFFICIAL_HOST_MISMATCH'],
  [x=>{x.ui.config.releaseBaseUrl='https://invalid.example'},'OVERRIDE_OR_REMOTE_AUTH_UNSUPPORTED'],
  [x=>{x.ui.config.serverArgs=['--custom']},'OVERRIDE_OR_REMOTE_AUTH_UNSUPPORTED'],
  [x=>{x.ui.official.packageJSON.main='../another-extension.js'},'OFFICIAL_ENTRY_UNAVAILABLE'],
 ]){
  const f=setup();officialFixture(f);f.ui.remoteName='wsl';change(f);
  await assert.rejects(f.api.resolveOfficialLifecycle(f.context,true,true),{message:code});assert.deepEqual(f.events,[]);
 }
 const f=setup();await assert.rejects(f.api.resolveOfficialLifecycle(f.context,true,true),/OFFICIAL_EXTENSION_MISSING/);
});
test('lifecycle accepts future releases and missing version diagnostics with live capabilities',async t=>{
 const f=setup(),official=officialFixture(f),path=require('node:path'),storage=require('../out/live-storage');
 f.ui.remoteName='wsl';const main=path.join(official.extensionPath,'extension.js');const previousCache=require.cache[main],previousRun=storage.runPrivate;
 const contract=require('../out/official-contract'),environment=require('../out/live-environment'),fs=require('node:fs/promises'),previousContract=contract.assertOfficialEntrypoint,previousHash=environment.assertWslBackendExecutable,previousStat=fs.stat,previousAccess=fs.access;
 contract.assertOfficialEntrypoint=async()=>{};environment.assertWslBackendExecutable=async()=>{};fs.stat=async()=>({isFile:()=>true});fs.access=async()=>{};
 let stopped=false,versionResult={code:0,stdout:'agy version 99.4.2-preview',stderr:''};const calls=[];
 require.cache[main]={loaded:true,exports:{async deactivate(){stopped=true;official.exports={port:undefined,csrfToken:'synthetic-official-csrf'};f.events.push('deactivate-official')}}};
 storage.runPrivate=async(executable,args)=>{calls.push({executable,args});if(args[0]==='--version'){if(versionResult instanceof Error)throw versionResult;return versionResult}return{code:0,stdout:stopped?'':process.platform==='win32'?'"agy.exe","321"':'agy\n',stderr:''}};
 t.after(()=>{contract.assertOfficialEntrypoint=previousContract;environment.assertWslBackendExecutable=previousHash;fs.stat=previousStat;fs.access=previousAccess;storage.runPrivate=previousRun;if(previousCache)require.cache[main]=previousCache;else delete require.cache[main]});
 official.packageJSON.version='99.0.0';
 const backend=await f.api.resolveOfficialLifecycle(f.context,true,true);
 assert.equal(backend.backendVersion,'99.4.2-preview');
 for(versionResult of [{code:0,stdout:'future-opaque-release',stderr:''},{code:2,stdout:'',stderr:'unknown option'},new Error('synthetic diagnostic failure')]){
  const compatible=await f.api.resolveOfficialLifecycle(f.context,true,true);assert.equal(compatible.backendVersion,undefined);
 }
 assert.deepEqual(f.events,['activate-official']);assert.ok(calls.some(x=>x.args[0]==='--version'));
 assert.match(backend.generation,/^[a-f0-9]{64}$/);await backend.stop();await backend.stop();assert.equal(f.events.filter(x=>x==='deactivate-official').length,1);
});
test('missing loaded module or invalid exported API fails before any credential operation',async t=>{
 const f=setup(),official=officialFixture(f),path=require('node:path'),storage=require('../out/live-storage');official.isActive=true;
 const previous=storage.runPrivate,main=path.join(official.extensionPath,'extension.js');
 const contract=require('../out/official-contract'),environment=require('../out/live-environment'),fs=require('node:fs/promises'),previousContract=contract.assertOfficialEntrypoint,previousHash=environment.assertWslBackendExecutable,previousStat=fs.stat,previousAccess=fs.access;
 contract.assertOfficialEntrypoint=async()=>{};environment.assertWslBackendExecutable=async()=>{};fs.stat=async()=>({isFile:()=>true});fs.access=async()=>{};storage.runPrivate=async()=>({code:0,stdout:'agy version 1.2.14',stderr:''});
 t.after(()=>{contract.assertOfficialEntrypoint=previousContract;environment.assertWslBackendExecutable=previousHash;fs.stat=previousStat;fs.access=previousAccess;storage.runPrivate=previous;delete require.cache[main]});
 await assert.rejects(f.api.resolveOfficialLifecycle(f.context),/OFFICIAL_LIFECYCLE_NOT_LOADED/);
 const hub=require('../out/live-hub'),oldQuota=hub.queryFreshQuota;t.after(()=>{hub.queryFreshQuota=oldQuota});
 hub.queryFreshQuota=async pinned=>({generation:hub.generation(pinned),email:'personal@example.test',authValid:true,quotaSource:'server',buckets:[{label:'synthetic',remaining:1,resetAt:null}]});
 const readOnly=await f.api.resolveOfficialReadOnlyHub(f.context);
 assert.equal((await readOnly.quota('personal@example.test')).quotaSource,'server','missing stop capability only blocks credential mutation');
 require.cache[main]={loaded:true,exports:{deactivate:async()=>{throw Error('must not stop')}}};official.exports={port:34567,csrfToken:'invalid'};
 await assert.rejects(f.api.resolveOfficialLifecycle(f.context),/OFFICIAL_HUB_API_UNAVAILABLE/);assert.deepEqual(f.events,[]);
});

test('passive readiness reports missing dependency and remote official host without activation',()=>{
 const f=setup();f.ui.remoteName='wsl';assert.equal(f.diag.getState().official.code,'OFFICIAL_EXTENSION_MISSING');assert.match(f.diag.getState().environment.message,/WSL 工作区/);
 const official=officialFixture(f);assert.equal(f.diag.getState().official.available,true);assert.deepEqual(f.events,[]);
 official.extensionKind=2;assert.equal(f.diag.getState().official.code,'OFFICIAL_HOST_MISMATCH');assert.deepEqual(f.events,[]);
});
test('saved-copy removal remains possible with no official extension installed',async()=>{
 const f=setup();assert.equal(f.diag.getState().official.available,false);f.state.set('live-switch.accounts.v1',[saved]);let deleted;
 f.context.secrets.delete=async key=>{deleted=key};f.ui.answer='删除保存副本';await f.commands.get('antigravityAccounts.live.remove')(saved.id);assert.equal(deleted,'live-switch.quota-pending.v1.'+saved.id);
});
test('entrypoint validation permits changed code and unknown releases while bounding local paths',async t=>{
 const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),contract=require('../out/official-contract');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'agm-contract-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 await fs.writeFile(path.join(dir,'extension.js'),'exports.activate=async()=>({port:1234,csrfToken:"synthetic-only"});exports.deactivate=()=>{};');
 for(const version of ['1.6.0','1.6.1','99.0.0','future-release',undefined])await contract.assertOfficialEntrypoint({extensionPath:dir,packageJSON:{main:'./extension.js',version}});
 for(const main of ['../outside.js','/outside.js','',null])assert.throws(()=>contract.officialEntryPath({extensionPath:dir,packageJSON:{main}}),/OFFICIAL_ENTRY_UNAVAILABLE/);
 const large=await fs.open(path.join(dir,'large.js'),'w');await large.truncate(32*1024*1024+1);await large.close();
 await assert.rejects(contract.assertOfficialEntrypoint({extensionPath:dir,packageJSON:{main:'large.js'}}),/OFFICIAL_ENTRY_UNAVAILABLE/);
});
test('code contract refuses entrypoint symlinks escaping installed extension',async t=>{
 if(process.platform==='win32'){t.skip('symlink creation can require Windows privileges');return}
 const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),contract=require('../out/official-contract');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'agm-contract-link-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 await fs.mkdir(path.join(dir,'extension'));await fs.writeFile(path.join(dir,'outside.js'),'synthetic');await fs.symlink(path.join(dir,'outside.js'),path.join(dir,'extension','entry.js'));
 await assert.rejects(contract.assertOfficialEntrypoint({extensionPath:path.join(dir,'extension'),packageJSON:{main:'entry.js'}}),/OFFICIAL_ENTRY_UNAVAILABLE/);
});

test('version labels are optional diagnostics and never an allowlist',()=>{
 const {diagnosticBackendVersion}=require('../out/official-contract');
 for(const version of ['1.2.14','1.2.16','99.0.0','1.2.14-preview','1.2.14+custom'])assert.equal(diagnosticBackendVersion('agy version '+version),version);
 for(const value of ['unavailable','old 1.2.14 new 1.3.0','9'.repeat(8193)])assert.equal(diagnosticBackendVersion(value),undefined);
});
test('native HOME backend absence gives install guidance without running a workspace executable',async t=>{
 const f=setup(),official=officialFixture(f),storage=require('../out/live-storage'),contract=require('../out/official-contract'),fs=require('node:fs/promises');official.isActive=true;
 const previousContract=contract.assertOfficialEntrypoint,previousStat=fs.stat,previousRun=storage.runPrivate;
 contract.assertOfficialEntrypoint=async()=>{};fs.stat=async filename=>{assert.equal(filename,require('node:path').join(require('node:os').homedir(),'.gemini','bin',process.platform==='win32'?'agy.exe':'agy'));throw Error('synthetic missing executable')};
 storage.runPrivate=async()=>{throw Error('must not launch')};t.after(()=>{contract.assertOfficialEntrypoint=previousContract;fs.stat=previousStat;storage.runPrivate=previousRun});
 await assert.rejects(f.api.resolveOfficialLifecycle(f.context),/OFFICIAL_BACKEND_UNAVAILABLE/);assert.match(f.api.liveErrorMessage('OFFICIAL_BACKEND_UNAVAILABLE'),/WSL/);assert.deepEqual(f.events,[]);
});

test('host matrix distinguishes native WSL execution, local remote windows and unsupported remotes',()=>{
 const {nativeHostStatus,sameNativeHost}=require('../out/native-host');
 const f=setup();
 for(const platform of ['win32','darwin','linux']) for(const remote of [undefined,'wsl','ssh-remote']) assert.equal(nativeHostStatus(f.context,true,true,remote,platform).available,true);
 f.context.extension.extensionKind=2;
 assert.equal(nativeHostStatus(f.context,true,true,'wsl','linux').available,true);
 assert.match(nativeHostStatus(f.context,true,true,'wsl','linux').message,/WSL · Linux/);
 for(const [remote,platform] of [['wsl','win32'],['ssh-remote','linux'],['dev-container','linux']])assert.equal(nativeHostStatus(f.context,true,true,remote,platform).code,'REMOTE_HOST_UNVERIFIED');
 const official=officialFixture(f);
 assert.equal(sameNativeHost(f.context,official,'wsl'),false);
 official.extensionKind=2;assert.equal(sameNativeHost(f.context,official,'wsl'),true);
 official.extensionUri.authority='different-machine';assert.equal(sameNativeHost(f.context,official,'wsl'),false);
 official.extensionUri.authority='';official.extensionKind=1;assert.equal(sameNativeHost(f.context,official),true,'native nonremote hosts can contain UI and workspace kinds');
});
test('WSL workspace host accepts same-host official runtime and never chooses Windows HOME backend',async t=>{
 if(process.platform!=='linux'){t.skip('actual WSL runtime is Linux; platform matrix checked separately');return;}
 const f=setup(),official=officialFixture(f),path=require('node:path'),storage=require('../out/live-storage'),contract=require('../out/official-contract'),fs=require('node:fs/promises');
 const environment=require('../out/live-environment'),previousMode=environment.resolveOfficialStorageMode,previousHash=environment.assertWslBackendExecutable;
 let checked=false;environment.resolveOfficialStorageMode=async()=> 'wsl-file';environment.assertWslBackendExecutable=async()=>{checked=true};
 t.after(()=>{environment.resolveOfficialStorageMode=previousMode;environment.assertWslBackendExecutable=previousHash});
 f.ui.remoteName='wsl';f.context.extension.extensionKind=2;official.extensionKind=2;
 const main=path.join(official.extensionPath,'extension.js'),previousCache=require.cache[main],previousRun=storage.runPrivate,previousContract=contract.assertOfficialEntrypoint,previousStat=fs.stat,previousAccess=fs.access;
 contract.assertOfficialEntrypoint=async()=>{};fs.stat=async()=>({isFile:()=>true});fs.access=async()=>{};
 let stopped=false,birth=1;const calls=[];
 const processes=require('../out/official-process'),oldInspect=processes.inspectWslProcesses;
 processes.inspectWslProcesses=async()=>{if(stopped)return{processes:[]};const current={pid:710,parentPid:process.pid,startTicks:String(birth),kind:'current-hub',taskState:'unknown'};return{processes:[current],current};};
 t.after(()=>{processes.inspectWslProcesses=oldInspect});
 require.cache[main]={loaded:true,exports:{async deactivate(){stopped=true;official.exports={port:undefined,csrfToken:'synthetic-official-csrf'}}}};
 storage.runPrivate=async(executable,args)=>{calls.push({executable,args});return{code:0,stdout:args[0]==='--version'?'agy version 1.2.14':stopped?'':'agy\n',stderr:''}};
 t.after(()=>{contract.assertOfficialEntrypoint=previousContract;fs.stat=previousStat;fs.access=previousAccess;storage.runPrivate=previousRun;if(previousCache)require.cache[main]=previousCache;else delete require.cache[main]});
 const backend=await f.api.resolveOfficialLifecycle(f.context,true,true);
 assert.equal(checked,true);assert.equal(f.diag.getState().environment.available,true);assert.equal(f.diag.getState().official.available,true);
 assert.equal(calls.find(x=>x.args[0]==='--version').executable,path.join(require('node:os').homedir(),'.gemini','bin','agy'));
 assert.ok(!calls.some(x=>/\.exe$/i.test(x.executable)));
 assert.equal(backend.restartMode,'unavailable');await backend.stop();await assert.rejects(backend.reload(),/OFFICIAL_COMPONENT_RESTART_UNAVAILABLE/);assert.ok(!f.events.includes('workbench.action.reloadWindow'));
 f.ui.commandIds=['antigravity.reconnect','antigravity.panel.focus'];f.ui.execute=async command=>{if(command==='antigravity.panel.focus'){stopped=false;birth++;official.exports={port:45679,csrfToken:'synthetic-official-csrf'};}};
 const restart=await f.api.resolveOfficialLifecycle(f.context,false);await restart.reload();assert.notEqual(restart.generation,'stopped');assert.deepEqual(f.events.slice(-2),f.ui.commandIds);
 await restart.stop();await restart.reload();await restart.stop();assert.equal(stopped,true,'controlled restart repins the new process birth');
});
test('credential host fingerprint isolates WSL from native but remains stable across workspace windows',()=>{
 const {credentialHostId}=require('../out/native-host'),f=setup();
 const native=credentialHostId(f.context);assert.match(native,/^[a-f0-9]{64}$/);
 assert.equal(credentialHostId(f.context,'wsl'),native);
 f.context.extension.extensionKind=2;assert.equal(credentialHostId(f.context),native);assert.notEqual(credentialHostId(f.context,'wsl'),native);
});

test('WSL orphan preflight blocks before mutation, rejects reused PID before stop and recovers after explicit external exit',async t=>{
 if(process.platform!=='linux'){t.skip('WSL lifecycle executes on Linux');return;}
 const f=setup(),official=officialFixture(f),path=require('node:path'),storage=require('../out/live-storage'),contract=require('../out/official-contract'),environment=require('../out/live-environment'),fs=require('node:fs/promises'),processes=require('../out/official-process');
 official.isActive=true;const main=path.join(official.extensionPath,'extension.js'),oldCache=require.cache[main],oldRun=storage.runPrivate,oldContract=contract.assertOfficialEntrypoint,oldMode=environment.resolveOfficialStorageMode,oldHash=environment.assertWslBackendExecutable,oldStat=fs.stat,oldAccess=fs.access,oldInspect=processes.inspectWslProcesses;
 contract.assertOfficialEntrypoint=async()=>{};environment.resolveOfficialStorageMode=async()=> 'wsl-file';environment.assertWslBackendExecutable=async()=>{};fs.stat=async()=>({isFile:()=>true});fs.access=async()=>{};
 let peer=true,deactivated=0,stopping=false,exitPolls=0,birth='123';
 const current={pid:710,parentPid:process.pid,startTicks:'123',kind:'current-hub',taskState:'unknown'},orphan={pid:711,parentPid:702,startTicks:'100',kind:'unowned-hub',taskState:'unknown'};
 processes.inspectWslProcesses=async()=>{if(stopping&&++exitPolls>=3)return{processes:[]};const owned={...current,startTicks:birth};return{processes:peer?[owned,orphan]:[owned],current:owned};};
 require.cache[main]={loaded:true,exports:{async deactivate(){deactivated++;stopping=true;official.exports={port:undefined,csrfToken:'synthetic-official-csrf'};}}};
 storage.runPrivate=async(_exe,args)=>{assert.equal(args[0],'--version','WSL process proof must not use global name-only count');return{code:0,stdout:'agy version 1.3.1',stderr:''};};
 t.after(()=>{contract.assertOfficialEntrypoint=oldContract;environment.resolveOfficialStorageMode=oldMode;environment.assertWslBackendExecutable=oldHash;fs.stat=oldStat;fs.access=oldAccess;storage.runPrivate=oldRun;processes.inspectWslProcesses=oldInspect;if(oldCache)require.cache[main]=oldCache;else delete require.cache[main]});
 let credentialReads=0;f.context.secrets.get=async()=>{credentialReads++;throw Error('must not read')};
 await assert.rejects(f.api.resolveOfficialLifecycle(f.context),/OFFICIAL_UNOWNED_HUB_TASK_UNKNOWN/);assert.equal(deactivated,0);assert.equal(credentialReads,0);assert.deepEqual(f.events,[]);assert.equal(f.diag.getState().pending,false);
 assert.match(f.api.liveErrorMessage('OFFICIAL_UNOWNED_HUB_TASK_UNKNOWN'),/查看下方进程/);
 peer=false;const backend=await f.api.resolveOfficialLifecycle(f.context);
 birth='124';await assert.rejects(backend.stop(),/HUB_CHANGED_DURING_OPERATION/);assert.equal(deactivated,0,'same PID and Hub API with a new birth must not be stopped');assert.equal(credentialReads,0);
 birth='123';await backend.stop();assert.equal(deactivated,1);assert.ok(exitPolls>=4,'hook completion alone does not prove child exit');assert.equal(credentialReads,0);
});

for(const platform of ['darwin','win32']) test(`${platform} native lifecycle preserves exclusivity, waits for exit and restarts without proc access`,async t=>{
 const originalPlatform=Object.getOwnPropertyDescriptor(process,'platform');Object.defineProperty(process,'platform',{...originalPlatform,value:platform});
 const f=setup(),official=officialFixture(f),path=require('node:path'),storage=require('../out/live-storage'),contract=require('../out/official-contract'),environment=require('../out/live-environment'),fs=require('node:fs/promises'),processes=require('../out/official-process');
 official.isActive=true;const main=path.join(official.extensionPath,'extension.js'),oldCache=require.cache[main],oldRun=storage.runPrivate,oldContract=contract.assertOfficialEntrypoint,oldHash=environment.assertWslBackendExecutable,oldStat=fs.stat,oldAccess=fs.access,oldInspect=processes.inspectWslProcesses;
 t.after(()=>{Object.defineProperty(process,'platform',originalPlatform);contract.assertOfficialEntrypoint=oldContract;environment.assertWslBackendExecutable=oldHash;fs.stat=oldStat;fs.access=oldAccess;storage.runPrivate=oldRun;processes.inspectWslProcesses=oldInspect;if(oldCache)require.cache[main]=oldCache;else delete require.cache[main]});
 contract.assertOfficialEntrypoint=async()=>{};environment.assertWslBackendExecutable=async()=>{throw Error('native must not inspect WSL executable')};processes.inspectWslProcesses=async()=>{throw Error('native must not access proc')};
 fs.stat=async filename=>{assert.equal(path.basename(filename),platform==='win32'?'agy.exe':'agy');return{isFile:()=>true}};fs.access=async(_filename,mode)=>{assert.equal(mode,platform==='win32'?require('node:fs').constants.F_OK:require('node:fs').constants.X_OK)};
 let count=2,stopping=false,polls=0,deactivated=0,epoch=0;const observed=[];
 storage.runPrivate=async(executable,args)=>{
  if(args[0]==='--version')return{code:0,stdout:'agy version 1.3.1',stderr:''};observed.push({executable,args});
  if(platform==='win32'){assert.equal(executable,path.win32.join(process.env.SystemRoot||'C:\\Windows','System32','tasklist.exe'));assert.deepEqual(args,['/FO','CSV','/NH','/FI','IMAGENAME eq agy.exe']);}
  else{assert.equal(executable,'/bin/ps');assert.deepEqual(args,['-A','-o','comm=']);}
  if(stopping&&++polls>=3)count=0;
  return{code:0,stdout:Array.from({length:count},()=>platform==='win32'?'"agy.exe","710"':'agy').join('\n'),stderr:''};
 };
 require.cache[main]={loaded:true,exports:{async deactivate(){deactivated++;stopping=true;polls=0;official.exports={port:undefined,csrfToken:'synthetic-official-csrf'};}}};
 f.ui.commandIds=['antigravity.reconnect','antigravity.panel.focus'];f.ui.execute=async command=>{if(command==='antigravity.panel.focus'){stopping=false;count=1;epoch++;official.exports={port:45678,csrfToken:'synthetic-native-csrf-'+epoch};}};
 await assert.rejects(f.api.resolveOfficialLifecycle(f.context),/CLOSE_OTHER_AGY_PROCESSES/);assert.equal(deactivated,0);
 count=1;const backend=await f.api.resolveOfficialLifecycle(f.context);assert.equal(backend.fileOnlyGuard,undefined);
 await backend.stop();assert.ok(polls>=4);await backend.reload();const first=backend.generation;await backend.stop();await backend.reload();assert.notEqual(backend.generation,first);assert.equal(deactivated,2);
 assert.ok(observed.length>0);assert.ok(!f.events.includes('workbench.action.reloadWindow'));
});


test('current-account legacy query stays inline and reads no saved credentials',async()=>{
 const f=setup();f.state.set('live-switch.accounts.v1',[saved]);
 f.service.account=async()=>{throw Error('must not read saved token')};await f.call('quota');
 assert.equal(f.diag.getAccounts()[0].quota.phase,'ready');assert.deepEqual(f.warnings,[]);assert.deepEqual(f.notifications,[]);
});
test('explicit saved-account refresh queries without a reminder and only updates that card',async()=>{
 const f=setup(),other={...saved,id:'00000000-0000-4000-8000-000000000002',expectedEmail:'other@example.test'};f.state.set('live-switch.accounts.v1',[saved,other]);
 let reads=0;f.service.account=async id=>{reads++;return {...other,id,slots:{keyring:null,file:'synthetic'}}};
 assert.equal(reads,0);f.backend.quota=async expected=>({...await f.backend.proof(),email:expected,quotaSource:'server'});await f.call('quota',other.id);
 assert.equal(reads,2);assert.equal(f.diag.getAccounts()[0].quota,undefined);assert.equal(f.diag.getAccounts()[1].quota.snapshot.email,other.expectedEmail);
 assert.equal(f.state.get('live-switch.quota-consent.v2.'+other.id),undefined);assert.deepEqual(f.notifications,[]);assert.deepEqual(f.warnings,[]);assert.ok(!f.events.includes('stop')&&!f.events.includes('install'));
});
for(const language of ['zh-CN','en']) test(`${language} manual quota refresh stays inline through loading, failure and retry`,async t=>{
 const i18n=require('../out/i18n');i18n.setLanguage(language);t.after(()=>i18n.setLanguage('zh-CN'));
 const f=setup(),other={...saved,id:'00000000-0000-4000-8000-000000000002',expectedEmail:'other@example.test'};
 f.state.set('live-switch.accounts.v1',[saved,other]);let calls=0,release;
 f.ui.savedQuota=async account=>{calls++;await new Promise(resolve=>release=resolve);if(calls===1)throw new (require('../out/live-storage').LiveError)('ACCOUNT_QUOTA_REAUTH_REQUIRED');return {...await f.backend.proof(),email:account.expectedEmail,quotaSource:'server'};};
 await f.diag.refresh();f.ui.focus({focused:true});await settle();assert.equal(calls,0,'activation and focus do not query a saved account');
 const first=f.call('quota',other.id);await settle();assert.equal(calls,1);assert.equal(f.diag.getAccounts()[1].quota.phase,'loading');assert.equal(f.diag.getAccounts()[0].quota,undefined);
 await f.call('quota',other.id);assert.equal(calls,1,'repeat click shares the pending request');release();await first;
 assert.equal(f.diag.getAccounts()[1].quota.phase,'error');assert.match(f.diag.getAccounts()[1].quota.message,language==='en'?/Authorize and save again/:/重新授权/);
 const retry=f.call('quota',other.id);await settle();assert.equal(calls,2);release();await retry;
 assert.equal(f.diag.getAccounts()[1].quota.phase,'ready');assert.equal(f.diag.getAccounts()[1].quota.snapshot.observedAt,'2026-10-01T00:00:00.000Z');assert.equal(f.diag.getAccounts()[0].quota,undefined);
 f.service.account=async()=>assert.fail('current quota must not read saved credentials');await f.call('quota');assert.equal(f.diag.getAccounts()[0].quota.phase,'ready');
 assert.deepEqual(f.notifications,[]);assert.deepEqual(f.warnings,[]);assert.ok(!f.events.includes('stop')&&!f.events.includes('install'));
 for(const sub of f.context.subscriptions)sub.dispose();
});
test('saved-account identity mismatch never repaints current or selected accounts with unrelated quota',async()=>{
 const f=setup();f.state.set('live-switch.accounts.v1',[{...saved,expectedEmail:'other@example.test'}]);
 await f.call('quota',saved.id);assert.equal(f.diag.getAccounts()[0].quota.phase,'error');assert.equal(f.diag.getAccounts()[0].quota.snapshot,undefined);assert.equal(f.diag.getState().currentQuota,undefined);
});
test('quota errors preserve only explicitly historical server results and no toast',async()=>{
 const f=setup();f.state.set('live-switch.accounts.v1',[saved]);await f.call('quota',saved.id);
 f.backend.quota=async()=>{throw new (require('../out/live-storage').LiveError)('ACCOUNT_QUOTA_REAUTH_REQUIRED')};await f.call('quota',saved.id);
 assert.equal(f.diag.getAccounts()[0].quota.phase,'error');assert.equal(f.diag.getAccounts()[0].quota.snapshot.email,saved.expectedEmail);assert.match(f.diag.getAccounts()[0].quota.message,/重新授权/);assert.deepEqual(f.warnings,[]);
});
test('untrusted, foreign and invalid saved-account requests never read saved credentials',async()=>{
 const f=setup();f.state.set('live-switch.accounts.v1',[saved]);let reads=0;f.service.account=async()=>{reads++;throw Error('must not read')};
 for(const value of ['invalid',{id:saved.id},'00000000-0000-4000-8000-000000000002'])await f.call('quota',value);
 f.service.hostIsCurrent=()=>false;await f.call('quota',saved.id);f.ui.trusted=false;await f.call('quota',saved.id);assert.equal(reads,0);
});
test('cancel interrupts saved-account query and retry remains isolated',async()=>{
 const f=setup();f.state.set('live-switch.accounts.v1',[saved]);let signal;
 f.backend.quota=async(_email,value)=>{signal=value;return new Promise((_r,reject)=>value.addEventListener('abort',()=>reject(new (require('../out/live-storage').LiveError)('QUOTA_QUERY_CANCELLED'))))};
 const pending=f.call('quota',saved.id);await new Promise(setImmediate);await f.call('quotaCancel');await pending;assert.equal(signal.aborted,true);assert.match(f.diag.getAccounts()[0].quota.message,/已取消/);
 f.backend.quota=async()=>({...await f.backend.proof(),quotaSource:'server'});await f.call('quota',saved.id);assert.equal(f.diag.getAccounts()[0].quota.phase,'ready');
});
test('cached status cannot become a saved-account quota and repeated clicks are coalesced',async()=>{
 const f=setup();f.state.set('live-switch.accounts.v1',[saved]);f.backend.quota=f.backend.proof;await f.call('quota',saved.id);assert.equal(f.diag.getAccounts()[0].quota.phase,'error');
 let release,starts=0;f.backend.quota=async()=>{starts++;await new Promise(r=>release=r);return {...await f.backend.proof(),quotaSource:'server'}};
 const first=f.call('quota',saved.id);await new Promise(setImmediate);await f.call('quota',saved.id);assert.equal(starts,1);release();await first;assert.equal(f.diag.getAccounts()[0].quota.phase,'ready');
});
test('file-scoped restore is concise and restored state uses automatic verification without confirmation',async()=>{
 const f=setup();f.service.journal=async()=>({id:'synthetic-recovery',phase:'installed',backup:{keyring:null,file:null,keyringState:'unobserved'}});f.locks.assertRecovery=async()=>{};
 await f.call('restore');assert.match(f.warnings.at(-1),/原官方登录文件/);assert.doesNotMatch(f.warnings.at(-1),/两处|核对官方面板/);
 f.service.journal=async()=>({id:'synthetic-recovery',phase:'restored'});f.service.finishVerified=async()=>{f.service.journal=async()=>null;return {email:'original@example.test'}};
 const count=f.warnings.length;await f.call('verify');assert.equal(f.warnings.length,count);assert.match(f.diag.getState().status,/已恢复原登录/);assert.equal(f.diag.getState().pending,false);
});
test('lifecycle never stops a new hub that appeared while its process count was pending',async t=>{
 const f=setup(),official=officialFixture(f),path=require('node:path'),storage=require('../out/live-storage'),contract=require('../out/official-contract'),environment=require('../out/live-environment'),fs=require('node:fs/promises');
 official.isActive=true;const main=path.join(official.extensionPath,'extension.js'),oldCache=require.cache[main],oldRun=storage.runPrivate,oldContract=contract.assertOfficialEntrypoint,oldHash=environment.assertWslBackendExecutable,oldStat=fs.stat,oldAccess=fs.access;
 contract.assertOfficialEntrypoint=async()=>{};environment.assertWslBackendExecutable=async()=>{};fs.stat=async()=>({isFile:()=>true});fs.access=async()=>{};let drift=false,empty=false,deactivated=0;
 require.cache[main]={loaded:true,exports:{deactivate:async()=>{deactivated++}}};
 storage.runPrivate=async(_executable,args)=>{if(args[0]==='--version')return{code:0,stdout:'agy version 1.2.14',stderr:''};if(drift)official.exports={port:45678,csrfToken:'synthetic-new-generation'};return{code:0,stdout:empty?'':process.platform==='win32'?'"agy.exe","321"':'agy\n',stderr:''};};
 t.after(()=>{contract.assertOfficialEntrypoint=oldContract;environment.assertWslBackendExecutable=oldHash;fs.stat=oldStat;fs.access=oldAccess;storage.runPrivate=oldRun;if(oldCache)require.cache[main]=oldCache;else delete require.cache[main]});
 const backend=await f.api.resolveOfficialLifecycle(f.context);drift=true;await assert.rejects(backend.stop(),/HUB_CHANGED_DURING_OPERATION/);assert.equal(deactivated,0);
 official.exports={port:undefined,csrfToken:'synthetic-official-csrf'};empty=true;await assert.rejects(backend.stop(),/HUB_CHANGED_DURING_OPERATION/);assert.equal(deactivated,0);
});
test('Login rechecks generation after awaited file proof and sends no RPC to a replacement hub',async t=>{
 const f=setup(),official=officialFixture(f),path=require('node:path'),storage=require('../out/live-storage'),contract=require('../out/official-contract'),fs=require('node:fs/promises'),environment=require('../out/live-environment'),proof=require('../out/live-wsl-proof'),hub=require('../out/live-hub');
 official.isActive=true;const main=path.join(official.extensionPath,'extension.js'),oldCache=require.cache[main],oldRun=storage.runPrivate,oldContract=contract.assertOfficialEntrypoint,oldStat=fs.stat,oldAccess=fs.access,oldMode=environment.resolveOfficialStorageMode,oldHash=environment.assertWslBackendExecutable,oldGuard=proof.createWslFileGuard,oldLogin=hub.loginWithOfficialHub;
 contract.assertOfficialEntrypoint=async()=>{};fs.stat=async()=>({isFile:()=>true});fs.access=async()=>{};environment.resolveOfficialStorageMode=async()=> 'wsl-file';environment.assertWslBackendExecutable=async()=>{};
 const processes=require('../out/official-process'),oldInspect=processes.inspectWslProcesses;
 processes.inspectWslProcesses=async()=>{const current={pid:710,parentPid:process.pid,startTicks:'123',kind:'current-hub',taskState:'unknown'};return{processes:[current],current};};
 t.after(()=>{processes.inspectWslProcesses=oldInspect});
 let drift=false,logins=0;proof.createWslFileGuard=()=>async()=>{if(drift)official.exports={port:45678,csrfToken:'synthetic-new-generation'};return true};hub.loginWithOfficialHub=async()=>{logins++};
 require.cache[main]={loaded:true,exports:{deactivate:async()=>{}}};storage.runPrivate=async(_executable,args)=>({code:0,stdout:args[0]==='--version'?'agy version 1.2.14':process.platform==='win32'?'"agy.exe","321"':'agy\n',stderr:''});
 t.after(()=>{contract.assertOfficialEntrypoint=oldContract;fs.stat=oldStat;fs.access=oldAccess;storage.runPrivate=oldRun;environment.resolveOfficialStorageMode=oldMode;environment.assertWslBackendExecutable=oldHash;proof.createWslFileGuard=oldGuard;hub.loginWithOfficialHub=oldLogin;if(oldCache)require.cache[main]=oldCache;else delete require.cache[main]});
 const backend=await f.api.resolveOfficialLifecycle(f.context);assert.equal(await backend.fileOnlyGuard(false),true);drift=true;
 await assert.rejects(backend.login(new AbortController().signal),/HUB_CHANGED_DURING_OPERATION/);assert.equal(logins,0);
});

// READ_ONLY_CAPABILITY: storage compatibility gates never block a read-only hub query.
test('read-only quota accepts newer or unknown package versions with compatible runtime response schemas',async t=>{
 const http=require('node:http'),storage=require('../out/live-storage'),contract=require('../out/official-contract');
 const oldRun=storage.runPrivate,oldContract=contract.assertOfficialEntrypoint;
 contract.assertOfficialEntrypoint=async()=>{throw Error('read-only quota must not inspect credential contract')};
 const probes=[];storage.runPrivate=async(executable,args)=>{probes.push({executable,args});assert.notEqual(args[0],'--version');return{code:0,stdout:process.platform==='win32'?'"agy.exe","321"':'agy\n',stderr:''}};
 t.after(()=>{storage.runPrivate=oldRun;contract.assertOfficialEntrypoint=oldContract});
 let schema='groups';const requests=[];
 const server=http.createServer((req,res)=>{let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
  const method=req.url.split('/').pop();requests.push({method,body,csrf:req.headers['x-codeium-csrf-token']});
  const payload=method==='GetAuthStatus'?{authResult:{hasValidAuth:true}}:method==='GetUserStatus'?{userStatus:{email:'personal@example.test'}}:method==='RetrieveUserQuotaSummary'?
   schema==='groups'?{response:{groups:[{displayName:'Plan',buckets:[{displayName:'Model',remainingFraction:0.75}]}]},backendVersion:'99.0.0'}:
   schema==='legacy'?{response:{buckets:[{displayName:'Model',remainingAmount:'12'}]}}:
   schema==='invalid'?{response:{groups:'unrecognized-schema'}}:{response:{futureQuotaFormat:[]}}:null;
  res.writeHead(payload?200:404,{'Content-Type':'application/json'});res.end(JSON.stringify(payload));
 })});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 for(const version of ['1.6.0','1.6.1','9.0.0','unknown',undefined]) for(schema of ['groups','legacy','invalid','unknown']){
  const f=setup(),official=officialFixture(f);official.isActive=true;official.packageJSON={version};official.exports={port:server.address().port,csrfToken:'synthetic-official-csrf'};
  const backend=await f.api.resolveOfficialReadOnlyHub(f.context),start=requests.length;
  assert.deepEqual(Object.keys(backend).sort(),['freshProof','generation','proof','quota']);
  if(schema==='invalid'||schema==='unknown') await assert.rejects(backend.quota('personal@example.test'),schema==='invalid'?/HUB_QUOTA_RESPONSE_INVALID/:/HUB_QUOTA_EMPTY/);
  else {const proof=await backend.quota('personal@example.test');assert.equal(proof.quotaSource,'server');assert.equal(proof.email,'personal@example.test');assert.equal(proof.generation,backend.generation);assert.equal(proof.buckets.length,1)}
  const calls=requests.slice(start);assert.ok(calls.every(x=>['GetAuthStatus','GetUserStatus','RetrieveUserQuotaSummary'].includes(x.method)));
  assert.equal(calls.filter(x=>x.method==='RetrieveUserQuotaSummary').length,1);
  assert.equal(calls.find(x=>x.method==='RetrieveUserQuotaSummary').body,'{"forceRefresh":true}');
  assert.ok(calls.every(x=>x.csrf==='synthetic-official-csrf'));assert.deepEqual(f.events,[]);
 }
 assert.equal(probes.length,0,'read-only quota must not inspect unrelated agy processes');
});
test('read-only hub refuses unsupported hosts, overrides, inactive extensions and invalid capabilities before RPC',async t=>{
 const storage=require('../out/live-storage'),oldRun=storage.runPrivate;let probes=0;
 storage.runPrivate=async()=>{probes++;throw Error('must not inspect processes before static prerequisites')};t.after(()=>{storage.runPrivate=oldRun});
 for(const [change,code] of [
  [f=>{f.ui.official=undefined},'OFFICIAL_EXTENSION_MISSING'],
  [f=>{f.ui.official.extensionUri.scheme='vscode-remote'},'OFFICIAL_HOST_MISMATCH'],
  [f=>{f.ui.config.serverArgs=['--custom']},'OVERRIDE_OR_REMOTE_AUTH_UNSUPPORTED'],
  [f=>{f.ui.official.isActive=false},'OPEN_OFFICIAL_ANTIGRAVITY_FIRST'],
  [f=>{f.ui.official.exports={}},'OFFICIAL_HUB_NOT_READY'],
  [f=>{f.ui.official.exports={port:1234,csrfToken:'invalid'}},'OFFICIAL_HUB_API_UNAVAILABLE'],
 ]){
  const f=setup();officialFixture(f).isActive=true;change(f);await assert.rejects(f.api.resolveOfficialReadOnlyHub(f.context),{message:code});assert.deepEqual(f.events,[]);
 }
 assert.equal(probes,0);
});
test('read-only hub ignores unrelated CLI processes while rejecting generation drift without credential lifecycle',async t=>{
 const storage=require('../out/live-storage'),hub=require('../out/live-hub'),oldRun=storage.runPrivate,oldQuota=hub.queryFreshQuota,oldProof=hub.queryHub;
 t.after(()=>{storage.runPrivate=oldRun;hub.queryFreshQuota=oldQuota;hub.queryHub=oldProof});
 let f,official,count=1,calls=0,probes=0;
 storage.runPrivate=async()=>{probes++;return{code:0,stdout:Array.from({length:count},()=>process.platform==='win32'?'"agy.exe","321"':'agy').join('\n'),stderr:''}};
 for(count of [0,1,2,5]) {
  f=setup();official=officialFixture(f);official.isActive=true;const backend=await f.api.resolveOfficialReadOnlyHub(f.context);
  hub.queryFreshQuota=async pinned=>({generation:hub.generation(pinned),authValid:true,quotaSource:'server'});
  assert.equal((await backend.quota()).generation,backend.generation);
 }
 assert.equal(probes,0,'other image or terminal sessions must not block a pinned read-only hub');
 for(const stage of ['before','during','invalidated']){
  f=setup();official=officialFixture(f);official.isActive=true;const backend=await f.api.resolveOfficialReadOnlyHub(f.context);
  hub.queryFreshQuota=async pinned=>{calls++;assert.notEqual(pinned,official.exports);if(stage==='during')official.exports.csrfToken='synthetic-new-generation';return{generation:backend.generation}};
  const previous=calls;
  if(stage==='before')official.exports={port:45678,csrfToken:'synthetic-new-generation'};
  if(stage==='invalidated')official.isActive=false;
  await assert.rejects(backend.quota(),/HUB_CHANGED_DURING_QUERY/);assert.equal(calls-previous,stage==='during'?1:0);
 }
 f=setup();official=officialFixture(f);official.isActive=true;const backend=await f.api.resolveOfficialReadOnlyHub(f.context);
 hub.queryHub=async()=>{official.exports={port:45678,csrfToken:'synthetic-new-generation'};return{generation:backend.generation}};
 await assert.rejects(backend.proof(),/HUB_CHANGED_DURING_QUERY/);
});

test('saved-account replacement during query discards the result',async()=>{
 const f=setup();f.state.set('live-switch.accounts.v1',[saved]);
 f.backend.quota=async()=>{f.state.set('live-switch.accounts.v1',[]);return {...await f.backend.proof(),quotaSource:'server'}};
 await f.call('quota',saved.id);assert.equal(f.diag.getAccounts().length,0);assert.equal(f.diag.getState().currentQuota?.phase,'error');
});
test('a pending switch automatically finishes on refresh without prompting or filling cached quota',async()=>{
 const f=setup();await f.diag.refresh();f.state.set('live-switch.accounts.v1',[saved]);
 f.locks.assertRecovery=async()=>{};f.service.journal=async()=>({id:'pending-switch',phase:'installed',target:saved});
 let finished=0;f.service.finishVerified=async()=>{finished++;f.service.journal=async()=>null;return {...await f.backend.proof(),quotaSource:'server'}};
 await f.diag.refresh();assert.equal(finished,1);assert.equal(f.diag.getState().pending,false);assert.match(f.diag.getStatus(),/已切换/);assert.equal(f.diag.getAccounts()[0].quota,undefined);assert.deepEqual(f.warnings,[]);assert.deepEqual(f.notifications,[]);
});
test('switches after long idle and repeated failures receive separate bounded recovery windows',async()=>{
 const {verificationClock}=require('./fixtures/verification-clock.cjs'),clock=verificationClock(),f=setup({verificationClock:clock});
 await f.diag.refresh();clock.jump(3_600_000);let journal,proofs=0,installs=0;
 f.ui.selected={account:{id:'fixture',expectedEmail:'b@example.test'}};f.ui.answer='切换账号';f.backend.restartMode='component';
 f.locks.assertRecovery=async()=>{};f.service.journal=async()=>journal;
 f.service.install=async(_id,_backend,id)=>{installs++;journal={id,phase:'installed',target:{expectedEmail:'b@example.test'}};};
 f.service.finishVerified=async backend=>{proofs++;await backend.proof();throw new (require('../out/live-storage').LiveError)('HUB_RPC_FAILED');};
 f.service.restore=async()=>{throw new (require('../out/live-storage').LiveError)('EXTERNAL_CHANGE');};
 await f.call('switch');assert.equal(proofs,1);await clock.advance(1500);assert.equal(proofs,2,'idle did not consume this transaction window');
 await clock.advance(90_000);const first=proofs;await clock.advance(900_000);assert.equal(proofs,first);assert.match(f.diag.getState().status,/90 秒|自动重试已停止/);
 for(let n=0;n<3;n++)await f.diag.refresh();assert.equal(proofs,first,'focus cannot renew the failed transaction');
 journal=null;await f.diag.refresh();await f.call('switch');assert.equal(installs,2);assert.equal(proofs,first+1);
 await clock.advance(1500);assert.equal(proofs,first+2,'a later switch has its own retry window');
 await clock.advance(90_000);const second=proofs;await clock.advance(900_000);assert.equal(proofs,second);
 await f.call('verify');assert.equal(proofs,second+1,'only explicit verify renews this expired phase');
 f.context.subscriptions.forEach(x=>x.dispose());
});
test('stale scheduled recovery cannot verify a later journal or publish its identity',async()=>{
 const {verificationClock,settle}=require('./fixtures/verification-clock.cjs'),clock=verificationClock(),f=setup({verificationClock:clock});await f.diag.refresh();
 let journal={id:'old-transaction',phase:'installed',target:saved},calls=0;
 f.service.journal=async()=>journal;f.locks.assertRecovery=async()=>{};
 f.service.finishVerified=async()=>{calls++;throw new (require('../out/live-storage').LiveError)('HUB_RPC_FAILED');};
 await f.diag.refresh();const oldCallback=[...clock.timers].find(t=>t.at===1500).callback;
 journal={id:'new-transaction',phase:'installed',target:saved};await f.diag.refresh();const before=calls;
 oldCallback();await settle();assert.equal(calls,before);assert.equal(f.diag.getState().activeEmail,undefined);assert.equal(f.diag.getState().pending,true);
 await clock.advance(1500);assert.equal(calls,before+1);f.context.subscriptions.forEach(x=>x.dispose());
});
test('disposed controller discards a late switch proof without starting rollback or restart',async()=>{
 const {verificationClock,settle}=require('./fixtures/verification-clock.cjs'),clock=verificationClock(),f=setup({verificationClock:clock});await f.diag.refresh();
 let journal,complete,restores=0;f.ui.selected={account:{id:'fixture',expectedEmail:'b@example.test'}};f.ui.answer='切换账号';f.backend.restartMode='component';
 f.locks.assertRecovery=async()=>{};f.service.journal=async()=>journal;
 f.service.install=async(_id,_backend,id)=>{journal={id,phase:'installed',target:{expectedEmail:'b@example.test'}};};
 f.backend.proof=()=>new Promise(resolve=>{complete=resolve;});f.service.finishVerified=async backend=>backend.proof();f.service.restore=async()=>{restores++;};
 const pending=f.call('switch');await settle();assert.equal(typeof complete,'function');f.context.subscriptions.forEach(x=>x.dispose());
 await pending;complete({email:'b@example.test',generation:'late'});await settle();
 assert.equal(restores,0);assert.equal(journal.phase,'installed');assert.equal(f.diag.getState().activeEmail,undefined);assert.ok(!f.events.includes('bad-direct-reload'));
});
test('an externally replaced journal invalidates the old timer without verifying the replacement',async()=>{
 const {verificationClock,settle}=require('./fixtures/verification-clock.cjs'),clock=verificationClock(),f=setup({verificationClock:clock});await f.diag.refresh();
 let journal={id:'old-external',phase:'installed',target:saved},calls=0;f.service.journal=async()=>journal;f.locks.assertRecovery=async()=>{};
 f.service.finishVerified=async()=>{calls++;throw new (require('../out/live-storage').LiveError)('HUB_RPC_FAILED');};
 await f.diag.refresh();const callback=[...clock.timers].find(t=>t.at===1500).callback;
 journal={id:'replacement',phase:'installed',target:saved};callback();await settle();assert.equal(calls,1);assert.match(f.diag.getState().status,/登录事务已变化/);
 await clock.advance(900_000);assert.equal(calls,1);assert.match(f.diag.getState().status,/登录事务已变化/);assert.equal(clock.timers.size,0);
 f.context.subscriptions.forEach(x=>x.dispose());
});

test('current badge comes only from fresh official identity and isolated quota cannot change it',async()=>{
 const f=setup();await f.diag.refresh();const official=officialFixture(f);official.isActive=true;
 const current={email:'current@example.test',generation:require('../out/live-hub').generation(official.exports),observedAt:new Date().toISOString(),authValid:true,quotaSource:'server',buckets:[]};
 f.ui.currentProof=current;await f.diag.refresh();assert.equal(f.diag.getState().activeEmail,'current@example.test');
 f.state.set('live-switch.accounts.v1',[saved]);await f.call('quota',saved.id);assert.equal(f.diag.getState().activeEmail,'current@example.test');assert.equal(f.diag.getAccounts()[0].active,undefined);
 official.isActive=false;await f.diag.refresh();assert.equal(f.diag.getState().activeEmail,undefined);
});
test('startup readiness activates only the same-host official extension and verifies fresh identity',async()=>{
 const f=setup();await f.diag.refresh();const official=officialFixture(f);
 f.ui.currentProof={email:'current@example.test',generation:require('../out/live-hub').generation(official.exports),observedAt:new Date().toISOString(),authValid:true,quotaSource:'server',buckets:[]};
 await f.diag.refresh();
 assert.equal(official.isActive,true);
 assert.deepEqual(f.events.slice(-3),['locked','activate-official','unlocked']);
 assert.equal(f.diag.getState().activeEmail,'current@example.test');
 assert.equal(f.diag.getState().busy,false);
});
test('cached or invalid current identity never produces an active badge',async()=>{
 for(const proof of [{authValid:true,email:'cached@example.test'},{authValid:false,email:'cached@example.test',quotaSource:'server'}]){
  const f=setup();await f.diag.refresh();officialFixture(f).isActive=true;f.ui.currentProof=proof;await f.diag.refresh();assert.equal(f.diag.getState().activeEmail,undefined);
 }
});

test('focus after sixty seconds keeps the same verified card visible while rechecking',async t=>{
 const f=setup();t.after(()=>f.context.subscriptions.forEach(x=>x.dispose()));await f.diag.refresh();const official=officialFixture(f);official.isActive=true;
 const proof={email:'a@example.test',generation:require('../out/live-hub').generation(official.exports),observedAt:new Date(Date.now()-61_000).toISOString(),authValid:true,quotaSource:'server',buckets:[]};
 f.ui.currentProof=proof;await f.diag.refresh();const states=[];f.ui.changed=()=>states.push(f.diag.getState());
 let complete,reads=0;f.ui.currentIdentity=()=>{reads++;return new Promise(resolve=>{complete=resolve;});};
 f.ui.focus({focused:false});await settle();assert.equal(reads,0);
 f.ui.focus({focused:true});await settle();assert.equal(reads,1);assert.equal(f.diag.getState().activeEmail,'a@example.test');assert.equal(f.diag.getState().identityChecking,true);
 official.exports={...official.exports}; // A new wrapper is the same backend, not a different account.
 complete({...proof,observedAt:new Date().toISOString()});await f.diag.refresh();
 assert.ok(states.length>=2);assert.ok(states.every(s=>s.activeEmail==='a@example.test'));assert.equal(f.diag.getState().identityChecking,false);
 f.ui.focus({focused:true});await settle();assert.equal(reads,2,'focus rechecks even a fresh same-Hub identity after external login');complete({...proof,observedAt:new Date().toISOString()});await f.diag.refresh();
});

test('a failed focus proof invalidates identity; a late proof cannot survive backend replacement',async t=>{
 for(const mode of ['failed','replacement']){
  const f=setup();t.after(()=>f.context.subscriptions.forEach(x=>x.dispose()));await f.diag.refresh();const official=officialFixture(f);official.isActive=true;
  const proof={email:'a@example.test',generation:require('../out/live-hub').generation(official.exports),observedAt:new Date(Date.now()-61_000).toISOString(),authValid:true,quotaSource:'server',buckets:[]};
  f.ui.currentProof=proof;await f.diag.refresh();let resolve,reject;f.ui.currentIdentity=()=>new Promise((a,b)=>{resolve=a;reject=b;});
  const pending=f.diag.refresh();await settle();assert.equal(f.diag.getState().activeEmail,proof.email);
  if(mode==='failed')reject(Error('synthetic unavailable'));else{official.exports={...official.exports,port:official.exports.port+1};resolve({...proof,observedAt:new Date().toISOString()});}
  await pending;assert.equal(f.diag.getState().activeEmail,undefined);assert.equal(f.diag.getState().identityChecking,false);
 }
});

test('fresh proof of a different identity replaces the current card only after verification',async t=>{
 const f=setup();t.after(()=>f.context.subscriptions.forEach(x=>x.dispose()));await f.diag.refresh();const official=officialFixture(f);official.isActive=true;
 const proof={email:'a@example.test',generation:require('../out/live-hub').generation(official.exports),observedAt:new Date(Date.now()-61_000).toISOString(),authValid:true,quotaSource:'server',buckets:[]};
 f.ui.currentProof=proof;await f.diag.refresh();let complete;f.ui.currentIdentity=()=>new Promise(resolve=>{complete=resolve;});
 const pending=f.diag.refresh();await settle();assert.equal(f.diag.getState().activeEmail,'a@example.test');
 complete({...proof,email:'b@example.test',observedAt:new Date().toISOString()});await pending;assert.equal(f.diag.getState().activeEmail,'b@example.test');
});

test('refresh callbacks are scoped to selected account, preserve pending continuation, and compare committed snapshot',async()=>{
 const f=setup();await f.diag.refresh();f.state.set('live-switch.accounts.v1',[saved]);
 const old={keyring:null,file:'synthetic-old'},pending={keyring:null,file:'synthetic-pending'},next={keyring:null,file:'synthetic-new'};let stored={...saved,slots:old};const calls=[];
 f.service.account=async id=>{assert.equal(id,saved.id);return structuredClone(stored)};
 f.service.pendingQuotaRefresh=async(id,expected)=>{calls.push('pending');assert.equal(id,saved.id);assert.deepEqual(expected,old);return pending};
 f.service.stageQuotaRefresh=async(id,expected,value,previous)=>{calls.push('stage');assert.equal(id,saved.id);assert.deepEqual(expected,old);assert.deepEqual(value,next);assert.deepEqual(previous,pending)};
 f.service.commitQuotaRefresh=async(id,expected,value)=>{calls.push('commit');assert.equal(id,saved.id);assert.deepEqual(expected,old);stored={...saved,slots:value};return stored};
 f.ui.savedQuota=async(account,_signal,options)=>{assert.equal(typeof options.refresh.provider.exchange,'function');assert.deepEqual(await options.refresh.loadPending(account.slots),pending);options.phase('refreshing');assert.match(f.diag.getAccounts()[0].quota.message,/刷新/);await options.refresh.stage(account.slots,next);await options.refresh.commit(account.slots,next);return {...await f.backend.proof(),quotaSource:'server'}};
 await f.call('quota',saved.id);assert.deepEqual(calls,['pending','stage','commit']);assert.equal(f.diag.getAccounts()[0].quota.phase,'ready');assert.doesNotMatch(JSON.stringify(f.diag.getState()),/synthetic-old|synthetic-pending|synthetic-new/);assert.ok(!f.events.includes('install')&&!f.events.includes('stop'));
});
test('currently verified account uses official refresh without exporting a saved refresh token',async()=>{
 const f=setup();await f.diag.refresh();const official=officialFixture(f);official.isActive=true;f.ui.currentProof={...await f.backend.proof(),quotaSource:'server',generation:require('../out/live-hub').generation(official.exports),observedAt:new Date().toISOString()};await f.diag.refresh();f.state.set('live-switch.accounts.v1',[saved]);
 f.service.account=async()=>{throw Error('must not read saved credential')};f.ui.savedQuota=async()=>{throw Error('must not refresh duplicate grant')};
 await f.call('quota',saved.id);assert.equal(f.diag.getAccounts()[0].quota.phase,'ready');assert.equal(f.notifications.length,0);assert.equal(f.diag.getState().activeEmail,saved.expectedEmail);
});

test('debug account hooks report actual caught failure without account identity or raw error',async t=>{
 const {DebugRecorder,installDebugRecorder}=require('../out/debug-events'),records=[];const logger=new DebugRecorder({append:async(line,current)=>{if(current())records.push(JSON.parse(line));},readLines:async()=>[],flush:async()=>{},dispose(){}},{version:'0.13.2',platform:'linux',host:'local'});await logger.setEnabled(true);const installed=installDebugRecorder(logger);t.after(()=>installed.dispose());
 const f=setup();f.state.set('live-switch.accounts.v1',[saved]);f.locks.withOperation=async()=>{throw Error('SECRET_ERROR personal@example.test')};await f.call('switch',saved.id);const end=records.find(x=>x.operation==='account.switch'&&x.phase==='result');assert.equal(end.outcome,'failed');assert.equal(end.data.code,'UNCLASSIFIED_ERROR');assert.doesNotMatch(JSON.stringify(records),/SECRET|personal@example|00000000-0000-4000/);assert.notEqual(end.operationId,saved.id);
});

test('debug account consent dismissals are cancelled without claiming a login or switch completed',async t=>{
 const {DebugRecorder,installDebugRecorder}=require('../out/debug-events'),records=[];const logger=new DebugRecorder({append:async(line,current)=>{if(current())records.push(JSON.parse(line));},readLines:async()=>[],flush:async()=>{},dispose(){}},{version:'0.13.2',platform:'linux',host:'local'});await logger.setEnabled(true);const installed=installDebugRecorder(logger);t.after(()=>installed.dispose());const f=setup();f.state.set('live-switch.accounts.v1',[saved]);await f.call('login');await f.call('switch',saved.id);await f.call('capture');assert.deepEqual(records.filter(e=>e.operation!=='account.refresh'&&e.phase==='result').map(e=>e.outcome),['cancelled','cancelled','cancelled']);assert.ok(!f.events.includes('install'));
});

test('manual refresh logs current environment and recovery failures after enabling with no retroactive events',async t=>{
 const f=setup();await f.diag.refresh();const {DebugRecorder,installDebugRecorder}=require('../out/debug-events'),records=[];const logger=new DebugRecorder({append:async(line,current)=>{if(current())records.push(JSON.parse(line));},readLines:async()=>[],flush:async()=>{},dispose(){}},{version:'0.13.2',platform:'linux',host:'local'});const installed=installDebugRecorder(logger);t.after(()=>installed.dispose());await f.diag.refresh();assert.deepEqual(records,[]);await logger.setEnabled(true);
 f.context.globalStorageUri.scheme='vscode-remote';await f.diag.refresh();assert.ok(records.some(e=>e.operation==='account.refresh'&&e.outcome==='blocked'&&e.data.code==='NATIVE_HOST_PATH_REQUIRED'));f.context.globalStorageUri.scheme='file';f.service.journal=async()=>{throw Error('SECRET_RECOVERY_DETAIL')};await f.diag.refresh();assert.ok(records.some(e=>e.operation==='account.refresh'&&e.outcome==='failed'&&e.data.code==='UNCLASSIFIED_ERROR'));assert.doesNotMatch(JSON.stringify(records),/SECRET|synthetic-private|@/);
});
test('debug cancelled quota records its actual cancellation code and never reports completed',async t=>{
 const f=setup();await f.diag.refresh();const {DebugRecorder,installDebugRecorder}=require('../out/debug-events'),{LiveError}=require('../out/live-storage'),records=[];const logger=new DebugRecorder({append:async(line,current)=>{if(current())records.push(JSON.parse(line));},readLines:async()=>[],flush:async()=>{},dispose(){}},{version:'0.13.2',platform:'linux',host:'local'});await logger.setEnabled(true);const installed=installDebugRecorder(logger);t.after(()=>installed.dispose());f.state.set('live-switch.accounts.v1',[saved]);f.ui.savedQuota=async()=>{throw new LiveError('QUOTA_QUERY_CANCELLED')};await f.call('quota',saved.id);const ends=records.filter(e=>e.operation==='account.quota'&&e.phase==='result');assert.equal(ends.length,1);assert.equal(ends[0].outcome,'cancelled');assert.equal(ends[0].data.code,'QUOTA_QUERY_CANCELLED');
});


test('official-current identity never marks ambiguous saved records or a pending operation active',async t=>{
 const f=setup();t.after(()=>f.context.subscriptions.forEach(x=>x.dispose()));await f.diag.refresh();const official=officialFixture(f);official.isActive=true;
 f.service.hostIsCurrent=()=>true;f.state.set('live-switch.accounts.v1',[saved,{...saved,id:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'}]);
 f.ui.currentProof={email:saved.expectedEmail,generation:require('../out/live-hub').generation(official.exports),observedAt:new Date().toISOString(),authValid:true,quotaSource:'server',buckets:[]};await f.diag.refresh();assert.ok(f.diag.getAccounts().every(a=>!a.active));
 f.state.set('live-switch.accounts.v1',[saved]);assert.equal(f.diag.getAccounts()[0].active,true);
 official.isActive=false;await f.diag.refresh();assert.ok(f.diag.getAccounts().every(a=>!a.active));
});

function startupProof(f,email='cold@example.test') { return {email,generation:require('../out/live-hub').generation(f.ui.official.exports),observedAt:new Date().toISOString(),authValid:true,quotaSource:'server',buckets:[]}; }
test('cold startup accepts a 25-second fresh proof automatically and view readiness coalesces it',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date']});const f=setup();t.after(()=>f.context.subscriptions.forEach(s=>s.dispose()));officialFixture(f);
 let reads=0;f.ui.currentIdentity=()=>{reads++;return new Promise(resolve=>setTimeout(()=>resolve(startupProof(f)),25_000));};
 const pending=f.diag.refresh();await settle();assert.equal(reads,1);assert.equal(f.diag.ensureIdentity(),pending);assert.equal(f.diag.getState().identityChecking,true);
 t.mock.timers.tick(20_000);await settle();assert.equal(f.diag.getState().identityChecking,true);t.mock.timers.tick(5_000);await pending;
 assert.equal(f.diag.getState().activeEmail,'cold@example.test');assert.equal(f.diag.getState().identityChecking,false);assert.equal(reads,1);
 await f.diag.ensureIdentity();assert.equal(reads,1,'rebuilding a fresh view does not force another server refresh');
});
test('a never-resolving identity lookup has a bounded deadline and explicit recheck can recover',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date']});const f=setup();t.after(()=>f.context.subscriptions.forEach(s=>s.dispose()));officialFixture(f).isActive=true;let signal;
 f.ui.currentIdentity=s=>{signal=s;return new Promise(()=>{});};const pending=f.diag.refresh();await settle();t.mock.timers.tick(60_000);await pending;
 assert.equal(signal.aborted,true);assert.equal(f.diag.getState().identityChecking,false);assert.equal(f.diag.getState().activeEmail,undefined);
 f.ui.currentIdentity=async()=>startupProof(f);await f.diag.recheck();assert.equal(f.diag.getState().activeEmail,'cold@example.test');
});
test('verified identity is visible before local capture, whose timeout retains the host lock and permits recheck',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date']});const f=setup();t.after(()=>f.context.subscriptions.forEach(s=>s.dispose()));officialFixture(f).isActive=true;f.ui.currentIdentity=async()=>startupProof(f);
 let release,verify,captures=0;f.service.captureCurrent=async(_metadata,_index,guard)=>{captures++;verify=guard;await new Promise(resolve=>release=resolve);await guard();f.events.push('late-save');};
 const pending=f.diag.refresh();await settle();assert.equal(f.diag.getState().identityChecking,false);assert.equal(f.diag.getState().activeEmail,'cold@example.test');assert.equal(captures,1);
 const unlocked=f.events.filter(x=>x==='unlocked').length;t.mock.timers.tick(20_000);await pending;
 assert.match(f.diag.getState().status,/已核验.*保存尚未完成/);assert.equal(f.events.filter(x=>x==='unlocked').length,unlocked,'a timed-out UI cannot release an unfinished secure operation');
 await f.diag.recheck();assert.equal(f.diag.getState().activeEmail,'cold@example.test');assert.equal(captures,1,'do not enqueue another save behind a hung one');
 await assert.rejects(verify());release();await settle();await settle();assert.ok(!f.events.includes('late-save'));assert.equal(f.events.filter(x=>x==='unlocked').length,unlocked+1);
});
test('explicit recheck replaces a pending proof and late old-generation success cannot overwrite the new identity',async t=>{
 const f=setup();t.after(()=>f.context.subscriptions.forEach(s=>s.dispose()));officialFixture(f).isActive=true;let finish,oldSignal,calls=0;
 f.ui.currentIdentity=signal=>{calls++;oldSignal=signal;return new Promise(resolve=>finish=resolve);};const pending=f.diag.refresh();await settle();const oldProof=startupProof(f,'old@example.test');
 f.ui.official.exports={...f.ui.official.exports,port:f.ui.official.exports.port+1};f.ui.currentIdentity=async()=>{calls++;return startupProof(f,'new@example.test');};
 const recheck=f.diag.recheck();assert.equal(f.diag.recheck(),recheck);assert.equal(oldSignal.aborted,true);await recheck;await pending;
 assert.equal(f.diag.getState().activeEmail,'new@example.test');finish(oldProof);await settle();assert.equal(f.diag.getState().activeEmail,'new@example.test');assert.equal(calls,2);
});
test('recheck cancels a hung save wait without erasing a newer verified identity',async t=>{
 const f=setup();t.after(()=>f.context.subscriptions.forEach(s=>s.dispose()));officialFixture(f).isActive=true;f.ui.currentIdentity=async()=>startupProof(f,'old@example.test');let release;
 f.service.captureCurrent=async(_metadata,_index,verify)=>{await new Promise(resolve=>release=resolve);await verify();f.events.push('late-save');};
 const pending=f.diag.refresh();await settle();f.ui.official.exports={...f.ui.official.exports,port:f.ui.official.exports.port+1};f.ui.currentIdentity=async()=>startupProof(f,'new@example.test');
 await f.diag.recheck();await pending;assert.equal(f.diag.getState().identityChecking,false);assert.equal(f.diag.getState().activeEmail,'new@example.test');release();await settle();await settle();assert.ok(!f.events.includes('late-save'));assert.equal(f.diag.getState().activeEmail,'new@example.test');
});
test('disposal cancels identity lookup and ignores its later proof',async()=>{
 const f=setup();officialFixture(f).isActive=true;let finish,signal;f.ui.currentIdentity=s=>{signal=s;return new Promise(resolve=>finish=resolve);};const pending=f.diag.refresh();await settle();f.context.subscriptions.forEach(s=>s.dispose());await pending;
 assert.equal(signal.aborted,true);finish(startupProof(f));await settle();assert.equal(f.diag.getState().activeEmail,undefined);
});
test('focus and panel readiness share the current lookup instead of duplicating it',async t=>{
 const f=setup();t.after(()=>f.context.subscriptions.forEach(s=>s.dispose()));officialFixture(f).isActive=true;let finish,reads=0;
 f.ui.currentIdentity=()=>{reads++;return new Promise(resolve=>finish=resolve);};const pending=f.diag.refresh();await settle();f.ui.focus({focused:true});assert.equal(f.diag.ensureIdentity(),pending);assert.equal(reads,1);
 finish(startupProof(f));await pending;await f.diag.ensureIdentity();assert.equal(reads,1);
});
test('last confirmed account persists only a host-bound ID and is restored as unverified display metadata',async t=>{
 const storage=new Map(),id='00000000-0000-4000-8000-000000000001',host='f'.repeat(64),row={...saved,id,expectedEmail:'cold@example.test',hostId:host};storage.set('live-switch.accounts.v1',[row]);
 const f=setup({state:storage});t.after(()=>f.context.subscriptions.forEach(s=>s.dispose()));f.service.hostIsCurrent=a=>a.hostId===host;f.service.credentialHostIdentity=()=>host;officialFixture(f).isActive=true;f.ui.currentIdentity=async()=>startupProof(f);await f.diag.refresh();
 const key='live-switch.last-verified-account.v1.'+host;assert.equal(storage.get(key),id);assert.equal(f.diag.getState().lastKnownAccountId,id);assert.ok(f.diag.getAccounts()[0].active);
 const restored=setup({state:storage});t.after(()=>restored.context.subscriptions.forEach(s=>s.dispose()));restored.service.hostIsCurrent=a=>a.hostId===host;restored.service.credentialHostIdentity=()=>host;officialFixture(restored).isActive=true;
 let finish;restored.ui.currentIdentity=()=>new Promise(resolve=>finish=resolve);const pending=restored.diag.refresh();await settle();
 assert.equal(restored.diag.getAccounts().length,1);assert.equal(restored.diag.getAccounts()[0].active,undefined);assert.equal(restored.diag.getState().activeEmail,undefined);assert.equal(restored.diag.getState().lastKnownAccountId,id);assert.equal(restored.diag.getState().currentLoginSave,undefined);
 finish(startupProof(restored));await pending;assert.equal(restored.diag.getAccounts()[0].active,true);assert.equal(typeof storage.get(key),'string');assert.ok(!storage.get(key).includes('@'));
});
test('deleted, ambiguous or foreign-host last-known IDs never become display identities',async t=>{
 for(const rows of [[],[{...saved,hostId:'e'.repeat(64)}],[{...saved,hostId:'f'.repeat(64)},{...saved,hostId:'f'.repeat(64)}]]) await t.test(JSON.stringify(rows.map(x=>x.hostId)),async st=>{
  const state=new Map([['live-switch.accounts.v1',rows],['live-switch.last-verified-account.v1.'+'f'.repeat(64),saved.id]]),f=setup({state});st.after(()=>f.context.subscriptions.forEach(s=>s.dispose()));f.service.hostIsCurrent=a=>a.hostId==='f'.repeat(64);f.service.credentialHostIdentity=()=> 'f'.repeat(64);await f.diag.refresh();assert.equal(f.diag.getState().lastKnownAccountId,undefined);assert.equal(f.diag.getState().activeEmail,undefined);
 });
});
test('repeated cached Hub proof cannot renew an exhausted fresh-identity retry budget forever',async t=>{
 t.mock.timers.enable({apis:['setTimeout','setInterval','Date']});const f=setup();t.after(()=>f.context.subscriptions.forEach(s=>s.dispose()));officialFixture(f).isActive=true;
 const hub=require('../out/live-hub'),original=hub.queryHub;hub.queryHub=async()=>startupProof(f);t.after(()=>hub.queryHub=original);
 let reads=0;f.ui.currentIdentity=async()=>{reads++;throw new (require('../out/live-storage').LiveError)('HUB_RPC_FAILED');};await f.diag.refresh();
 for(let i=0;i<60;i++){t.mock.timers.tick(5_000);await settle();await settle();}
 const exhausted=reads;for(let i=0;i<12;i++){t.mock.timers.tick(5_000);await settle();await settle();}assert.equal(reads,exhausted);assert.equal(f.diag.getState().identityChecking,false);assert.equal(f.diag.getState().activeEmail,undefined);
 f.ui.currentIdentity=async()=>startupProof(f);await f.diag.recheck();assert.equal(f.diag.getState().activeEmail,'cold@example.test');
});

async function ownedStartupCapture(t){
 const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),{LiveLocks}=require('../out/live-lock');
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'agm-startup-owned-'));
 const locks=new LiveLocks(directory,'a'.repeat(64),{pid:99,probe:async()=>({state:'alive',startIdentity:'synthetic-self-99'})}),operations=[],withOperation=locks.withOperation.bind(locks);
 locks.withOperation=fn=>{const promise=withOperation(fn);operations.push(promise);return promise;};
 const f=setup({locks});officialFixture(f).isActive=true;let release,ready,captures=0,proofs=0,journal=null;
 const started=new Promise(resolve=>ready=resolve);f.service.journal=async()=>journal;
 f.ui.currentIdentity=async()=>{proofs++;return startupProof(f);};
 f.service.captureCurrent=async(_metadata,_index,verify)=>{captures++;ready();await new Promise(resolve=>release=resolve);await verify();f.events.push('late-save');};
 t.after(async()=>{f.context.subscriptions.forEach(s=>s.dispose());release?.();await Promise.allSettled(operations);await fs.rm(directory,{recursive:true,force:true});});
 const pending=f.diag.refresh();await started;
 return{f,locks,pending,operations,release:()=>release(),captures:()=>captures,proofs:()=>proofs,setJournal:value=>journal=value};
}
test('production lock path preserves verified identity after save timeout and rechecks without unlocking or another save',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date']});const x=await ownedStartupCapture(t),{f,locks}=x;
 const owner=(await locks.inspectOperation()).owner;t.mock.timers.tick(20_000);await x.pending;
 assert.equal(f.diag.getState().activeEmail,'cold@example.test');assert.equal(f.diag.getState().pending,false);
 f.ui.currentIdentity=async()=>startupProof(f,'new@example.test');await f.diag.recheck();await f.diag.ensureIdentity();
 assert.equal(f.diag.getState().activeEmail,'new@example.test');assert.equal(f.diag.getState().pending,false);assert.equal(f.diag.getState().identityChecking,false);
 assert.equal(x.captures(),1);assert.deepEqual((await locks.inspectOperation()).owner,owner);assert.equal((await locks.inspectOperation()).state,'active');
 x.release();await Promise.allSettled(x.operations);assert.equal((await locks.inspectOperation()).state,'absent');assert.ok(!f.events.includes('late-save'));assert.equal(f.diag.getState().activeEmail,'new@example.test');
});
test('owned copy refresh accepts only its matching active save-only recovery marker',async t=>{
 const x=await ownedStartupCapture(t),{f,locks}=x,owner=(await locks.inspectOperation()).owner;
 const journal={id:'00000000-0000-4000-8000-000000000099',operation:'login',loginMode:'save-only'};x.setJournal(journal);
 locks.inspectRecovery=async()=>({state:'active',owner:{...owner,id:journal.id}});
 locks.reconcileRecovery=async()=>assert.fail('must not reconcile while copy holds lock');f.service.recoverLogin=async()=>assert.fail('must not recover or write official slots');
 f.ui.currentIdentity=async()=>startupProof(f,'new@example.test');await f.diag.recheck();await x.pending;
 assert.equal(f.diag.getState().activeEmail,'new@example.test');assert.equal(f.diag.getState().pending,false);assert.equal(x.captures(),1);assert.equal((await locks.inspectOperation()).state,'active');
});
test('production copy exception rejects external or unidentified operation and recovery owners',async t=>{
 for(const mode of ['id','nonce','startIdentity','owner','uncertain-operation','legacy-operation','marker-id','marker-owner','marker-pid','marker-startIdentity','marker-image','uncertain-marker','stale-marker','legacy-marker','wrong-journal'])await t.test(mode,async st=>{
  const x=await ownedStartupCapture(st),{f,locks}=x,owner=(await locks.inspectOperation()).owner,inspect=locks.inspectOperation.bind(locks);
  const journal={id:'00000000-0000-4000-8000-000000000099',operation:'login',loginMode:'save-only'};
  if(['id','nonce','startIdentity','owner'].includes(mode))locks.inspectOperation=async()=>({state:'active',owner:{...owner,[mode]:mode==='owner'?'b'.repeat(64):mode==='startIdentity'?'different-start':'00000000-0000-4000-8000-000000000100'}});
  if(mode==='uncertain-operation')locks.inspectOperation=async()=>({state:'uncertain',reason:'LOCK_PROCESS_STATUS_UNKNOWN',owner});
  if(mode==='legacy-operation')locks.inspectOperation=async()=>({state:'active',owner:{...owner,schema:1}});
  if(mode.includes('marker')){
   x.setJournal(journal);let marker={...owner,id:journal.id};const key=mode.replace('marker-','');
   if(['id','owner','pid','startIdentity'].includes(key))marker={...marker,[key]:key==='owner'?'b'.repeat(64):key==='pid'?101:key==='startIdentity'?'different-start':'00000000-0000-4000-8000-000000000100'};
   if(mode==='marker-image')marker.purpose='image';if(mode==='legacy-marker')marker.schema=1;
   locks.inspectRecovery=async()=>({state:mode==='uncertain-marker'?'uncertain':mode==='stale-marker'?'stale':'active',owner:marker});
  }
  if(mode==='wrong-journal')x.setJournal({id:journal.id,phase:'installed',operation:'switch'});
  await f.diag.recheck();await x.pending;
  assert.equal(f.diag.getState().activeEmail,mode==='uncertain-operation'?'cold@example.test':undefined);assert.equal(f.diag.getState().pending,true);assert.equal(x.proofs(),1);assert.equal(x.captures(),1);assert.equal((await inspect()).state,'active');assert.ok(!f.events.includes('late-save'));
 });
});
