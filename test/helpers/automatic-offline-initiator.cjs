const fs=require('node:fs/promises'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {AutomaticOfflineKey,AutomaticOfflineControl,launchAutomaticOfflineHelper}=require('../../out/offline-automatic');
const {LiveLocks,probeProcessIdentity}=require('../../out/live-lock');
const {OfflineRecoveryStore}=require('../../out/offline-recovery-store');
const {resolveCredentialHostId}=require('../../out/native-host');
(async()=>{
 const home=process.env.HOME,host=await resolveCredentialHostId({extension:{extensionKind:2}},'wsl','wsl-file'),id=randomUUID(),owner='c'.repeat(64);
 await fs.mkdir(path.join(home,'.gemini'),{mode:0o700});
 const slots=name=>({keyring:null,file:JSON.stringify({token:{refresh_token:'synthetic-'+name}}),keyringState:'unobserved'});
 const identity=await probeProcessIdentity(process.pid),self={pid:process.pid,startIdentity:identity.startIdentity};
 const record={schema:1,hostId:host,id,phase:'prepared',backup:slots('old'),target:slots('new'),expectedEmail:'target@example.test',originalEmail:'old@example.test',execution:{owner,extensionKind:2,remoteName:'wsl',knownHosts:[self],participants:[self]}};
 await fs.writeFile(path.join(home,'.gemini','jetski-standalone-oauth-token'),record.backup.file,{mode:0o600});
 const locks=new LiveLocks(path.join(home,'.gemini'),owner);
 await locks.withOperation(async()=>{
  const key=await new AutomaticOfflineKey(home,host,id).create();
  await new AutomaticOfflineControl(home,id).reset();
  await new OfflineRecoveryStore(path.join(home,'.gemini','antigravity-workbench-offline',id),key,host,id).save(record,undefined);
  await locks.beginOfflineRecovery(id);
 });
 await fs.writeFile(path.join(home,'metadata.json'),JSON.stringify({host,id,owner}));
 await launchAutomaticOfflineHelper(path.join(__dirname,'automatic-offline-worker.cjs'),id,host,2,'wsl','install',(await new AutomaticOfflineControl(home,id).read()).attempt);
 await fs.writeFile(path.join(home,'ready'),'READY');
 // Fixture process exits only after the test signals it, emulating Save/Close.
 for(;;){try{await fs.stat(path.join(home,'close'));break;}catch(e){if(e.code!=='ENOENT')throw e;}await new Promise(r=>setTimeout(r,20));}
})().catch(()=>{process.exitCode=1;});
