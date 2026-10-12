const {test}=require('node:test'),assert=require('node:assert/strict'),Module=require('node:module');
const panels=[],commands=new Map(),writes=[],actions=[],subscriptions=[],values={language:'zh-CN','hideIdentity':false,'images.endpoint':'daily'};let finishWrite;
const mock={ViewColumn:{Active:1},ConfigurationTarget:{Global:1},workspace:{getConfiguration:()=>({inspect:key=>({globalValue:values[key],workspaceValue:key==='language'?'en':undefined}),update:(key,value,target)=>{writes.push({key,value,target});return new Promise(resolve=>finishWrite=()=>{values[key]=value;resolve()})}}),onDidChangeConfiguration:()=>({dispose(){}}),openTextDocument:async()=>({})},commands:{registerCommand:(id,fn)=>{commands.set(id,fn);return{dispose(){}}},executeCommand:async(...args)=>actions.push(args)},window:{showWarningMessage(){},showTextDocument:async()=>{},createWebviewPanel:()=>{
 let receive,close;const messages=[];const p={webview:{html:'',postMessage:async m=>messages.push(m),onDidReceiveMessage:fn=>{receive=fn;return{dispose(){}}}},reveal(){},onDidDispose:fn=>{close=fn;return{dispose(){}}},dispose(){close?.()},receive:m=>receive(m),messages};panels.push(p);return p;
}}};
const old=Module._load;Module._load=function(name,...args){return name==='vscode'?mock:old.call(this,name,...args)};
const {registerWorkbenchSupport,supportHtml}=require('../out/workbench-support-ui');Module._load=old;
test('global settings reject unsafe keys/values, coalesce duplicates, and discard late replies after a closed page',async()=>{
 registerWorkbenchSupport({subscriptions,extension:{packageJSON:{version:'0.1.13'}}},{helpUri:{},debug:()=>({enabled:false,host:'local'})});
 commands.get('antigravityAccounts.openSettings')();const p=panels.at(-1);await p.receive({type:'ready'});
 assert.equal(p.messages.at(-1).language,'zh-CN');assert.equal(writes.length,0);
 for(const m of [{type:'setting',key:'language',value:{}},{type:'setting',key:'language',value:'fr'},{type:'setting',key:'images.endpoint',value:'https://unsafe'},{type:'setting',key:'credentials',value:'secret'},{type:'setting',key:'hideIdentity',value:'true'},{type:'setting',key:'language',value:'en',scope:'workspace'}])await p.receive(m);
 assert.equal(writes.length,0);const first=p.receive({type:'setting',key:'language',value:'en'});await p.receive({type:'setting',key:'language',value:'en'});assert.deepEqual(writes,[{key:'language',value:'en',target:1}]);
 const before=p.messages.length;p.dispose();finishWrite();await first;assert.equal(p.messages.length,before);await p.receive({type:'setting',key:'hideIdentity',value:true});assert.equal(writes.length,1);
});
test('help and diagnostics keep bounded actions; language controls exist only in settings',async()=>{
 for(const page of ['settings','help','diagnostics']){const html=supportHtml(page,'nonce');assert.match(html,/default-src 'none'/);assert.match(html,/style-src 'nonce-nonce'/);assert.equal(html.includes('id="support-language"'),page==='settings');assert.doesNotMatch(html,/synthetic-preview|@example\.test|demo-/);}
 commands.get('antigravityAccounts.support.diagnostics')();const p=panels.at(-1);await p.receive({type:'action',action:'workbench.action.terminal.new'});await p.receive({type:'action',action:'catalog',path:'/private'});assert.equal(actions.length,0);
 await p.receive({type:'action',action:'previewLogs'});assert.deepEqual(actions,[['antigravityAccounts.debug.preview']]);p.dispose();await p.receive({type:'action',action:'toggleLogs'});assert.equal(actions.length,1);
 for(const sub of subscriptions)sub.dispose();
});
