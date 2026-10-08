const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { LiveSwitchService, JOURNAL_KEY, ACCOUNT_PREFIX, parseJournal } = require('../out/live-switch');
const { LiveError } = require('../out/live-storage');
const { loginWithOfficialHub } = require('../out/live-hub');
const fixture = name => JSON.stringify({ token: { access_token: 'synthetic-access-' + name, refresh_token: 'synthetic-refresh-' + name, token_type: 'Bearer' }, auth_method: 'oauth' });
const A = { keyring: fixture('A'), file: fixture('A') }, B = { keyring: fixture('B'), file: null };
function setup(initial=A) {
  const data = new Map(), events=[]; let current=structuredClone(initial);
  const vault = { get:async k=>data.get(k), store:async(k,v)=>{data.set(k,v)}, delete:async k=>{data.delete(k)} };
  const slots = { read:async()=>structuredClone(current), write:async(next,expected)=>{assert.deepEqual(current,expected);events.push('write');current=structuredClone(next)} };
  const backend = { generation:'original', stop:async()=>{events.push('stop')}, reload:async()=>{events.push('reload');backend.generation='fresh-'+events.filter(e=>e==='reload').length}, proof:async()=>({email:(current.keyring||current.file)===fixture('A')?'a@example.test':'b@example.test',generation:backend.generation,authValid:true,quotaSource:'server',buckets:[],observedAt:new Date().toISOString()}), signedOutProof:async()=>({generation:backend.generation,authValid:false}) };
  return { data, events, vault, slots, backend, service:new LiveSwitchService(vault,slots), set:v=>{current=structuredClone(v)}, current:()=>current };
}
const metadata={label:'B',expectedEmail:'b@example.test',identitySource:'hub'};

test('external login arriving during prepared-journal save is checked again before stop',async()=>{
 const x=setup();await x.service.prepareLogin(x.backend);x.set(B);const saved=await x.service.captureLogin(metadata),store=x.vault.store;const external={keyring:fixture('C'),file:fixture('C')};
 x.vault.store=async(key,value)=>{await store(key,value);if(key===JOURNAL_KEY&&JSON.parse(value).phase==='prepared')x.set(external)};
 await assert.rejects(x.service.completeLogin(saved.id,x.backend),/EXTERNAL_CHANGE/);assert.deepEqual(x.events,[]);assert.deepEqual(x.current(),external);assert.deepEqual((await x.service.journal()).backup,A);
});

