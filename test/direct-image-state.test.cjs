const test=require('node:test');
const assert=require('node:assert/strict');
const Module=require('node:module');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const accountId='00000000-0000-4000-8000-000000000001', modelId='gemini-3.1-flash-image';
const choices={accounts:[{id:accountId,label:'synthetic',expectedEmail:'a@example.test',active:true}],models:[{id:modelId,label:modelId}]};
const tick=()=>new Promise(setImmediate);
async function fixture(t, storage = new Map(), options = {}) {
 const output=await fs.mkdtemp(path.join(os.tmpdir(),'agm-image-state-'));t.after(()=>fs.rm(output,{recursive:true,force:true}));
 const commands=new Map(),states=[],panels=[];let decide,lateChoice,reading=0,runs=[],finishRun,currentChoices=choices;
 const direct={getEndpoint:()=> 'production',readChoices:async()=>{reading++;if(lateChoice)return lateChoice;return currentChoices;},
  run:async(request,signal,_progress,id)=>{runs.push({request,signal,id,progress:_progress});const result=await new Promise(resolve=>{finishRun=resolve;});if(result instanceof Error)throw result;return result||{images:[],batch:{outcome:'complete'}};}};
 const uri=file=>({scheme:'file',authority:'',fsPath:file,path:file});
 const vscode={ViewColumn:{Active:1},env:{},workspace:{workspaceFolders:options.noWorkspace?[]:[{uri:uri(output)}]},
  commands:{registerCommand:(id,fn)=>{commands.set(id,fn);return{dispose(){}};}},window:{showWarningMessage:()=>new Promise(resolve=>{decide=resolve;}),
   createWebviewPanel:()=>{const panel={webview:{postMessage:async state=>states.push(structuredClone(state)),onDidReceiveMessage:fn=>{panel.receive=fn;return{dispose(){}};}},onDidDispose:fn=>{panel.close=fn;return{dispose(){}};},reveal(){}};panels.push(panel);return panel;}}};
 const entry=require.resolve('../out/direct-image-ui'),original=Module._load;Module._load=function(name,...args){return name==='vscode'?vscode:original.call(this,name,...args);};
 let controller;try{delete require.cache[entry];controller=require(entry).registerDirectImageUi({subscriptions:[],globalState:{get:key=>storage.get(key),update:async(key,value)=>storage.set(key,value)}},direct,undefined,require('./helpers/image-session.cjs').memorySession());}finally{Module._load=original;}
 const open=()=>commands.get('antigravityAccounts.images.open')();await open();
 const send=async(value,panel=panels.at(-1))=>{panel.receive(value);await tick();};
 const generate={type:'generate',prompt:'approved synthetic prompt',accountId,modelId,ratio:'1:1',size:'1K',quality:'detail',count:1};
 return{controller,states,panels,runs,setChoices:value=>{currentChoices=value;},open,send,generate,decide:(answer='确认生成')=>decide(answer),finish:value=>finishRun(value),reading:()=>reading,
  deferChoices:()=>{let resolve;lateChoice=new Promise(r=>{resolve=r;});return value=>{lateChoice=undefined;resolve(value);};}};
}
test('late model refresh and ready/draft messages cannot change the already confirmed request',async t=>{
 const f=await fixture(t),resolve=f.deferChoices();await f.send({type:'ready'});
 await f.send(f.generate);const reads=f.reading();await f.send({type:'ready'});await f.send({...f.generate,type:'draft',prompt:'UNAPPROVED_REPLACEMENT',ratio:'16:9'});
 resolve({accounts:[{id:'other',active:true}],models:[{id:'other-image'}]});await tick();assert.equal(f.reading(),reads);
 f.decide();await tick();assert.equal(f.runs.length,1);assert.equal(f.runs[0].request.prompt,f.generate.prompt);assert.equal(f.runs[0].request.accountId,accountId);assert.equal(f.runs[0].request.aspectRatio,'1:1');
 f.finish();await tick();await tick();assert.equal(f.states.at(-1).busy,false);
});

