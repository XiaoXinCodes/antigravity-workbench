const test=require('node:test'),assert=require('node:assert/strict'),Module=require('node:module'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const entry=require.resolve('../out/debug-ui');
const file=fsPath=>({scheme:'file',authority:'',fsPath});
function fixture(options={}){
 const commands=new Map(),calls=[],providers=new Map(),records=[];let answer,target,closed=false;
 const mock={env:{uiKind:1,remoteName:options.remoteName,clipboard:{writeText:async text=>calls.push(['copy',text])}},UIKind:{Desktop:1},Uri:{file,parse:value=>({scheme:'antigravity-debug-preview',authority:'',value})},EventEmitter:class{event=()=>({dispose(){}});fire(){calls.push(['previewChanged']);}dispose(){}},
 commands:{registerCommand:(id,fn)=>{commands.set(id,fn);return{dispose(){}};},executeCommand:async(...args)=>calls.push(['execute',...args])},
 workspace:{registerTextDocumentContentProvider:(scheme,provider)=>{providers.set(scheme,provider);return{dispose(){}};},openTextDocument:async uri=>{calls.push(['open',uri]);return{uri,getText:()=>providers.get(uri.scheme).provideTextDocumentContent(uri)};}},
 window:{showQuickPick:async options=>{calls.push(['quickPick',options]);return options.find(x=>x.command===answer)},showTextDocument:async doc=>{calls.push(['show',doc.getText()]);},showWarningMessage:async text=>calls.push(['warning',text]),showInformationMessage:async(text,...buttons)=>{calls.push(['info',text,...buttons]);return answer;},showSaveDialog:async config=>{calls.push(['saveDialog',config]);return target;}}};
 const previous=Module._load;Module._load=function(name,...args){return name==='vscode'?mock:previous.call(this,name,...args);};let api;try{delete require.cache[entry];api=require(entry);}finally{Module._load=previous;}
 const context={extension:{extensionKind:options.kind??1,packageJSON:{version:'0.13.2'}},globalStorageUri:options.uri??file(options.storage??path.resolve('/synthetic/storage')),subscriptions:[]};
 const store={append:async(line,current)=>{if(!closed&&current())records.push(line);},readLines:async()=>records,flush:async()=>{},dispose(){closed=true;}};
 const controller=api.registerDebugUi(context,()=>calls.push(['changed']),{store:options.store??store,diagnoseCatalog:options.diagnoseCatalog,revealCatalog:options.revealCatalog??(async()=>{calls.push(['revealCatalog']);}),...(options.runtime?{runtime:options.runtime}:{})});
 return{api,controller,context,calls,records,providers,command:(name,...args)=>commands.get('antigravityAccounts.debug.'+name)(...args),setAnswer:v=>answer=v,setTarget:v=>target=v,dispose:()=>context.subscriptions.forEach(x=>x.dispose())};
}
const tick=()=>new Promise(r=>setImmediate(r));
test('toggle starts OFF, does not persist enabling, ignores injected arguments, preserves records when OFF',async()=>{
 const f=fixture();assert.equal(f.controller.getState().enabled,false);assert.deepEqual(f.records,[]);await f.command('toggle','SECRET');assert.equal(f.controller.getState().enabled,false);await f.command('toggle');assert.equal(f.controller.getState().enabled,true);
 require('../out/debug-events').beginDebugOperation('account.quota').end('completed');await tick();const before=f.records.slice();await f.command('toggle');require('../out/debug-events').beginDebugOperation('account.quota').end('failed');assert.deepEqual(f.records,before);assert.equal(f.controller.getState().enabled,false);f.dispose();const next=fixture();assert.equal(next.controller.getState().enabled,false);next.dispose();
});
test('current-host paths stay literal across WSL, SSH and UI-host remote windows',()=>{
 const f=fixture(),resolve=f.api.resolveDebugLocation,c={extension:{extensionKind:2},globalStorageUri:file('/home/synthetic/.vscode-server/globalStorage/workbench')};
 const wsl=resolve(c,{platform:'linux',desktop:true,remoteName:'wsl'});assert.equal(wsl.directory,'/home/synthetic/.vscode-server/globalStorage/workbench/debug-logs');assert.equal(wsl.host,'wsl');assert.equal(wsl.canOpen,false);assert.doesNotMatch(wsl.directory,/wsl\$|Users/);
 const ssh=resolve(c,{platform:'linux',desktop:true,remoteName:'ssh-remote'});assert.equal(ssh.host,'remote');assert.equal(ssh.canOpen,false);
 const local=resolve({extension:{extensionKind:1},globalStorageUri:file('C:\\Users\\synthetic\\storage')},{platform:'win32',desktop:true,remoteName:'wsl'});assert.equal(local.host,'local');assert.equal(local.directory,'C:\\Users\\synthetic\\storage\\debug-logs');assert.equal(local.canOpen,true);f.dispose();
});
test('web, foreign-authority, remote URI and malformed storage are unavailable',()=>{
 const f=fixture(),resolve=f.api.resolveDebugLocation,ctx={extension:{extensionKind:1},globalStorageUri:file('/safe')};
 for(const uri of [{scheme:'file',authority:'remote',fsPath:'/safe'},{scheme:'vscode-remote',authority:'wsl+Ubuntu',fsPath:'/safe'},file('relative'),file('/path\nSECRET'),file('/C:/foreign'),file('C:\\foreign')])assert.equal(resolve({...ctx,globalStorageUri:uri},{platform:'linux',desktop:true}).available,false);
 assert.equal(resolve(ctx,{platform:'linux',desktop:false}).available,false);f.dispose();
});
test('remote folder command never reveals the UI-host path and copy ignores supplied values',async()=>{
 const f=fixture({kind:2,remoteName:'wsl'});await f.command('copyDirectory','SECRET');await f.command('openDirectory');assert.deepEqual(f.calls,[]);await f.command('copyDirectory');assert.deepEqual(f.calls,[['copy',f.controller.getState().directory]]);f.dispose();
});
test('empty preview is read-only and never opens a save dialog',async()=>{
 const f=fixture();await f.command('preview');assert.equal(f.providers.has('antigravity-debug-preview'),true);assert.ok(f.calls.find(x=>x[0]==='show'&&x[1].includes('暂无调试日志')));assert.equal(f.calls.some(x=>x[0]==='saveDialog'),false);f.dispose();
});
test('VS Code local userdata storage opens a log preview rather than silently returning',async()=>{
 const storage=path.resolve('/synthetic/profile/User/globalStorage/workbench'),f=fixture({uri:{scheme:'vscode-userdata',authority:'',fsPath:storage}});
 assert.equal(f.controller.getState().available,true);assert.equal(f.controller.getState().directory,path.join(storage,'debug-logs'));
 await f.command('preview');assert.ok(f.calls.find(x=>x[0]==='show'&&x[1].includes('暂无调试日志')));assert.equal(f.calls.some(x=>x[0]==='warning'||x[0]==='saveDialog'),false);f.dispose();
});
test('userdata log storage stays unavailable for foreign, malformed and remote workspace paths',()=>{
 const f=fixture(),resolve=f.api.resolveDebugLocation,c={extension:{extensionKind:1},globalStorageUri:{scheme:'vscode-userdata',authority:'',fsPath:'/synthetic/storage'}};
 for(const uri of [{...c.globalStorageUri,authority:'foreign'},{...c.globalStorageUri,fsPath:'relative'},{...c.globalStorageUri,fsPath:'/C:/foreign'},{...c.globalStorageUri,fsPath:'/synthetic\nforeign'}])assert.equal(resolve({...c,globalStorageUri:uri},{platform:'linux',desktop:true}).available,false);
 for(const remoteName of ['wsl','ssh-remote'])assert.equal(resolve({...c,extension:{extensionKind:2}},{platform:'linux',desktop:true,remoteName}).available,false);
 assert.equal(resolve(c,{platform:'linux',desktop:false}).available,false);f.dispose();
});
test('read failure reports its actual stage and safe OS category',async()=>{
 const f=fixture({store:{append:async()=>{},readLines:async()=>{throw Object.assign(new Error('private path'),{code:'EACCES'})},flush:async()=>{},dispose(){}}});
 await f.command('preview');const warning=f.calls.find(x=>x[0]==='warning')?.[1];
 assert.match(warning,/storage\.read \/ DEBUG_STORAGE_PERMISSION_DENIED/);
 assert.doesNotMatch(warning,/private path/);f.dispose();
});
test('export requires inspected immutable plaintext snapshot and explicit save action',async t=>{
 const dir=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'agw-debug-ui-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const target=path.join(dir,'report.txt'),f=fixture({storage:dir});t.after(f.dispose);
 await f.command('toggle');require('../out/debug-events').beginDebugOperation('image.generate').end('failed',{code:'IMAGE_REQUEST_SCOPE_DENIED',guard:{version:1,reason:'UNKNOWN_ARGUMENT',generationAllowed:false},prompt:'SECRET_PROMPT',accountId:'SECRET_ACCOUNT'});await tick();await f.command('toggle');
 f.setTarget(file(target));await f.command('preview');assert.equal(f.calls.some(x=>x[0]==='saveDialog'),false);await assert.rejects(fs.access(target));
 assert.equal(f.controller.getState().previewReady,true);await f.command('exportPreview');const exported=await fs.readFile(target,'utf8');const shown=f.calls.filter(x=>x[0]==='show').at(-1)[1];assert.equal(exported,shown);assert.doesNotMatch(exported,/SECRET|\/tmp\//);assert.match(exported,/UNKNOWN_ARGUMENT/);assert.ok(f.calls.findIndex(x=>x[0]==='show')<f.calls.findIndex(x=>x[0]==='saveDialog'));if(process.platform!=='win32')assert.equal((await fs.stat(target)).mode&0o777,0o600);
 await f.command('preview');await f.command('exportPreview');assert.equal(await fs.readFile(target,'utf8'),exported);assert.ok(f.calls.find(x=>x[0]==='warning'));
});
test('export cancellation, unknown action, foreign URI, injected path and disposal never write',async t=>{
 const dir=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'agw-debug-cancel-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const target=path.join(dir,'should-not-exist.txt'),f=fixture({storage:dir});await f.command('toggle');require('../out/debug-events').beginDebugOperation('account.capture').end('completed');
 await f.command('preview');await f.command('exportPreview');assert.ok(f.calls.some(x=>x[0]==='saveDialog'));f.setTarget({scheme:'vscode-remote',authority:'wsl+other',fsPath:target});await f.command('exportPreview');await f.command('exportPreview',{target});await assert.rejects(fs.access(target));f.dispose();f.setTarget(file(target));await f.command('exportPreview');await assert.rejects(fs.access(target));
});
test('export rejects existing files, symlinks and linked ancestors',async t=>{
 if(process.platform==='win32'){t.skip('Windows symlink creation may need privileges');return;}const dir=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'agw-debug-links-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const f=fixture();t.after(f.dispose);const original=path.join(dir,'existing.txt');await fs.writeFile(original,'SENTINEL');await assert.rejects(f.api.writeDebugExport(original,'safe'));const link=path.join(dir,'link');await fs.symlink(original,link);await assert.rejects(f.api.writeDebugExport(link,'safe'));const parent=path.join(dir,'parent');await fs.symlink(dir,parent);await assert.rejects(f.api.writeDebugExport(path.join(parent,'new.txt'),'safe'));assert.equal(await fs.readFile(original,'utf8'),'SENTINEL');
});


test('catalog diagnostic is explicit, single-flight and reports inline without opening a file',async()=>{
 let calls=0,reply;const f=fixture({diagnoseCatalog:async()=>{calls++;return new Promise(r=>reply=r)}});assert.equal(calls,0);await f.command('catalog','SENTINEL');assert.equal(calls,0);const pending=f.command('catalog');await tick();assert.equal(f.controller.getState().catalogBusy,true);assert.match(f.controller.getState().catalogReport,/正在核验/);assert.equal(f.controller.getState().enabled,false);assert.ok(f.calls.some(x=>x[0]==='revealCatalog'));await f.command('catalog');assert.equal(calls,1);
 reply('Synthetic sanitized catalog result');await pending;assert.equal(f.controller.getState().catalogBusy,false);assert.equal(f.controller.getState().catalogReport,'Synthetic sanitized catalog result');assert.equal(f.calls.some(x=>x[0]==='open'||x[0]==='show'),false);f.dispose();
});
test('disposing an in-flight catalog aborts and suppresses its late report',async()=>{
 let signal,reply;const f=fixture({diagnoseCatalog:async s=>{signal=s;return new Promise(r=>reply=r)}});await f.command('toggle');const pending=f.command('catalog');await tick();f.dispose();assert.equal(signal.aborted,true);reply('late');await pending;assert.equal(f.controller.getState().catalogReport,'');
});


test('hung catalog is bounded to sixty seconds and a late result cannot replace retry',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let late,calls=0;const f=fixture({diagnoseCatalog:async()=>++calls===1?new Promise(r=>late=r):'fresh result'});await f.command('toggle');const pending=f.command('catalog');await tick();t.mock.timers.tick(60000);await pending;
 assert.equal(f.controller.getState().catalogBusy,false);assert.match(f.controller.getState().catalogReport,/超时.*未完成对照/);assert.equal(f.controller.getState().catalogStopping,true);await f.command('catalog');assert.equal(calls,1);late('stale result');await tick();assert.match(f.controller.getState().catalogReport,/超时/);assert.equal(f.controller.getState().catalogStopping,false);await f.command('catalog');assert.equal(f.controller.getState().catalogReport,'fresh result');f.dispose();
});

test('catalog works with unavailable log storage and leaves logging off',async()=>{
 let queries=0;const f=fixture({uri:{scheme:'vscode-remote',authority:'remote',fsPath:'/safe'},diagnoseCatalog:async()=>{queries++;return 'safe result';}});
 await f.command('catalog');assert.equal(queries,1);assert.equal(f.controller.getState().available,false);assert.equal(f.controller.getState().enabled,false);assert.equal(f.controller.getState().catalogReport,'safe result');assert.deepEqual(f.records,[]);f.dispose();
});
test('failed reveal stops before any query and emits only a safe actionable fallback',async()=>{
 let queries=0;const f=fixture({revealCatalog:async()=>{throw Error('SECRET');},diagnoseCatalog:async()=>{queries++;return 'unexpected';}});
 await f.command('catalog');assert.equal(queries,0);assert.equal(f.controller.getState().catalogBusy,false);assert.match(f.controller.getState().catalogReport,/CATALOG_VIEW_UNAVAILABLE/);assert.equal(f.calls.filter(x=>x[0]==='warning').length,1);assert.doesNotMatch(JSON.stringify(f.calls),/SECRET/);f.dispose();
});
test('hung reveal is bounded before any directory request and late reveal cannot start it',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let reveal,queries=0;const f=fixture({revealCatalog:()=>new Promise(r=>reveal=r),diagnoseCatalog:async()=>{queries++;return 'unexpected';}});
 const pending=f.command('catalog');await tick();t.mock.timers.tick(5000);await pending;assert.equal(queries,0);assert.match(f.controller.getState().catalogReport,/CATALOG_VIEW_UNAVAILABLE/);reveal();await tick();assert.equal(queries,0);f.dispose();
});
test('closing extension while revealing cancels before any query and leaves no warning',async()=>{
 let reveal,queries=0;const f=fixture({revealCatalog:()=>new Promise(r=>reveal=r),diagnoseCatalog:async()=>{queries++;return 'unexpected';}});
 const pending=f.command('catalog');await tick();f.dispose();await pending;reveal();await tick();assert.equal(queries,0);assert.equal(f.controller.getState().catalogReport,'');assert.equal(f.calls.some(x=>x[0]==='warning'),false);
});
test('catalog failure is inline and safe, with no popup or log editor',async()=>{
 const f=fixture({diagnoseCatalog:async()=>{throw Error('SECRET');}});await f.command('catalog');assert.match(f.controller.getState().catalogReport,/目录查询失败/);assert.doesNotMatch(f.controller.getState().catalogReport,/SECRET/);assert.equal(f.calls.some(x=>['open','show','warning','info'].includes(x[0])),false);f.dispose();
});

test('advanced tools route only an explicitly selected fixed command and keep logging off',async()=>{
 const f=fixture();await f.command('tools','INJECTED');assert.equal(f.calls.length,0);f.setAnswer('debug.preview');await f.command('tools');assert.ok(f.calls.some(c=>c[0]==='execute'&&c[1]==='antigravityAccounts.debug.preview'));assert.equal(f.controller.getState().enabled,false);f.dispose();
});
test('closing diagnostic retires a late result, repeated command shows stopping, and later retry works',async()=>{
 let reply,queries=0;const f=fixture({diagnoseCatalog:async()=>++queries===1?new Promise(r=>reply=r):'new result'});
 const first=f.command('catalog');await tick();await f.command('dismissCatalog');await first;assert.equal(f.controller.getState().catalogReport,'');assert.equal(f.controller.getState().catalogBusy,false);
 await f.command('catalog');assert.match(f.controller.getState().catalogReport,/正在停止/);assert.equal(queries,1);
 reply('late result');await tick();assert.doesNotMatch(f.controller.getState().catalogReport,/late result/);await f.command('catalog');assert.equal(f.controller.getState().catalogReport,'new result');assert.equal(queries,2);f.dispose();
});
