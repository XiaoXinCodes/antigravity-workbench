// Keep private-state fixtures under the canonical, user-owned checkout, not macOS /var aliases or a foreign-owned TMPDIR.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),{spawn}=require('node:child_process'),{once}=require('node:events');
const {AutomaticOfflineKey,AutomaticOfflineControl}=require('../out/offline-automatic'),{OfflineRecoveryStore}=require('../out/offline-recovery-store'),{LiveLocks}=require('../out/live-lock');
async function until(fn){for(let n=0;n<600;n++){const result=await fn();if(result)return result;await new Promise(r=>setTimeout(r,20));}throw Error('SYNTHETIC_TIMEOUT');}
async function exists(file){try{await fs.stat(file);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
for(const mode of ['close','new-instance','cancel','late-write'])test('automatic detached helper closed loop: '+mode,{skip:process.platform!=='linux'},async t=>{
 const home=await fs.mkdtemp(path.join(await fs.realpath(__dirname),'automatic-loop-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));
 const child=spawn(process.execPath,[path.join(__dirname,'helpers/automatic-offline-initiator.cjs')],{env:{...process.env,HOME:home,WSL_DISTRO_NAME:'SyntheticOfflineFixture'},stdio:'ignore'});
 const exited=once(child,'exit');t.after(()=>{if(child.exitCode===null)child.kill();});
 await until(()=>exists(path.join(home,'ready')));
 const {host,id,owner}=JSON.parse(await fs.readFile(path.join(home,'metadata.json'),'utf8')),control=new AutomaticOfflineControl(home,id);
 const key=await new AutomaticOfflineKey(home,host,id).read(),store=new OfflineRecoveryStore(path.join(home,'.gemini','antigravity-workbench-offline',id),key,host,id),original=await store.read();
 const file=path.join(home,'.gemini','jetski-standalone-oauth-token');assert.equal(await fs.readFile(file,'utf8'),original.backup.file);
 if(mode==='new-instance')await fs.writeFile(path.join(home,'new-instance.json'),JSON.stringify({pid:999999,startIdentity:'linux:11111111-1111-4111-8111-111111111111:999'}));
 if(mode==='cancel')await control.cancel();
 if(mode==='late-write')await fs.writeFile(path.join(home,'delay-write'),'fixture');
 await fs.writeFile(path.join(home,'close'),'close');assert.equal((await exited)[0],0);
 if(mode==='late-write'){await until(()=>exists(path.join(home,'write-started')));await control.cancel();const lock=new LiveLocks(path.join(home,'.gemini'),owner);await assert.rejects(lock.withOperation(async()=>assert.fail('must not enter while old writer is pending')),{code:'LIVE_OPERATION_OR_RECOVERY_LOCKED'});await fs.writeFile(path.join(home,'allow-write'),'fixture');}
 const status=await until(async()=>{const s=(await control.read()).status;return s==='WAITING_FOR_CLOSE'?false:s;});
 assert.equal(status,mode==='close'?'INSTALLED':mode==='cancel'?'CANCELLED':mode==='late-write'?'OFFLINE_RECOVERY_REQUIRED':'OFFLINE_NEW_INSTANCE');
 const record=await store.read();assert.equal(record.phase,mode==='close'?'installed':'prepared');assert.equal(await fs.readFile(file,'utf8'),['close','late-write'].includes(mode)?record.target.file:record.backup.file);
 const locks=new LiveLocks(path.join(home,'.gemini'),owner);assert.equal((await locks.inspectRecovery()).owner.id,id);
 await locks.withOperation(async()=>assert.equal((await store.read()).id,id)); // Writer settled; no stuck operation lock.
 assert.equal(await new AutomaticOfflineKey(home,host,id).read(),key);assert.deepEqual(record.backup,original.backup);
});