test('capture binds its expected transaction through slot-read waits before saving a profile',async()=>{
 const x=setup();await x.service.prepareLogin(x.backend);x.set(B);const journal=await x.service.journal(),read=x.slots.read;
 const replacement={...journal,id:'00000000-0000-4000-8000-000000000098'};replacement.target={...replacement.target,id:replacement.id};const raw=JSON.stringify(replacement);let reads=0;
 x.slots.read=async(...args)=>{const value=await read(...args);if(++reads===2)x.data.set(JOURNAL_KEY,raw);return value};
 await assert.rejects(x.service.captureLogin(metadata,journal.id),/RECOVERY_CHANGED/);assert.equal(x.data.get(JOURNAL_KEY),raw);assert.equal([...x.data.keys()].filter(key=>key.startsWith(ACCOUNT_PREFIX)).length,0);
});
test('full captured official slots retain the old fallback and block restoration over an independent login before stop',async()=>{
 const x=setup();await x.service.prepareLogin(x.backend);const owned={keyring:fixture('B'),file:fixture('A')};x.set(owned);const account=await x.service.captureLogin(metadata);const journal=await x.service.journal();
 assert.deepEqual(journal.loginCurrent,owned);assert.deepEqual((await x.service.account(account.id)).slots,B);const external={keyring:fixture('C'),file:fixture('C')};x.set(external);
 await assert.rejects(x.service.completeLogin(account.id,x.backend),/EXTERNAL_CHANGE/);assert.deepEqual(x.current(),external);assert.deepEqual(x.events,[]);assert.deepEqual((await x.service.journal()).backup,A);
});
test('external official login during an owned add stop prevents any old credential write or restart',async()=>{
 const x=setup();await x.service.prepareLogin(x.backend);x.set(B);const account=await x.service.captureLogin(metadata);const external={keyring:fixture('C'),file:fixture('C')};x.backend.stop=async()=>{x.events.push('stop');x.set(external)};
 await assert.rejects(x.service.completeLogin(account.id,x.backend),/EXTERNAL_CHANGE/);assert.deepEqual(x.current(),external);assert.deepEqual(x.events,['stop']);assert.deepEqual((await x.service.journal()).backup,A);
});
test('unknown official changes before any capture remain untouched after an old add cancellation',async()=>{
 const x=setup();await x.service.prepareLogin(x.backend);const before=JSON.stringify(await x.service.journal());x.set(B);
 await assert.rejects(x.service.restoreLogin((await x.service.journal()).id,x.backend),/EXTERNAL_CHANGE/);assert.deepEqual(x.current(),B);assert.deepEqual(x.events,[]);assert.equal(JSON.stringify(await x.service.journal()),before);
});
test('journal replacement during restore stop blocks credentials and preserves the replacement verbatim',async()=>{
 const x=setup();await x.service.prepareLogin(x.backend);x.set(B);const saved=await x.service.captureLogin(metadata);let raw;
 x.backend.stop=async()=>{const journal=await x.service.journal();journal.id='00000000-0000-4000-8000-000000000097';journal.target={...journal.target,id:journal.id};raw=JSON.stringify(journal);x.data.set(JOURNAL_KEY,raw)};
 await assert.rejects(x.service.completeLogin(saved.id,x.backend),/RECOVERY_CHANGED/);assert.equal(x.data.get(JOURNAL_KEY),raw);assert.deepEqual(x.events,[]);assert.deepEqual(x.current(),B);
});
test('login durably backs up both original slots before any authentication or mutation',async()=>{
 const x=setup();await x.service.prepareLogin(x.backend);assert.deepEqual(x.events,[]);const j=await x.service.journal();assert.equal(j.operation,'login');assert.equal(j.phase,'authorizing');assert.deepEqual(j.backup,A);await assert.rejects(x.service.prepareLogin(x.backend),/RECOVERY_PENDING/);
});
test('empty original session is restorable and no speculative token is created',async()=>{
 const x=setup({keyring:null,file:null});await x.service.prepareLogin(x.backend);await assert.rejects(x.service.captureLogin(metadata),/LOGIN_TOKEN_NOT_UPDATED/);x.set(B);await x.service.restore(x.backend);assert.deepEqual(x.current(),{keyring:null,file:null});assert.equal((await x.service.journal()).phase,'restored');
});
test('backup readback failure keeps Login unstarted',async()=>{
 const x=setup();x.vault.store=async()=>{};await assert.rejects(x.service.prepareLogin(x.backend),/RECOVERY_SAVE_NOT_VERIFIED/);assert.deepEqual(x.events,[]);
});
test('backup rejects concurrent official token refresh',async()=>{
 const x=setup();let reads=0;x.slots.read=async()=>++reads===1?A:B;await assert.rejects(x.service.prepareLogin(x.backend),/OFFICIAL_STORAGE_CHANGED/);assert.equal(x.data.size,0);
});
test('new login ignores an unchanged old-account fallback and preserves it only in recovery',async()=>{
 const x=setup();await x.service.prepareLogin(x.backend);x.set({keyring:fixture('B'),file:fixture('A')});const account=await x.service.captureLogin(metadata);assert.deepEqual((await x.service.account(account.id)).slots,B);assert.deepEqual((await x.service.journal()).backup,A);assert.ok(!JSON.stringify(account).includes('synthetic'));
 await x.service.installLogin(account.id,x.backend);assert.deepEqual(x.events,['stop','write','reload']);assert.deepEqual(x.current(),A);assert.deepEqual((await x.service.journal()).backup,A);assert.equal((await x.service.journal()).phase,'restored');assert.equal((await x.service.verifyRestored(x.backend)).email,'a@example.test');
});
test('file-only login does not carry an unchanged old keyring into a saved profile',async()=>{
 const x=setup();await x.service.prepareLogin(x.backend);x.set({keyring:fixture('A'),file:fixture('B')});const account=await x.service.captureLogin(metadata);assert.deepEqual((await x.service.account(account.id)).slots,{keyring:null,file:fixture('B')});
});
test('inconsistent newly changed slots and wrong ID-token hints fail closed',async()=>{
 const x=setup();await x.service.prepareLogin(x.backend);x.set({keyring:fixture('B'),file:fixture('C')});await assert.rejects(x.service.captureLogin(metadata),/IDENTITY_AMBIGUOUS/);
 const wrong=JSON.stringify({token:{refresh_token:'synthetic-b'},id_token:'e30.'+Buffer.from(JSON.stringify({email:'c@example.test'})).toString('base64url')+'.synthetic'});x.set({keyring:wrong,file:null});await assert.rejects(x.service.captureLogin(metadata),/EMAIL_MISMATCH/);assert.equal([...x.data.keys()].filter(k=>k.startsWith(ACCOUNT_PREFIX)).length,0);
});
test('cancelled or failed browser auth restores only after stopping official callbacks',async()=>{
 const x=setup();await x.service.prepareLogin(x.backend);x.set(B);await x.service.restore(x.backend);assert.deepEqual(x.events,['stop','write','reload']);assert.deepEqual(x.current(),A);assert.equal((await x.service.journal()).phase,'restored');
});
test('stop failure leaves original recovery untouched and does not write slots',async()=>{
 const x=setup();await x.service.prepareLogin(x.backend);x.set(B);const a=await x.service.captureLogin(metadata);x.backend.stop=async()=>{throw new LiveError('STOP_FAILED')};await assert.rejects(x.service.installLogin(a.id,x.backend),/STOP_FAILED/);assert.deepEqual(x.events,[]);assert.equal((await x.service.journal()).phase,'prepared');assert.deepEqual((await x.service.journal()).backup,A);
});
test('interrupted installation retains original pre-OAuth backup rather than intermediate new session',async()=>{
 const x=setup();await x.service.prepareLogin(x.backend);x.set(B);const a=await x.service.captureLogin(metadata);x.slots.write=async()=>{throw new LiveError('NATIVE_HELPER_TIMEOUT_OR_LIMIT')};await assert.rejects(x.service.installLogin(a.id,x.backend),/NATIVE_HELPER_TIMEOUT_OR_LIMIT/);assert.equal((await x.service.journal()).phase,'prepared');assert.deepEqual((await x.service.journal()).backup,A);assert.ok(x.data.has(ACCOUNT_PREFIX+a.id));
});
test('authorizing journal must explicitly be a login and cannot pass switch verification',async()=>{
 const x=setup();await x.service.prepareLogin(x.backend);await assert.rejects(x.service.verify(x.backend),/NO_SWITCH_TO_VERIFY/);const j=JSON.parse(x.data.get(JOURNAL_KEY));delete j.operation;assert.throws(()=>parseJournal(JSON.stringify(j)),/RECOVERY_RECORD_INVALID/);
});
async function serve(handler,fn){const server=http.createServer(handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));try{await fn({port:server.address().port,csrfToken:'synthetic-login-csrf-value'});}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}}
test('real loopback Login transport fixes endpoint, scope flags and CSRF; only boolean auth is consumed',async()=>{
 const seen=[];await serve((req,res)=>{let body='';req.on('data',d=>body+=d);req.on('end',()=>{seen.push({path:req.url,body:JSON.parse(body),csrf:req.headers['x-codeium-csrf-token']});res.end(JSON.stringify({authResult:{hasValidAuth:true},unused:'not-forwarded'}));})},async api=>{assert.equal(await loginWithOfficialHub(api,new AbortController().signal),undefined)});
 assert.deepEqual(seen,[{path:'/exa.language_server_pb.LanguageServerService/Login',body:{isGcpTos:false,additionalScopes:[],enableBusinessLogin:false},csrf:'synthetic-login-csrf-value'}]);
});
test('login rejects false auth, redirects, and raw backend errors without echo',async()=>{
 for(const [status,body,code] of [[200,'{"authResult":{"hasValidAuth":false},"error":"private"}','LOGIN_NOT_AUTHENTICATED'],[302,'private','HUB_RPC_FAILED'],[200,'private','HUB_RESPONSE_INVALID']])await serve((_req,res)=>{res.statusCode=status;res.end(body)},async api=>{await assert.rejects(loginWithOfficialHub(api,new AbortController().signal),e=>e.message===code)});
});
test('cancellation before request sends nothing; during request aborts bounded client operation',async()=>{
 const a=new AbortController();a.abort();await assert.rejects(loginWithOfficialHub({port:1,csrfToken:'synthetic-csrf-token'},a.signal),/LOGIN_CANCELLED/);
 const b=new AbortController();await serve(()=>{b.abort()},async api=>{await assert.rejects(loginWithOfficialHub(api,b.signal),/LOGIN_CANCELLED/)});
});
const Module=require('node:module');
function uiSetup(options={}){
 const core=options.core||setup(),commands=new Map(),state=options.state||new Map(),warnings=[],progresses=[],events=core.events;
 let cancel,focus;const ui={answer:undefined,trusted:options.trusted??true,restores:0,activeProgress:0,closedProgress:0,changed:0};
 const vscode={UIKind:{Desktop:1},ProgressLocation:{Notification:1},env:{uiKind:1},workspace:{get isTrusted(){return ui.trusted}},commands:{registerCommand(n,fn){commands.set(n,fn);return{dispose(){}}},async executeCommand(n){events.push(n)}},window:{onDidChangeWindowState(callback){focus=callback;return{dispose(){focus=undefined}}},async showWarningMessage(message){warnings.push(message);return ui.answer},async withProgress(options,fn){progresses.push(options);return fn({report(){}},{isCancellationRequested:false,onCancellationRequested(callback){cancel=callback;return{dispose(){cancel=undefined}}}})},async showInformationMessage(){}}};
 const original=Module._load;Module._load=function(n,...args){return n==='vscode'?vscode:original.call(this,n,...args)};let registerLiveUi;try{const entry=require.resolve('../out/live-ui');delete require.cache[entry];({registerLiveUi}=require(entry));}finally{Module._load=original}
 const context={secrets:core.vault,globalState:{get(k,d){return state.has(k)?state.get(k):d},async update(k,v){state.set(k,v)}},extension:{extensionKind:1},extensionUri:{scheme:'file',authority:''},globalStorageUri:{scheme:'file',authority:'',toString:()=> 'file:///synthetic-login-home'},subscriptions:[]};
 const locks=options.locks||{withOperation:async fn=>{events.push('locked');try{return await fn()}finally{events.push('unlocked')}},hasRecovery:async()=>false,async beginRecovery(){events.push('recovery')},async clearRecovery(){events.push('clear')}};
 const backend={...core.backend,proof:async()=>({...await core.backend.proof(),generation:backend.generation}),signedOutProof:async()=>({generation:backend.generation,authValid:false}),login:async()=>{assert.equal((await core.service.journal()).phase,'authorizing');events.push('login');core.set({keyring:fixture('B'),file:fixture('A')})}};
 if(options.component){backend.restartMode='component';backend.reload=async()=>{events.push('component-restart');backend.generation='fresh-'+events.filter(e=>e==='component-restart').length;};locks.assertRecovery=async()=>{};}
 const lifecycle=async(...args)=>{events.push('lifecycle');if(args.length&&!options.component)assert.equal(args[0],true);return backend};
 const progress=vscode.window.withProgress;vscode.window.withProgress=async(...args)=>{ui.activeProgress++;try{return await progress(...args)}finally{ui.activeProgress--;ui.closedProgress++}};
 const diag=registerLiveUi(context,{service:core.service,locks,lifecycle,processCount:async()=>0,changed:()=>ui.changed++});
 return{...core,context,backend,locks,commands,state,warnings,progresses,ui,diag,events,cancel:()=>cancel?.(),focus:()=>focus?.({focused:true}),run:()=>commands.get('antigravityAccounts.live.login')()};
}
const consent='添加并保存';
const settleLogin=()=>new Promise(setImmediate);
test('browser progress closes before delayed identity, secure saving and final proof; list refreshes immediately after save',async()=>{
 const x=uiSetup({component:true});x.ui.answer=consent;await x.diag.refresh();
 const originalProof=x.backend.proof,store=x.vault.store;let proofs=0,releaseProof,releaseSave;
 x.backend.proof=async(...args)=>{if(++proofs===2||proofs===3)await new Promise(resolve=>releaseProof=resolve);return originalProof(...args)};
 x.vault.store=async(key,value)=>{if(key.startsWith(ACCOUNT_PREFIX))await new Promise(resolve=>releaseSave=resolve);return store(key,value)};
 const pending=x.run();await settleLogin();assert.equal(proofs,2);assert.equal(x.ui.activeProgress,0);assert.equal(x.ui.closedProgress,1);assert.equal(x.diag.getAccounts().length,0);assert.match(x.diag.getStatus(),/核验/);
 releaseProof();await settleLogin();assert.equal(typeof releaseSave,'function');assert.equal(x.ui.activeProgress,0);assert.equal(x.diag.getAccounts().length,0,'pending storage is not saved');
 const before=x.ui.changed;releaseSave();await settleLogin();assert.equal(proofs,3);assert.equal(x.diag.getAccounts().length,1);assert.ok(x.ui.changed>before);assert.match(x.diag.getStatus(),/已安全保存.*确认/);assert.equal(x.ui.activeProgress,0);
 releaseProof();await pending;assert.equal(x.ui.activeProgress,0);assert.equal(x.ui.closedProgress,2);assert.equal(await x.service.journal(),null);assert.equal(x.diag.getState().busy,false);
});
test('cancelled browser request cannot save a late authenticated result and always closes its progress',async()=>{
 const x=uiSetup();x.ui.answer=consent;let finish;
 x.backend.login=async()=>{x.events.push('login');await new Promise(resolve=>finish=resolve);x.set(B)};
 const pending=x.run();await settleLogin();assert.equal(x.ui.activeProgress,1);x.cancel();finish();await pending;
 assert.equal(x.diag.getAccounts().length,0);assert.equal(x.ui.activeProgress,0);assert.equal(x.diag.getState().busy,false);assert.deepEqual(x.current(),B);assert.ok(!x.events.includes('stop')&&!x.events.includes('write'));assert.equal((await x.service.journal()).phase,'authorizing');
});
test('a replacement transaction rejects late login proof without saving, restoring or clearing its journal',async()=>{
 const x=uiSetup();x.ui.answer=consent;const original=x.backend.proof;let proofs=0,finish;
 x.backend.proof=async(...args)=>{if(++proofs===2)await new Promise(resolve=>finish=resolve);return original(...args)};
 const pending=x.run();await settleLogin();const replacement={...await x.service.journal(),id:'00000000-0000-4000-8000-000000000099'};replacement.target={...replacement.target,id:replacement.id};const raw=JSON.stringify(replacement);x.data.set(JOURNAL_KEY,raw);finish();await pending;
 assert.equal(x.data.get(JOURNAL_KEY),raw);assert.equal(x.diag.getAccounts().length,0);assert.ok(!x.events.includes('stop')&&!x.events.includes('write')&&!x.events.includes('clear'));assert.equal(x.ui.activeProgress,0);assert.equal(x.diag.getState().busy,false);assert.match(x.diag.getStatus(),/事务|记录/);
});
test('post-browser identity failure closes progress and preserves unowned changed slots for explicit recovery',async()=>{
 const x=uiSetup();x.ui.answer=consent;const original=x.backend.proof;let calls=0;
 x.backend.proof=async(...args)=>{if(++calls===2)throw new LiveError('HUB_RPC_TIMEOUT');return original(...args)};await x.run();
 assert.equal(x.diag.getAccounts().length,0);assert.equal(x.ui.activeProgress,0);assert.equal(x.ui.closedProgress,1);assert.equal(x.diag.getState().busy,false);assert.deepEqual(x.current(),{keyring:fixture('B'),file:fixture('A')});assert.equal((await x.service.journal()).phase,'authorizing');assert.ok(!x.events.includes('stop')&&!x.events.includes('write'));
});
for(const cancelled of [false,true])test(`component OAuth ${cancelled?'cancellation':'completion'} verifies original identity without window reload`,async()=>{
 const x=uiSetup({component:true});x.ui.answer=consent;
 if(cancelled)x.backend.login=async()=>{x.events.push('login');throw new LiveError('LOGIN_CANCELLED')};
 const restart=x.backend.reload;x.backend.reload=async()=>{assert.throws(require('../out/image-activity').enterAccountChange,/LIVE_OPERATION_IN_PROGRESS/);await restart();};
 await x.run();assert.deepEqual(x.current(),A);assert.equal(x.diag.getAccounts().length,cancelled?0:1);
 assert.equal(await x.service.journal(),null);assert.equal(x.diag.getState().pending,false);assert.equal(x.diag.getState().activeEmail,'a@example.test');
 assert.equal(x.events.filter(e=>e==='component-restart').length,1);assert.ok(!x.events.includes('workbench.action.reloadWindow'));assert.equal(x.warnings.length,1);
});
test('login button dismissal never starts backend, browser or backup',async()=>{
 const x=uiSetup();await x.run();assert.deepEqual(x.events,['locked','unlocked']);assert.equal(x.data.size,0);
});
test('complete add flow saves B and restores A, reloads after unlock, with one consent only',async()=>{
 const x=uiSetup();x.ui.answer=consent;await x.run();assert.deepEqual(x.events,['locked','lifecycle','recovery','login','stop','write','unlocked','workbench.action.reloadWindow']);assert.deepEqual(x.current(),A);assert.equal(x.diag.getAccounts().length,1);assert.equal((await x.service.journal()).phase,'restored');assert.deepEqual(x.progresses.map(x=>x.cancellable),[true,false]);assert.ok(!JSON.stringify([...x.state.values()]).includes('synthetic-refresh'));assert.match(x.diag.getStatus(),/恢复.*自动检查/);assert.equal(x.warnings.length,1);
});

