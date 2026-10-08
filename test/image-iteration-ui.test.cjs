const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),Module=require('node:module'),{randomUUID}=require('node:crypto');
const {png}=require('./fixtures/png-fixture.cjs'),{readImageSession}=require('../out/image-session-store');
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',model='gemini-3.1-flash-image';
const tick=()=>new Promise(setImmediate);
async function fixture(t,legacyCloud=false){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'ag-iteration-ui-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));const file=path.join(root,'source.png');await fs.writeFile(file,png());
 const original={id:randomUUID(),createdAt:'2026-10-05T00:00:00Z',prompt:'original synthetic prompt',promptSummary:'original',accountId:B,modelId:model,endpoint:'daily',ratio:'16:9',count:2,size:'2K',quality:'detail',references:[path.join(root,'old-ref.png')],outputDirectory:root,phase:'complete',status:'saved',images:[{file,width:2,height:2}]};
 let stored={schema:2,draft:{prompt:'unsent user draft',accountId:A,modelId:model,ratio:'1:1',count:1,size:'auto',quality:'auto',followCurrent:true},references:[],outputDirectory:root,tasks:[original],savedDrafts:[]};
 if(legacyCloud){const backup={draft:{...stored.draft},references:[],outputDirectory:root};stored=readImageSession({...stored,schema:1,draft:{...stored.draft,prompt:'unfinished cloud edit',accountId:B,followCurrent:false},references:[file],edit:{parentTaskId:original.id,parentImageIndex:0,backup}})}
 let panel,decision,fail=false,choiceReads=0,models=[{id:model,label:'Synthetic'}],outcome='complete',endpoint='daily';const states=[],runs=[],dialogs=[],commands=new Map(),selected=[];
 const accounts=[{id:A,label:'Synthetic A',expectedEmail:'a@example.test',hostCurrent:true,active:true},{id:B,label:'Synthetic B',expectedEmail:'b@example.test',hostCurrent:true,active:false}];
 const direct={getEndpoint:()=>endpoint,listAccounts:()=>accounts,selectSavedAccount:id=>selected.push(id),hasSavedAccountSelection:id=>selected.includes(id),readChoices:async()=>{choiceReads++;return{accounts,models,readiness:'ready'}},run:async request=>{runs.push(request);if(outcome==='failed')throw Error('IMAGE_DIRECT_RESOURCE_EXHAUSTED');const result=path.join(root,randomUUID()+'.png');await fs.writeFile(result,png({value:90}));return{images:[{file:result,width:2,height:2}],batch:{outcome}}}};
 const uri=file=>({scheme:'file',authority:'',fsPath:file,path:file});const subscriptions=[];
 const vscode={env:{},Uri:{file:uri},workspace:{workspaceFolders:[{name:'synthetic',uri:uri(root)}]},ViewColumn:{Active:1},commands:{registerCommand:(id,fn)=>{commands.set(id,fn);return{dispose(){}}}},window:{showOpenDialog:async()=>dialogs.shift(),showWarningMessage:()=>new Promise(r=>decision=r),createWebviewPanel:()=>{panel={webview:{asWebviewUri:u=>({toString:()=>u.fsPath}),postMessage:async s=>states.push(structuredClone(s)),onDidReceiveMessage:fn=>{panel.receive=fn;return{dispose(){}}}},onDidDispose:fn=>{panel.close=fn;return{dispose(){}}},reveal(){}};return panel}}};
 const old=Module._load,entries=['../out/direct-image-ui','../out/image-project-actions'].map(require.resolve);let ui;
 try{Module._load=function(name,...args){return name==='vscode'?vscode:old.call(this,name,...args)};for(const e of entries)delete require.cache[e];ui=require(entries[0]).registerDirectImageUi({subscriptions,globalState:{get:()=>undefined,update:async()=>{}}},direct,undefined,{load:async()=>structuredClone(stored),save:async s=>{if(fail)throw Error('synthetic write fail');stored=readImageSession(s)},flush:async()=>{}})}finally{Module._load=old;for(const e of entries)delete require.cache[e]}
 t.after(async()=>{await ui.flush();for(const d of subscriptions)d.dispose()});await commands.get('antigravityAccounts.images.open')();
 return{root,file,original,accounts,runs,selected,ui,states,dialogs,choiceReads:()=>choiceReads,send:async msg=>{await panel.receive(msg);await tick();await tick()},start:msg=>panel.receive(msg),latest:()=>states.at(-1),disk:()=>structuredClone(stored),setModels:m=>models=m,setEndpoint:e=>endpoint=e,setFail:b=>fail=b,setOutcome:o=>outcome=o,confirm:answer=>{decision(answer);decision=undefined},ready:()=>!!decision,close:()=>panel.close(),open:()=>commands.get('antigravityAccounts.images.open')()};
}
async function until(fn){for(let i=0;i<100&&!fn();i++)await new Promise(r=>setTimeout(r,10));assert.ok(fn())}
test('continue replaces references, protects the latest draft, pins account and sends only after explicit confirmation',async t=>{
 const f=await fixture(t),action={type:'continueImage',taskId:f.original.id,index:0};await f.send(action);
 assert.equal(f.runs.length,0);assert.equal(f.latest().draft.prompt,f.original.prompt);assert.equal(f.latest().draft.accountId,B);assert.equal(f.latest().draft.followCurrent,false);assert.equal(f.latest().draft.ratio,'16:9');assert.deepEqual(f.disk().references,[f.file]);assert.equal(f.disk().savedDrafts[0].draft.prompt,'unsent user draft');assert.equal(f.disk().origin.taskId,f.original.id);
 const pending=f.start({type:'generate',...f.latest().draft,prompt:'explicit synthetic edit'});await until(f.ready);assert.equal(f.runs.length,0);await f.send({type:'continueImage',taskId:f.original.id,index:0});assert.equal(f.latest().tasks.length,2);f.confirm('确认生成');await pending;assert.equal(f.runs.length,1);assert.deepEqual(f.runs[0].references,[f.file]);assert.match(f.runs[0].referenceHashes[f.file],/^[a-f0-9]{64}$/);assert.equal(f.disk().tasks[1].origin.taskId,f.original.id);assert.equal(f.disk().tasks[0].prompt,f.original.prompt);
 await f.send({type:'compareImage',taskId:f.latest().tasks[1].id,index:0});assert.equal(f.latest().comparison.versions.length,2);
 await f.send({type:'restoreDraft',id:f.disk().savedDrafts[0].id});assert.equal(f.latest().draft.prompt,'unsent user draft');assert.equal(f.disk().savedDrafts[0].draft.prompt,'explicit synthetic edit');assert.equal(f.disk().origin,undefined);
});
test('unavailable original model is retained without fallback; missing account, endpoint mismatch and missing image preserve drafts',async t=>{
 const f=await fixture(t),action={type:'continueImage',taskId:f.original.id,index:0},before=f.disk().draft;
 f.accounts.pop();await f.send(action);assert.deepEqual(f.disk().draft,before);assert.match(f.latest().actionNotice,/原生图账号已删除/);
 f.accounts.push({id:B,label:'B',hostCurrent:true});f.setEndpoint('production');await f.send(action);assert.deepEqual(f.disk().draft,before);assert.match(f.latest().actionNotice,/端点不同/);f.setEndpoint('daily');
 f.setModels([{id:'other-image-model',label:'Other'}]);await f.send(action);assert.equal(f.latest().draft.modelId,model);assert.equal(f.latest().accountBlocked,true);assert.equal(f.latest().iteration.modelUnavailable,true);
 await f.send({type:'generate',...f.latest().draft});assert.equal(f.runs.length,0);assert.match(f.latest().status,/原模型当前不可用/);
 await f.send({type:'draft',...f.latest().draft,modelId:'other-image-model'});assert.equal(f.latest().iteration.modelUnavailable,false);
 await fs.unlink(f.file);await f.ui.flush();const current=f.disk().draft;await f.send(action);assert.deepEqual(f.disk().draft,current);assert.match(f.latest().actionNotice,/不存在/);assert.equal(f.runs.length,0);
});
test('failed saves roll back draft replacement; repeated clicks serialize and ten saved drafts never silently evict',async t=>{
 const f=await fixture(t),action={type:'continueImage',taskId:f.original.id,index:0};const before=f.disk();f.setFail(true);await f.send(action);assert.deepEqual(f.disk(),before);assert.equal(f.latest().draft.prompt,before.draft.prompt);
 f.setFail(false);await f.send({type:'saveRecords'});await Promise.all([f.start(action),f.start(action)]);await tick();assert.equal(f.disk().savedDrafts.length,1);
 for(let i=1;i<10;i++)await f.send(action);assert.equal(f.disk().savedDrafts.length,10);const kept=f.disk().savedDrafts;await f.send(action);assert.deepEqual(f.disk().savedDrafts,kept);assert.match(f.latest().actionNotice,/10 份/);assert.equal(f.runs.length,0);
 await f.send({type:'restoreDraft',id:kept[0].id});assert.equal(f.disk().savedDrafts.length,10);assert.equal(f.latest().draft.prompt,'unsent user draft');
});
test('closing confirmation interrupts no request; failure keeps lineage but never creates a successful comparison version',async t=>{
 const f=await fixture(t);await f.send({type:'continueImage',taskId:f.original.id,index:0});const pending=f.start({type:'generate',...f.latest().draft});await until(f.ready);f.close();f.confirm('确认生成');await pending;assert.equal(f.runs.length,0);await f.open();assert.equal(f.latest().tasks[1].phase,'cancelled');
 f.setOutcome('failed');const failed=f.start({type:'generate',...f.latest().draft});await until(f.ready);f.confirm('确认生成');await failed;assert.equal(f.latest().tasks[2].phase,'failed');assert.equal(f.disk().tasks[2].origin.taskId,f.original.id);
 await f.send({type:'compareImage',taskId:f.original.id,index:0});assert.equal(f.latest().comparison.versions.length,1);assert.equal(f.runs.length,1);
});
test('restored cloud edit remains recoverable and cannot submit before explicit source verification',async t=>{
 const f=await fixture(t,true);assert.equal(f.latest().draft.prompt,'unfinished cloud edit');assert.match(f.latest().actionNotice,/旧版没有保存来源图片摘要/);
 await f.send({type:'generate',...f.latest().draft});assert.equal(f.runs.length,0);assert.equal(f.ready(),false);assert.match(f.latest().status,/旧版没有保存来源图片摘要/);
 await f.send({type:'continueImage',taskId:f.original.id,index:0});assert.equal(f.runs.length,0);assert.match(f.disk().origin.sha256,/^[a-f0-9]{64}$/);
 assert.ok(f.disk().savedDrafts.some(s=>s.draft.prompt==='unfinished cloud edit'));const original=f.disk().savedDrafts.find(s=>s.draft.prompt==='unsent user draft');assert.ok(original);
 await f.send({type:'restoreDraft',id:original.id});assert.equal(f.latest().draft.prompt,'unsent user draft');assert.equal(f.runs.length,0);
});