test('layout preferences survive panel and host recreation without touching tasks, choices or drafts',async t=>{
 const storage=new Map(),f=await fixture(t,storage),reads=f.reading();
 await f.send({...f.generate,type:'draft'});
 await f.send({type:'layout',resultsShare:.31,resultsCollapsed:true,prompt:'must not persist',accountId:'ignored'});
 assert.deepEqual(storage.get('images.layout.v1'),{resultsShare:.31,resultsCollapsed:true});
 assert.equal(f.reading(),reads);assert.equal(f.runs.length,0);
 f.panels.at(-1).close();await f.open();
 assert.match(f.panels.at(-1).webview.html,/const layoutInitial=\{"resultsShare":0.31,"resultsCollapsed":true\}/);
 assert.equal(f.states.at(-1).draft.prompt,f.generate.prompt);
 const recreated=await fixture(t,storage);
 assert.match(recreated.panels.at(-1).webview.html,/const layoutInitial=\{"resultsShare":0.31,"resultsCollapsed":true\}/);
});

test('invalid layout input is ignored; ranges are bounded and disposed panels cannot overwrite it',async t=>{
 const storage=new Map(),f=await fixture(t,storage);
 for(const resultsShare of [NaN,Infinity,'0.4',{},null])await f.send({type:'layout',resultsShare,resultsCollapsed:false});
 await f.send({type:'layout',resultsShare:.4,resultsCollapsed:'true'});
 assert.equal(storage.has('images.layout.v1'),false);
 await f.send({type:'layout',resultsShare:99,resultsCollapsed:false});
 assert.deepEqual(storage.get('images.layout.v1'),{resultsShare:.6,resultsCollapsed:false});
 const old=f.panels.at(-1);old.close();await f.open();
 await f.send({type:'layout',resultsShare:.2,resultsCollapsed:true},old);
 assert.deepEqual(storage.get('images.layout.v1'),{resultsShare:.6,resultsCollapsed:false});
 assert.equal(f.runs.length,0);
});

test('layout storage failure leaves image state intact and subsequent saves recover',async t=>{
 const storage=new Map(),f=await fixture(t,storage);let fail=true;
 storage.set=(key,value)=>{if(fail)throw Error('synthetic storage unavailable');return Map.prototype.set.call(storage,key,value)};
 const before=f.controller.getStatus();await f.send({type:'layout',resultsShare:.3,resultsCollapsed:true});
 assert.deepEqual(f.states.at(-1),{type:'layoutPersistenceError'});assert.equal(f.controller.getStatus(),before);
 fail=false;await f.send({type:'layout',resultsShare:.45,resultsCollapsed:false});
 assert.deepEqual(storage.get('images.layout.v1'),{resultsShare:.45,resultsCollapsed:false});assert.equal(f.runs.length,0);
});
test('a disposed panel cannot submit its pending consent into a reopened panel',async t=>{
 const f=await fixture(t);await f.send(f.generate);const old=f.panels[0];old.close();await f.open();f.decide();await tick();await tick();
 assert.equal(f.runs.length,0);await f.send(f.generate,old);assert.equal(f.runs.length,0);assert.equal(f.states.at(-1).busy,false);
});
test('account changes invalidate late choices while preserving user prompt, directory and dimensions',async t=>{
 const f=await fixture(t);await f.send({...f.generate,type:'draft'});const before=f.states.at(-1).outputDirectory;
 const resolve=f.deferChoices();await f.send({type:'ready'});f.controller.accountStateChanged({pending:true,email:'',accountIds:[]});resolve(choices);await tick();
 assert.deepEqual(f.states.at(-1).choices.accounts,[]);assert.equal(f.states.at(-1).draft.prompt,f.generate.prompt);assert.equal(f.states.at(-1).outputDirectory,before);
 await f.send(f.generate);assert.equal(f.runs.length,0);assert.match(f.states.at(-1).status,/IMAGE_ACCOUNT_RECOVERY_PENDING/);
 f.controller.accountStateChanged({pending:false,email:'a@example.test',accountIds:[accountId]});await tick();assert.equal(f.states.at(-1).draft.accountId,accountId);assert.equal(f.states.at(-1).draft.size,'1K');
});

test('same-account focus, quota and token refresh do not clear choices or the successful image result',async t=>{
 const f=await fixture(t),state={pending:false,email:'a@example.test',accountIds:[accountId]};
 f.controller.accountStateChanged(state);await tick();await f.send(f.generate);f.decide();await tick();f.finish();await tick();await tick();
 const success=f.states.at(-1).status,reads=f.reading();assert.match(success,/已保存/);
 for(let n=0;n<3;n++)f.controller.accountStateChanged({...state,email:'A@example.test'});
 await tick();assert.equal(f.reading(),reads);assert.equal(f.states.at(-1).status,success);assert.equal(f.states.at(-1).draft.accountId,accountId);assert.equal(f.states.at(-1).accountStatus,'');
});

