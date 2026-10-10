// Launch a separate development extension with production UI and synthetic accounts.
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {runTests}=require('@vscode/test-electron');
(async()=>{
 const profile=await fs.mkdtemp(path.join(os.tmpdir(),'ag-quota-ui-')),extension=path.join(profile,'synthetic-extension'),evidence=path.resolve(__dirname,'../.test-results/quota-ui-host');await fs.mkdir(extension);await fs.mkdir(evidence,{recursive:true});
 await fs.rm(path.join(evidence,'result.json'),{force:true});
 const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port))})});
 await fs.writeFile(path.join(extension,'package.json'),JSON.stringify({name:'quota-ui-fixture',publisher:'synthetic',version:'0.0.1',engines:{vscode:'^1.95.0'},main:'./main.cjs',activationEvents:['onStartupFinished'],contributes:{viewsContainers:{activitybar:[{id:'syntheticQuota',title:'Synthetic quota UI',icon:'./workbench.svg'}]},views:{syntheticQuota:[{id:'antigravityAccounts.accounts',name:'合成额度测试',type:'webview'}]}}}));
 await fs.copyFile(path.resolve(__dirname,'../media/workbench.svg'),path.join(extension,'workbench.svg'));
 await fs.writeFile(path.join(extension,'main.cjs'),'module.exports=require('+JSON.stringify(path.resolve(__dirname,'../test/fixtures/quota-host-extension.cjs'))+');');
 try{await runTests({version:process.env.AG_VSCODE_TEST_VERSION||'stable',extensionDevelopmentPath:extension,extensionTestsPath:path.resolve(__dirname,'../test/quota-host-suite.cjs'),extensionTestsEnv:{HOME:profile,USERPROFILE:profile,AG_QUOTA_CDP_PORT:String(port),AG_QUOTA_EVIDENCE:evidence},launchArgs:['--no-sandbox','--disable-gpu','--disable-extensions','--skip-welcome','--skip-release-notes','--disable-workspace-trust','--disable-telemetry',`--remote-debugging-port=${port}`,'--user-data-dir',profile,'--extensions-dir',path.join(profile,'extensions')]})}finally{await fs.cp(path.join(profile,'logs'),path.join(evidence,'vscode-logs'),{recursive:true,force:true}).catch(()=>{});await fs.rm(profile,{recursive:true,force:true,maxRetries:20,retryDelay:100})}
})().catch(error=>{console.error(error);process.exitCode=1});
