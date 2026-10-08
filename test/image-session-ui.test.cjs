const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),Module=require('node:module');
const {ImageSessionStore}=require('../out/image-session-store');
const accountId='00000000-0000-4000-8000-000000000001',modelId='gemini-3.1-flash-image';
const form={type:'generate',prompt:'private synthetic submitted prompt',accountId,modelId,ratio:'16:9',count:2,size:'2K',quality:'detail'};
async function fixture(t){const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'ag-session-ui-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));return{root,storage:path.join(root,'vscode-workspace-storage'),image:path.join(root,'result.jpg')}}
function host(f,override){
 const states=[],commands=new Map(),runs=[];let panel,resolveConfirmation,confirmationLabel,failSave=false;const confirmations=[];const subscriptions=[];
 const uri=file=>({scheme:'file',authority:'',fsPath:file,path:file});
 const vscode={ViewColumn:{Active:1},env:{remoteName:'wsl'},workspace:{workspaceFolders:[{uri:uri(f.root)}]},Uri:{file:uri},commands:{registerCommand:(id,fn)=>{commands.set(id,fn);return{dispose(){}}},executeCommand:async()=>{}},window:{showWarningMessage:(text,_options,label)=>{confirmations.push({text,label});confirmationLabel=label;return new Promise(r=>resolveConfirmation=r)},createWebviewPanel:()=>{
  panel={webview:{postMessage:async s=>states.push(structuredClone(s)),asWebviewUri:uri=>({toString:()=>uri.fsPath}),onDidReceiveMessage:fn=>{panel.receive=fn;return{dispose(){}}}},onDidDispose:fn=>{panel.close=fn;return{dispose(){}}},reveal(){}};return panel;
 }}};
 const store=override??new ImageSessionStore(path.join(f.storage,'image-session'));const wrapper={load:()=>store.load(),save:s=>failSave?Promise.reject(Error('synthetic storage fail')):store.save(s),flush:()=>store.flush()};
 const direct={readChoices:async()=>({accounts:[{id:accountId,label:'Synthetic',active:true}],models:[{id:modelId,label:'Synthetic model'}]}),getEndpoint:()=> 'daily',run:async request=>{runs.push(request);return{images:[{file:f.image,width:3,height:4}],batch:{outcome:'complete'}}}};
 const entry=require.resolve('../out/direct-image-ui'),old=Module._load;let ui;try{Module._load=function(name,...args){return name==='vscode'?vscode:old.call(this,name,...args)};delete require.cache[entry];ui=require(entry).registerDirectImageUi({subscriptions,storageUri:uri(f.storage),globalState:{get:()=>undefined,update:async()=>{}}},direct,undefined,wrapper)}finally{Module._load=old;delete require.cache[entry]}
 return{ui,states,runs,store,confirmations,subscriptions,open:()=>commands.get('antigravityAccounts.images.open')(),send:msg=>panel.receive(msg),close:()=>panel.close(),confirm:(label=confirmationLabel)=>{const resolve=resolveConfirmation;resolveConfirmation=undefined;resolve(label)},deny:()=>{const resolve=resolveConfirmation;resolveConfirmation=undefined;resolve(undefined)},ready:()=>!!resolveConfirmation,fail:value=>failSave=value,latest:()=>states.at(-1)};
}
async function until(fn){const deadline=Date.now()+10000;while(!fn()&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));assert.ok(fn(),'bounded wait completed')}
test('actual session storage restores two separate submissions and latest draft across close, host restart and upgrade',async t=>{
 const f=await fixture(t);await fs.writeFile(f.image,'synthetic image sentinel');const h=host(f);await h.open();
 const first=h.send(form);await until(h.ready);h.confirm();await first;
 const second=h.send({...form,prompt:'second submitted prompt'});await until(()=>h.latest().tasks.length===2&&h.ready());h.deny();await second;
 await h.send({...form,type:'draft',prompt:'latest unsent draft'});await h.ui.flush();const ids=h.latest().tasks.map(x=>x.id);assert.equal(h.runs.length,1);
 const saved=await new ImageSessionStore(path.join(f.storage,'image-session')).load();assert.equal(saved.tasks[0].prompt,form.prompt);assert.equal(saved.tasks[1].phase,'cancelled');assert.equal(saved.tasks[0].endpoint,'daily');assert.equal(saved.draft.prompt,'latest unsent draft');
 h.close();await h.ui.flush();await h.open();assert.deepEqual(h.latest().tasks.map(x=>x.id),ids);h.close();await h.ui.flush();
 const next=host(f);await next.open();assert.deepEqual(next.latest().tasks.map(x=>x.id),ids);assert.equal(next.latest().draft.prompt,'latest unsent draft');assert.equal(next.latest().tasks[0].images[0].preview,f.image);assert.equal(next.runs.length,0);
 await next.send({type:'deleteTask',taskId:ids[0]});assert.equal(next.latest().tasks.length,1);assert.equal(await fs.readFile(f.image,'utf8'),'synthetic image sentinel');await next.ui.flush();
 const again=host(f);await again.open();assert.deepEqual(again.latest().tasks.map(x=>x.id),[ids[1]]);await again.ui.flush();
});
test('a failed durable save blocks before confirmation/send, surfaces retry, preserves old disk and rolls back failed deletion',async t=>{
 const f=await fixture(t),h=host(f);await h.open();await h.send({...form,type:'draft'});await h.ui.flush();const file=path.join(f.storage,'image-session','session.json'),before=await fs.readFile(file,'utf8');
 h.fail(true);await h.send(form);assert.equal(h.runs.length,0);assert.equal(h.ready(),false);assert.equal(h.latest().storageBlocked,true);assert.match(h.latest().storageNotice,/尚未保存/);assert.equal(await fs.readFile(file,'utf8'),before);
 const id=h.latest().tasks[0].id;await h.send({type:'deleteTask',taskId:id});assert.equal(h.latest().tasks.length,1);
 h.fail(false);await h.send({type:'saveRecords'});assert.equal(h.latest().storageBlocked,false);await h.send({type:'deleteTask',taskId:id});assert.equal(h.latest().tasks.length,0);await h.ui.flush();
});
test('corrupt session is preserved and never overwritten by automatic metadata or draft events',async t=>{
 const f=await fixture(t),dir=path.join(f.storage,'image-session');await fs.mkdir(dir,{recursive:true,mode:0o700});const file=path.join(dir,'session.json');await fs.writeFile(file,'{"schema":99}',{mode:0o600});
 const h=host(f);await h.open();assert.equal(h.latest().storageBlocked,true);await h.send({...form,type:'draft'});await h.send(form);await h.ui.flush();assert.equal(h.runs.length,0);assert.equal(await fs.readFile(file,'utf8'),'{"schema":99}');
});