test('unknown then same identity is not a switch, but a verified different identity is',async t=>{
 const f=await fixture(t),a={pending:false,email:'a@example.test',accountIds:[accountId]};
 f.controller.accountStateChanged(a);await tick();await f.send({...f.generate,type:'draft'});
 f.controller.accountStateChanged({pending:false,email:'',accountIds:[]});
 assert.match(f.states.at(-1).accountStatus,/尚未核验/);assert.doesNotMatch(f.states.at(-1).accountStatus,/已变化/);
 f.controller.accountStateChanged(a);await tick();assert.equal(f.states.at(-1).accountStatus,'');assert.equal(f.states.at(-1).draft.prompt,f.generate.prompt);
 const b={accounts:[{id:'b',expectedEmail:'b@example.test',label:'B',active:true}],models:choices.models};f.setChoices(b);
 f.controller.accountStateChanged({pending:false,email:'b@example.test',accountIds:['b']});await tick();
 assert.match(f.states.at(-1).accountStatus,/当前账号已变化/);assert.equal(f.states.at(-1).draft.accountId,'b');
});

test('consecutive creations retain their own prompt, parameters and images across reopening',async t=>{
 const f=await fixture(t);
 for(const [index,prompt] of ['first synthetic scene','second synthetic scene'].entries()){
  await f.send({...f.generate,prompt,ratio:index?'16:9':'1:1'});f.decide();await tick();
  f.finish({images:[{file:path.join(f.states.at(-1).outputDirectory,`result-${index}.png`),width:1024,height:1024}],batch:{outcome:'complete'}});await tick();await tick();
 }
 const tasks=f.states.at(-1).tasks;assert.equal(tasks.length,2);assert.notEqual(tasks[0].id,tasks[1].id);
 assert.deepEqual(tasks.map(x=>x.promptSummary),['first synthetic scene','second synthetic scene']);assert.deepEqual(tasks.map(x=>x.ratio),['1:1','16:9']);
 assert.deepEqual(tasks.map(x=>x.images[0].name),['result-0.png','result-1.png']);assert.deepEqual(tasks.map(x=>x.id),f.runs.map(x=>x.id));
 f.runs[0].progress({phase:'generating',message:'late stale callback'});assert.deepEqual(f.states.at(-1).tasks,tasks);
 f.panels.at(-1).close();await f.open();assert.deepEqual(f.states.at(-1).tasks,tasks);assert.equal(f.states.at(-1).draft.prompt,'second synthetic scene');
});

test('failed and cancelled creations stay separate and cannot discard a preceding success',async t=>{
 const f=await fixture(t);await f.send(f.generate);f.decide();await tick();f.finish();await tick();await tick();
 await f.send({...f.generate,prompt:'failed scene'});f.decide();await tick();f.finish(Error('IMAGE_DIRECT_RESOURCE_EXHAUSTED'));await tick();await tick();
 await f.send({...f.generate,prompt:'cancelled scene'});f.decide('cancel');await tick();await tick();
 assert.equal(f.runs.length,2);assert.deepEqual(f.states.at(-1).tasks.map(x=>x.phase),['complete','failed','cancelled']);
 assert.match(f.states.at(-1).tasks[1].status,/资源|RESOURCE/);assert.match(f.states.at(-1).tasks[2].status,/未提交/);
});

test('closing an in-flight panel keeps its late result bound to the old task and serializes the next run',async t=>{
 const f=await fixture(t);await f.send(f.generate);f.decide();await tick();const firstId=f.runs[0].id;
 f.panels.at(-1).close();assert.equal(f.runs[0].signal.aborted,true);await f.open();await f.send({...f.generate,prompt:'must not start while previous run settles'});assert.equal(f.runs.length,1);
 f.finish({images:[{file:path.join(f.states.at(-1).outputDirectory,'committed-before-cancel.png'),width:32,height:32}],batch:{outcome:'complete'}});await tick();await tick();
 await f.send({...f.generate,prompt:'next scene'});f.decide();await tick();assert.equal(f.runs.length,2);f.finish(Error('IMAGE_CANCELLED'));await tick();await tick();
 const tasks=f.states.at(-1).tasks;assert.equal(tasks[0].id,firstId);assert.equal(tasks[0].images[0].name,'committed-before-cancel.png');assert.equal(tasks[1].images.length,0);assert.equal(tasks[1].phase,'cancelled');
});

