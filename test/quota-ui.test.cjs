const {test}=require('node:test');
const assert=require('node:assert/strict');
const Module=require('node:module');
const path=require('node:path');
const entry=path.resolve(__dirname,'../out/extension');
async function fixture(t){
 const commands=new Map(),subscriptions=[],calls={executed:[],documents:[],warnings:[],prompts:0,queries:0,reloads:0};
 const api={StatusBarAlignment:{Right:2},ThemeIcon:class{constructor(id){this.id=id}},Uri:{parse:s=>({scheme:s.split(':')[0],toString:()=>s})},EventEmitter:class{event=()=>({dispose(){}});fire(){}dispose(){}},commands:{registerCommand(n,f){commands.set(n,f);return {dispose(){}};},async executeCommand(...args){calls.executed.push(args);}},
 workspace:{getConfiguration:()=>({inspect:()=>undefined}),onDidChangeConfiguration:()=>({dispose(){}}),registerTextDocumentContentProvider:()=>({dispose(){}}),isTrusted:true,async openTextDocument(d){calls.documents.push(d);return d;}},
 window:{createStatusBarItem(){return{show(){},hide(){},dispose(){}}},registerWebviewViewProvider(){return {dispose(){}};},async showInputBox(){calls.prompts++;},async showWarningMessage(text){calls.warnings.push(text);},async withProgress(){calls.prompts++;},async showTextDocument(){calls.prompts++;},async showInformationMessage(){calls.prompts++;}}};
 const original=Module._load;Module._load=function(n,parent,main){if(n==='vscode')return api;if(n==='./debug-ui')return {registerDebugUi(){return {getState:()=>({enabled:false,storageUnavailable:false,available:false,canOpen:false,host:'local'})};}};if(n==='./live-ui')return {registerLiveUi(){return {getStatus:()=> 'idle',getAccounts:()=>[],getState:()=>({busy:false,pending:false,status:'idle',environment:{available:true,message:'local'}})};}};if(n==='./image-ui')return {registerImageUi(){}};if(n==='./snapshot-files')return {async readAccounts(){return [];},async ensurePrivateDirectory(){},async readSnapshotDirectory(){calls.reloads++;return {snapshots:[],failures:0,truncated:false};},async mutateAccounts(_d,fn){return fn([]);}};if(n==='./quota-query')return {async queryQuota(){calls.queries++;throw Error('must not silently replace hub identity with CLI identity')}};return original.call(this,n,parent,main);};
 delete require.cache[require.resolve(entry)];try{await require(entry).activate({globalStorageUri:{fsPath:'/private/storage'},globalState:{get:()=>undefined,update:async()=>{}},subscriptions,asAbsolutePath:p=>p});}finally{Module._load=original;}
 t.after(()=>subscriptions.forEach(d=>d.dispose()));return {calls,subscriptions,command:(n,...args)=>commands.get(`antigravityAccounts.${n}`)(...args)};
}
test('main Refresh uses the same inline identity-bound server query and keeps snapshots separate',async t=>{
 const f=await fixture(t),before=f.calls.reloads;await f.command('refresh');assert.deepEqual(f.calls.executed,[['antigravityAccounts.live.quota']]);assert.equal(f.calls.reloads,before);assert.equal(f.calls.queries,0);assert.deepEqual(f.calls.documents,[]);assert.equal(f.calls.prompts,0);assert.deepEqual(f.calls.warnings,[]);await f.command('reloadSnapshots');assert.equal(f.calls.reloads,before+1);
});
test('refresh forwards requested account identity only through its stored-id validation path',async t=>{
 const f=await fixture(t),id='00000000-0000-4000-8000-000000000001';await f.command('refresh',id);assert.deepEqual(f.calls.executed,[['antigravityAccounts.live.quota',id]]);assert.equal(f.calls.prompts,0);assert.equal(f.calls.queries,0);
});
test('disposed extension never starts another refresh or opens an editor',async t=>{
 const f=await fixture(t);for(const sub of f.subscriptions)sub.dispose();await f.command('refresh');assert.deepEqual(f.calls.executed,[]);assert.deepEqual(f.calls.documents,[]);
});
