const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path');
const {randomUUID}=require('node:crypto');
const {runOfflineFileSession}=require('../out/offline-session');
const {OfflineRecoveryStore}=require('../out/offline-recovery-store');
const {LiveLocks}=require('../out/live-lock');
const owner='a'.repeat(64),password='synthetic-session-password';
const slots=value=>({keyring:null,file:JSON.stringify({token:{refresh_token:value}}),keyringState:'unobserved'});
async function fixture(t){
 const home=await fs.mkdtemp(path.join(await fs.realpath(__dirname),'offline-session-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));
 await fs.mkdir(path.join(home,'.gemini'),{mode:0o700});
 const file=path.join(home,'.gemini','jetski-standalone-oauth-token'),record={schema:1,hostId:'fixture-host',id:randomUUID(),phase:'prepared',backup:slots('old'),target:slots('new'),expectedEmail:'fixture@example.test'};
 await fs.writeFile(file,record.backup.file,{mode:0o600});
 const host={pid:123,startIdentity:'fixture-birth'},empty={complete:true,unknown:false,hosts:[],hubs:[]};let scans=0,ready=false;
 const input={record,password,knownHosts:[host],fileRoute:{hostId:record.hostId,backup:record.backup}};
 const journal=new OfflineRecoveryStore(path.join(home,'.gemini','antigravity-workbench-offline',record.id),password,record.hostId,record.id);
 const deps={home,hostId:record.hostId,owner,census:async()=>++scans===1?{...empty,hosts:[host]}:empty,
  ready:async()=>{assert.equal((await journal.read()).phase,'prepared');assert.equal(await fs.readFile(file,'utf8'),record.backup.file);ready=true;},wait:async()=>{},now:()=>0,deadlineMs:100};
 return{home,file,record,input,deps,journal,host,empty,isReady:()=>ready};
}
test('executor publishes durable recovery and legacy fence before waiting, installs after closure',async t=>{
 const f=await fixture(t);if(process.platform==='win32'){await assert.rejects(runOfflineFileSession(f.input,f.deps),{code:'OFFLINE_DURABILITY_UNSUPPORTED'});assert.equal(f.isReady(),false);assert.equal(await fs.readFile(f.file,'utf8'),f.record.backup.file);assert.equal((await new LiveLocks(path.join(f.home,'.gemini'),owner).inspectRecovery()).state,'absent');return;}assert.equal(await runOfflineFileSession(f.input,f.deps),'installed-awaiting-verification');
 assert.equal(f.isReady(),true);assert.equal(await fs.readFile(f.file,'utf8'),f.record.target.file);assert.equal((await f.journal.read()).phase,'installed');
 const locks=new LiveLocks(path.join(f.home,'.gemini'),owner);assert.equal((await locks.inspectRecovery()).owner.schema,4);
 await assert.rejects(locks.withOperation(()=>locks.reconcileRecovery(null)),{code:'OFFLINE_RECOVERY_REQUIRED'});
});
test('new host after preparation aborts and keeps encrypted recovery and original credentials',{skip:process.platform==='win32'?'Requires successful POSIX directory durability; Windows refusal covered above':false},async t=>{
 const f=await fixture(t);let calls=0;f.deps.census=async()=>({...f.empty,hosts:[{...f.host,startIdentity:++calls===1?'fixture-birth':'new-birth'}]});
 await assert.rejects(runOfflineFileSession(f.input,f.deps),{code:'OFFLINE_NEW_INSTANCE'});
 assert.equal(await fs.readFile(f.file,'utf8'),f.record.backup.file);assert.equal((await f.journal.read()).phase,'prepared');
});
test('close timeout and cancellation retain a recoverable prepared record without writing',{skip:process.platform==='win32'?'Requires successful POSIX directory durability; Windows refusal covered above':false},async t=>{
 for(const cancel of [false,true]){const f=await fixture(t),controller=new AbortController();let clock=0;
 f.deps.census=async()=>({...f.empty,hosts:[f.host]});f.deps.now=()=>clock;f.deps.wait=async()=>{clock=200;if(cancel)controller.abort();};
 await assert.rejects(runOfflineFileSession(f.input,f.deps,controller.signal),{code:cancel?'CANCELLED':'OFFLINE_CLOSE_TIMEOUT'});
 assert.equal(await fs.readFile(f.file,'utf8'),f.record.backup.file);assert.equal((await f.journal.read()).phase,'prepared');}
});
test('file route receipt cannot downgrade native slots or replace another transaction',async t=>{
 const f=await fixture(t);f.input.fileRoute.backup=slots('different');await assert.rejects(runOfflineFileSession(f.input,f.deps),{code:'OFFLINE_SCOPE_UNVERIFIED'});assert.equal(f.isReady(),false);
 f.input.fileRoute.backup=f.record.backup;const locks=new LiveLocks(path.join(f.home,'.gemini'),owner);await locks.beginRecovery(randomUUID());
 await assert.rejects(runOfflineFileSession(f.input,f.deps),{code:'OFFLINE_RECOVERY_REQUIRED'});assert.equal(f.isReady(),false);
});
test('external execution consumes prior GUI preparation, restore retains fence until fresh verification',{skip:process.platform==='win32'?'Requires successful POSIX directory durability; Windows refusal covered above':false},async t=>{
 const f=await fixture(t),locks=new LiveLocks(path.join(f.home,'.gemini'),owner);
 f.host.startIdentity='linux:11111111-1111-4111-8111-111111111111:123';
 f.record.execution={owner,extensionKind:2,remoteName:'wsl',knownHosts:[f.host],participants:[f.host]};
 f.record.originalEmail='original@example.test';
 await locks.withOperation(async()=>{await f.journal.save(f.record,undefined);await locks.beginOfflineRecovery(f.record.id);});
 f.deps.prepared=true;assert.equal(await runOfflineFileSession(f.input,f.deps),'installed-awaiting-verification');
 const installed=await f.journal.read();
 // A normal access-token refresh does not turn our target into unrelated data.
 await fs.writeFile(f.file,JSON.stringify({token:{refresh_token:'new',access_token:'updated'}}),{mode:0o600});
 f.input.record=installed;f.deps.restore=true;f.deps.ready=async()=>{};
 assert.equal(await runOfflineFileSession(f.input,f.deps),'restored-awaiting-verification');
 assert.equal(await fs.readFile(f.file,'utf8'),f.record.backup.file);assert.equal((await f.journal.read()).phase,'restored');
 assert.equal((await locks.inspectRecovery()).owner.schema,4);
});

test('late helper cannot write after reopened host cleared its exact recovery marker',{skip:process.platform==='win32'?'Requires successful POSIX directory durability; Windows refusal covered above':false},async t=>{
 const f=await fixture(t),locks=new LiveLocks(path.join(f.home,'.gemini'),owner);await locks.withOperation(async()=>{await f.journal.save(f.record,undefined);await locks.beginOfflineRecovery(f.record.id);await locks.clearOfflineRecovery(f.record.id);});f.deps.prepared=true;await assert.rejects(runOfflineFileSession(f.input,f.deps),{code:'RECOVERY_LOCK_OWNER_MISMATCH'});assert.equal(await fs.readFile(f.file,'utf8'),f.record.backup.file);assert.equal(f.isReady(),false);
});