test('browser cancellation restores originals and performs the already-consented reload without another dialog',async()=>{
 const x=uiSetup();x.ui.answer=consent;x.backend.login=signal=>new Promise((_resolve,reject)=>{x.events.push('login');signal.addEventListener('abort',()=>reject(new LiveError('LOGIN_CANCELLED')));setImmediate(x.cancel)});await x.run();assert.deepEqual(x.events,['locked','lifecycle','recovery','login','stop','write','unlocked','workbench.action.reloadWindow']);assert.deepEqual(x.current(),A);assert.equal(x.diag.getAccounts().length,0);assert.equal((await x.service.journal()).phase,'restored');assert.match(x.diag.getStatus(),/已取消添加账号.*原凭据已恢复/);assert.equal(x.warnings.length,1);assert.equal(x.diag.getState().recoveryPhase,'restored');assert.equal(x.diag.getState().pending,true);
});

test('timeout or Google denial restores rather than calling login a second time',async()=>{
 for(const code of ['LOGIN_TIMEOUT','LOGIN_NOT_AUTHENTICATED']){const x=uiSetup();x.ui.answer=consent;x.backend.login=async()=>{x.events.push('login');throw new LiveError(code)};await x.run();assert.equal(x.events.filter(s=>s==='login').length,1);assert.deepEqual(x.current(),A);assert.equal((await x.service.journal()).phase,'restored');}
});
test('repeated Add clicks do not create second OAuth request',async()=>{
 const x=uiSetup();x.ui.answer=consent;let done,started;const ready=new Promise(r=>started=r);x.backend.login=async()=>{x.events.push('login');started();await new Promise(r=>done=r);x.set(B)};const first=x.run();await ready;await x.run();done();await first;assert.equal(x.events.filter(s=>s==='login').length,1);assert.equal(x.diag.getAccounts().length,1);
});
test('backup failure never invokes Login, and restore failure retains pending state',async()=>{
 const x=uiSetup();x.ui.answer=consent;x.vault.store=async()=>{throw Error('private')};await x.run();assert.ok(!x.events.includes('login'));assert.ok(x.events.includes('clear'));assert.equal(x.state.get('live-switch.pending.v1'),false);assert.ok(!x.warnings.at(-1).includes('private'));
 const y=uiSetup();y.ui.answer=consent;y.backend.login=async()=>{throw new LiveError('LOGIN_NOT_AUTHENTICATED')};y.backend.stop=async()=>{throw Error('private')};await y.run();assert.match(y.diag.getStatus(),/保留加密恢复记录/);assert.equal((await y.service.journal()).phase,'prepared');assert.ok(!y.events.includes('write'));
});
test('unverified new hub identity prevents secure account capture',async()=>{
 const x=uiSetup();x.ui.answer=consent;const original=x.backend.proof;let calls=0;x.backend.proof=async()=>++calls===1?original():({email:'b@example.test',generation:'different',authValid:true});await x.run();assert.equal(x.diag.getAccounts().length,0);assert.deepEqual(x.current(),{keyring:fixture('B'),file:fixture('A')});assert.equal((await x.service.journal()).phase,'authorizing');assert.ok(!x.events.includes('stop')&&!x.events.includes('write'));
});
test('native helper timeout never races a possibly in-flight OS credential operation with rollback',async()=>{
 const x=uiSetup();x.ui.answer=consent;x.service.captureLogin=async()=>{throw new LiveError('NATIVE_HELPER_TIMEOUT_OR_LIMIT')};await x.run();assert.match(x.diag.getStatus(),/保留加密恢复记录/);assert.ok(!x.events.includes('stop'));assert.ok(!x.events.includes('write'));assert.equal((await x.service.journal()).phase,'authorizing');
});