test('cleared references stay empty across a new extension host while original files and saved history remain',async t=>{
 const f=await fixture(t),first=host(f);await first.store.load();await first.store.save({schema:3,draft:{prompt:'keep description',accountId,modelId,ratio:'1:1',count:1,size:'auto',quality:'auto',followCurrent:true},outputDirectory:f.root,references:[f.image],tasks:[],savedDrafts:[]});
 await fs.writeFile(f.image,'synthetic source sentinel');await first.open();assert.equal(first.latest().references.length,1);
 await first.send({type:'clearReferences',revision:first.latest().referenceRevision});await first.ui.flush();first.close();await first.ui.flush();
 const second=host(f);await second.open();assert.deepEqual(second.latest().references,[]);assert.equal(second.latest().draft.prompt,'keep description');assert.equal(await fs.readFile(f.image,'utf8'),'synthetic source sentinel');assert.equal(second.runs.length,0);await second.ui.flush();
});

test('manual language changes update an open image panel during confirmation without resetting draft, account or task',async t=>{
 const {setLanguage}=require('../out/i18n');setLanguage('en');const f=await fixture(t);await fs.writeFile(f.image,'synthetic local result');const h=host(f);
 try{await h.open();await h.send({...form,type:'draft',prompt:'中文 user prompt <img onerror=x>'});await h.ui.flush();const before=await h.store.load();
 const pending=h.send({...form,prompt:before.draft.prompt});await until(h.ready);const taskId=h.latest().tasks[0].id,confirmation=h.confirmations.at(-1);
 assert.equal(confirmation.label,'Confirm generation');assert.match(confirmation.text,/Submit 2 image requests/);assert.doesNotMatch(confirmation.text,/中文 user prompt/);
 setLanguage('zh-CN');assert.equal(h.latest().languageOnly,true);assert.equal(h.latest().busy,true);assert.equal(h.latest().draft.prompt,before.draft.prompt);assert.equal(h.latest().draft.accountId,accountId);assert.equal(h.latest().tasks[0].id,taskId);assert.equal(h.runs.length,0);
 assert.ok(h.states.some(s=>s.type==='language'&&s.language==='zh-CN'));h.confirm(confirmation.label);await pending;assert.equal(h.runs.length,1);assert.equal(h.latest().tasks[0].phase,'complete');
 await h.ui.flush();const saved=await h.store.load();assert.equal(saved.draft.prompt,before.draft.prompt);assert.equal(saved.tasks[0].id,taskId);
 }finally{h.close();for(const sub of h.subscriptions)sub.dispose();await h.ui.flush();setLanguage('zh-CN')}
});
