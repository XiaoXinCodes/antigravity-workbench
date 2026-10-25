const fs=require('node:fs/promises'),path=require('node:path'),{configuration,launcher}=require('./common.cjs');
(async()=>{
 const root=process.argv[2],c=await configuration(root),{WindowReopen}=require(path.join(root,'out/window-reopen.js')),{probeProcessIdentity}=require(path.join(root,'out/live-lock.js'));
 const state=JSON.parse(await fs.readFile(path.join(root,'.gemini/antigravity-workbench-window-reopen/state.json'),'utf8'));const old=state.request.oldHost;
 process.stdout.end('READY\n');const deadline=Date.now()+60000;let exited=false;
 while(Date.now()<deadline){const p=await probeProcessIdentity(old.pid);if(p.state==='dead'||p.state==='alive'&&p.startIdentity!==old.startIdentity){exited=true;break;}await new Promise(r=>setTimeout(r,100));}
 if(!exited)throw Error('TEST_CLOSE_TIMEOUT');
 const actor=await new WindowReopen(root).reopen(c.id,launcher(root,c),60000);
 const contents=await fs.readFile(path.join(root,'workspace','synthetic.txt'),'utf8');if(!contents.startsWith('saved-by-fixture'))throw Error('SAVE_NOT_CONFIRMED');
 await fs.writeFile(path.join(root,'passed.json'),JSON.stringify({schema:1,attempt:c.id,oldHostExited:true,independentHelperSurvived:true,matchingWorkspaceRejoined:true,newHost:actor,accountOperations:false,profilePolicy:'workspace-association'}));
})().catch(async e=>{const root=process.argv[2];if(root&&/\/AntigravityWindowTest-[a-f0-9-]{36}$/.test(root))await fs.writeFile(path.join(root,'helper-failure.json'),JSON.stringify({code:e.code??'FIXTURE_FAILED'}));process.exitCode=1;});