test('hub capability contract rejects malformed exports before transport',async()=>{
 const {hasOfficialHubApi,generation,hubRpc}=require('../out/live-hub');
 for(const value of [undefined,null,{}, {port:'34567',csrfToken:'synthetic-valid-csrf'}, {port:0,csrfToken:'synthetic-valid-csrf'}, {port:65536,csrfToken:'synthetic-valid-csrf'}, {port:34567,csrfToken:'bad\r\nheader'}]){
  assert.equal(hasOfficialHubApi(value),false);assert.throws(()=>generation(value),/OFFICIAL_HUB_API_UNAVAILABLE/);await assert.rejects(hubRpc(value,'GetAuthStatus'),/OFFICIAL_HUB_API_UNAVAILABLE/);
 }
 assert.equal(hasOfficialHubApi({port:34567,csrfToken:'synthetic-valid-csrf'}),true);
});


test('inaccessible WSL mutation store blocks before Login and keeps both original slots untouched',async()=>{
 const x=uiSetup();x.ui.answer=consent;x.service.prepareLogin=async()=>{throw new LiveError('KEYRING_UNAVAILABLE')};await x.run();
 assert.ok(!x.events.includes('login'));assert.ok(!x.events.includes('write'));assert.deepEqual(x.current(),A);assert.equal(x.data.size,0);assert.equal(x.state.get('live-switch.pending.v1'),false);assert.match(x.diag.getState().status,/WSL.*不需要密钥库/);assert.match(x.diag.getState().status,/旧双槽备份必须保留/);
});

