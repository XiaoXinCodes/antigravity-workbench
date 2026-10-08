const test=require('node:test'),assert=require('node:assert/strict'),Module=require('node:module'),fs=require('node:fs'),path=require('node:path');
const api=require('../out/i18n'),{zhCN}=require('../out/i18n-zh'),{en}=require('../out/i18n-en');
const key=text=>Object.keys(zhCN).find(k=>zhCN[k]===text);
const load=(name,vscode)=>{const id=require.resolve('../out/'+name),old=Module._load;delete require.cache[id];Module._load=function(n,...args){return n==='vscode'?vscode:old.call(this,n,...args)};try{return require(id)}finally{Module._load=old}};
test.afterEach(()=>api.setLanguage('zh-CN'));
test('complete catalogs retain identical interpolation contracts and default to Simplified Chinese',()=>{
 assert.equal(api.locale(),'zh-CN');assert.ok(Object.keys(zhCN).length>=849);assert.deepEqual(Object.keys(en).sort(),Object.keys(zhCN).sort());
 for(const k of Object.keys(zhCN)){const args=s=>[...s.matchAll(/\{([\w]+)\}/g)].map(m=>m[1]).sort();assert.deepEqual(args(en[k]),args(zhCN[k]),k);assert.ok(en[k].trim());assert.doesNotMatch(en[k],/[\u3400-\u9fff]/u,k);}
});
test('missing keys fall back safely; interpolation never interprets parameters or inherited properties',()=>{
 const dictionaries={'zh-CN':{known:'中文 {name}'},en:{}};assert.equal(api.translate('known',{name:'<img onerror=x>{other}'},'en',dictionaries),'中文 <img onerror=x>{other}');assert.equal(api.translate('__proto__',{},'en',dictionaries),'__proto__');assert.equal(api.translate('missing',{},'en',dictionaries),'missing');
 assert.equal(api.interpolate('{own} {inherited}',Object.assign(Object.create({inherited:'unsafe'}),{own:'$&'})),'$& {inherited}');
 assert.equal(api.escapeText('<img "x" &>'), '&lt;img &quot;x&quot; &amp;&gt;');
});
test('manual global setting persists on reactivation and ignores system, workspace and invalid values',()=>{
 let value,changed;const subscriptions=[];const vscode={env:{language:'en'},workspace:{getConfiguration:()=>({inspect:()=>({globalValue:value,workspaceValue:'en'})}),onDidChangeConfiguration:fn=>{changed=fn;return{dispose(){}}}}};
 const {registerI18n,LANGUAGE_SETTING}=load('i18n-vscode',vscode);registerI18n({subscriptions});assert.equal(api.locale(),'zh-CN');value='en';changed({affectsConfiguration:k=>k===LANGUAGE_SETTING});assert.equal(api.locale(),'en');
 api.setLanguage('zh-CN');registerI18n({subscriptions});assert.equal(api.locale(),'en');value='unknown';changed({affectsConfiguration:()=>true});assert.equal(api.locale(),'zh-CN');for(const v of [null,{},'EN','en\n','__proto__']){api.setLanguage(v);assert.equal(api.locale(),'zh-CN')}
});
test('open workbench changes language without dispatch, preserves names and IDs, and renders saved/update states consistently',()=>{
 let received,html='',dispatches=0;const vscode={commands:{executeCommand:()=>{dispatches++}},window:{showWarningMessage(){}}};const {WorkbenchView}=load('workbench-view',vscode);
 const account={id:'11111111-1111-4111-8111-111111111111',label:'已保存 <img onerror=x>',expectedEmail:'synthetic@example.test',hostCurrent:true};let save='saved';const provider=new WorkbenchView(()=>({accounts:[account],activeEmail:account.expectedEmail,activeVerifiedAt:new Date().toISOString(),currentLoginSave:save,snapshots:[],busy:false,pending:false,status:'准备就绪',warning:null,environment:{available:true,message:'local'}}));
 const webview={options:{},set html(v){html=v},get html(){return html},onDidReceiveMessage:fn=>{received=fn;return{dispose(){}}},postMessage:async()=>{}};provider.resolveWebviewView({webview,onDidDispose:()=>({dispose(){}})});assert.match(html,/已保存/);api.setLanguage('en');assert.match(html,/<html lang="en"/);assert.match(html,/data-command="live.capture" disabled[^>]*>Saved/);assert.match(html,/current login/);assert.match(html,/已保存 &lt;img onerror=x&gt;/);assert.match(html,new RegExp(account.id));assert.doesNotMatch(html,/<img onerror=x>/);assert.equal(dispatches,0);assert.equal(typeof received,'function');save='update';provider.refresh();assert.match(html,/>Update credentials<\/button>/);provider.dispose();const before=html;api.setLanguage('zh-CN');assert.equal(html,before);
});
test('generated persisted statuses relocalize parameters accurately, preserving user text and technical error codes',()=>{
 const original=api.t(key('已安全保存 {p0}；切换尚未执行'),{p0:'已保存 / 中文账号'});const nested=api.t(key('当前登录尚未就绪，正在自动重试。{p0}'),{p0:api.t(key('官方后台尚未就绪。请打开 Google Antigravity 面板，等待启动完成后重试。'))});api.setLanguage('en');assert.equal(api.localizeMessage(original),'Securely saved 已保存 / 中文账号; no switch performed');assert.doesNotMatch(api.localizeMessage(nested),/[\u3400-\u9fff]/u);assert.match(api.localizeMessage('此账户的加密登录副本已不可用。请删除记录后重新添加该账户。（SECURE_LOGIN_MISSING）'),/unavailable.*SECURE_LOGIN_MISSING/);
 const start=Date.now();assert.equal(api.localizeMessage('未知 '+ 'x'.repeat(4000)),'未知 '+ 'x'.repeat(4000));assert.ok(Date.now()-start<1000);
});
test('already loaded multiline operation history changes language and preserves catalog model IDs without image in the name',()=>{
 const {imageOperationStart,readImageOperation,formatImageOperations}=require('../out/image-operation-record');
 const record=imageOperationStart({accountId:'11111111-1111-4111-8111-111111111111',modelId:'gemini-nano-banana-2.1',aspectRatio:'16:9',prompt:'opaque user text'});
 record.responses=[{httpStatus:200},{httpStatus:429,code:'HTTP_429'}];
 assert.equal(readImageOperation(record).model,'gemini-nano-banana-2.1');
 const history=formatImageOperations([record,record]);api.setLanguage('en');const translated=api.localizeLines(history);
 assert.doesNotMatch(translated,/[\u3400-\u9fff]/u);assert.match(translated,/gemini-nano-banana-2\.1/);assert.match(translated,/HTTP_429/);
});
test('image error explanations use the chosen language and never expose arbitrary response text',()=>{
 const {liveErrorMessage}=load('live-ui',{}),{formatImageFailure}=require('../out/direct-image-http-error');api.setLanguage('en');assert.match(liveErrorMessage('CAPTURE_ACCOUNT_AMBIGUOUS'),/Multiple records/);assert.match(liveErrorMessage('SECURE_LOGIN_MISSING'),/encrypted login copy/);assert.doesNotMatch(formatImageFailure(Error('IMAGE_SAVED_MODELS_TRANSIENT')),/[\u3400-\u9fff]/u);assert.doesNotMatch(formatImageFailure(Error('synthetic-private-server-text')),/synthetic-private-server-text/);
});
test('native manifest keys are complete in both catalogs and expose one application-scoped language setting',()=>{
 const manifest=require('../package.json'),base=require('../package.nls.json'),zh=require('../package.nls.zh-cn.json');assert.deepEqual(Object.keys(base).sort(),Object.keys(zh).sort());const settings=manifest.contributes.configuration.properties,language=settings['antigravityAccounts.language'];assert.equal(language.default,'zh-CN');assert.equal(language.scope,'application');assert.deepEqual(language.enum,['zh-CN','en']);
 const refs=JSON.stringify(manifest.contributes).match(/%([^%]+)%/g)||[];for(const ref of refs){assert.ok(base[ref.slice(1,-1)],ref);assert.ok(zh[ref.slice(1,-1)],ref)}assert.match(base['command.openSettings'],/Settings.*设置/);assert.match(zh['setting.language.description'],/Language/);
});
test('already open help keeps its URI and reads selected-language docs after the locale changes',async()=>{
 let provider,notifications=0;const subscriptions=[];const uri=(scheme,p)=>({scheme,fsPath:p,toString:()=>scheme+':'+p});const vscode={Uri:{parse:s=>uri(s.split(':')[0],s.slice(s.indexOf(':')+1)),joinPath:(root,...p)=>uri('file',path.join(root.fsPath,...p))},EventEmitter:class{event=()=>({dispose(){}});fire(){notifications++}dispose(){}},workspace:{registerTextDocumentContentProvider:(_s,p)=>{provider=p;return{dispose(){}}}}};
 const {registerLocalizedHelp}=load('localized-help',vscode),ref=registerLocalizedHelp({extensionUri:uri('file',path.resolve(__dirname,'..')),subscriptions});assert.match(await provider.provideTextDocumentContent(ref),/使用指南/);api.setLanguage('en');assert.match(await provider.provideTextDocumentContent(ref),/Workbench guide/);assert.equal(notifications,1);for(const sub of subscriptions)sub.dispose();
});
test('production rendering sources contain no untranslated presentation literals; native parsing values remain stable',()=>{
 const ts=require('typescript');const allowed=new Set(['本机 PNG','原始']);for(const file of fs.readdirSync(path.join(__dirname,'../src')).filter(f=>f.endsWith('.ts')&&!f.startsWith('i18n'))){const source=fs.readFileSync(path.join(__dirname,'../src',file),'utf8'),tree=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true);function visit(node){if(ts.isStringLiteral(node)&&/[\u3400-\u9fff]/u.test(node.text))assert.ok(allowed.has(node.text),file+': '+node.text);ts.forEachChild(node,visit)}visit(tree)}
});
