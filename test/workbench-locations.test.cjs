const {test}=require('node:test'),assert=require('node:assert/strict'),Module=require('node:module'),os=require('node:os'),path=require('node:path');
const commands=new Map(),copies=[],opens=[];
const env={uiKind:1,remoteName:undefined,clipboard:{writeText:async text=>copies.push(text)}};
const original=Module._load;Module._load=function(name,...args){if(name==='vscode')return{env,UIKind:{Desktop:1},commands:{registerCommand:(id,fn)=>{commands.set(id,fn);return{dispose(){}};},executeCommand:async(...args)=>opens.push(args)}};return original.call(this,name,...args);};
const {resolveWorkbenchLocations,registerWorkbenchLocations}=require('../out/workbench-locations');Module._load=original;
const file=fsPath=>({scheme:'file',authority:'',fsPath});
const context=(kind=1,extensionPath='/extension')=>({extension:{extensionKind:kind},extensionUri:file(extensionPath),globalStorageUri:file('/storage'),subscriptions:[]});
const runtime={platform:'linux',home:'/home/synthetic',desktop:true};
test('native VS Code userdata storage does not hide local installed extension and output paths',()=>{
 const c=context();c.globalStorageUri={scheme:'vscode-userdata',authority:'',fsPath:'/synthetic/profile/storage'};
 const result=resolveWorkbenchLocations(c,'/synthetic/output',runtime);
 assert.equal(result.extensionPath,'/extension');assert.equal(result.credentialPath,'/home/synthetic/.gemini/jetski-standalone-oauth-token');assert.equal(result.imageOutputPath,'/synthetic/output');assert.equal(result.canOpenExtension,true);
});
test('locations derive installed extension and current-host credential paths without token reads',()=>{
 const result=resolveWorkbenchLocations(context(),'/project/images',runtime);
 assert.deepEqual(result,{host:'本机 Linux',extensionPath:'/extension',credentialPath:'/home/synthetic/.gemini/jetski-standalone-oauth-token',imageOutputPath:'/project/images',canOpenExtension:true});
 const mac=resolveWorkbenchLocations(context(2,'/Users/test/extensions/actual-version'),'',{...runtime,platform:'darwin',home:'/Users/test'});
 assert.equal(mac.extensionPath,'/Users/test/extensions/actual-version');assert.equal(mac.credentialPath,'/Users/test/.gemini/jetski-standalone-oauth-token');assert.equal(mac.imageOutputPath,undefined);assert.equal(mac.canOpenExtension,true);
});
test('WSL shows Linux paths but never reveals them in the Windows file manager',()=>{
 const result=resolveWorkbenchLocations(context(2,'/home/synthetic/.vscode-server/extensions/installed'),'/home/synthetic/project',{...runtime,remoteName:'wsl'});
 assert.equal(result.host,'WSL · Linux');assert.equal(result.canOpenExtension,false);assert.equal(result.credentialPath,'/home/synthetic/.gemini/jetski-standalone-oauth-token');assert.equal(result.imageOutputPath,'/home/synthetic/project');assert.doesNotMatch(JSON.stringify(result),/wsl\$/);
});
test('local Windows UI host in a WSL window derives Windows HOME, not remote workspace roots',()=>{
 const result=resolveWorkbenchLocations(context(1,'D:\\VSCode\\extensions\\actual'), 'C:\\projects\\images',{platform:'win32',home:'C:\\Users\\synthetic',desktop:true,remoteName:'wsl'});
 assert.equal(result.host,'本机 Windows');assert.equal(result.canOpenExtension,true);assert.equal(result.credentialPath,'C:\\Users\\synthetic\\.gemini\\jetski-standalone-oauth-token');
});
test('foreign, network, web, unverified hosts and malformed paths are not actionable',()=>{
 for(const [scheme,authority] of [['vscode-remote','wsl+Ubuntu'],['file','other-host'],['https','example.test']]){
  const c=context();c.extensionUri={...c.extensionUri,scheme,authority};const result=resolveWorkbenchLocations(c,'/out',runtime);assert.equal(result.canOpenExtension,false);assert.equal(result.extensionPath,undefined);assert.equal(result.credentialPath,undefined);
 }
 for(const r of [{...runtime,desktop:false},{...runtime,remoteName:'ssh-remote'}])assert.equal(resolveWorkbenchLocations(context(2),'/out',r).extensionPath,undefined);
 for(const invalid of ['relative','C:\\Windows\\secret','/C:/Windows/secret','/home/test\nsecret']){
  const result=resolveWorkbenchLocations(context(1,invalid),invalid,{...runtime,home:invalid});assert.equal(result.extensionPath,undefined);assert.equal(result.credentialPath,undefined);assert.equal(result.imageOutputPath,undefined);assert.equal(result.canOpenExtension,false);
 }
});
test('clipboard and reveal commands accept no arguments and use only live known paths',async()=>{
 commands.clear();copies.length=0;opens.length=0;env.remoteName=undefined;env.uiKind=1;
 const extension=process.platform==='win32'?'C:\\extensions\\actual':'/extensions/actual',output=process.platform==='win32'?'C:\\images':'/images';const c=context(1,extension);let current='';const api=registerWorkbenchLocations(c,()=>current);
 for(const name of ['copyExtension','copyCredentials','copyImageOutput','openExtension'])await commands.get(`antigravityAccounts.locations.${name}`)('/PRIVATE_TOKEN');
 assert.deepEqual(copies,[]);assert.deepEqual(opens,[]);
 await commands.get('antigravityAccounts.locations.copyImageOutput')();assert.deepEqual(copies,[]);
 await commands.get('antigravityAccounts.locations.copyExtension')();await commands.get('antigravityAccounts.locations.copyCredentials')();current=output;await commands.get('antigravityAccounts.locations.copyImageOutput')();
 assert.deepEqual(copies,[extension,path.join(os.homedir(),'.gemini','jetski-standalone-oauth-token'),output]);assert.equal(api.getState().imageOutputPath,output);
 await commands.get('antigravityAccounts.locations.openExtension')();assert.deepEqual(opens,[['revealFileInOS',c.extensionUri]]);
 env.remoteName='wsl';c.extension.extensionKind=2;await commands.get('antigravityAccounts.locations.openExtension')();assert.equal(opens.length,1);
 for(const sub of c.subscriptions)sub.dispose();env.remoteName=undefined;await commands.get('antigravityAccounts.locations.copyExtension')();assert.equal(copies.length,3);
});
