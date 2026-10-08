const test=require('node:test');
const assert=require('node:assert/strict');
const Module=require('node:module');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const accountId='00000000-0000-4000-8000-000000000001', modelId='gemini-3.1-flash-image';
const choices={accounts:[{id:accountId,label:'synthetic',expectedEmail:'a@example.test',active:true}],models:[{id:modelId,label:modelId}]};
const tick=()=>new Promise(setImmediate);
async function fixture(t, storage = new Map()) {
 const output=await fs.mkdtemp(path.join(os.tmpdir(),'agm-image-state-'));t.after(()=>fs.rm(output,{recursive:true,force:true}));
 const commands=new Map(),states=[],panels=[];let decide,lateChoice,reading=0,runs=[],finishRun,currentChoices=choices;
 const direct={getEndpoint:()=> 'production',readChoices:async()=>{reading++;if(lateChoice)return lateChoice;return currentChoices;},
  run:async(request,signal,_progress,id)=>{runs.push({request,signal,id,progress:_progress});const result=await new Promise(resolve=>{finishRun=resolve;});if(result instanceof Error)throw result;return result||{images:[],batch:{outcome:'complete'}};}};
 const uri=file=>({scheme:'file',authority:'',fsPath:file,path:file});
 const vscode={ViewColumn:{Active:1},env:{},workspace:{workspaceFolders:[{uri:uri(output)}]},
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
