const test=require('node:test'),assert=require('node:assert/strict'),Module=require('node:module'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',ma='gemini-3.1-flash-image',mb='gemini-3-pro-image';
const tick=()=>new Promise(setImmediate);
async function fixture(t,options={}){
 const output=await fs.mkdtemp(path.join(os.tmpdir(),'ag-selection-'));t.after(()=>fs.rm(output,{recursive:true,force:true}));
 const commands=new Map(),states=[],runs=[],reads=[],selections=new Map(),prompts=[],subscriptions=[];
 let panel,finish,decide,loader,quotaLoader,endpoint='daily',ready=options.ready!==false,startupFailures=options.startupFailures??0;const quotaReads=[];const accounts=[{id:A,label:'A',expectedEmail:'a@example.test',active:true,hostCurrent:true},{id:B,label:'B',expectedEmail:'b@example.test',active:false,hostCurrent:true}];
 const identity=id=>{const a=accounts.find(a=>a.id===id);return a&&a.hostCurrent!==false&&a.migrationState!=='pending'?JSON.stringify([a.id,a.expectedEmail,a.hostId,a.capturedAt]):undefined};
 const direct={readImageQuota:async(id,modelId,signal,selection)=>{quotaReads.push({id,modelId,signal,selection,endpoint});if(quotaLoader)return quotaLoader(id,modelId,signal,selection);return{accountId:id,modelId,endpoint,remainingFraction:.3,resetAt:'2026-10-08T00:00:00Z',queriedAt:'2026-10-07T08:00:00Z'}},listAccounts:()=>accounts,hasSavedAccountSelection:id=>selections.has(id)&&selections.get(id)===identity(id),selectSavedAccount:id=>{if(!ready)throw Error('IMAGE_ACCOUNT_INITIALIZING');assert.ok(identity(id));selections.set(id,identity(id))},getEndpoint:()=>endpoint,
 readChoices:async(signal,id,force)=>{reads.push({signal,id,force});if(!ready||startupFailures-->0)throw Error('IMAGE_ACCOUNT_INITIALIZING');if(id&&!direct.hasSavedAccountSelection(id))return{accounts,models:[],readiness:'error',accountMessage:'IMAGE_SAVED_SELECTION_REQUIRED'};if(loader)return loader(signal,id);return{accounts,models:[{id:id===B?mb:ma,label:id===B?'B model':'A model'}],readiness:'ready'}},
 run:async(request,signal,progress,id)=>{runs.push({request,signal,progress,id});return new Promise((resolve,reject)=>{finish=value=>value instanceof Error?reject(value):resolve(value??{images:[],batch:{outcome:'complete'}})})}};
 const vscode={ViewColumn:{Active:1},env:{},workspace:{workspaceFolders:[{uri:{scheme:'file',authority:'',fsPath:output}}]},commands:{registerCommand:(id,fn)=>{commands.set(id,fn);return{dispose(){}}}},window:{showWarningMessage:(message,...args)=>{prompts.push({message,args});return new Promise(r=>decide=r)},createWebviewPanel:()=>{panel={webview:{postMessage:async s=>states.push(structuredClone(s)),onDidReceiveMessage:fn=>{panel.receive=fn;return{dispose(){}}}},onDidDispose:fn=>{panel.close=fn;return{dispose(){}}},reveal(){}};return panel}}};
 const old=Module._load,entry=require.resolve('../out/direct-image-ui');Module._load=function(name,...args){return name==='vscode'?vscode:old.call(this,name,...args)};
 let ui;try{delete require.cache[entry];ui=require(entry).registerDirectImageUi({subscriptions,globalState:{get:()=>undefined,update:async()=>{}}},direct,undefined,require('./helpers/image-session.cjs').memorySession(options.restore?{value:{schema:3,draft:{prompt:'restored',accountId:B,modelId:mb,ratio:'1:1',count:1,size:'auto',quality:'auto',followCurrent:false},outputDirectory:output,references:[],tasks:[],savedDrafts:[]}}:{}))}finally{Module._load=old;delete require.cache[entry]}
 await commands.get('antigravityAccounts.images.open')();
 const send=async value=>{panel.receive(value);await tick();await tick()};
 const form={prompt:'synthetic draft preserved',accountId:A,modelId:ma,ratio:'16:9',count:3,size:'4K',quality:'detail'};
 return{ui,states,runs,reads,quotaReads,dispose:()=>subscriptions.forEach(item=>item.dispose()),setReady:value=>{ready=value},setStartupFailures:value=>{startupFailures=value},quotaLoad:fn=>{quotaLoader=fn},accounts,selections,prompts,send,form,decide:async value=>{decide(value);await tick();await tick()},finish:async value=>{finish(value);await tick();await tick()},load:fn=>{loader=fn},setEndpoint:e=>{endpoint=e},close:()=>panel.close(),open:async()=>{await commands.get('antigravityAccounts.images.open')();await tick()},cancel:()=>commands.get('antigravityAccounts.images.cancel')(),latest:()=>states.at(-1)};
}
test('explicit saved-account selection starts checks immediately with no extra consent or generation',async t=>{
 const f=await fixture(t);assert.equal(f.latest().draft.followCurrent,true);assert.equal(f.selections.size,0);assert.ok(f.reads.every(x=>x.id===undefined));
 await f.send({type:'selectAccount',selection:B,...f.form});
 assert.equal(f.latest().draft.accountId,B);assert.equal(f.latest().draft.followCurrent,false);assert.equal(f.latest().accountBlocked,false);assert.equal(f.latest().choices.models[0].id,mb);
 assert.equal(f.prompts.length,0);assert.equal(f.runs.length,0);assert.equal(f.selections.size,1);assert.equal(f.reads.at(-1).force,false);
 assert.equal(f.latest().draft.size,'4K');assert.equal(f.latest().draft.quality,'detail');assert.equal(f.latest().draft.prompt,f.form.prompt);
 await f.send({type:'checkAccount'});assert.equal(f.reads.at(-1).force,true);assert.equal(f.prompts.length,0);assert.equal(f.runs.length,0);
});
test('invalid, foreign and migration-pending selections cannot authorize checks or replace current selection',async t=>{
 const f=await fixture(t),before=f.reads.length;
 for(const change of [()=>{},()=>{f.accounts[1].hostCurrent=false},()=>{f.accounts[1].hostCurrent=true;f.accounts[1].migrationState='pending'}]){
  change();await f.send({type:'selectAccount',selection:f.accounts[1].hostCurrent===true&&!f.accounts[1].migrationState?'unknown':B,...f.form});
  assert.equal(f.latest().draft.followCurrent,true);assert.equal(f.reads.length,before);assert.equal(f.selections.size,0);
 }
 assert.equal(f.prompts.length,0);assert.equal(f.runs.length,0);
});
test('late B model response cannot overwrite selected A, and cancelled checks cannot enable generate',async t=>{
 const f=await fixture(t);let reply,oldSignal;
 f.load((signal,id)=>id===B?new Promise(r=>{reply=r;oldSignal=signal}):Promise.resolve({accounts:f.accounts,models:[{id:ma,label:'A'}]}));
 await f.send({type:'selectAccount',selection:B,...f.form});await f.send({type:'selectAccount',selection:'@current',...f.form});assert.equal(oldSignal.aborted,true);
 reply({accounts:f.accounts,models:[{id:mb,label:'late B'}]});await tick();assert.equal(f.latest().draft.accountId,A);assert.equal(f.latest().choices.models[0].id,ma);
 await f.send({type:'selectAccount',selection:B,...f.form});await f.send({type:'cancel'});reply({accounts:f.accounts,models:[{id:mb,label:'late cancelled'}]});await tick();assert.equal(f.latest().accountBlocked,true);assert.equal(f.latest().choices.models.length,0);
});
test('official login changes do not replace explicit B selection or cancel its frozen batch',async t=>{
 const f=await fixture(t);await f.send({type:'selectAccount',selection:B,...f.form});const reads=f.reads.length;
 f.ui.accountStateChanged({pending:true,email:'',accountIds:[A,B]});await tick();assert.equal(f.latest().draft.accountId,B);assert.equal(f.latest().choices.models[0].id,mb);assert.equal(f.reads.length,reads);
 await f.send({type:'generate',...f.form,accountId:B,modelId:mb});await f.decide('确认生成');assert.equal(f.runs.length,1);assert.equal(f.runs[0].request.accountSource,'saved');assert.equal(f.runs[0].request.accountId,B);assert.equal(f.runs[0].request.count,3);
 f.ui.accountStateChanged({pending:false,email:'other@example.test',accountIds:[A,B]});assert.equal(f.runs[0].signal.aborted,false);await f.finish();assert.equal(f.latest().tasks[0].accountId,B);assert.match(f.latest().tasks[0].accountLabel,/b@example.test/);assert.equal(f.latest().draft.accountId,B);
});
test('account removal disables selection without fallback, and aborts only its bound operation',async t=>{
 const f=await fixture(t);await f.send({type:'selectAccount',selection:B,...f.form});await f.send({type:'generate',...f.form,modelId:mb});await f.decide('确认生成');
 f.accounts.pop();f.ui.accountStateChanged({pending:false,email:'a@example.test',accountIds:[A]});assert.equal(f.runs[0].signal.aborted,true);assert.equal(f.latest().draft.accountId,B);assert.equal(f.latest().accountBlocked,true);
 await f.finish(Error('IMAGE_SAVED_ACCOUNT_REMOVED'));assert.equal(f.latest().tasks[0].accountId,B);assert.equal(f.runs.length,1);
});
test('selected model is remembered per account while size, detail, ratio and prompt remain unchanged',async t=>{
 const f=await fixture(t);await f.send({...f.form,type:'draft'});await f.send({type:'selectAccount',selection:B,...f.form});assert.equal(f.latest().draft.modelId,mb);
 await f.send({type:'selectAccount',selection:'@current',...f.form,modelId:mb});assert.equal(f.latest().draft.modelId,ma);assert.equal(f.latest().draft.size,'4K');assert.equal(f.latest().draft.ratio,'16:9');assert.equal(f.latest().draft.quality,'detail');
});
test('wrong model or changed endpoint cannot send, failures never rotate selected account',async t=>{
 const f=await fixture(t);await f.send({type:'selectAccount',selection:B,...f.form});await f.send({type:'generate',...f.form});assert.equal(f.runs.length,0);
 await f.send({type:'generate',...f.form,modelId:mb});await f.decide('确认生成');await f.finish(Error('IMAGE_DIRECT_RESOURCE_EXHAUSTED'));assert.equal(f.runs.length,1);assert.equal(f.latest().draft.accountId,B);
 f.setEndpoint('production');await f.send({type:'generate',...f.form,modelId:mb});assert.equal(f.runs.length,1);assert.equal(f.latest().draft.accountId,B);
});

test('switching B back to current clears the loading notice after successful model lookup',async t=>{
 const f=await fixture(t);
 await f.send({type:'selectAccount',selection:B,...f.form});assert.equal(f.latest().choicesLoading,false);assert.match(f.latest().accountStatus,/官方当前登录保持不变/);
 await f.send({type:'selectAccount',selection:'@current',...f.form,modelId:mb});
 assert.equal(f.latest().draft.followCurrent,true);assert.equal(f.latest().draft.accountId,A);assert.equal(f.latest().accountStatus,'');assert.equal(f.latest().choicesLoading,false);assert.equal(f.latest().accountBlocked,false);
 assert.equal(f.latest().draft.prompt,f.form.prompt);assert.equal(f.latest().draft.size,'4K');assert.equal(f.latest().draft.quality,'detail');assert.equal(f.runs.length,0);
});
test('official focus callbacks list only active IDs and cannot mistake saved B for a removed account',async t=>{
 const f=await fixture(t);let resolve;
 f.load((_signal,id)=>id===B?new Promise(r=>resolve=r):Promise.resolve({accounts:f.accounts,models:[{id:ma}]}));
 await f.send({type:'selectAccount',selection:B,...f.form});const reads=f.reads.length;
 for(const state of [{pending:true,email:'',accountIds:[]},{pending:false,email:'a@example.test',accountIds:[A]},{pending:false,email:'A@example.test',accountIds:[A]}])f.ui.accountStateChanged(state);
 assert.equal(f.latest().choicesLoading,true);assert.equal(f.reads.length,reads);assert.equal(f.reads.at(-1).signal.aborted,false);
 resolve({accounts:f.accounts,models:[{id:mb,label:'B model'}],readiness:'ready'});await tick();await tick();
 assert.equal(f.latest().choicesLoading,false);assert.equal(f.latest().accountBlocked,false);assert.equal(f.latest().draft.accountId,B);
 f.accounts.pop();f.ui.accountStateChanged({pending:false,email:'a@example.test',accountIds:[A]});
 assert.equal(f.latest().accountBlocked,true);assert.match(f.latest().accountStatus,/IMAGE_SAVED_ACCOUNT_REMOVED/);assert.equal(f.latest().choices.models.length,0);
});
test('a hung B lookup times out, aborts, offers retry and cannot overwrite a later successful retry',async t=>{
 const f=await fixture(t);t.mock.timers.enable({apis:['setTimeout']});let late,signal;
 f.load(s=>{signal=s;return new Promise(r=>late=r)});
 await f.send({type:'selectAccount',selection:B,...f.form});t.mock.timers.tick(59_999);await tick();assert.equal(f.latest().choicesLoading,true);
 t.mock.timers.tick(1);await tick();await tick();
 assert.equal(signal.aborted,true);assert.equal(f.latest().choicesLoading,false);assert.equal(f.latest().accountBlocked,true);assert.equal(f.latest().canCheckAccount,true);assert.match(f.latest().accountStatus,/IMAGE_ACCOUNT_CHECK_TIMEOUT/);assert.equal(f.latest().choices.models.length,0);
 f.load(async()=>({accounts:f.accounts,models:[{id:mb,label:'fresh B'}],readiness:'ready'}));await f.send({type:'checkAccount'});
 assert.equal(f.reads.at(-1).force,true);assert.equal(f.latest().accountBlocked,false);assert.equal(f.latest().choices.models[0].label,'fresh B');
 late({accounts:f.accounts,models:[{id:ma,label:'stale B'}]});await tick();assert.equal(f.latest().choices.models[0].label,'fresh B');assert.equal(f.latest().choicesLoading,false);assert.equal(f.runs.length,0);
});
test('current-account timeout has an in-place retry and success clears its notice',async t=>{
 const f=await fixture(t);t.mock.timers.enable({apis:['setTimeout']});f.load(()=>new Promise(()=>{}));await f.send({type:'ready'});
 t.mock.timers.tick(60_000);await tick();await tick();assert.equal(f.latest().choicesLoading,false);assert.equal(f.latest().canCheckAccount,true);assert.match(f.latest().accountStatus,/IMAGE_ACCOUNT_CHECK_TIMEOUT/);
 f.load(async()=>({accounts:f.accounts,models:[{id:ma,label:'current'}]}));await f.send({type:'checkAccount'});
 assert.equal(f.latest().accountStatus,'');assert.equal(f.latest().accountBlocked,false);assert.equal(f.latest().draft.followCurrent,true);assert.equal(f.prompts.length,0);assert.equal(f.runs.length,0);
});
test('rapid A-B selections isolate old replies and duplicate ready notifications reuse the live lookup',async t=>{
 const f=await fixture(t);const pending=[];
 f.load((signal,id)=>id===B?new Promise((resolve,reject)=>pending.push({signal,resolve,reject})):Promise.resolve({accounts:f.accounts,models:[{id:ma}]}));
 await f.send({type:'selectAccount',selection:B,...f.form});await f.send({type:'ready'});await f.send({type:'ready'});assert.equal(pending.length,1);
 await f.send({type:'selectAccount',selection:'@current',...f.form});assert.equal(f.latest().accountStatus,'');
 await f.send({type:'selectAccount',selection:B,...f.form});assert.equal(pending.length,2);assert.equal(pending[0].signal.aborted,true);
 pending[0].reject(Error('IMAGE_SAVED_MODELS_FORBIDDEN'));await tick();assert.equal(f.latest().choicesLoading,true);assert.doesNotMatch(f.latest().accountStatus,/FORBIDDEN/);
 pending[1].resolve({accounts:f.accounts,models:[{id:mb,label:'latest B'}],readiness:'ready'});await tick();await tick();
 assert.equal(f.latest().choicesLoading,false);assert.equal(f.latest().draft.accountId,B);assert.equal(f.latest().accountBlocked,false);assert.equal(f.latest().choices.models[0].label,'latest B');
});
test('denied target models finish loading with an actionable failure and retry stays on B',async t=>{
 const f=await fixture(t);f.load(async()=>{throw Error('IMAGE_SAVED_MODELS_FORBIDDEN')});
 await f.send({type:'selectAccount',selection:B,...f.form});assert.equal(f.latest().choicesLoading,false);assert.equal(f.latest().accountBlocked,true);assert.equal(f.latest().canCheckAccount,true);assert.match(f.latest().accountStatus,/IMAGE_SAVED_MODELS_FORBIDDEN/);assert.equal(f.latest().choices.models.length,0);
 f.load(async()=>({accounts:f.accounts,models:[{id:mb,label:'B'}],readiness:'ready'}));await f.send({type:'checkAccount'});
 assert.equal(f.latest().draft.accountId,B);assert.equal(f.latest().accountBlocked,false);assert.doesNotMatch(f.latest().accountStatus,/正在读取|FORBIDDEN/);assert.equal(f.runs.length,0);
});
test('command cancellation finishes metadata loading and a late result cannot enable generation',async t=>{
 const f=await fixture(t);let resolve;
 f.load(()=>new Promise(r=>resolve=r));await f.send({type:'selectAccount',selection:B,...f.form});f.cancel();
 assert.equal(f.latest().choicesLoading,false);assert.equal(f.latest().accountBlocked,true);assert.equal(f.latest().canCheckAccount,true);assert.match(f.latest().accountStatus,/IMAGE_ACCOUNT_CHECK_CANCELLED/);
 resolve({accounts:f.accounts,models:[{id:mb}]});await tick();assert.equal(f.latest().choices.models.length,0);assert.equal(f.latest().draft.prompt,f.form.prompt);assert.equal(f.runs.length,0);
});
test('duplicate selection coalesces the active check and cancelling never schedules a background retry',async t=>{
 const f=await fixture(t);let calls=0;
 f.load(()=>{calls++;return new Promise(()=>{})});
 await f.send({type:'selectAccount',selection:B,...f.form});
 await f.send({type:'selectAccount',selection:B,...f.form});await f.send({type:'ready'});assert.equal(calls,1);
 f.cancel();await f.send({type:'ready'});f.ui.accountStateChanged({pending:false,email:'a@example.test',accountIds:[A]});
 f.close();await f.open();assert.equal(calls,1);assert.match(f.latest().accountStatus,/CHECK_CANCELLED/);assert.equal(f.latest().canCheckAccount,true);
 f.load(async()=>({accounts:f.accounts,models:[{id:mb}],readiness:'ready'}));await f.send({type:'checkAccount'});
 assert.equal(f.latest().accountBlocked,false);assert.equal(f.prompts.length,0);assert.equal(f.runs.length,0);
});
test('failed automatic check stays on the selected account without ready/focus retries or login prompts',async t=>{
 const f=await fixture(t);let calls=0;
 f.load(async()=>{calls++;return{accounts:f.accounts,models:[],readiness:'error',accountMessage:'IMAGE_SAVED_AUTH_REQUIRED'}});
 await f.send({type:'selectAccount',selection:B,...f.form});
 for(let i=0;i<3;i++){await f.send({type:'ready'});f.ui.accountStateChanged({pending:false,email:'a@example.test',accountIds:[A]})}
 assert.equal(calls,1);assert.equal(f.latest().draft.accountId,B);assert.equal(f.latest().accountBlocked,true);assert.match(f.latest().accountStatus,/AUTH_REQUIRED/);
 assert.equal(f.prompts.length,0);assert.equal(f.runs.length,0);
});
test('selected account replacement or host disable aborts a lookup and cannot silently renew selection',async t=>{
 for(const change of [a=>{a.expectedEmail='replacement@example.test'},a=>{a.hostCurrent=false},a=>{a.migrationState='pending'}]){
  const f=await fixture(t);let resolve,signal;
  f.load(s=>{signal=s;return new Promise(r=>resolve=r)});await f.send({type:'selectAccount',selection:B,...f.form});
  change(f.accounts[1]);f.ui.accountStateChanged({pending:false,email:'a@example.test',accountIds:[A]});
  assert.equal(signal.aborted,true);assert.equal(f.latest().accountBlocked,true);assert.match(f.latest().accountStatus,/SELECTION_REQUIRED/);
  assert.equal(f.latest().choices.accounts.find(a=>a.id===B).unavailable,f.accounts[1].hostCurrent===false||f.accounts[1].migrationState==='pending');
  const reads=f.reads.length;await f.send({type:'ready'});assert.equal(f.reads.length,reads);
  resolve({accounts:f.accounts,models:[{id:mb}],readiness:'ready'});await tick();assert.equal(f.latest().choices.models.length,0);
  await f.send({type:'checkAccount'});assert.equal(f.latest().accountBlocked,true);assert.equal(f.prompts.length,0);assert.equal(f.runs.length,0);
 }
});
test('opening the retained panel restores explicit selection without a new purpose prompt',async t=>{
 const f=await fixture(t);await f.send({type:'selectAccount',selection:B,...f.form});f.close();await f.open();
 assert.equal(f.latest().draft.accountId,B);assert.equal(f.latest().draft.followCurrent,false);assert.equal(f.latest().choices.models[0].id,mb);
 assert.equal(f.reads.at(-1).force,false);assert.equal(f.latest().draft.prompt,f.form.prompt);assert.equal(f.prompts.length,0);assert.equal(f.runs.length,0);
});


test('healthy current refresh remains visible, collapses repeated clicks and drops a closed-panel reply',async t=>{
 const f=await fixture(t);await f.send({...f.form,type:'draft'});assert.equal(f.latest().canCheckAccount,true);let reply;const before=f.reads.length;
 f.load(()=>new Promise(r=>reply=r));await f.send({type:'checkAccount'});assert.equal(f.latest().choicesLoading,true);assert.equal(f.latest().canCheckAccount,true);
 await f.send({type:'checkAccount'});assert.equal(f.reads.length,before+1);const oldReply=reply;f.close();f.load(async()=>({accounts:f.accounts,models:[{id:ma,label:'reopened'}]}));await f.open();
 oldReply({accounts:f.accounts,models:[{id:mb,label:'late'}]});await tick();assert.equal(f.latest().choices.models[0].label,'reopened');assert.equal(f.latest().draft.prompt,f.form.prompt);assert.equal(f.latest().draft.ratio,'16:9');assert.equal(f.latest().draft.size,'4K');assert.equal(f.prompts.length,0);assert.equal(f.runs.length,0);
});
test('late refresh from an old endpoint fails closed and offers a manual recheck',async t=>{
 const f=await fixture(t);let reply;f.load(()=>new Promise(r=>reply=r));await f.send({type:'checkAccount'});f.setEndpoint('production');reply({accounts:f.accounts,models:[{id:ma,label:'old endpoint'}]});await tick();await tick();
 assert.equal(f.latest().accountBlocked,true);assert.equal(f.latest().choices.models.length,0);assert.match(f.latest().accountStatus,/ENDPOINT_CHANGED/);assert.equal(f.latest().canCheckAccount,true);assert.equal(f.runs.length,0);
});

test('image page quota query uses selected B inline, with no confirmation, image call or file opening',async t=>{
 const f=await fixture(t);await f.send({type:'selectAccount',selection:B,...f.form});await f.send({type:'queryQuota'});
 assert.equal(f.quotaReads.length,1);assert.equal(f.quotaReads[0].id,B);assert.equal(f.quotaReads[0].modelId,mb);assert.equal(f.quotaReads[0].selection,B);
 assert.equal(f.latest().imageQuota.snapshot.accountId,B);assert.equal(f.latest().imageQuota.snapshot.remainingFraction,.3);assert.equal(f.latest().imageQuota.stale,false);
 assert.equal(f.prompts.length,0);assert.equal(f.runs.length,0);
 f.quotaLoad(async()=>{throw Error('IMAGE_SAVED_MODELS_FORBIDDEN')});await f.send({type:'queryQuota'});
 assert.equal(f.latest().imageQuota.stale,true);assert.ok(f.latest().imageQuota.error);assert.equal(f.latest().imageQuota.snapshot.remainingFraction,.3);
});
test('image page discards quota when model or endpoint changes during a request',async t=>{
 const f=await fixture(t);let reply;f.quotaLoad((id,modelId)=>new Promise(resolve=>reply=()=>resolve({accountId:id,modelId,endpoint:'daily',remainingFraction:.9,resetAt:null,queriedAt:'2026-10-07T08:00:00Z'})));
 await f.send({type:'queryQuota'});assert.equal(f.latest().imageQuota.loading,true);await f.send({...f.form,type:'draft',modelId:'new-model'});reply();await tick();await tick();
 assert.equal(f.latest().imageQuota.snapshot,undefined);assert.equal(f.latest().imageQuota.loading,false);
 await f.send({...f.form,type:'draft'});await f.send({type:'queryQuota'});f.setEndpoint('production');reply();await tick();await tick();assert.equal(f.latest().imageQuota.snapshot,undefined);
});
test('image page retires a late quota on account switch and close',async t=>{
 const f=await fixture(t);let reply;f.quotaLoad((id,modelId)=>new Promise(resolve=>reply=()=>resolve({accountId:id,modelId,endpoint:'daily',remainingFraction:.9,resetAt:null,queriedAt:'2026-10-07T08:00:00Z'})));
 await f.send({type:'queryQuota'});await f.send({type:'selectAccount',selection:B,...f.form});reply();await tick();assert.equal(f.latest().imageQuota.snapshot,undefined);
 await f.send({type:'queryQuota'});f.close();reply();await tick();await f.open();assert.equal(f.latest().imageQuota.snapshot,undefined);assert.equal(f.runs.length,0);
});


test('reload startup retries an unready Hub with a bounded budget and preserves the draft',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=await fixture(t,{startupFailures:2});
 assert.equal(f.latest().accountBlocked,true);assert.match(f.latest().accountStatus,/自动重新检查/);
 t.mock.timers.tick(500);await tick();await tick();assert.equal(f.reads.length,2);
 t.mock.timers.tick(1500);await tick();await tick();assert.equal(f.reads.length,3);assert.equal(f.latest().accountBlocked,false);
 t.mock.timers.tick(60000);await tick();assert.equal(f.reads.length,3);assert.equal(f.runs.length,0);f.close();
});
test('startup recovery stops after five retries and explicit retry starts a fresh check',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=await fixture(t,{startupFailures:99});
 for(const delay of [500,1500,3000,5000,8000]){t.mock.timers.tick(delay);await tick();await tick()}
 assert.equal(f.reads.length,6);assert.match(f.latest().accountStatus,/稍后重新检查/);
 t.mock.timers.tick(120000);await tick();await f.send({type:'ready'});assert.equal(f.reads.length,6);
 f.setStartupFailures(0);await f.send({type:'checkAccount'});assert.equal(f.reads.at(-1).force,true);assert.equal(f.latest().accountBlocked,false);f.close();
});
test('cancel and panel disposal retire scheduled startup recovery',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=await fixture(t,{startupFailures:99});f.cancel();
 t.mock.timers.tick(60000);await tick();await f.send({type:'ready'});assert.equal(f.reads.length,1);
 f.close();t.mock.timers.tick(60000);await tick();assert.equal(f.reads.length,1);
});
test('a restored saved account waits for storage and resumes only its original fingerprint',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=await fixture(t,{ready:false,restore:true});
 assert.equal(f.latest().draft.accountId,B);assert.equal(f.latest().draft.modelId,mb);assert.equal(f.selections.size,0);
 f.setReady(true);f.ui.accountStateChanged({pending:false,email:'a@example.test',accountIds:[A]});await tick();await tick();
 assert.equal(f.latest().accountBlocked,false);assert.equal(f.latest().draft.accountId,B);assert.equal(f.latest().draft.modelId,mb);assert.equal(f.selections.size,1);
 t.mock.timers.tick(60000);await tick();assert.equal(f.runs.length,0);f.close();
});
test('startup cannot silently renew a restored saved selection after replacement',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=await fixture(t,{ready:false,restore:true});
 f.accounts[1].capturedAt='replacement';f.setReady(true);f.ui.accountStateChanged({pending:false,email:'a@example.test',accountIds:[A]});await tick();await tick();
 assert.equal(f.latest().accountBlocked,true);assert.equal(f.selections.size,0);assert.match(f.latest().accountStatus,/IMAGE_SAVED_SELECTION_REQUIRED/);f.close();
});
test('successful image generation freshly queries the same saved account and retains actual server 1.0',async t=>{
 const f=await fixture(t);await f.send({type:'selectAccount',selection:B,...f.form});await f.send({type:'queryQuota'});
 f.quotaLoad(async(id,modelId)=>({accountId:id,modelId,endpoint:'daily',remainingFraction:1,resetAt:null,queriedAt:'2026-10-07T10:30:07Z'}));
 await f.send({type:'generate',...f.form,modelId:mb});assert.equal(f.latest().imageQuota.stale,true);await f.decide('确认生成');
 await f.finish({images:[{file:'/synthetic/result.png',width:1,height:1}],batch:{outcome:'complete'}});await tick();await tick();
 assert.equal(f.quotaReads.length,2);assert.equal(f.quotaReads[1].id,B);assert.equal(f.quotaReads[1].selection,B);assert.equal(f.quotaReads[1].modelId,mb);assert.equal(f.latest().imageQuota.stale,false);assert.equal(f.latest().imageQuota.snapshot.remainingFraction,1);f.close();
});
test('cancelled or failed image attempts do not issue a post-generation quota query',async t=>{
 const f=await fixture(t);await f.send({type:'generate',...f.form});await f.decide(undefined);assert.equal(f.quotaReads.length,0);
 await f.send({type:'generate',...f.form});await f.decide('确认生成');await f.finish(Error('IMAGE_DIRECT_RESOURCE_EXHAUSTED'));assert.equal(f.quotaReads.length,0);f.close();
});
test('a changed endpoint suppresses the completed batch quota query',async t=>{
 const f=await fixture(t);await f.send({type:'generate',...f.form});await f.decide('确认生成');f.setEndpoint('production');
 await f.finish({images:[{file:'/synthetic/result.png',width:1,height:1}],batch:{outcome:'complete'}});assert.equal(f.quotaReads.length,0);f.close();
});


