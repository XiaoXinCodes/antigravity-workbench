// Isolated development-host experiment. No extension installation or real
// account data. Both extensions below are synthetic fixtures, not official code.
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {runTests}=require('@vscode/test-electron');
(async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'ag-offline-recovery-host-'));
 const workbench=path.join(root,'workbench'),official=path.join(root,'official'),profile=path.join(root,'profile');
 try{
  for(const p of [workbench,official,profile])await fs.mkdir(p,{recursive:true});
  await fs.writeFile(path.join(workbench,'package.json'),JSON.stringify({name:'offline-research',publisher:'synthetic',version:'0.0.1',engines:{vscode:'^1.95.0'},main:'main.cjs',activationEvents:[]}));
  await fs.writeFile(path.join(workbench,'main.cjs'),`exports.activate=c=>({store:v=>c.secrets.store('synthetic-key',v),get:()=>c.secrets.get('synthetic-key')});`);
  await fs.writeFile(path.join(official,'package.json'),JSON.stringify({name:'google-antigravity',publisher:'google',version:'0.0.0',engines:{vscode:'^1.95.0'},main:'main.cjs',activationEvents:['*']}));
  await fs.writeFile(path.join(official,'main.cjs'),`exports.activate=()=>({synthetic:true});`);
  // Normal extension scanning is required: VS Code deliberately never disables
  // --extensionDevelopmentPath fixtures. Place this synthetic fixture only in
  // the disposable test extensions directory; no installer or real package.
  const scanned=path.join(root,'empty-extensions','google.google-antigravity-0.0.0');
  await fs.mkdir(path.dirname(scanned),{recursive:true});
  await fs.cp(official,scanned,{recursive:true});
  const suite=path.join(root,'suite.cjs');
  await fs.writeFile(suite,`const assert=require('node:assert/strict'),v=require('vscode');exports.run=async()=>{const e=v.extensions.getExtension('synthetic.offline-research');assert.ok(e);const api=await e.activate();if(process.env.RESEARCH_PHASE==='prepare'){await api.store('synthetic-recovery-key');assert.equal(await api.get(),'synthetic-recovery-key');console.log('RESEARCH_PREPARE_OK');}else{console.log(await api.get()==='synthetic-recovery-key'?'RESEARCH_SECRET_PERSISTED':'RESEARCH_SECRET_NOT_PERSISTED');const o=v.extensions.getExtension('google.google-antigravity');assert.ok(!o||!o.isActive,'disabled official fixture must not activate');console.log('RESEARCH_RECOVERY_OK');}};`);
  for(const phase of ['prepare','recover'])await runTests({
   vscodeExecutablePath:path.resolve(__dirname,'../.vscode-test/vscode-linux-x64-1.141.0/code'),
   extensionDevelopmentPath:workbench,extensionTestsPath:suite,
   extensionTestsEnv:{HOME:root,USERPROFILE:root,RESEARCH_PHASE:phase},
   launchArgs:['--no-sandbox','--disable-gpu','--skip-welcome','--skip-release-notes','--disable-telemetry','--user-data-dir',profile,'--extensions-dir',path.join(root,'empty-extensions'),'--new-window',...(phase==='recover'?['--disable-extension','google.google-antigravity']:[])],
  });
 }finally{await fs.rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100});}
})().catch(()=>{console.error('OFFLINE_RECOVERY_HOST_EXPERIMENT_FAILED');process.exitCode=1;});
