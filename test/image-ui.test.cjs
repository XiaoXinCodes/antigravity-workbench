const test=require('node:test'),assert=require('node:assert/strict'),Module=require('node:module'),vm=require('node:vm'),{EventEmitter}=require('node:events');
const entry=require.resolve('../out/legacy/image-ui');
const tick=()=>new Promise(r=>setImmediate(r));
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};}
function setup(overrides={}){
 const commands=new Map(),panels=[],messages=[],calls=[],dialogs=[],dialogOptions=[],warnings=[];let receive,close;
 const ui={trusted:true,answer:'确认生成',confirmation:null};
 const vscode={UIKind:{Desktop:1},ExtensionKind:{UI:1,Workspace:2},env:{uiKind:overrides.uiKind??1,get remoteName(){return ui.remoteName;}},ViewColumn:{One:1},Uri:{file:p=>({scheme:'file',authority:'',fsPath:p})},workspace:{workspaceFolders:overrides.workspaceFolders,getWorkspaceFolder:uri=>(overrides.workspaceFolders||[]).find(folder=>folder.uri===uri||folder===overrides.activeWorkspace),get isTrusted(){return ui.trusted;}},
 commands:{registerCommand(name,fn){commands.set(name,fn);return{dispose(){}};},executeCommand:async(...args)=>calls.push(args)},
 window:{activeTextEditor:overrides.activeWorkspace?{document:{uri:overrides.activeWorkspace.uri}}:undefined,showQuickPick:async options=>{calls.push(['pickWorkspace',options]);return overrides.pickWorkspace===null?undefined:options[overrides.pickWorkspace??0];},createWebviewPanel(){const p={webview:{html:'',postMessage:async m=>messages.push(m),onDidReceiveMessage(fn){receive=fn;return{dispose(){}};}},onDidDispose(fn){close=fn;return{dispose(){}};},reveal(){},dispose(){close();}};panels.push(p);return p;},showOpenDialog:async options=>{dialogOptions.push(options);return dialogs.shift();},showWarningMessage:async text=>{warnings.push(text);return ui.confirmation?ui.confirmation.promise:ui.answer;}}};
 const original=Module._load;Module._load=function(name,...args){if(name==='vscode')return vscode;if(name==='node:child_process'&&overrides.spawn)return{...original.call(this,name,...args),spawn:overrides.spawn};if(name==='../image-files'&&overrides.readPng)return{readPng:overrides.readPng};return original.call(this,name,...args);};let api;try{delete require.cache[entry];api=require(entry);}finally{Module._load=original;}
 const context={subscriptions:[],extensionUri:overrides.extensionUri||vscode.Uri.file('/extension'),globalStorageUri:overrides.globalStorageUri||vscode.Uri.file('/storage'),extension:{extensionKind:overrides.extensionKind??1},globalState:{get:()=>ui.recoveryPending??false}};let run=async()=>({images:[],warning:'unknown',identity:null,quota:null});const runs=[];
 const diag=api.registerImageUi(context,{outputChanged:overrides.outputChanged,accountRecoveryPending:overrides.accountRecoveryPending,reviewConfiguration:overrides.reviewConfiguration||(async()=>({scripts:[]})),run:async(...args)=>{runs.push(args);return run(...args);},configurationTimeoutMs:overrides.configurationTimeoutMs,workerTimeoutMs:overrides.workerTimeoutMs,cancelTimeoutMs:overrides.cancelTimeoutMs});
 const open=()=>commands.get('antigravityAccounts.images.open')();const send=async m=>{receive(m);await tick();};
 const choose=async()=>{dialogs.push([{scheme:'file',authority:'',fsPath:process.platform==='win32'?'C:\\outputs':'/tmp/outputs'}]);await send({type:'output'});};
 return{api,commands,panels,messages,calls,dialogs,dialogOptions,warnings,ui,context,diag,runs,open,send,choose,setRun:fn=>{run=fn;},close:()=>close()};
}
const request={type:'generate',prompt:'a cloud',executable:'agy',aspectRatio:'1:1'};
const output=n=>({file:`/tmp/outputs/image-${n}.png`,width:640,height:480,sha256:'checked-image'});
const result=(images,batch)=>({images,warning:'账户与图片额度未知。',identity:null,quota:null,completedAt:'2026-09-30T00:00:00.000Z',conversationId:'test-conversation',...(batch?{batch}:{})});
test('image UI activation does no CLI or credential work; panel has strict CSP and no remote resources',()=>{const f=setup();assert.equal(f.runs.length,0);f.open();assert.match(f.panels[0].webview.html,/default-src 'none'/);assert.match(f.panels[0].webview.html,/使用当前扩展宿主的 agy 登录账户与 HOME/);assert.doesNotMatch(f.panels[0].webview.html,/<(?:img|script)[^>]+src="https?:/);});
test('cancelled confirmation, untrusted workspace and missing output never launch generation',async()=>{
 const f=setup();f.open();await f.send(request);assert.equal(f.runs.length,0);await f.choose();f.ui.answer=undefined;await f.send(request);assert.equal(f.runs.length,0);f.ui.answer='确认生成';f.ui.trusted=false;await f.send(request);assert.equal(f.runs.length,0);
});
test('repeated generation clicks are coalesced during modal confirmation and cancel stays effective',async()=>{
 const f=setup();f.open();await f.choose();f.ui.confirmation=deferred();await f.send(request);await f.send(request);assert.equal(f.warnings.length,1);await f.send({type:'cancel'});f.ui.confirmation.resolve('确认生成');await tick();assert.equal(f.runs.length,0);assert.match(f.diag.getStatus(),/取消/);
});
test('active task reports progress, blocks repeat generation, and cancel aborts the same task',async()=>{
 const f=setup();f.open();await f.choose();const pending=deferred();f.setRun((_req,signal,progress)=>{progress({phase:'generating',message:'working'});signal.addEventListener('abort',()=>pending.resolve({images:[],warning:'late'}));return pending.promise;});
 await f.send(request);await f.send(request);assert.equal(f.runs.length,1);assert.match(f.diag.getStatus(),/working/);await f.send({type:'cancel'});await tick();assert.equal(f.runs[0][1].aborted,true);assert.match(f.diag.getStatus(),/已取消/);assert.equal(f.messages.at(-1).busy,false);
});
test('close and reopen invalidates stale completion without cancelling a newer generation',async()=>{
 const f=setup();f.open();await f.choose();const old=deferred(),newer=deferred();let n=0;f.setRun(()=>++n===1?old.promise:newer.promise);await f.send(request);const oldSignal=f.runs[0][1];f.close();f.open();await f.send(request);assert.equal(oldSignal.aborted,true);assert.equal(f.runs.length,1);old.resolve({images:[],warning:'STALE'});await tick();assert.doesNotMatch(f.diag.getStatus(),/STALE/);assert.equal(f.messages.at(-1).busy,false);await f.send(request);assert.equal(f.runs.length,2);newer.resolve({images:[],warning:'FRESH'});await tick();assert.equal(f.messages.at(-1).resultWarning,'FRESH');assert.equal(f.messages.at(-1).busy,false);
});
test('extension disposal aborts running image task and no later result reaches a closed panel',async()=>{
 const f=setup();f.open();await f.choose();const pending=deferred();f.setRun(()=>pending.promise);await f.send(request);for(const sub of f.context.subscriptions)sub.dispose();assert.equal(f.runs[0][1].aborted,true);const count=f.messages.length;pending.resolve({images:[],warning:'old'});await tick();assert.equal(f.messages.length,count);
});
test('native selection pending cannot race with generate, and unknown messages do not unlock a task',async()=>{
 const f=setup();f.open();await f.choose();const pending=deferred();f.setRun(()=>pending.promise);await f.send(request);await f.send({type:'nonsense'});await f.send(request);assert.equal(f.runs.length,1);pending.resolve({images:[],warning:'done'});await tick();
});

test('local UI host can generate from a remote workspace window using only local selections',async()=>{const f=setup();f.open();await f.choose();for(const name of ['ssh-remote','wsl','dev-container']){f.ui.remoteName=name;await f.send(request);assert.equal(f.runs.length,['ssh-remote','wsl','dev-container'].indexOf(name)+1);}});

test('native local workspace extension host can use its own filesystem',async()=>{const f=setup({extensionKind:2});f.open();await f.choose();await f.send(request);assert.equal(f.runs.length,1);});

test('bounded count and honest prompt preferences reach the worker unchanged and are included in confirmation',async()=>{
 const f=setup();f.open();await f.choose();await f.send({...request,count:3,size:'2K',quality:'detail'});
 assert.equal(f.runs.length,1);assert.deepEqual(f.runs[0][0],{prompt:'a cloud',executable:'agy',aspectRatio:'1:1',references:[],outputDirectory:process.platform==='win32'?'C:\\outputs':'/tmp/outputs',count:3,size:'2K',quality:'detail'});
 const confirmation=f.warnings[0];assert.match(confirmation,/生成 3 张图片/);assert.match(confirmation,/最多发起 3 次独立图片生成/);assert.match(confirmation,/逐张串行/);assert.match(confirmation,/官方 CLI 内部可能重试/);assert.match(confirmation,/每次可能单独计费或消耗 AI credits/);assert.match(confirmation,/CLI 当前登录账户/);assert.match(confirmation,/不自动重试或换号/);assert.match(confirmation,/尺寸偏好：2K/);assert.match(confirmation,/不保证固定分辨率或官方画质档位/);assert.match(confirmation,/保留已保存图片/);
});

test('older webview requests without option fields use one automatic generation',async()=>{
 const f=setup();f.open();await f.choose();await f.send(request);assert.equal(f.runs.length,1);assert.equal(f.runs[0][0].count,1);assert.equal(f.runs[0][0].size,'auto');assert.equal(f.runs[0][0].quality,'auto');assert.match(f.warnings[0],/生成 1 张图片/);
});

test('malformed counts or unsupported size and detail tiers cannot open confirmation or launch a worker',async()=>{
 const f=setup();f.open();await f.choose();for(const invalid of [{count:0},{count:5},{count:1.5},{count:'2'},{count:null},{count:NaN},{count:Infinity},{size:'8K'},{size:null},{quality:'ultra'},{quality:4}])await f.send({...request,...invalid});
 assert.equal(f.runs.length,0);assert.equal(f.warnings.length,0);assert.match(f.diag.getStatus(),/图片选项无效/);
});

test('cancelled batch retains every completed image and all images remain previewable',async()=>{
 const f=setup({readPng:async()=>({info:{sha256:'checked-image'}})});f.open();await f.choose();const pending=deferred();
 f.setRun((_req,signal)=>{signal.addEventListener('abort',()=>pending.resolve(result([output(1),output(2)],{requested:4,completed:2,outcome:'cancelled',error:'IMAGE_CANCELLED'})));return pending.promise;});
 await f.send({...request,count:4});await f.send({type:'cancel'});await tick();assert.equal(f.runs[0][1].aborted,true);assert.match(f.diag.getStatus(),/已取消；已完成 2\/4 次生成，已保留 2 张 PNG/);assert.equal(f.messages.at(-1).images.length,2);assert.equal(f.messages.at(-1).busy,false);
 await f.send({type:'preview',index:0});await f.send({type:'preview',index:1});assert.deepEqual(f.calls.map(call=>[call[0],call[1].fsPath]),[['vscode.open',output(1).file],['vscode.open',output(2).file]]);
});

test('partial batch exposes concrete progress and a fixed readable error without raw CLI output',async()=>{
 const f=setup();f.open();await f.choose();f.setRun(async()=>result([output(1)],{requested:3,completed:1,outcome:'partial',error:'IMAGE_QUOTA_EXHAUSTED'}));await f.send({...request,count:3});assert.match(f.diag.getStatus(),/已完成 1\/3 次生成，已保存 1 张 PNG/);assert.match(f.diag.getStatus(),/官方报告图片配额不足/);assert.equal(f.messages.at(-1).images.length,1);
 f.setRun(async()=>result([output(2)],{requested:3,completed:1,outcome:'partial',error:'PRIVATE_RAW_CLI_OUTPUT user@example.test'}));await f.send({...request,count:3});assert.match(f.diag.getStatus(),/图片任务未完成/);assert.doesNotMatch(f.diag.getStatus(),/PRIVATE_RAW_CLI_OUTPUT|user@example\.test/);assert.equal(f.messages.at(-1).images[0].name,'image-2.png');
});

test('late cancellation still retains a validated single image returned before worker completion',async()=>{
 const f=setup();f.open();await f.choose();const pending=deferred();f.setRun(()=>pending.promise);await f.send(request);await f.send({type:'cancel'});pending.resolve(result([output(1)]));await tick();assert.equal(f.messages.at(-1).images.length,1);assert.match(f.diag.getStatus(),/已完成 1\/1 次生成，已保留 1 张 PNG/);
});

test('completed images from a closed generation cannot replace the reopened panel state',async()=>{
 const f=setup();f.open();await f.choose();const pending=deferred();f.setRun(()=>pending.promise);await f.send({...request,count:3});f.close();f.open();assert.equal(f.runs[0][1].aborted,true);pending.resolve(result([output(1)],{requested:3,completed:1,outcome:'cancelled'}));await tick();assert.equal(f.messages.at(-1).images.length,0);assert.equal(f.messages.at(-1).busy,false);assert.doesNotMatch(f.diag.getStatus(),/已保留 1 张/);
});

test('cancelling a new confirmation preserves the previous previews and permits a later new request',async()=>{
 const f=setup();f.open();await f.choose();f.setRun(async()=>result([output(1),output(2)],{requested:2,completed:2,outcome:'complete'}));await f.send({...request,count:2});assert.equal(f.messages.at(-1).images.length,2);
 f.ui.confirmation=deferred();await f.send({...request,count:4,size:'4K',quality:'detail'});await f.send({...request,count:4});assert.equal(f.warnings.length,2);await f.send({type:'cancel'});f.ui.confirmation.resolve('确认生成');await tick();assert.equal(f.runs.length,1);assert.equal(f.messages.at(-1).images.length,2);assert.equal(f.messages.at(-1).busy,false);
 f.ui.confirmation=null;await f.send({...request,count:2});assert.equal(f.runs.length,2);
});

test('webview selectors serialize typed values, follow the selected count and disable during a task',()=>{
 const f=setup();const html=f.api.imageHtml();assert.match(html,/尺寸偏好（提示词）/);assert.match(html,/细节偏好（提示词）/);assert.match(html,/不保证固定分辨率或官方画质档位/);assert.match(html,/<summary>更多选项<\/summary>/);
 const elements=new Map(),sent=[],events=new Map();const element=()=>({value:'',disabled:false,hidden:false,textContent:'',children:[],replaceChildren(){this.children=[];},append(child){this.children.push(child);}});const el=id=>{if(!elements.has(id))elements.set(id,element());return elements.get(id);};
 for(const [id,value]of Object.entries({prompt:'a cloud',executable:'agy',ratio:'16:9',count:'1',size:'auto',quality:'auto'}))el(id).value=value;
 const code=html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];vm.runInNewContext(code,{acquireVsCodeApi:()=>({postMessage:m=>sent.push(JSON.parse(JSON.stringify(m)))}),document:{getElementById:el,createElement:element},window:{addEventListener:(name,handler)=>events.set(name,handler)}});
 events.get('message')({data:{type:'state',busy:false,status:'ready',references:[],outputDirectory:'/tmp/outputs',images:[]}});assert.equal(el('generate').textContent,'生成 1 张图片');el('count').value='4';el('count').onchange();el('size').value='4K';el('quality').value='detail';el('generate').onclick();assert.equal(el('generate').textContent,'处理中 · 4 张图片');assert.match(el('status').textContent,/已收到生成请求/);assert.deepEqual(sent.at(-1),{type:'generate',prompt:'a cloud',aspectRatio:'16:9',executable:'agy',count:4,size:'4K',quality:'detail'});const sentBeforeHost=sent.length;el('generate').onclick();assert.equal(sent.length,sentBeforeHost);assert.equal(el('cancel').disabled,false);
 const state={type:'state',busy:true,cancellable:true,status:'generating',references:[],outputDirectory:'/tmp/outputs',images:[]};events.get('message')({data:state});for(const id of ['generate','count','size','quality','prompt','ratio'])assert.equal(el(id).disabled,true);assert.equal(el('cancel').disabled,false);const before=sent.length;el('generate').onclick();assert.equal(sent.length,before);
 events.get('message')({data:{...state,busy:false,images:[{index:0,name:'one.png',width:1,height:2},{index:1,name:'two.png',width:3,height:4}]}});for(const id of ['count','size','quality'])assert.equal(el(id).disabled,false);assert.equal(el('images').children.length,2);el('images').children[1].onclick();assert.deepEqual(sent.at(-1),{type:'preview',index:1});assert.equal(el('reveal').hidden,false);
});

function workerStub(){
 const child=new EventEmitter(),sent=[];child.connected=true;child.stdin=new EventEmitter();child.stdin.end=value=>{child.request=JSON.parse(value);};child.channel={unref(){}};child.unref=()=>{};child.disconnect=()=>{child.connected=false;};child.send=(value,callback)=>{sent.push(value);callback?.();};return{child,sent};
}

test('worker IPC preserves valid cancelled batch output instead of discarding it after abort',async()=>{
 const {child,sent}=workerStub();const f=setup({spawn:()=>child});const controller=new AbortController(),progress=[];const pending=f.api.runImageWorker({...request,count:3,size:'2K',quality:'detail',references:[],outputDirectory:'/tmp/outputs'},controller.signal,value=>progress.push(value));assert.equal(child.request.count,3);child.emit('message',{kind:'progress',progress:{phase:'generating',message:'first'}});assert.equal(progress.length,1);controller.abort();assert.deepEqual(sent,['cancel']);const completed=result([output(1)],{requested:3,completed:1,outcome:'cancelled',error:'IMAGE_CANCELLED'});child.emit('message',{kind:'result',result:completed});assert.deepEqual(await pending,completed);child.emit('exit',0);
});

test('worker IPC rejects cancellation without completed images and never starts an already aborted request',async()=>{
 const {child}=workerStub();let starts=0;const f=setup({spawn:()=>{starts++;return child;}});const controller=new AbortController();const pending=f.api.runImageWorker(request,controller.signal,()=>{});controller.abort();child.emit('message',{kind:'result',result:result([],{requested:3,completed:0,outcome:'cancelled'})});await assert.rejects(pending,/IMAGE_CANCELLED/);await assert.rejects(f.api.runImageWorker(request,controller.signal,()=>{}),/IMAGE_CANCELLED/);assert.equal(starts,1);
});


test('draft survives closing and reopening without starting generation',async()=>{
 const f=setup();f.open();const draft={prompt:'a saved scene',executable:'/local/agy',aspectRatio:'16:9',count:4,size:'2K',quality:'detail'};
 await f.send({type:'draft',...draft});f.close();f.open();await f.send({type:'ready'});
 assert.deepEqual(f.messages.at(-1).draft,draft);assert.equal(f.runs.length,0);
});

test('remote folder selection gives an actionable error without clearing prior local output',async()=>{
 const f=setup();f.open();await f.choose();const local=f.messages.at(-1).outputDirectory;
 f.dialogs.push([{scheme:'vscode-remote',fsPath:'/remote/output'}]);await f.send({type:'output'});
 assert.match(f.diag.getStatus(),/请选择当前宿主的原生文件夹/);assert.equal(f.messages.at(-1).outputDirectory,local);
 await f.send(request);assert.equal(f.runs[0][0].outputDirectory,local);
});

test('native folder selection is not presented as a cancellable image task',async()=>{
 const f=setup();f.open();const pending=deferred();f.dialogs.push(pending.promise);await f.send({type:'output'});
 assert.equal(f.messages.at(-1).busy,true);assert.equal(f.messages.at(-1).cancellable,false);
 await f.send({type:'cancel'});assert.doesNotMatch(f.diag.getStatus(),/正在取消/);
 pending.resolve(undefined);await tick();assert.equal(f.messages.at(-1).busy,false);
});

test('previous previews remain after a new generation fails',async()=>{
 const f=setup();f.open();await f.choose();f.setRun(async()=>result([output(1)],{requested:1,completed:1,outcome:'complete'}));await f.send(request);
 f.setRun(async()=>{throw Error('IMAGE_CLI_NOT_FOUND');});await f.send(request);
 assert.match(f.diag.getStatus(),/找不到官方 agy/);assert.equal(f.messages.at(-1).images[0].name,'image-1.png');
});

test('existing result previews remain available during workspace trust loss or account recovery',async()=>{
 const f=setup({readPng:async()=>({info:{sha256:'checked-image'}})});f.open();await f.choose();f.setRun(async()=>result([output(1)]));await f.send(request);
 f.ui.trusted=false;f.ui.recoveryPending=true;await f.send({type:'preview',index:0});assert.equal(f.calls.at(-1)[0],'vscode.open');
 await f.send(request);assert.equal(f.runs.length,1);
});


test('file dialogs explicitly start in the local filesystem',async()=>{
 const f=setup();f.open();await f.choose();assert.equal(f.dialogOptions[0].defaultUri.scheme,'file');
 await f.send({type:'references'});assert.equal(f.dialogOptions[1].defaultUri.scheme,'file');
});

test('closing an idle panel preserves the last completed status',async()=>{
 const f=setup();f.open();await f.choose();f.setRun(async()=>result([output(1)]));await f.send(request);const status=f.diag.getStatus();
 f.close();f.open();await f.send({type:'ready'});assert.equal(f.diag.getStatus(),status);assert.equal(f.messages.at(-1).images.length,1);
});

test('failed confirmation releases busy and cancellable state without a worker',async()=>{
 const f=setup();f.open();await f.choose();f.ui.confirmation={promise:Promise.reject(Error('dialog failed'))};await f.send(request);
 assert.equal(f.runs.length,0);assert.equal(f.messages.at(-1).busy,false);assert.equal(f.messages.at(-1).cancellable,false);
 f.ui.confirmation=null;await f.send(request);assert.equal(f.runs.length,1);
});


test('WSL workspace host generates with explicitly selected native output and reference paths', {skip:process.platform!=='linux'}, async()=>{
 const readPaths=[];const f=setup({extensionKind:2,readPng:async file=>{readPaths.push(file);return{info:{sha256:'checked-image'}};}});f.ui.remoteName='wsl';f.open();
 f.dialogs.push([{scheme:'file',authority:'',fsPath:'/home/wsl/images'}]);await f.send({type:'output'});
 f.dialogs.push([{scheme:'file',authority:'',fsPath:'/home/wsl/reference.png'}]);await f.send({type:'references'});
 await f.send({...request,executable:'/usr/local/bin/agy'});
 assert.equal(f.runs.length,1);assert.equal(f.runs[0][0].outputDirectory,'/home/wsl/images');assert.deepEqual(f.runs[0][0].references,['/home/wsl/reference.png']);assert.equal(f.runs[0][0].executable,'/usr/local/bin/agy');assert.deepEqual(readPaths,['/home/wsl/reference.png']);
 for(const dialog of f.dialogOptions){assert.equal(dialog.defaultUri.scheme,'file');assert.equal(dialog.defaultUri.authority,'');assert.match(dialog.title,/当前宿主/);}
 assert.match(f.warnings[0],/当前宿主 CLI 当前登录账户/);
});

test('mismatched extension/storage URI, browser and unsupported remote hosts block image generation',async()=>{
 const remote={scheme:'vscode-remote',authority:'wsl+Ubuntu',fsPath:'/remote/path'};const foreign={scheme:'file',authority:'other-host',fsPath:'/remote/path'};
 for(const options of [{uiKind:2},{extensionUri:remote},{globalStorageUri:remote},{extensionUri:foreign},{globalStorageUri:foreign},{extensionKind:2,remoteName:'ssh-remote'},{extensionKind:2,remoteName:'dev-container'}]){
  const f=setup(options);f.ui.remoteName=options.remoteName;f.open();await f.choose();await f.send(request);
  assert.equal(f.runs.length,0);assert.equal(f.dialogOptions.length,0);assert.match(f.diag.getStatus(),/原生扩展宿主/);
 }
});

test('foreign authorities and Windows-shaped image paths never replace a native output or read references',async()=>{
 const readPaths=[];const f=setup({readPng:async file=>{readPaths.push(file);return{info:{sha256:'checked-image'}};}});f.open();await f.choose();const local=f.messages.at(-1).outputDirectory;
 const choices=[{scheme:'vscode-remote',authority:'wsl+Ubuntu',fsPath:'/remote/image.png'},{scheme:'file',authority:'other-host',fsPath:'/remote/image.png'},{scheme:'file',fsPath:'/missing-authority/image.png'}];
 if(process.platform!=='win32')choices.push({scheme:'file',authority:'',fsPath:'C:\\Users\\user\\image.png'},{scheme:'file',authority:'',fsPath:'/C:/Users/user/image.png'});
 for(const choice of choices){f.dialogs.push([choice]);await f.send({type:'output'});assert.equal(f.messages.at(-1).outputDirectory,local);f.dialogs.push([choice]);await f.send({type:'references'});assert.deepEqual(f.messages.at(-1).references,[]);}
 assert.deepEqual(readPaths,[]);await f.send(request);assert.equal(f.runs.length,1);assert.equal(f.runs[0][0].outputDirectory,local);
});

test('image worker uses the current Node executable and environment without a cross-host launcher',async()=>{
 const {child}=workerStub();let spawned;const f=setup({spawn:(...args)=>{spawned=args;return child;}});const pending=f.api.runImageWorker(request,new AbortController().signal,()=>{});
 assert.equal(spawned[0],process.execPath);assert.deepEqual(spawned[1],[require('node:path').join(__dirname,'../out/legacy/image-worker.js')]);assert.equal(spawned[2].shell,false);assert.deepEqual(spawned[2].env,{...process.env,ELECTRON_RUN_AS_NODE:'1'},'preserve exact environment keys, including Windows Path casing');
 child.emit('message',{kind:'result',result:result([])});await pending;
});


test('typed foreign or relative image executable paths never reach confirmation or the worker',async()=>{
 const f=setup();f.open();await f.choose();const choices=['relative/path/agy','agy --version'];
 if(process.platform!=='win32')choices.push('C:\\Tools\\agy.exe','/C:/Tools/agy.exe');
 for(const executable of choices)await f.send({...request,executable});
 assert.equal(f.runs.length,0);assert.equal(f.warnings.length,0);assert.match(f.diag.getStatus(),/当前宿主可信任的原生可执行文件|当前宿主的原生 Linux agy CLI/);
});


test('Linux and WSL image requests reject Windows executable names and mounted paths before confirmation', {skip:process.platform!=='linux'}, async()=>{
 const f=setup({extensionKind:2});f.ui.remoteName='wsl';f.open();await f.choose();
 for(const executable of ['agy.exe','/mnt/c/Tools/agy.exe','/mnt/c/Tools/AGY.EXE','/usr/local/bin/agy.cmd','/usr/local/bin/agy.bat','/usr/local/bin/agy.ps1']){
  await f.send({...request,executable});assert.match(f.diag.getStatus(),/原生 Linux agy CLI/);
 }
 assert.equal(f.runs.length,0);assert.equal(f.warnings.length,0);
});

const folder=(name,directory)=>({name,uri:{scheme:'file',authority:'',fsPath:directory,path:directory,toString(){return 'file:'+directory;}}});
test('single opened workspace is the default image output without a folder dialog',async()=>{
 const directory=process.platform==='win32'?'C:\\project':'/workspace/project';const f=setup({workspaceFolders:[folder('project',directory)]});f.open();await f.send({type:'ready'});assert.equal(f.messages.at(-1).outputDirectory,directory);
 await f.send(request);assert.equal(f.dialogOptions.length,0);assert.equal(f.runs[0][0].outputDirectory,directory);assert.match(f.warnings[0],/保存目录/);
});
test('multi-root uses active editor workspace, otherwise asks for the project once',async()=>{
 const roots=[folder('a',process.platform==='win32'?'C:\\a':'/workspace/a'),folder('b',process.platform==='win32'?'C:\\b':'/workspace/b')];
 const active=setup({workspaceFolders:roots,activeWorkspace:roots[1]});active.open();await active.send(request);assert.equal(active.runs[0][0].outputDirectory,roots[1].uri.fsPath);assert.equal(active.calls.length,0);
 const ambiguous=setup({workspaceFolders:roots,pickWorkspace:1});ambiguous.open();await tick();await ambiguous.send(request);assert.equal(ambiguous.runs[0][0].outputDirectory,roots[1].uri.fsPath);assert.equal(ambiguous.calls.filter(v=>v[0]==='pickWorkspace').length,1);assert.equal(ambiguous.dialogOptions.length,0);
});
test('manual output override survives reopen and cancelling workspace choice never guesses',async()=>{
 const roots=[folder('a',process.platform==='win32'?'C:\\a':'/workspace/a'),folder('b',process.platform==='win32'?'C:\\b':'/workspace/b')];
 const f=setup({workspaceFolders:roots,activeWorkspace:roots[0]});f.open();await f.choose();const manual=f.messages.at(-1).outputDirectory;f.close();f.open();await f.send(request);assert.equal(f.runs[0][0].outputDirectory,manual);
 const cancelled=setup({workspaceFolders:roots,pickWorkspace:null});cancelled.open();await tick();await cancelled.send(request);assert.equal(cancelled.runs.length,0);assert.equal(cancelled.warnings.length,0);
});
test('closing while workspace picker is open cannot replace the reopened output',async()=>{
 const roots=[folder('a',process.platform==='win32'?'C:\\a':'/workspace/a'),folder('b',process.platform==='win32'?'C:\\b':'/workspace/b')];const f=setup({workspaceFolders:roots});f.open();f.close();await tick();f.open();await tick();await f.send(request);assert.equal(f.runs.length,1);
});
test('WSL workspace output resolves only after matching the actual workspace host and distro', {skip:process.platform!=='linux'}, async()=>{
 const old=process.env.WSL_DISTRO_NAME;process.env.WSL_DISTRO_NAME='Ubuntu';
 try{
  const uri={scheme:'vscode-remote',authority:'wsl+Ubuntu',path:'/home/me/project',fsPath:'/home/me/project',toString(){return 'vscode-remote://wsl+Ubuntu/home/me/project';}};
  const roots=[{name:'project',uri}];const f=setup({extensionKind:2,workspaceFolders:roots});f.ui.remoteName='wsl';f.open();await f.send(request);assert.equal(f.runs[0][0].outputDirectory,'/home/me/project');assert.equal(f.dialogOptions.length,0);
  for(const options of [{extensionKind:1,authority:'wsl+Ubuntu'},{extensionKind:2,authority:'wsl+Other'},{extensionKind:2,authority:'ssh-remote+server'}]){const other=setup({extensionKind:options.extensionKind,workspaceFolders:[{name:'foreign',uri:{...uri,authority:options.authority}}]});other.ui.remoteName='wsl';other.open();await other.send(request);assert.equal(other.runs.length,0);}
  delete process.env.WSL_DISTRO_NAME;assert.equal(f.api.imageHostPath(uri,2,'wsl'),undefined);
 }finally{if(old===undefined)delete process.env.WSL_DISTRO_NAME;else process.env.WSL_DISTRO_NAME=old;}
});
test('configuration diagnostics render only known sources and never raw config values',async()=>{
 const f=setup();f.open();await f.choose();f.setRun(async()=>{throw Object.assign(Error('IMAGE_EXTERNAL_CUSTOMIZATIONS_UNSUPPORTED'),{diagnostics:[{source:'~/.gemini/config/config.json',key:'userSettings.statusLine',reason:'存在全局工具执行或服务覆盖配置'},{source:'https://private.example/token',key:'PRIVATE_SECRET',reason:'raw private command'}]});});await f.send(request);assert.match(f.diag.getStatus(),/~\/\.gemini\/config\/config\.json → userSettings.statusLine/);assert.doesNotMatch(f.diag.getStatus(),/private.example|PRIVATE_SECRET|raw private command/);assert.equal(f.runs.length,1);
});
test('worker IPC preserves only sanitized configuration diagnostics',async()=>{
 const {child}=workerStub();const f=setup({spawn:()=>child});const pending=f.api.runImageWorker(request,new AbortController().signal,()=>{});child.emit('message',{kind:'error',code:'IMAGE_EXTERNAL_CUSTOMIZATIONS_UNSUPPORTED',diagnostics:[{source:'~/.gemini/config/hooks.json',key:'hooks',reason:'存在全局工具执行或服务覆盖配置'},{source:'/secret/location',reason:'private'}]});await assert.rejects(pending,error=>{assert.deepEqual(error.diagnostics,[{source:'~/.gemini/config/hooks.json',key:'hooks',reason:'存在全局工具执行或服务覆盖配置'}]);return true;});
});
test('WSL native workspace-host file URI defaults normally but desktop-side vscode-local is rejected', {skip:process.platform!=='linux'}, async()=>{
 const f=setup({extensionKind:2,workspaceFolders:[folder('current WSL','/home/me/project')]});f.ui.remoteName='wsl';f.open();await f.send(request);assert.equal(f.runs[0][0].outputDirectory,'/home/me/project');
 const other=setup({extensionKind:2,workspaceFolders:[{name:'desktop',uri:{scheme:'vscode-local',authority:'',path:'/C:/project',fsPath:'/C:/project'}}]});other.ui.remoteName='wsl';other.open();await other.send(request);assert.equal(other.runs.length,0);
});

const approvedScript={source:'~/.gemini/antigravity-cli/settings.json',key:'statusLine',sha256:'a'.repeat(64),preview:'node …（参数已隐藏）'};
test('known UI script permission is folded into generation confirmation and never persists',async()=>{
 const f=setup({reviewConfiguration:async()=>({scripts:[approvedScript]})});f.open();await f.choose();
 await f.send({...request,authorizedScripts:[approvedScript]});assert.equal(f.runs.length,0,'the ordinary generate button does not authorize scripts');
 assert.match(f.warnings[0],/读写本机文件、访问网络/);assert.match(f.warnings[0],/statusLine/);assert.match(f.warnings[0],/参数已隐藏/);assert.match(f.warnings[0],/不保存为以后授权/);
 f.ui.answer='允许本次界面脚本并生成';await f.send(request);assert.equal(f.runs.length,1);assert.deepEqual(f.runs[0][0].authorizedScripts,[{source:approvedScript.source,key:approvedScript.key,sha256:approvedScript.sha256}]);assert.equal(f.warnings.length,2);
 f.ui.answer=undefined;await f.send(request);assert.equal(f.runs.length,1);assert.equal(f.warnings.length,3);
});
test('cancel during script preflight or confirmation never launches the image worker',async()=>{
 const pending=deferred();const f=setup({reviewConfiguration:()=>pending.promise});f.open();await f.choose();await f.send(request);await f.send({type:'cancel'});pending.resolve({scripts:[approvedScript]});await tick();assert.equal(f.warnings.length,0);assert.equal(f.runs.length,0);
 const confirmation=deferred();const g=setup({reviewConfiguration:async()=>({scripts:[approvedScript]})});g.open();await g.choose();g.ui.confirmation=confirmation;await g.send(request);g.close();confirmation.resolve('允许本次界面脚本并生成');await tick();assert.equal(g.runs.length,0);
});

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test('configuration timeout is visible, releases controls and preserves draft/results for explicit retry',async()=>{
 const stalled=deferred();let checking=false;
 const f=setup({configurationTimeoutMs:10,reviewConfiguration:()=>checking?stalled.promise:Promise.resolve({scripts:[]})});f.open();await f.choose();
 f.setRun(async()=>result([output(1)]));await f.send(request);checking=true;
 await f.send({...request,prompt:'keep this draft',count:2});assert.equal(f.messages.at(-1).cancellable,true);assert.match(f.diag.getStatus(),/正在检查/);
 await delay(30);assert.equal(f.messages.at(-1).busy,false);assert.equal(f.messages.at(-1).errorCode,'IMAGE_CONFIGURATION_TIMEOUT');assert.equal(f.messages.at(-1).retryable,true);assert.match(f.diag.getStatus(),/尚未启动图片生成/);assert.equal(f.runs.length,1);assert.equal(f.warnings.length,1);
 await f.send({type:'ready'});assert.equal(f.messages.at(-1).draft.prompt,'keep this draft');assert.equal(f.messages.at(-1).images[0].name,'image-1.png');
 checking=false;await f.send(request);assert.equal(f.runs.length,2);stalled.resolve({scripts:[]});await tick();assert.equal(f.runs.length,2);assert.equal(f.messages.at(-1).errorCode,'');
});

test('cancel immediately releases a hung configuration check and its late result cannot launch a worker',async()=>{
 const stalled=deferred();let attempts=0;const f=setup({reviewConfiguration:()=>++attempts===1?stalled.promise:Promise.resolve({scripts:[]})});f.open();await f.choose();
 await f.send(request);await f.send({type:'cancel'});assert.equal(f.messages.at(-1).busy,false);assert.equal(f.messages.at(-1).cancellable,false);assert.equal(f.warnings.length,0);assert.match(f.diag.getStatus(),/已取消/);
 await f.send(request);assert.equal(f.runs.length,1);stalled.resolve({scripts:[approvedScript]});await tick();assert.equal(f.warnings.length,1);assert.equal(f.runs.length,1);assert.equal(f.runs[0][0].authorizedScripts,undefined);
});

test('late acceptance of a cancelled confirmation cannot start or unlock a newer confirmation',async()=>{
 const f=setup();f.open();await f.choose();const old=deferred(),next=deferred();f.ui.confirmation=old;await f.send(request);await f.send({type:'cancel'});assert.equal(f.messages.at(-1).busy,false);
 f.ui.confirmation=next;await f.send({...request,prompt:'new draft'});old.resolve('确认生成');await tick();assert.equal(f.runs.length,0);assert.equal(f.messages.at(-1).busy,true);assert.equal(f.messages.at(-1).cancellable,true);
 next.resolve('确认生成');await tick();assert.equal(f.runs.length,1);assert.equal(f.runs[0][0].prompt,'new draft');
});

test('closing a hung configuration check allows reopening and keeps stale inspection isolated',async()=>{
 const stalled=deferred();let attempts=0;const f=setup({reviewConfiguration:()=>++attempts===1?stalled.promise:Promise.resolve({scripts:[]})});f.open();await f.choose();await f.send(request);f.close();f.open();await tick();await f.send(request);assert.equal(f.runs.length,1);
 const current=f.diag.getStatus();stalled.resolve({scripts:[approvedScript]});await tick();assert.equal(f.runs.length,1);assert.equal(f.diag.getStatus(),current);
});

test('webview ready during generation restores draft, progress and previous previews without resubmission',async()=>{
 const f=setup();f.open();await f.choose();f.setRun(async()=>result([output(1)]));await f.send(request);const pending=deferred();f.setRun((_req,_signal,progress)=>{progress({phase:'generating',message:'第 1/3 张：正在生成'});return pending.promise;});
 await f.send({...request,prompt:'keep on reload',count:3});const current=f.diag.getStatus();await f.send({type:'ready'});const state=f.messages.at(-1);assert.equal(state.draft.prompt,'keep on reload');assert.equal(state.draft.count,3);assert.equal(state.status,current);assert.equal(state.busy,true);assert.equal(state.cancellable,true);assert.equal(state.images[0].name,'image-1.png');assert.equal(f.runs.length,2);
 pending.resolve(result([output(2)]));await tick();
});

test('a nonresponsive injected worker times out, aborts and ignores late progress without automatic retry',async()=>{
 const pending=deferred();let progress;const f=setup({workerTimeoutMs:10,cancelTimeoutMs:10});f.open();await f.choose();f.setRun((_request,_signal,report)=>{progress=report;return pending.promise;});await f.send(request);await delay(30);
 assert.equal(f.runs[0][1].aborted,true);assert.equal(f.messages.at(-1).busy,false);assert.equal(f.messages.at(-1).errorCode,'IMAGE_WORKER_TIMEOUT');assert.equal(f.messages.at(-1).retryable,true);assert.equal(f.runs.length,1);const current=f.diag.getStatus();progress({phase:'generating',message:'LATE'});pending.resolve(result([output(9)]));await tick();assert.equal(f.diag.getStatus(),current);assert.equal(f.messages.at(-1).images.length,0);
});

test('worker phase timeout requests cancel then disconnects a hung child with a readable error',async()=>{
 const {child,sent}=workerStub();const f=setup({spawn:()=>child});const pending=f.api.runImageWorker(request,new AbortController().signal,()=>{},{preparationMs:5,cancelMs:5});await assert.rejects(pending,/IMAGE_WORKER_TIMEOUT/);assert.ok(sent.includes('cancel'));assert.equal(child.connected,false);
});

test('worker cancellation has a bounded grace period when the child never replies',async()=>{
 const {child,sent}=workerStub();const f=setup({spawn:()=>child});const controller=new AbortController();const pending=f.api.runImageWorker(request,controller.signal,()=>{},{cancelMs:5});controller.abort();await assert.rejects(pending,/IMAGE_CANCEL_TIMEOUT/);assert.ok(sent.includes('cancel'));assert.equal(child.connected,false);
});

test('worker timeout keeps completed images returned during cancellation',async()=>{
 const {child}=workerStub();const originalSend=child.send;child.send=(message,callback)=>{originalSend(message,callback);if(message==='cancel')queueMicrotask(()=>child.emit('message',{kind:'result',result:result([output(1)],{requested:3,completed:1,outcome:'cancelled'})}));};
 const f=setup({spawn:()=>child});const completed=await f.api.runImageWorker({...request,count:3},new AbortController().signal,()=>{},{preparationMs:5,cancelMs:20});assert.equal(completed.images.length,1);assert.equal(completed.batch.outcome,'partial');assert.equal(completed.batch.error,'IMAGE_WORKER_TIMEOUT');
});

function webviewHarness(html){
 const elements=new Map(),sent=[],events=new Map();const element=()=>({value:'',disabled:false,hidden:false,textContent:'',children:[],replaceChildren(){this.children=[];},append(child){this.children.push(child);}});const el=id=>{if(!elements.has(id))elements.set(id,element());return elements.get(id);};
 for(const [id,value]of Object.entries({prompt:'a cloud',executable:'agy',ratio:'1:1',count:'1',size:'auto',quality:'auto'}))el(id).value=value;
 const code=html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];vm.runInNewContext(code,{acquireVsCodeApi:()=>({postMessage:m=>sent.push(JSON.parse(JSON.stringify(m)))}),document:{getElementById:el,createElement:element},window:{addEventListener:(name,handler)=>events.set(name,handler)}});
 return{el,sent,receive:state=>events.get('message')({data:state})};
}
test('webview gives immediate click and cancel feedback, and explicit retry is coalesced',()=>{
 const f=setup(),ui=webviewHarness(f.api.imageHtml()),state={type:'state',busy:false,status:'prior error',errorCode:'IMAGE_CLI_CAPABILITY_MISSING',retryable:true,references:[],outputDirectory:'/tmp/outputs',images:[]};ui.receive(state);assert.equal(ui.el('retry').hidden,false);assert.match(ui.el('statusBox').className,/error/);
 ui.el('retry').onclick();assert.match(ui.el('status').textContent,/已收到生成请求/);assert.equal(ui.el('busyIndicator').hidden,false);assert.equal(ui.el('cancel').disabled,false);const sent=ui.sent.length;ui.el('retry').onclick();ui.el('generate').onclick();assert.equal(ui.sent.length,sent);
 ui.el('cancel').onclick();assert.match(ui.el('status').textContent,/正在取消/);assert.deepEqual(ui.sent.at(-1),{type:'cancel'});ui.el('cancel').onclick();assert.equal(ui.sent.length,sent+1);
 ui.receive({...state,errorCode:'IMAGE_CANCELLED',retryable:false,status:'已取消'});assert.equal(ui.el('retry').hidden,true);assert.equal(ui.el('generate').disabled,false);ui.el('refreshStatus').onclick();assert.deepEqual(ui.sent.at(-1),{type:'ready'});
});

test('capability failures render sanitized actual executable and required flags without version pins',async()=>{
 const f=setup();f.open();await f.choose();f.setRun(async()=>{throw Object.assign(Error('IMAGE_CLI_CAPABILITY_MISSING'),{capabilities:{executable:'/usr/local/bin/agy',missingFlags:['--agent','--json-schema']}});});await f.send(request);assert.match(f.diag.getStatus(),/实际 CLI：\/usr\/local\/bin\/agy/);assert.match(f.diag.getStatus(),/缺少参数：--agent、--json-schema/);assert.equal(f.messages.at(-1).retryable,true);assert.doesNotMatch(Object.values(f.api.IMAGE_ERRORS).join('\n'),/1\.2\.14/);
 const {child}=workerStub();const g=setup({spawn:()=>child});const pending=g.api.runImageWorker(request,new AbortController().signal,()=>{});child.emit('message',{kind:'error',code:'IMAGE_CLI_PROBE_FAILED',capabilities:{executable:'/usr/local/bin/agy',missingFlags:[]}});await assert.rejects(pending,error=>{assert.deepEqual(error.capabilities,{executable:'/usr/local/bin/agy',missingFlags:[]});return true;});
});

test('trust loss during configuration yields an actionable error rather than a stuck checking status',async()=>{
 const pending=deferred();const f=setup({reviewConfiguration:()=>pending.promise});f.open();await f.choose();await f.send(request);f.ui.trusted=false;pending.resolve({scripts:[]});await tick();assert.equal(f.runs.length,0);assert.equal(f.warnings.length,0);assert.equal(f.messages.at(-1).busy,false);assert.equal(f.messages.at(-1).errorCode,'IMAGE_TRUSTED_LOCAL_DESKTOP_REQUIRED');
});

test('a closed native dialog cannot release the lock of a newer task',async()=>{
 const f=setup();f.open();await f.choose();const dialog=deferred();f.dialogs.push(dialog.promise);await f.send({type:'output'});f.close();f.open();const worker=deferred();f.setRun(()=>worker.promise);await f.send(request);assert.equal(f.runs.length,1);dialog.resolve([{scheme:'file',authority:'',fsPath:'/stale'}]);await tick();assert.equal(f.messages.at(-1).busy,true);assert.notEqual(f.messages.at(-1).outputDirectory,'/stale');worker.resolve(result([]));await tick();assert.equal(f.messages.at(-1).busy,false);
});

test('worker IPC disconnect cannot leave the image UI waiting for the phase deadline',async()=>{
 const {child}=workerStub();const f=setup({spawn:()=>child});const pending=f.api.runImageWorker(request,new AbortController().signal,()=>{});child.connected=false;child.emit('disconnect');await assert.rejects(pending,/IMAGE_WORKER_EXITED/);
});

test('watchdog terminates a harmless real nonresponsive worker before rejecting', {skip:process.platform==='win32'},async()=>{
 const spawn=require('node:child_process').spawn;let child;
 const f=setup({spawn:(_exe,_args,options)=>{child=spawn(process.execPath,['-e',"process.stdin.resume();process.on('message',()=>{});setInterval(()=>{},1000)"],options);return child;}});
 const pending=f.api.runImageWorker(request,new AbortController().signal,()=>{},{preparationMs:20,cancelMs:10,shutdownMs:10});await assert.rejects(pending,/IMAGE_WORKER_TIMEOUT/);assert.ok(child.pid);assert.notEqual(child.exitCode===null&&child.signalCode===null,true);assert.throws(()=>process.kill(child.pid,0),/ESRCH/);
});

test('live recovery checking and a transaction started during confirmation both block image submission',async()=>{
 let pending=true;const f=setup({accountRecoveryPending:()=>pending});f.open();await f.choose();await f.send(request);assert.equal(f.runs.length,0);assert.equal(f.messages.at(-1).errorCode,'IMAGE_ACCOUNT_RECOVERY_PENDING');
 pending=false;f.ui.confirmation=deferred();await f.send(request);pending=true;f.ui.confirmation.resolve('确认生成');await tick();assert.equal(f.runs.length,0);assert.equal(f.messages.at(-1).errorCode,'IMAGE_ACCOUNT_RECOVERY_PENDING');assert.equal(f.messages.at(-1).busy,false);
});

test('guard diagnosis is inline, redacted and distinguishes an already-allowed generation',async()=>{
 const f=setup();f.open();await f.choose();
 f.setRun(async()=>{throw Object.assign(new Error('IMAGE_REQUEST_SCOPE_DENIED'),{guard:{version:1,reason:'IMAGE_NAME',generationAllowed:false,SECRET:'PRIVATE'}});});await f.send(request);
 assert.match(f.diag.getStatus(),/ImageName/);assert.match(f.diag.getStatus(),/诊断代码：IMAGE_NAME/);assert.match(f.diag.getStatus(),/当前失败的单图任务尚未放行图片工具/);assert.doesNotMatch(f.diag.getStatus(),/PRIVATE|SECRET/);
 f.setRun(async()=>result([output(1)],{requested:2,completed:1,outcome:'partial',error:'IMAGE_REQUEST_SCOPE_DENIED',guard:{version:1,reason:'CALL_LIMIT',generationAllowed:true}}));await f.send({...request,count:2});
 assert.match(f.diag.getStatus(),/已保存 1 张 PNG/);assert.match(f.diag.getStatus(),/第二次调用已拦截/);assert.match(f.diag.getStatus(),/可能已消耗额度/);assert.match(f.diag.getStatus(),/重新生成会创建新任务并再次确认/);
});

test('worker IPC carries only whitelisted guard diagnostics to the extension host',async()=>{
 const {child}=workerStub();const f=setup({spawn:()=>child});const pending=f.api.runImageWorker(request,new AbortController().signal,()=>{});
 child.emit('message',{kind:'error',code:'IMAGE_REQUEST_SCOPE_DENIED',guard:{version:1,reason:'ARGUMENT_SHAPE',generationAllowed:false,secret:'DO_NOT_COPY'}});
 await assert.rejects(pending,error=>{assert.deepEqual(error.guard,{version:1,reason:'ARGUMENT_SHAPE',generationAllowed:false});assert.doesNotMatch(JSON.stringify(error),/DO_NOT_COPY|secret/);return true;});
});


test('location state tracks output selection immediately and never exposes prompt or references',async()=>{
 const changes=[];const f=setup({outputChanged:()=>changes.push('changed')});assert.equal(f.diag.getOutputDirectory(),'');f.open();await f.choose();
 const chosen=process.platform==='win32'?'C:\\outputs':'/tmp/outputs';assert.equal(f.diag.getOutputDirectory(),chosen);assert.deepEqual(changes,['changed']);
 await f.choose();assert.deepEqual(changes,['changed']);f.dialogs.push(undefined);await f.send({type:'output'});assert.equal(f.diag.getOutputDirectory(),chosen);
 f.dialogs.push([{scheme:'vscode-remote',authority:'ssh-remote+foreign',fsPath:'/foreign'}]);await f.send({type:'output'});assert.equal(f.diag.getOutputDirectory(),chosen);assert.deepEqual(changes,['changed']);
});


test('location getter follows default project on reopen and clears an unavailable automatic choice',()=>{
 const folders=[{name:'first',uri:{scheme:'file',authority:'',fsPath:process.platform==='win32'?'C:\\first':'/first'}}];let changes=0;
 const f=setup({workspaceFolders:folders,outputChanged:()=>changes++});f.open();assert.equal(f.diag.getOutputDirectory(),folders[0].uri.fsPath);assert.equal(changes,1);f.close();
 folders.splice(0);f.open();assert.equal(f.diag.getOutputDirectory(),'');assert.equal(changes,2);
});

test('debug image hooks persist exact worker-safe guard failure and exclude prompt, paths and unknown keys',async t=>{
 const {DebugRecorder,installDebugRecorder}=require('../out/debug-events'),records=[];
 const logger=new DebugRecorder({append:async(line,current)=>{if(current())records.push(JSON.parse(line));},flush:async()=>{},readLines:async()=>[],dispose(){}},{version:'0.13.2',platform:'linux',host:'local'});await logger.setEnabled(true);const installed=installDebugRecorder(logger);t.after(()=>installed.dispose());
 const f=setup();f.open();await f.choose();f.setRun(async(_request,_signal,progress)=>{progress({phase:'checking',message:'SECRET_STDERR'});progress({phase:'generating',message:'SECRET_PROGRESS'});throw Object.assign(Error('IMAGE_REQUEST_SCOPE_DENIED'),{guard:{version:1,reason:'UNKNOWN_ARGUMENT',generationAllowed:false,unknownFields:['SECRET_ARGUMENT_NAME']},prompt:'SECRET_PROMPT',token:'SECRET_TOKEN'});});
 await f.send({...request,prompt:'SECRET_PROMPT'});await tick();const ended=records.filter(x=>x.phase==='result');assert.equal(ended.length,1);assert.equal(ended[0].outcome,'failed');assert.deepEqual(ended[0].data,{code:'IMAGE_REQUEST_SCOPE_DENIED',guard:{version:1,reason:'UNKNOWN_ARGUMENT',generationAllowed:false}});assert.ok(records.some(x=>x.phase==='generating'));assert.doesNotMatch(JSON.stringify(records),/SECRET|outputs|cloud|prompt|token/);
 await logger.setEnabled(false);const count=records.length;await f.send(request);await tick();assert.equal(records.length,count);
});
test('debug image hooks identify partial output and modal cancellation without raw batch fields',async t=>{
 const {DebugRecorder,installDebugRecorder}=require('../out/debug-events'),records=[];const logger=new DebugRecorder({append:async(line,current)=>{if(current())records.push(JSON.parse(line));},flush:async()=>{},readLines:async()=>[],dispose(){}},{version:'0.13.2',platform:'linux',host:'local'});await logger.setEnabled(true);const installed=installDebugRecorder(logger);t.after(()=>installed.dispose());
 const f=setup();f.open();await f.choose();f.setRun(async()=>result([output(1)],{requested:3,completed:1,outcome:'partial',error:'SECRET_ERROR',guard:{version:1,reason:'CALL_LIMIT',generationAllowed:true}}));await f.send({...request,count:3});await tick();const partial=records.find(x=>x.outcome==='partial');assert.equal(partial.data.completedCount,1);assert.equal(partial.data.requestedCount,3);assert.equal(partial.data.code,'UNCLASSIFIED_ERROR');assert.equal(partial.data.guard.reason,'CALL_LIMIT');f.ui.answer=undefined;await f.send(request);await tick();assert.equal(records.filter(x=>x.phase==='result').at(-1).outcome,'cancelled');assert.doesNotMatch(JSON.stringify(records),/SECRET/);
});