test('stale draft revisions cannot replace newer text or change the confirmed request',async t=>{
 const f=await fixture(t);
 await f.send({...f.generate,type:'draft',prompt:'ABC',draftRevision:3});
 await f.send({...f.generate,type:'draft',prompt:'A',draftRevision:1});
 assert.equal(f.states.at(-1).draft.prompt,'ABC');
 assert.equal(f.states.at(-1).draftRevision,3);
 await f.send({...f.generate,prompt:'ABC',draftRevision:3});f.decide();await tick();
 assert.equal(f.runs[0].request.prompt,'ABC');f.finish();await tick();await tick();
 f.panels.at(-1).close();await f.open();
 await f.send({...f.generate,type:'draft',prompt:'fresh reopened edit',draftRevision:1});
 assert.equal(f.states.at(-1).draft.prompt,'fresh reopened edit');assert.equal(f.states.at(-1).draftRevision,1);
});

test('missing description and save location give distinct actionable errors before confirmation or send',async t=>{
 const blank=await fixture(t);await blank.send({...blank.generate,prompt:''});
 assert.match(blank.states.at(-1).status,/画面描述/);assert.equal(blank.runs.length,0);assert.equal(blank.states.at(-1).tasks.length,0);
 const noWorkspace=await fixture(t,new Map(),{noWorkspace:true});await noWorkspace.send(noWorkspace.generate);
 assert.match(noWorkspace.states.at(-1).status,/选择保存位置/);assert.equal(noWorkspace.runs.length,0);assert.equal(noWorkspace.states.at(-1).tasks.length,0);
});

test('sent request cancellation explains unknown server outcome and already loaded image errors relocalize',async t=>{
 const {setLanguage}=require('../out/i18n');const f=await fixture(t);
 await f.send(f.generate);f.decide();await tick();await f.send({type:'cancel'});
 f.finish(Object.assign(Error('IMAGE_DIRECT_OUTCOME_UNKNOWN'),{modelSource:'saved-account',projectSource:'saved-token'}));await tick();await tick();
 assert.match(f.states.at(-1).status,/服务端结果未知/);assert.match(f.states.at(-1).status,/消耗额度/);assert.equal(f.states.at(-1).busy,false);
 try{setLanguage('en');const translated=f.states.at(-1);assert.match(translated.status,/server outcome/i);assert.doesNotMatch(translated.status,/[\u3400-\u9fff]/u);assert.doesNotMatch(translated.tasks[0].status,/[\u3400-\u9fff]/u);
  f.setChoices({accounts:choices.accounts,models:[],readiness:'error',accountMessage:'IMAGE_SAVED_MODELS_FORBIDDEN'});setLanguage('zh-CN');await f.send({type:'checkAccount'});
  assert.match(f.states.at(-1).accountStatus,/Google 拒绝/);setLanguage('en');assert.match(f.states.at(-1).accountStatus,/Google denied/);assert.doesNotMatch(f.states.at(-1).accountStatus,/[\u3400-\u9fff]/u);
 }finally{setLanguage('zh-CN');f.panels.at(-1).close();await f.controller.flush()}
});

test('existing composite account errors switch to English without translating account labels or IDs',async t=>{
 const {setLanguage}=require('../out/i18n');const f=await fixture(t);
 f.setChoices({accounts:choices.accounts,models:[],readiness:'error',accountMessage:'IMAGE_SAVED_MODELS_FORBIDDEN'});await f.send({type:'checkAccount'});
 assert.match(f.states.at(-1).accountStatus,/Google 拒绝/);
 try{setLanguage('en');assert.doesNotMatch(f.states.at(-1).accountStatus,/[\u3400-\u9fff]/u);assert.match(f.states.at(-1).accountStatus,/Google denied/);assert.equal(f.states.at(-1).choices.accounts[0].id,accountId);
 }finally{setLanguage('zh-CN');f.panels.at(-1).close();await f.controller.flush()}
});