test('reference picker cancellation retains input; replace previews, single removal and clearing preserve files and history',async t=>{
 const f=await fixture(t),uri=fsPath=>({scheme:'file',authority:'',fsPath,path:fsPath});
 const second=path.join(f.root,'second.png');await fs.writeFile(second,png({value:20}));
 f.dialogs.push([uri(f.file),uri(second)]);await f.send({type:'references'});
 assert.deepEqual(f.disk().references,[f.file,second]);assert.equal(f.latest().referenceImages.length,2);assert.equal(f.latest().referenceImages[0].preview,f.file);
 const before=f.disk(),revision=f.latest().referenceRevision;f.dialogs.push(undefined);await f.send({type:'references'});assert.deepEqual(f.disk(),before);assert.equal(f.latest().referenceRevision,revision);
 await f.send({type:'removeReference',index:0,revision});assert.deepEqual(f.disk().references,[second]);
 await f.send({type:'removeReference',index:0,revision});assert.deepEqual(f.disk().references,[second],'stale duplicate cannot remove the next image');
 await f.send({type:'removeReference',index:-1,revision:f.latest().referenceRevision});assert.deepEqual(f.disk().references,[second]);
 f.dialogs.push([uri(f.file)]);await f.send({type:'references'});assert.deepEqual(f.disk().references,[f.file]);
 await f.send({type:'clearReferences',revision:f.latest().referenceRevision});assert.deepEqual(f.disk().references,[]);
 assert.deepEqual(f.disk().draft,before.draft);assert.deepEqual(f.disk().tasks,before.tasks);assert.deepEqual(f.disk().savedDrafts,before.savedDrafts);
 assert.equal(f.runs.length,0);assert.ok((await fs.stat(f.file)).isFile());assert.ok((await fs.stat(second)).isFile());
 f.close();await f.ui.flush();await f.open();assert.deepEqual(f.latest().references,[]);
});
test('removing source keeps other references and clears lineage; failed clear rolls back source and draft without changing history',async t=>{
 const f=await fixture(t);await f.send({type:'continueImage',taskId:f.original.id,index:0});
 const before=f.disk();f.setFail(true);f.dialogs.push([{scheme:'file',authority:'',fsPath:f.file,path:f.file}]);await f.send({type:'references'});assert.deepEqual(f.disk(),before);assert.match(f.latest().actionNotice,/保留原引用/);await f.send({type:'clearReferences',revision:f.latest().referenceRevision});
 assert.deepEqual(f.disk(),before);assert.deepEqual(f.latest().references,[path.basename(f.file)]);assert.equal(f.latest().iteration.taskId,before.origin.taskId);assert.match(f.latest().actionNotice,/保留原引用/);
 f.setFail(false);await f.send({type:'saveRecords'});await f.send({type:'clearReferences',revision:f.latest().referenceRevision});
 assert.deepEqual(f.disk().references,[]);assert.equal(f.disk().origin,undefined);assert.equal(f.latest().iteration,undefined);
 assert.deepEqual(f.disk().draft,before.draft);assert.deepEqual(f.disk().tasks,before.tasks);assert.deepEqual(f.disk().savedDrafts,before.savedDrafts);assert.equal(f.disk().outputDirectory,before.outputDirectory);assert.equal(f.runs.length,0);
 await f.send({type:'continueImage',taskId:f.original.id,index:0});const second=path.join(f.root,'second.png');await fs.writeFile(second,png());
 const uri=fsPath=>({scheme:'file',authority:'',fsPath,path:fsPath});f.dialogs.push([uri(f.file),uri(second)]);await f.send({type:'references'});
 assert.equal(f.latest().referenceImages[0].source,true);await f.send({type:'removeReference',index:0,revision:f.latest().referenceRevision});
 assert.deepEqual(f.disk().references,[second]);assert.equal(f.disk().origin,undefined);assert.ok((await fs.stat(f.file)).isFile());
});
test('busy confirmation rejects reference edits and duplicate clicks; denying confirmation sends no image request',async t=>{
 const f=await fixture(t);await f.send({type:'continueImage',taskId:f.original.id,index:0});const before=f.disk().references;
 const pending=f.start({type:'generate',...f.latest().draft});await until(f.ready);
 await Promise.all([f.send({type:'clearReferences',revision:f.latest().referenceRevision}),f.send({type:'removeReference',index:0,revision:f.latest().referenceRevision})]);
 assert.deepEqual(f.disk().references,before);f.confirm(undefined);await pending;assert.equal(f.runs.length,0);assert.deepEqual(f.disk().references,before);assert.equal(f.latest().busy,false);
});

test('clearing a source preserves an unavailable model and parameters without another account/model lookup',async t=>{
 const f=await fixture(t);f.setModels([{id:'other-image-model',label:'Other'}]);await f.send({type:'continueImage',taskId:f.original.id,index:0});
 assert.equal(f.latest().iteration.modelUnavailable,true);const before=f.disk().draft,reads=f.choiceReads();
 await f.send({type:'clearReferences',revision:f.latest().referenceRevision});
 assert.deepEqual(f.disk().draft,before);assert.equal(f.choiceReads(),reads);assert.equal(f.disk().origin,undefined);assert.deepEqual(f.disk().references,[]);assert.equal(f.runs.length,0);assert.equal(f.latest().accountBlocked,true);
 await f.send({type:'draft',...f.latest().draft,modelId:'other-image-model'});assert.equal(f.latest().accountBlocked,false);
});
