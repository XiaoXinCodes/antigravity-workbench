const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const {OfflineRecoveryStore}=require('../out/offline-recovery-store');
const token=JSON.stringify({token:{refresh_token:'synthetic-recovery-token'}});
const record={schema:1,hostId:'synthetic-host',id:'18b6b550-6e0d-4b57-b5be-9d70810f07a9',phase:'prepared',backup:{keyring:null,file:null},target:{keyring:token,file:token},expectedEmail:'synthetic@example.test'};
const password='synthetic recovery password';
async function setup(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'offline-store-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}
test('persistent encrypted journal reopens without SecretStorage and contains no token or email',{skip:process.platform==='win32'},async t=>{
 const dir=await setup(t),store=new OfflineRecoveryStore(dir,password,record.hostId,record.id);
 await store.save(record,undefined);
 const bytes=await fs.readFile(path.join(dir,'state.json'),'utf8');assert.ok(!bytes.includes('synthetic-recovery-token'));assert.ok(!bytes.includes(record.expectedEmail));
 const reopened=new OfflineRecoveryStore(dir,password,record.hostId,record.id);assert.deepEqual(await reopened.read(),record);
 await reopened.save({...record,phase:'installed'},record);assert.equal((await store.read()).phase,'installed');
});
test('wrong password does not replace existing journal',{skip:process.platform==='win32'},async t=>{
 const dir=await setup(t),store=new OfflineRecoveryStore(dir,password,record.hostId,record.id);await store.save(record,undefined);
 const bad=new OfflineRecoveryStore(dir,'different password',record.hostId,record.id);
 await assert.rejects(bad.save({...record,phase:'installed'},record),/OFFLINE_RECOVERY_DECRYPT_FAILED/);assert.deepEqual(await store.read(),record);
});
test('stale journal CAS rejects and preserves newer phase',{skip:process.platform==='win32'},async t=>{
 const dir=await setup(t),store=new OfflineRecoveryStore(dir,password,record.hostId,record.id);await store.save(record,undefined);
 await store.save({...record,phase:'installed'},record);
 await assert.rejects(store.save({...record,phase:'restored'},record),/OFFLINE_JOURNAL_CHANGED/);assert.equal((await store.read()).phase,'installed');
});
test('a separate process unlocks the persisted recovery record using only stdin password',{skip:process.platform==='win32'},async t=>{
 const dir=await setup(t),store=new OfflineRecoveryStore(dir,password,record.hostId,record.id);await store.save(record,undefined);
 const code=`const fs=require('node:fs');const {OfflineRecoveryStore}=require(${JSON.stringify(require.resolve('../out/offline-recovery-store'))});const p=JSON.parse(fs.readFileSync(0,'utf8'));new OfflineRecoveryStore(p.directory,p.password,p.host,p.tx).read().then(r=>process.stdout.write(r.phase),()=>{process.exitCode=2});`;
 const result=spawnSync(process.execPath,['-e',code],{input:JSON.stringify({directory:dir,password,host:record.hostId,tx:record.id}),encoding:'utf8',timeout:5000});
 assert.equal(result.status,0);assert.equal(result.stdout,'prepared');assert.equal(result.stderr,'');
});
test('new recovery directory ancestors are synced before save reports success',{skip:process.platform==='win32'},async t=>{
 const root=await setup(t),dir=path.join(root,'new-parent','new-leaf'),synced=[];
 const original=fs.open;
 fs.open=async(...args)=>{
  const handle=await original(...args),sync=handle.sync.bind(handle);
  handle.sync=async()=>{synced.push(String(args[0]));return sync();};return handle;
 };
 try{await new OfflineRecoveryStore(dir,password,record.hostId,record.id).save(record,undefined);}
 finally{fs.open=original;}
 assert.ok(synced.includes(dir));assert.ok(synced.includes(path.dirname(dir)));assert.ok(synced.includes(root));assert.ok(synced.includes(path.dirname(root)));
});