test('production webview preserves unfocused new edits and submits the complete prompt despite queued echoes',()=>{
 const f=require('./helpers/image-webview.cjs').imageWebview();
 const state={type:'state',busy:false,draftRevision:0,draftEpoch:0,actionRevision:0,status:'ready',references:[],choices,outputDirectory:'/synthetic/output',tasks:[],draft:{prompt:'',accountId,modelId,ratio:'1:1',count:1,size:'auto',quality:'auto',followCurrent:true}};
 f.message(state);assert.equal(f.el('generate').disabled,true);assert.match(f.el('formHint').textContent,/画面描述/);
 f.el('prompt').focus();for(const prompt of ['A','AB','ABC']){f.el('prompt').value=prompt;f.el('prompt').dispatch('input')}
 f.el('count').focus();f.message({...state,draftRevision:1,draft:{...state.draft,prompt:'A'}});
 assert.equal(f.el('prompt').value,'ABC');assert.equal(f.el('generate').disabled,false);
 f.el('generate').click();assert.equal(f.sent.at(-1).prompt,'ABC');assert.equal(f.sent.at(-1).draftRevision,3);
 // A queued idle echo must not unlock a just-submitted action.
 f.message({...state,draftRevision:3,draft:{...state.draft,prompt:'ABC'}});assert.equal(f.el('generate').disabled,true);const count=f.sent.length;f.el('generate').click();assert.equal(f.sent.length,count);
 f.message({...state,draftRevision:3,actionRevision:1,draft:{...state.draft,prompt:'ABC'}});assert.equal(f.el('generate').disabled,false);
 // Explicitly loading a saved draft remains authoritative, including when the old textarea is focused.
 f.el('prompt').focus();f.message({...state,draftEpoch:1,draftRevision:3,actionRevision:1,draft:{...state.draft,prompt:'saved draft'}});assert.equal(f.el('prompt').value,'saved draft');
 f.message({...state,draftRevision:3,actionRevision:1,draft:{...state.draft,prompt:'late old draft'}});assert.equal(f.el('prompt').value,'saved draft');
 // A previous account's idle echo cannot enable generation during a new selection.
 f.el('account').value='saved-B';f.el('account').dispatch('change');assert.equal(f.el('generate').disabled,true);
 f.message({...state,draftEpoch:1,draftRevision:3,actionRevision:1,draft:{...state.draft,prompt:'saved draft'}});assert.equal(f.el('generate').disabled,true);assert.equal(f.el('account').value,'saved-B');
});

test('production webview guides missing save location and labels a stopped sent request as outcome unconfirmed',()=>{
 const f=require('./helpers/image-webview.cjs').imageWebview();
 const state={type:'state',busy:false,status:'ready',references:[],choices,outputDirectory:'',tasks:[],draft:{prompt:'synthetic',accountId,modelId,ratio:'1:1',count:1,size:'auto',quality:'auto',followCurrent:true}};
 f.message(state);assert.equal(f.el('generate').disabled,true);assert.match(f.el('formHint').textContent,/选择保存位置/);
 f.message({...state,outputDirectory:'/synthetic/output',tasks:[{id:'synthetic-task',createdAt:'2026-10-09T00:00:00Z',phase:'cancelled',status:'IMAGE_DIRECT_OUTCOME_UNKNOWN',promptSummary:'synthetic',modelId,ratio:'1:1',count:1,size:'auto',quality:'auto',images:[]}]});
 const heading=f.el('tasks').children[0].children[0];assert.equal(heading.children[1].textContent,'结果未确认');assert.equal(f.el('generate').disabled,false);
});

test('cancelling a pending native generation consent releases this task before the dialog replies',async t=>{
 const f=await fixture(t);await f.send(f.generate);assert.equal(f.states.at(-1).busy,true);
 await f.send({type:'cancel'});await tick();assert.equal(f.states.at(-1).busy,false);assert.equal(f.states.at(-1).tasks[0].phase,'cancelled');assert.equal(f.runs.length,0);
 f.decide();await tick();assert.equal(f.runs.length,0);f.panels.at(-1).close();await f.controller.flush();
});

test('model favorites persist exact available IDs without generating or querying another catalog',async t=>{
 const storage=new Map(),f=await fixture(t,storage);await f.send({type:'ready'});const before=f.reading();
 await f.send({type:'favoriteModel',modelId});assert.deepEqual(f.states.at(-1).imageFavorites,[modelId]);assert.equal(f.reading(),before);assert.equal(f.runs.length,0);
 await f.send({type:'favoriteModel',modelId:'unknown-or-quota-label'});assert.deepEqual(f.states.at(-1).imageFavorites,[modelId]);
 f.panels.at(-1).close();await f.open();assert.deepEqual(f.states.at(-1).imageFavorites,[modelId]);
 await f.send({type:'favoriteModel',modelId});assert.deepEqual(f.states.at(-1).imageFavorites,[]);assert.equal(f.runs.length,0);
});