// OAUTH_CANCELLATION_RECOVERY: synthetic vault/slots only, no browser or credentials.
test('cancel reports truthful inline state and reloads only after mutex release',async()=>{
 const x=uiSetup();x.ui.answer=consent;x.backend.login=async()=>{x.events.push('login');throw new LiveError('LOGIN_CANCELLED')};
 await x.run();assert.deepEqual(x.events,['locked','lifecycle','recovery','login','stop','write','unlocked','workbench.action.reloadWindow']);
 assert.match(x.diag.getStatus(),/已取消添加账号.*原凭据已恢复/);assert.equal(x.warnings.length,1);assert.equal((await x.service.journal()).phase,'restored');assert.deepEqual(x.current(),A);
});

test('restored journal automatically verifies original live account after restart without consent or second write',async()=>{
 const x=uiSetup();x.ui.answer=consent;x.backend.login=async()=>{throw new LiveError('LOGIN_CANCELLED')};await x.run();
 const writes=x.events.filter(e=>e==='write').length;x.backend.generation='restarted';x.locks.assertRecovery=async()=>{};
 const restart=uiSetup({core:x,state:x.state,locks:x.locks});await restart.diag.refresh();
 assert.equal(restart.diag.getState().pending,false);assert.equal(restart.diag.getState().recoveryPhase,'none');assert.equal(await x.service.journal(),null);assert.equal(x.events.filter(e=>e==='write').length,writes);assert.deepEqual(restart.warnings,[]);assert.match(restart.diag.getStatus(),/已恢复原登录/);
});

