const test=require('node:test'),assert=require('node:assert/strict'),Module=require('node:module');
function fixture(){
 const state={calls:[],saved:true};
 const vscode={env:{remoteName:'wsl'},workspace:{workspaceFile:undefined,workspaceFolders:[{uri:{toString:()=> 'vscode-remote://wsl+fixture/home/project'}}],textDocuments:[],notebookDocuments:[],saveAll:async include=>{assert.equal(include,true);state.calls.push('save');state.afterSave?.();return state.saved;}},window:{tabGroups:{all:[{tabs:[]}]}},commands:{executeCommand:async name=>state.calls.push(name)}};
 const original=Module._load,id=require.resolve('../out/vscode-window-participant');delete require.cache[id];
 Module._load=function(name,...args){if(name==='vscode')return vscode;if(name==='./live-lock')return{probeProcessIdentity:async()=>({state:'alive',startIdentity:'birth'})};return original.call(this,name,...args);};
 let api;try{api=require(id);}finally{Module._load=original;delete require.cache[id];}return{api,state,vscode};
}
test('current window capture uses runtime workspace and explicitly cannot name profile',async()=>{
 const f=fixture(),s=await f.api.captureCurrentWindow();assert.equal(s.host.pid,process.pid);assert.equal(s.profile,'not-exposed-by-public-api');assert.equal(s.remoteName,'wsl');assert.equal(s.workspace.kind,'folder');assert.deepEqual(f.state.calls,[]);
 f.vscode.workspace.workspaceFile={scheme:'untitled',toString:()=> 'untitled:workspace'};assert.equal((await f.api.captureCurrentWindow()).workspace,null);
});
test('save cancellation and remaining dirty custom editor prevent close',async()=>{
 for(const dirty of [false,true]){const f=fixture(),s=await f.api.captureCurrentWindow();f.state.saved=dirty;f.vscode.window.tabGroups.all[0].tabs=[{isDirty:dirty}];await assert.rejects(f.api.requestCurrentWindowClose(s,async()=>{}),{code:'WINDOW_SAVE_CANCELLED'});assert.deepEqual(f.state.calls,['save']);}
});
test('changed workspace after save refuses close',async()=>{
 const f=fixture(),s=await f.api.captureCurrentWindow();f.state.afterSave=()=>{f.vscode.workspace.workspaceFolders=[];};await assert.rejects(f.api.requestCurrentWindowClose(s,async()=>{}),{code:'WINDOW_PARTICIPANTS_CHANGED'});assert.deepEqual(f.state.calls,['save']);
});
test('missing or withdrawn durable handoff refuses native close',async()=>{
 for(const afterSave of [false,true]){const f=fixture(),s=await f.api.captureCurrentWindow();let count=0;await assert.rejects(f.api.requestCurrentWindowClose(s,async()=>{if(++count>Number(afterSave))throw Error('HANDOFF_WITHDRAWN');}),/HANDOFF_WITHDRAWN/);assert.deepEqual(f.state.calls,afterSave?['save']:[]);}
});
test('validated request calls only current native close, with no discard or quit-all',async()=>{
 const f=fixture(),s=await f.api.captureCurrentWindow();await f.api.requestCurrentWindowClose(s,async()=>{});assert.deepEqual(f.state.calls,['save','workbench.action.closeWindow']);
});