test('a manual quota click coalesces with the one automatic query after successful generation',async t=>{
 const f=await fixture(t);let resolve;f.quotaLoad((id,modelId)=>new Promise(r=>resolve=()=>r({accountId:id,modelId,endpoint:'daily',remainingFraction:.8,resetAt:null,queriedAt:'2026-10-07T10:30:07Z'})));
 await f.send({type:'generate',...f.form});await f.decide('确认生成');await f.finish({images:[{file:'/synthetic/result.png',width:1,height:1}],batch:{outcome:'complete'}});
 assert.equal(f.latest().imageQuota.loading,true);await f.send({type:'queryQuota'});assert.equal(f.quotaReads.length,1);
 resolve();await tick();await tick();assert.equal(f.latest().imageQuota.snapshot.remainingFraction,.8);f.close();
});
test('a quota request from before generation cannot replace the fresh post-generation response',async t=>{
 const f=await fixture(t);let old;f.quotaLoad((id,modelId)=>new Promise(r=>old=()=>r({accountId:id,modelId,endpoint:'daily',remainingFraction:1,resetAt:null,queriedAt:'2026-10-07T10:29:00Z'})));
 await f.send({type:'queryQuota'});await f.send({type:'generate',...f.form});assert.equal(f.quotaReads[0].signal.aborted,true);await f.decide('确认生成');
 f.quotaLoad(async(id,modelId)=>({accountId:id,modelId,endpoint:'daily',remainingFraction:.7,resetAt:null,queriedAt:'2026-10-07T10:30:07Z'}));
 await f.finish({images:[{file:'/synthetic/result.png',width:1,height:1}],batch:{outcome:'complete'}});old();await tick();await tick();
 assert.equal(f.quotaReads.length,2);assert.equal(f.latest().imageQuota.snapshot.remainingFraction,.7);assert.equal(f.latest().imageQuota.stale,false);f.close();
});