test('disposal after new login capture preserves the saved account and original recovery backup without a late reload',async()=>{
 const x=uiSetup();x.ui.answer=consent;let proofs=0;const real=x.backend.proof;
 x.backend.proof=async()=>{if(++proofs===3)for(const subscription of x.context.subscriptions)subscription.dispose();return real()};await x.run();
 assert.equal(x.diag.getAccounts().length,1);assert.equal((await x.service.journal()).phase,'restored');assert.deepEqual(x.current(),A);assert.ok(!x.events.includes('workbench.action.reloadWindow'));assert.match(x.diag.getStatus(),/新登录副本也已保存/);assert.equal(x.ui.activeProgress,0);
});
test('restoration readback mismatch keeps original backup and never claims restored or reloads',async()=>{
 const x=setup();await x.service.prepareLogin(x.backend);x.set(B);x.slots.write=async()=>{x.events.push('write-without-change')};
 await assert.rejects(x.service.restore(x.backend,{reload:false}),/RECOVERY_RESTORE_NOT_VERIFIED/);assert.equal((await x.service.journal()).phase,'prepared');assert.deepEqual((await x.service.journal()).backup,A);assert.ok(!x.events.includes('reload'));
});
test('cancel with original empty or file-only unknown keyring retains exact original scope without reload',async()=>{
 for(const original of [{keyring:null,file:null},{keyring:null,file:fixture('A'),keyringState:'unobserved'}]) {
  const x=setup(original);await x.service.prepareLogin(x.backend);x.set({...original,file:fixture('B')});await x.service.restore(x.backend,{reload:false});
  assert.deepEqual(x.current(),original);assert.deepEqual((await x.service.journal()).backup,original);assert.equal((await x.service.journal()).phase,'restored');assert.deepEqual(x.events,['stop','write']);
 }
});
test('stale pending boolean alone heals on activation without deleting accounts or touching official slots',async()=>{
 const core=setup(),account=await core.service.capture({label:'A',expectedEmail:'a@example.test',identitySource:'user'}),before=JSON.stringify([...core.data.entries()]);
 const state=new Map([['live-switch.pending.v1',true],['live-switch.accounts.v1',[account]]]);const x=uiSetup({core,state});await new Promise(setImmediate);
 assert.equal(x.diag.getState().pending,false);assert.equal(x.diag.getState().recoveryPhase,'none');assert.equal(state.get('live-switch.pending.v1'),false);assert.equal(JSON.stringify([...core.data.entries()]),before);assert.deepEqual(core.events,[]);
 await x.commands.get('antigravityAccounts.live.verify')();assert.equal(x.warnings.length,0);assert.equal(x.diag.getAccounts().length,1);
});
test('real authorizing journal with missing pending flag is recovered from metadata without native reads or mutation',async()=>{
 const core=setup();await core.service.prepareLogin(core.backend);core.slots.read=async()=>{throw Error('must not open official storage during activation')};
 const x=uiSetup({core});await new Promise(setImmediate);assert.equal(x.diag.getState().pending,true);assert.equal(x.diag.getState().recoveryPhase,'authorizing');assert.match(x.diag.getStatus(),/浏览器登录未完成/);assert.deepEqual(x.events,[]);
});
test('corrupt or foreign recovery metadata stays blocked and is never silently removed',async()=>{
 for(const raw of ['invalid-json',JSON.stringify({schema:1,id:'old',phase:'restored',backup:{keyring:null,file:null},target:{id:'target'},oldGeneration:'old',hostId:17})]){
  const core=setup();core.data.set(JOURNAL_KEY,raw);const x=uiSetup({core});await new Promise(setImmediate);assert.equal(x.diag.getState().pending,true);assert.equal(x.diag.getState().recoveryPhase,'unavailable');assert.equal(core.data.get(JOURNAL_KEY),raw);assert.deepEqual(x.events,[]);
 }
});
test('cancel preserves unreadable official storage and its journal without claiming automatic restoration',async()=>{
 const x=uiSetup();x.ui.answer=consent;x.backend.login=async()=>{x.slots.read=async()=>{throw new LiveError('KEYRING_UNAVAILABLE')};throw new LiveError('LOGIN_CANCELLED')};
 await x.run();assert.equal(x.events.filter(e=>e==='stop').length,0);assert.ok(!x.events.includes('write'));assert.ok(!x.events.includes('workbench.action.reloadWindow'));assert.equal((await x.service.journal()).phase,'authorizing');assert.match(x.diag.getStatus(),/保留加密恢复记录/);
});

async function automaticLockFixture(t,core,options={}){
 const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{randomUUID}=require('node:crypto'),{LiveLocks}=require('../out/live-lock');
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'agm-ui-recovery-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));const owner='a'.repeat(64);
 const status={alive:options.alive??false};const probe=async pid=>pid===111?{state:'alive',startIdentity:'current-instance'}:status.alive?{state:'alive',startIdentity:'previous-instance'}:{state:'dead'};
 const locks=new LiveLocks(directory,owner,{pid:111,probe});
 const write=async(name,id=randomUUID(),schema=2)=>{const location=path.join(directory,name);await fs.mkdir(location);const record={schema,owner,id,pid:222,...(schema===2?{nonce:randomUUID(),startIdentity:'previous-instance'}:{})};await fs.writeFile(path.join(location,'owner.json'),JSON.stringify(record));return record};
 return{fs,path,directory,locks,status,write,core};
}
test('startup automatically removes proven-dead operation and orphan recovery markers without credential changes',async t=>{
 const core=setup(),f=await automaticLockFixture(t,core);await f.write('.agm-operation.lock');await f.write('.antigravity-account-manager-switch.lock');
 core.slots.read=async()=>{throw Error('startup must not read official credentials')};const x=uiSetup({core,locks:f.locks,state:new Map([['live-switch.pending.v1',true]])});await x.diag.refresh();
 assert.equal(x.diag.getState().recoveryPhase,'none');assert.equal(x.diag.getState().pending,false);assert.equal(await f.locks.hasRecovery(),false);assert.equal((await f.locks.inspectOperation()).state,'absent');assert.deepEqual(core.events,[]);assert.deepEqual(x.warnings,[]);
});
test('startup recreates only a missing recovery marker and preserves the encrypted restored journal verbatim',async t=>{
 const core=setup();await core.service.prepareLogin(core.backend);await core.service.restore(core.backend,{reload:false});core.events.length=0;
 const before=await core.service.journal(),f=await automaticLockFixture(t,core);core.slots.read=async()=>{throw Error('do not touch credentials')};
 const x=uiSetup({core,locks:f.locks});await x.diag.refresh();assert.equal(x.diag.getState().recoveryPhase,'restored');const after=await core.service.journal();assert.deepEqual(after.backup,before.backup);assert.deepEqual(after.original,before.original);assert.equal(after.verification.state,'retry');await f.locks.assertRecovery(after.id);assert.deepEqual(core.events,['lifecycle']);
});
test('existing restored v1 recovery marker remains usable and is not replaced during automatic reconciliation',async t=>{
 const core=setup();await core.service.prepareLogin(core.backend);await core.service.restore(core.backend,{reload:false});core.events.length=0;
 const j=await core.service.journal(),f=await automaticLockFixture(t,core);const record=await f.write('.antigravity-account-manager-switch.lock',j.id,1);
 const x=uiSetup({core,locks:f.locks});await x.diag.refresh();assert.equal(x.diag.getState().recoveryPhase,'restored');assert.deepEqual(JSON.parse(await f.fs.readFile(f.path.join(f.directory,'.antigravity-account-manager-switch.lock','owner.json'),'utf8')),record);assert.deepEqual(core.events,['lifecycle']);
});
test('live concurrent operation is preserved and automatically reconsidered when window regains focus',async t=>{
 const core=setup(),f=await automaticLockFixture(t,core,{alive:true});const record=await f.write('.agm-operation.lock');
 const x=uiSetup({core,locks:f.locks});await x.diag.refresh();assert.equal(x.diag.getState().recoveryPhase,'locked');assert.deepEqual(JSON.parse(await f.fs.readFile(f.path.join(f.directory,'.agm-operation.lock','owner.json'),'utf8')),record);
 f.status.alive=false;x.focus();await x.diag.refresh();assert.equal(x.diag.getState().recoveryPhase,'none');assert.equal(x.diag.getState().pending,false);assert.equal((await f.locks.inspectOperation()).state,'absent');assert.deepEqual(core.events,[]);assert.equal(x.warnings.length,0);
});
test('corrupt journal prevents automatic lock cleanup and all original records remain intact',async t=>{
 const core=setup();core.data.set(JOURNAL_KEY,'damaged-record');const f=await automaticLockFixture(t,core);const record=await f.write('.agm-operation.lock');
 const x=uiSetup({core,locks:f.locks});await x.diag.refresh();assert.equal(x.diag.getState().recoveryPhase,'unavailable');assert.equal(core.data.get(JOURNAL_KEY),'damaged-record');assert.deepEqual(JSON.parse(await f.fs.readFile(f.path.join(f.directory,'.agm-operation.lock','owner.json'),'utf8')),record);assert.deepEqual(core.events,[]);
});
test('untrusted activation never reconciles or mutates even stale metadata',async t=>{
 const core=setup(),f=await automaticLockFixture(t,core);const record=await f.write('.agm-operation.lock');
 const x=uiSetup({core,locks:f.locks,trusted:false});await x.diag.refresh();assert.deepEqual(JSON.parse(await f.fs.readFile(f.path.join(f.directory,'.agm-operation.lock','owner.json'),'utf8')),record);assert.deepEqual(core.events,[]);
});

