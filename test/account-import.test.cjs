const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { LiveSwitchService, ACCOUNT_PREFIX, JOURNAL_KEY, migrationTargetSlots } = require('../out/live-switch');
const { IMPORT_PREFIX } = require('../out/account-import');
const token = name => JSON.stringify({token:{refresh_token:`synthetic-${name}`}});
const entry = (name='b') => ({label:`Account ${name}`,expectedEmail:`${name}@example.test`,capturedAt:'2026-10-01T00:00:00.000Z',token:token(name)});
function fixture(hostId='target-linux-wsl', data=new Map()) {
  let rows=[], reads=0,writes=0;
  const vault={get:async key=>data.get(key),store:async(key,value)=>{data.set(key,value);},delete:async key=>{data.delete(key);}};
  let current={keyring:token('a'),file:null};
  const slots={read:async()=>{reads++;return {...current};},write:async(next,expected)=>{assert.deepEqual(current,expected);writes++;current={...next};}};
  const service=new LiveSwitchService(vault,slots,hostId);
  const query=async account=>({subject:'synthetic-'+account.expectedEmail.split('@')[0],proof:{email:account.expectedEmail,authValid:true,quotaSource:'server',observedAt:new Date().toISOString(),generation:'synthetic',buckets:[]}});
  const importAccounts=service.importAccounts.bind(service);service.importAccounts=(entries,index,options={})=>importAccounts(entries,index,{query,...options});
  const legacy=async entries=>{
    const accounts=entries.map(e=>({id:crypto.randomUUID(),label:e.label,expectedEmail:e.expectedEmail,capturedAt:e.capturedAt,identitySource:'user',migrationState:'pending',hostId,slots:{keyring:e.token,file:e.token}}));
    for(const account of accounts)data.set(ACCOUNT_PREFIX+account.id,JSON.stringify(account));
    const metadata=accounts.map(({slots,...row})=>{void slots;return row;});await index.write([...index.read(),...metadata]);return metadata;
  };
  const index={read:()=>structuredClone(rows),write:async value=>{rows=structuredClone(value);}};
  let proof;
  const calls=[];const backend={generation:'old',stop:async()=>{calls.push('stop');},reload:async()=>{calls.push('reload');backend.generation='new-'+calls.filter(v=>v==='reload').length},proof:async()=>proof||({email:current.keyring===token('a')?'a@example.test':'b@example.test',generation:backend.generation,authValid:true,quotaSource:'server',observedAt:new Date().toISOString(),buckets:[]})};
  const key=hostId===undefined?IMPORT_PREFIX:`${IMPORT_PREFIX}.host.${crypto.createHash('sha256').update(hostId).digest('hex')}`;
  return {data,vault,service,index,slots,backend,calls,key:key+'.v2',legacyKey:key,legacy,rows:()=>rows,setRows:v=>{rows=v;},reads:()=>reads,writes:()=>writes,current:()=>current,proof:v=>{proof=v;}};
}
test('multi-account import verifies host-bound candidate copies without reading official credentials',async()=>{
  const f=fixture();const saved=await f.service.importAccounts([entry('b'),entry('c')],f.index);
  assert.equal(saved.length,2);assert.equal(f.rows().length,2);assert.equal(f.reads(),0);assert.equal(f.writes(),0);assert.equal(f.data.has(f.key),false);
  for(const a of saved){assert.equal(a.hostId,'target-linux-wsl');assert.equal(a.identitySource,'user');assert.equal(a.migrationState,'verified');assert.equal(a.capturedAt,entry().capturedAt);assert.ok(!JSON.stringify(a).includes('refresh_token'));assert.deepEqual((await f.service.account(a.id)).slots,{keyring:token(a.expectedEmail[0]),file:token(a.expectedEmail[0])});}
  assert.equal(f.data.has(JOURNAL_KEY),false);
});
test('same-email import requires an explicit target and replacement retains ID and order',async()=>{
  const f=fixture();const first=(await f.service.importAccounts([entry()],f.index))[0];const raw=f.data.get(ACCOUNT_PREFIX+first.id);
  await assert.rejects(f.service.importAccounts([entry()],f.index),/MIGRATION_TARGET_REQUIRED/);assert.equal(f.data.get(ACCOUNT_PREFIX+first.id),raw);
  const second=(await f.service.importAccounts([{...entry(),label:'Replacement'}],f.index,{replace:{'b@example.test':first.id}}))[0];assert.equal(first.id,second.id);assert.equal(f.rows().length,1);assert.equal(f.rows()[0].label,'Replacement');
});
test('export strips host, IDs, verification and recovery metadata while keeping portable token',async()=>{
  const f=fixture();const saved=await f.service.importAccounts([entry('b'),entry('c')],f.index);
  assert.deepEqual(await f.service.exportAccounts(saved.map(a=>a.id)),[entry('b'),entry('c')]);
  assert.equal(f.reads(),0);await assert.rejects(f.service.exportAccounts([]),/SELECTION/);await assert.rejects(f.service.exportAccounts([saved[0].id,saved[0].id]),/SELECTION/);
  const other=fixture('other',f.data);await assert.rejects(other.service.exportAccounts([saved[0].id]),/HOST_ACCOUNT_MISMATCH/);
});
test('invalid imports and capacity overflow fail before any vault or official changes',async()=>{
  const f=fixture();for(const entries of [[],[{...entry(),hostId:'source'}],[{...entry(),expectedEmail:'invalid'}]])await assert.rejects(f.service.importAccounts(entries,f.index));
  f.setRows(Array.from({length:50},()=>({id:crypto.randomUUID()})));await assert.rejects(f.service.importAccounts([entry()],f.index),/SAVED_ACCOUNT_LIMIT/);assert.equal(f.data.size,0);assert.equal(f.reads(),0);
});
test('mid-secret write failure rolls back all new copies and preserves previous account',async()=>{
  const f=fixture();await f.service.importAccounts([entry('a')],f.index);const rows=f.rows(),data=new Map(f.data),store=f.vault.store;let count=0;
  f.vault.store=async(k,v)=>{if(k.startsWith(ACCOUNT_PREFIX)&&++count===2)throw new Error('never reveal raw credential');await store(k,v);};
  await assert.rejects(f.service.importAccounts([entry('b'),entry('c')],f.index),/^Error: MIGRATION_IMPORT_FAILED$/);assert.deepEqual(f.rows(),rows);assert.deepEqual(new Map([...f.data].filter(([k])=>!k.startsWith('live-switch.import-candidate.'))),data);assert.equal(f.reads(),0);
});
test('index failure after write still removes staged IDs without deleting previous rows',async()=>{
  const f=fixture();await f.service.importAccounts([entry('a')],f.index);const rows=f.rows(),before=new Map(f.data),write=f.index.write;let first=true;
  f.index.write=async v=>{await write(v);if(first){first=false;throw new Error('index post-write failure');}};
  await assert.rejects(f.service.importAccounts([entry('b')],f.index),/MIGRATION_IMPORT_FAILED/);assert.deepEqual(f.rows(),rows);assert.deepEqual(new Map([...f.data].filter(([k])=>!k.startsWith('live-switch.import-candidate.'))),before);
});
test('failed rollback retains host-isolated journal and next explicit operation recovers it',async()=>{
  const f=fixture();const store=f.vault.store,del=f.vault.delete;let count=0;
  f.vault.store=async(k,v)=>{if(k.startsWith(ACCOUNT_PREFIX)&&++count===2)throw new Error('secret write failure');await store(k,v);};
  f.vault.delete=async()=>{throw new Error('delete failure');};
  await assert.rejects(f.service.importAccounts([entry('b'),entry('c')],f.index),/MIGRATION_ROLLBACK_REQUIRED/);assert.equal(f.data.has(f.key),true);assert.equal(f.rows().length,0);
  const other=fixture('other-host',f.data);await other.service.recoverImport(other.index);assert.equal(f.data.has(f.key),true);
  f.vault.delete=del;await f.service.recoverImport(f.index);assert.ok([...f.data.keys()].every(k=>k.startsWith('live-switch.import-candidate.')));assert.equal(f.writes(),0);
});
test('crash after index commit is recognized without adding duplicate copies',async()=>{
  const f=fixture();const del=f.vault.delete;f.vault.delete=async key=>{if(key===f.key)throw new Error('crash');return del(key);};
  await assert.rejects(f.service.importAccounts([entry('b')],f.index),/MIGRATION_ROLLBACK_REQUIRED/);const rows=structuredClone(f.rows());assert.equal(rows.length,1);
  f.vault.delete=del;await f.service.recoverImport(f.index);assert.deepEqual(f.rows(),rows);assert.equal(f.data.has(f.key),false);assert.equal([...f.data.keys()].filter(k=>k.startsWith(ACCOUNT_PREFIX)).length,1);
});
test('crash before index commit rolls back stages and preserves unrelated index edits',async()=>{
  const f=fixture();const del=f.vault.delete;f.vault.delete=async key=>{if(key===f.key)throw new Error('crash');return del(key);};
  await assert.rejects(f.service.importAccounts([entry('b')],f.index));const staged=f.rows()[0];const other={id:crypto.randomUUID(),label:'unrelated'};f.setRows([other]);f.vault.delete=del;
  await f.service.recoverImport(f.index);assert.deepEqual(f.rows(),[other]);assert.equal(f.data.has(ACCOUNT_PREFIX+staged.id),false);
});
test('malformed import journal is preserved and never treated as a recovery or imported account',async()=>{
  const f=fixture();f.data.set(f.legacyKey,JSON.stringify({schema:1,hostId:'source',accounts:[]}));await assert.rejects(f.service.recoverImport(f.index),/MIGRATION_RECOVERY_INVALID/);assert.equal(f.data.size,1);assert.equal(f.reads(),0);
});
test('migration import/export cannot replace an in-progress live switch or its backup',async()=>{
  const f=fixture();const a=(await f.legacy([entry()]))[0];await f.service.install(a.id,f.backend);const before=new Map(f.data);
  await assert.rejects(f.service.importAccounts([entry('c')],f.index),/RECOVERY_PENDING/);await assert.rejects(f.service.exportAccounts([a.id]),/RECOVERY_PENDING/);assert.deepEqual(f.data,before);
});
test('import first switch adapts both target slots, backs up originals and remains pending until fresh hub identity',async()=>{
  const f=fixture();const a=(await f.legacy([entry()]))[0];const before=f.current();await f.service.install(a.id,f.backend);
  assert.deepEqual(f.current(),{keyring:token('b'),file:token('b')});assert.deepEqual((await f.service.journal()).backup,before);assert.equal(f.rows()[0].migrationState,'pending');
  for(const proof of [{email:'x@example.test',generation:'new',authValid:true},{email:'b@example.test',generation:'old',authValid:true},{email:'b@example.test',generation:'new',authValid:false}]){f.proof(proof);await assert.rejects(f.service.markImportedVerified(f.backend,f.index),/HUB_IDENTITY_NOT_VERIFIED/);assert.equal(f.rows()[0].migrationState,'pending');}
  f.proof({email:'b@example.test',generation:f.backend.generation,authValid:true,quotaSource:'server'});await f.service.markImportedVerified(f.backend,f.index);assert.equal(f.rows()[0].migrationState,'verified');assert.equal((await f.service.account(a.id)).identitySource,'hub');assert.ok(await f.service.journal());
});
test('failed first switch can explicitly restore old login and never upgrades imported metadata',async()=>{
  const f=fixture();const before=f.current(),a=(await f.legacy([entry()]))[0];await f.service.install(a.id,f.backend);await f.service.restore(f.backend);assert.deepEqual(f.current(),before);assert.equal(f.rows()[0].migrationState,'pending');await assert.rejects(f.service.markImportedVerified(f.backend,f.index),/NO_SWITCH_TO_VERIFY/);
});
test('target storage limits are checked consistently for Windows/macOS/Linux and WSL',()=>{
  for(const platform of ['win32','darwin','linux'])assert.deepEqual(migrationTargetSlots(token('b'),platform),{keyring:token('b'),file:token('b')});
  for(const [platform,length] of [['win32',2561],['darwin',2926],['linux',8192]])assert.throws(()=>migrationTargetSlots('x'.repeat(length),platform),/MIGRATION_TARGET_SIZE_LIMIT/);
  assert.throws(()=>migrationTargetSlots(token('b'),'freebsd'),/PLATFORM_UNSUPPORTED/);
});
test('first-target migration lock initializes only an empty private directory and removes its temporary operation lock',async()=>{
  const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
  const {LiveLocks}=require('../out/live-lock');const root=await fs.mkdtemp(path.join(os.tmpdir(),'agm-import-lock-'));const dir=path.join(root,'.gemini');
  try {const lock=new LiveLocks(dir,'a'.repeat(64));let called=false;await lock.withOperation(async()=>{called=true;assert.deepEqual(await fs.readdir(dir),['.agm-operation.lock']);});assert.equal(called,true);assert.deepEqual(await fs.readdir(dir),[]);if(process.platform!=='win32')assert.equal((await fs.stat(dir)).mode&0o077,0);}
  finally{await fs.rm(root,{recursive:true,force:true});}
});
test('first-target migration lock refuses a symlink parent rather than initializing another directory',{skip:process.platform==='win32'},async()=>{
  const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
  const {LiveLocks}=require('../out/live-lock');const root=await fs.mkdtemp(path.join(os.tmpdir(),'agm-import-lock-'));const actual=path.join(root,'actual'),linked=path.join(root,'linked');
  try {await fs.mkdir(actual);await fs.symlink(actual,linked);const lock=new LiveLocks(path.join(linked,'.gemini'),'a'.repeat(64));await assert.rejects(lock.withOperation(async()=>{throw new Error('must not run');}),/LOCK_PARENT_UNSAFE/);assert.deepEqual(await fs.readdir(actual),[]);}
  finally{await fs.rm(root,{recursive:true,force:true});}
});
test('legacy browser-login long email labels can export without changing the full expected identity',async()=>{
  const f=fixture(), email='a'.repeat(78)+'@example.test';
  const a=await f.service.capture({label:email,expectedEmail:email,identitySource:'hub'});
  const [out]=await f.service.exportAccounts([a.id]);assert.equal(out.label,email.slice(0,80));assert.equal(out.expectedEmail,email);assert.equal((await f.service.account(a.id)).label,email);
});

test('schema 1 journal recovery remains compatible before and after legacy index commit',async()=>{
  for(const complete of [false,true]){
    const f=fixture(),rows=await f.legacy([entry('b')]);f.data.set(f.legacyKey,JSON.stringify({schema:1,hostId:'target-linux-wsl',accounts:rows}));
    if(!complete)f.setRows([]);
    await f.service.recoverImport(f.index);assert.equal(f.data.has(f.legacyKey),false);assert.equal(f.rows().length,complete?1:0);assert.equal(f.data.has(ACCOUNT_PREFIX+rows[0].id),complete);
  }
});