test('extension disposal suppresses late startup metadata and queued recovery',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=await fixture(t);let finish;
 f.load(()=>new Promise(r=>finish=r));await f.send({type:'checkAccount'});const count=f.states.length;f.dispose();
 finish({accounts:f.accounts,models:[{id:ma}],readiness:'ready'});await tick();await tick();
 f.ui.accountStateChanged({pending:false,email:'a@example.test',accountIds:[A]});t.mock.timers.tick(60000);await tick();
 assert.equal(f.states.length,count);assert.equal(f.runs.length,0);
});


test('image account options label official current A while B is independently selected',async t=>{
 const f=await fixture(t);f.ui.accountStateChanged({pending:false,email:'a@example.test',accountIds:[A]});await tick();await tick();
 await f.send({type:'selectAccount',selection:B,...f.form});
 assert.equal(f.latest().draft.accountId,B);assert.equal(f.latest().choices.accounts.find(a=>a.id===A).label,'A（当前登录）');assert.equal(f.latest().choices.accounts.find(a=>a.id===B).label,'B');
 f.ui.accountStateChanged({pending:false,email:'',accountIds:[]});assert.ok(f.latest().choices.accounts.every(a=>!a.label.includes('（当前登录）')));
 f.accounts[0].active=false;f.accounts[1].active=true;f.ui.accountStateChanged({pending:false,email:'b@example.test',accountIds:[B]});
 assert.equal(f.latest().choices.accounts.find(a=>a.id===B).label,'B（当前登录）');assert.equal(f.latest().choices.accounts.find(a=>a.id===A).label,'A');
 f.accounts.push({...f.accounts[1],id:'duplicate'});f.ui.accountStateChanged({pending:false,email:'b@example.test',accountIds:[B]});assert.ok(f.latest().choices.accounts.every(a=>!a.label.includes('（当前登录）')));f.close();
});
test('known temporary saved model failures recover on B with bounded retries and no generation',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=await fixture(t);let checks=0;
 f.load(async(_signal,id)=>{checks++;assert.equal(id,B);return checks<3?{accounts:f.accounts,models:[],readiness:'error',accountMessage:'IMAGE_SAVED_MODELS_TRANSIENT'}:{accounts:f.accounts,models:[{id:mb}],readiness:'ready'}});
 await f.send({type:'selectAccount',selection:B,...f.form});assert.equal(f.latest().accountRetryPending,true);assert.match(f.latest().accountStatus,/自动重新检查此账号/);
 for(const delay of [500,1500]){t.mock.timers.tick(delay);await tick();await tick()}
 assert.equal(checks,3);assert.equal(f.latest().accountBlocked,false);assert.equal(f.latest().draft.accountId,B);assert.equal(f.prompts.length,0);assert.equal(f.runs.length,0);f.close();
});
test('permanent or unclassified saved model failures do not enter startup recovery',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=await fixture(t);
 for(const code of ['IMAGE_SAVED_AUTH_REQUIRED','IMAGE_SAVED_MODELS_FORBIDDEN','IMAGE_SAVED_MODELS_INVALID','IMAGE_SAVED_MODELS_FAILED','IMAGE_SAVED_MODELS_UNAVAILABLE']){
  f.load(async()=>({accounts:f.accounts,models:[],readiness:'error',accountMessage:code}));await f.send({type:'selectAccount',selection:B,...f.form});const reads=f.reads.length;
  assert.equal(f.latest().accountRetryPending,false);t.mock.timers.tick(60000);await tick();assert.equal(f.reads.length,reads);assert.equal(f.latest().accountBlocked,true);
 }
 f.close();
});