// Save-only login and evidence-backed completion use synthetic official stores only.
test('add B saves one independent account and automatically verifies restored A before clearing backup',async()=>{
 const x=setup();await x.service.prepareLogin(x.backend);x.set(B);const saved=await x.service.captureLogin(metadata);
 await x.service.completeLogin(saved.id,x.backend);assert.deepEqual(x.current(),A);assert.deepEqual((await x.service.account(saved.id)).slots,B);
 const pending=await x.service.journal();assert.equal(pending.phase,'restored');assert.equal(pending.original.email,'a@example.test');assert.equal(pending.verification.state,'pending');
 const proof=await x.service.finishVerified(x.backend);assert.equal(proof.email,'a@example.test');assert.equal(await x.service.journal(),null);assert.ok(x.data.has(ACCOUNT_PREFIX+saved.id));
});
test('first account is saved without implicitly signing the originally empty official session in',async()=>{
 const x=setup({keyring:null,file:null});await x.service.prepareLogin(x.backend);x.set(B);const saved=await x.service.captureLogin(metadata);
 await x.service.completeLogin(saved.id,x.backend);assert.deepEqual(x.current(),{keyring:null,file:null});assert.equal((await x.service.journal()).original.email,null);
 assert.equal(await x.service.finishVerified(x.backend),null);assert.equal(await x.service.journal(),null);assert.ok(x.data.has(ACCOUNT_PREFIX+saved.id));
});
test('empty stored slots with a still-authenticated in-memory hub are not invented as signed-out baseline',async()=>{
 const x=setup({keyring:null,file:null});x.backend.signedOutProof=async()=>({generation:'original',authValid:true});
 await assert.rejects(x.service.prepareLogin(x.backend),/ORIGINAL_SESSION_UNVERIFIED/);assert.equal(x.data.size,0);assert.deepEqual(x.events,[]);
});
test('original identity must come from fresh server-backed proof, never cached status or JWT email alone',async()=>{
 for(const mutate of [p=>({...p,quotaSource:undefined}),p=>({...p,generation:'unrelated'}),p=>({...p,authValid:false})]){
  const x=setup();const original=x.backend.proof;x.backend.proof=async()=>mutate(await original());
  await assert.rejects(x.service.prepareLogin(x.backend),/ORIGINAL_SESSION_UNVERIFIED/);assert.equal(x.data.size,0);assert.deepEqual(x.events,[]);
 }
});
test('interruption after new account save repairs only missing index row and remains idempotent',async()=>{
 const x=setup();await x.service.prepareLogin(x.backend);x.set(B);const saved=await x.service.captureLogin(metadata);let rows=[];
 const index={read:()=>rows,write:async next=>{rows=next}},restarted=new LiveSwitchService(x.vault,x.slots);
 await restarted.recoverLogin(index);await restarted.recoverLogin(index);assert.deepEqual(rows,[saved]);assert.deepEqual(x.current(),B);assert.deepEqual(x.events,[]);
 await restarted.restore(x.backend);await restarted.finishVerified(x.backend);assert.ok(x.data.has(ACCOUNT_PREFIX+saved.id));assert.equal(rows.length,1);
});
test('interruption between vault save and journal target update still recovers the saved login index',async()=>{
 const x=setup();await x.service.prepareLogin(x.backend);const id=(await x.service.journal()).id;x.set(B);const store=x.vault.store;
 x.vault.store=async(k,v)=>{if(k===JOURNAL_KEY)throw new Error('synthetic interrupted journal write');await store(k,v)};
 await assert.rejects(x.service.captureLogin(metadata));assert.ok(x.data.has(ACCOUNT_PREFIX+id));x.vault.store=store;
 let rows=[];await new LiveSwitchService(x.vault,x.slots).recoverLogin({read:()=>rows,write:async v=>{rows=v}});assert.equal(rows[0].id,id);assert.equal(rows[0].expectedEmail,'b@example.test');
});
test('crash during original-slot restore keeps retryable encrypted A backup and saved B',async()=>{
 const x=setup();await x.service.prepareLogin(x.backend);x.set(B);const saved=await x.service.captureLogin(metadata),write=x.slots.write;
 x.slots.write=async()=>{throw new LiveError('NATIVE_HELPER_TIMEOUT_OR_LIMIT')};await assert.rejects(x.service.completeLogin(saved.id,x.backend),/NATIVE_HELPER_TIMEOUT_OR_LIMIT/);
 assert.equal((await x.service.journal()).phase,'prepared');assert.deepEqual((await x.service.journal()).backup,A);assert.ok(x.data.has(ACCOUNT_PREFIX+saved.id));assert.ok(!x.events.includes('reload'));
 x.slots.write=write;const restarted=new LiveSwitchService(x.vault,x.slots);await restarted.restore(x.backend);await restarted.finishVerified(x.backend);assert.deepEqual(x.current(),A);
});
test('reload failure after restoring A preserves truthful restored-but-unverified durable state',async()=>{
 const x=setup();await x.service.prepareLogin(x.backend);x.set(B);const saved=await x.service.captureLogin(metadata);x.backend.reload=async()=>{throw new LiveError('RELOAD_FAILED')};
 await assert.rejects(x.service.completeLogin(saved.id,x.backend),/RELOAD_FAILED/);assert.deepEqual(x.current(),A);assert.equal((await x.service.journal()).phase,'restored');
 await assert.rejects(x.service.finishVerified(x.backend),/HUB_IDENTITY_NOT_VERIFIED/);assert.equal((await x.service.journal()).verification.state,'retry');assert.ok(x.data.has(ACCOUNT_PREFIX+saved.id));
});
test('repeat add after automatic recovery permits a new transaction while preserving both saved copies',async()=>{
 const x=setup();const ids=[];
 for(let n=0;n<2;n++){await x.service.prepareLogin(x.backend);x.set(B);const saved=await x.service.captureLogin(metadata);ids.push(saved.id);await x.service.completeLogin(saved.id,x.backend);await x.service.finishVerified(x.backend);assert.deepEqual(x.current(),A)}
 assert.notEqual(ids[0],ids[1]);assert.equal(ids.filter(id=>x.data.has(ACCOUNT_PREFIX+id)).length,2);
});
test('restoration never clears its backup when server identity or signed-out state does not match',async()=>{
 const x=setup();await x.service.prepareLogin(x.backend);x.set(B);await x.service.restore(x.backend);x.backend.proof=async()=>({email:'b@example.test',generation:x.backend.generation,authValid:true,quotaSource:'server'});
 await assert.rejects(x.service.finishVerified(x.backend),/HUB_IDENTITY_NOT_VERIFIED/);assert.equal((await x.service.journal()).verification.state,'retry');
 const y=setup({keyring:null,file:null});await y.service.prepareLogin(y.backend);y.set(B);await y.service.restore(y.backend);y.backend.signedOutProof=async()=>({authValid:true,generation:y.backend.generation});
 await assert.rejects(y.service.finishVerified(y.backend),/HUB_SIGNED_OUT_NOT_VERIFIED/);assert.ok(await y.service.journal());
});
test('legacy restored journal derives mailbox only from new server-backed session bound to original storage',async()=>{
 const x=setup();await x.service.prepareLogin(x.backend);await x.service.restore(x.backend);const journal=await x.service.journal();delete journal.original;x.data.set(JOURNAL_KEY,JSON.stringify(journal));
 assert.equal((await x.service.finishVerified(x.backend)).email,'a@example.test');assert.equal(await x.service.journal(),null);
});
test('legacy recovery rejects stale generation, cached identity, changed credentials and contradictory JWT hints',async()=>{
 for(const mode of ['generation','cache','storage','hint','mixed','unsupported']){
  const x=setup();await x.service.prepareLogin(x.backend);await x.service.restore(x.backend);const journal=await x.service.journal();delete journal.original;
  if(mode==='generation')x.backend.generation=journal.oldGeneration;
  if(mode==='cache'){const proof=x.backend.proof;x.backend.proof=async()=>({...await proof(),quotaSource:undefined})}
  if(mode==='storage')x.set(B);
  if(mode==='hint'){const token=JSON.parse(fixture('A'));token.id_token='e30.'+Buffer.from(JSON.stringify({email:'wrong@example.test'})).toString('base64url')+'.synthetic';const raw=JSON.stringify(token);journal.backup={keyring:raw,file:raw};x.set(journal.backup)}
  if(mode==='mixed'){journal.backup={keyring:fixture('A'),file:fixture('B')};x.set(journal.backup)}
  if(mode==='unsupported'){journal.backup={keyring:'unsupported-old-format',file:null};x.set(journal.backup)}
  x.data.set(JOURNAL_KEY,JSON.stringify(journal));await assert.rejects(x.service.finishVerified(x.backend));assert.ok(await x.service.journal());assert.equal((await x.service.journal()).verification.state,'retry');
 }
});
test('legacy empty restoration requires explicit signed-out proof and never reads an unobserved keyring',async()=>{
 const x=setup({keyring:null,file:null,keyringState:'unobserved'});await x.service.prepareLogin(x.backend);await x.service.restore(x.backend);const journal=await x.service.journal();delete journal.original;x.data.set(JOURNAL_KEY,JSON.stringify(journal));
 assert.equal(await x.service.finishVerified(x.backend),null);assert.deepEqual(x.current(),{keyring:null,file:null,keyringState:'unobserved'});assert.equal(await x.service.journal(),null);
});

test('debug OAuth catches internally restored cancellation as cancelled rather than completed',async t=>{
 const {DebugRecorder,installDebugRecorder}=require('../out/debug-events'),records=[];const logger=new DebugRecorder({append:async(line,current)=>{if(current())records.push(JSON.parse(line));},readLines:async()=>[],flush:async()=>{},dispose(){}},{version:'0.13.2',platform:'linux',host:'local'});await logger.setEnabled(true);const installed=installDebugRecorder(logger);t.after(()=>installed.dispose());
 const x=uiSetup();x.ui.answer=consent;x.backend.login=async()=>{throw new LiveError('LOGIN_CANCELLED')};await x.run();assert.ok(records.some(e=>e.phase==='recovering'&&e.data.code==='LOGIN_CANCELLED'));const ends=records.filter(e=>e.operation==='account.login'&&e.phase==='result');assert.equal(ends.length,1);assert.equal(ends[0].outcome,'cancelled');assert.equal(ends[0].data.code,'LOGIN_CANCELLED');assert.doesNotMatch(JSON.stringify(records),/@|token|keyring|expectedEmail/);
});
