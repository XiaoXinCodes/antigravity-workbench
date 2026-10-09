const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { fork } = require('node:child_process');
const { prepareMigrationExport, writeMigrationArchive, encryptAccountArchive, decryptAccountArchive } = require('../out/account-migration');
const password = 'synthetic-export-replacement-password';
const account = name => ({label:name,expectedEmail:name+'@example.test',capturedAt:'2026-10-09T00:00:00.000Z',token:JSON.stringify({token:{refresh_token:'synthetic-refresh-'+name}})});
let encrypted;
const archives = () => encrypted ??= Promise.all(['old','new'].map(name=>encryptAccountArchive([account(name)],password)));
const code = expected => error => error.code === expected;
const real = Object.fromEntries(['open','lstat','writeFile','readFile','rename','unlink','rm','readdir'].map(name=>[name,fs[name].bind(fs)]));
const temporary = filename => path.basename(filename).startsWith('.agwenc-export-') && filename.endsWith('.tmp');
async function fixture(t, name='accounts.agwenc') {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'agw-export-'));
  t.after(()=>real.rm(directory,{recursive:true,force:true}));
  const filename = path.join(directory,name), [old,next] = await archives();
  await real.writeFile(filename,old);
  return {directory,filename,old,next,target:await prepareMigrationExport(filename)};
}
async function unchanged(f) { assert.deepEqual(await real.readFile(f.filename),f.old); }

test('confirmed same-name exports replace complete encrypted files repeatedly',async t=>{
  const f=await fixture(t);
  assert.equal(f.target.exists,true);
  await writeMigrationArchive(f.filename,f.next,f.target);
  assert.deepEqual((await decryptAccountArchive(await real.readFile(f.filename),password)).accounts,[account('new')]);
  await writeMigrationArchive(f.filename,f.old,await prepareMigrationExport(f.filename));
  await unchanged(f);assert.deepEqual(await real.readdir(f.directory),['accounts.agwenc']);
});

test('selection is read-only and replacement needs a filename-bound single-use snapshot',async t=>{
  const f=await fixture(t);
  await unchanged(f);assert.deepEqual(await real.readdir(f.directory),['accounts.agwenc']);
  await assert.rejects(writeMigrationArchive(f.filename,f.next),code('MIGRATION_FILE_EXISTS'));
  await assert.rejects(writeMigrationArchive(f.filename,f.next,{filename:f.filename,exists:true}),code('MIGRATION_EXPORT_CONFIRM_REQUIRED'));
  await assert.rejects(writeMigrationArchive(path.join(f.directory,'other.agwenc'),f.next,f.target),code('MIGRATION_EXPORT_CONFIRM_REQUIRED'));
  await unchanged(f);
  const target=await prepareMigrationExport(f.filename);await writeMigrationArchive(f.filename,f.next,target);
  await assert.rejects(writeMigrationArchive(f.filename,f.old,target),code('MIGRATION_EXPORT_CONFIRM_REQUIRED'));
  assert.deepEqual(await real.readFile(f.filename),f.next);
});

test('a confirmed missing destination still uses exclusive creation',async t=>{
  const f=await fixture(t), name=path.join(f.directory,'new.agwenc');
  const target=await prepareMigrationExport(name);assert.equal(target.exists,false);
  await writeMigrationArchive(name,f.next,target);assert.deepEqual(await real.readFile(name),f.next);
  const missing=path.join(f.directory,'raced.agwenc'), raced=await prepareMigrationExport(missing);
  await real.writeFile(missing,f.old);
  await assert.rejects(writeMigrationArchive(missing,f.next,raced),code('MIGRATION_EXPORT_FILE_CHANGED'));
  assert.deepEqual(await real.readFile(missing),f.old);
});

test('encryption and invalid archive failures leave confirmed old files untouched',async t=>{
  const f=await fixture(t);
  await assert.rejects(encryptAccountArchive([account('new')],'short'),code('MIGRATION_PASSWORD_INVALID'));
  await unchanged(f);
  await assert.rejects(writeMigrationArchive(f.filename,Buffer.from('synthetic plaintext'),f.target),code('MIGRATION_ARCHIVE_INVALID'));
  await unchanged(f);assert.deepEqual(await real.readdir(f.directory),['accounts.agwenc']);
});

for(const phase of ['open','write','partial','corrupt','sync','read','close','rename']) test(`replacement ${phase} failure preserves the old target`,async t=>{
  const f=await fixture(t);let hit=false;
  t.mock.method(fs,'open',async(filename,...args)=>{
    if(temporary(filename)&&phase==='open'){hit=true;throw Object.assign(Error('synthetic denied'),{code:'EACCES'});}
    const handle=await real.open(filename,...args);
    if(!temporary(filename))return handle;
    if(args[0]&constants.O_CREAT){assert.ok(args[0]&constants.O_EXCL);assert.ok(args[0]&constants.O_RDWR);}assert.equal(args[0]&constants.O_TRUNC,0);
    for(const method of ['writeFile','sync','read','close']){
      const original=handle[method].bind(handle);
      handle[method]=async(...values)=>{
        if(!hit&&(phase===method||phase==='write'&&method==='writeFile'||phase==='partial'&&method==='writeFile')){
          hit=true;if(phase==='partial') {await handle.write(f.next.subarray(0,7));return;}
          throw Object.assign(Error('synthetic file failure'),{code:'EIO'});
        }
        const result=await original(...values);
        if(!hit&&phase==='corrupt'&&method==='sync'){hit=true;await handle.write(Buffer.from('X'),0,1,0);}
        return result;
      };
    }
    return handle;
  });
  t.mock.method(fs,'rename',async(...args)=>{if(phase==='rename'){hit=true;throw Object.assign(Error('synthetic commit denied'),{code:'EPERM'});}return real.rename(...args);});
  await assert.rejects(writeMigrationArchive(f.filename,f.next,f.target),code(['partial','corrupt'].includes(phase)?'MIGRATION_EXPORT_FILE_CHANGED':'MIGRATION_FILE_WRITE_FAILED'));
  assert.equal(hit,true);await unchanged(f);assert.deepEqual(await real.readdir(f.directory),['accounts.agwenc']);
});

for(const change of ['bytes','inode','missing','symlink','directory']) test(`target ${change} after confirmation is preserved without commit`,async t=>{
  const f=await fixture(t);let expected=f.old;
  if(change==='bytes'){expected=Buffer.from(f.old);expected[0]=88;await real.writeFile(f.filename,expected);}
  if(change==='inode'){await real.rename(f.filename,f.filename+'.original');await real.writeFile(f.filename,f.old);}
  if(change==='missing')await real.unlink(f.filename);
  if(change==='symlink'){
    try{await fs.symlink(f.filename+'.other',f.filename+'.link');}catch(error){if(['EPERM','EACCES','ENOTSUP'].includes(error.code)){t.skip('symlink creation is unavailable');return;}throw error;}
    await real.writeFile(f.filename+'.other',f.next);await real.unlink(f.filename);await real.rename(f.filename+'.link',f.filename);
  }
  if(change==='directory'){await real.rename(f.directory,f.directory+'.original');await fs.mkdir(f.directory);await real.writeFile(f.filename,f.next);expected=f.next;t.after(()=>real.rm(f.directory+'.original',{recursive:true,force:true}));}
  await assert.rejects(writeMigrationArchive(f.filename,f.next,f.target),code(change==='symlink'?'MIGRATION_PATH_UNSAFE':'MIGRATION_EXPORT_FILE_CHANGED'));
  if(change==='missing')await assert.rejects(real.lstat(f.filename),{code:'ENOENT'});
  else if(change==='symlink'){assert.equal((await real.lstat(f.filename)).isSymbolicLink(),true);assert.deepEqual(await real.readFile(f.filename+'.other'),f.next);}
  else assert.deepEqual(await real.readFile(f.filename),expected);
});

test('target changes during staging abort and preserve another writer’s target',async t=>{
  const f=await fixture(t);let changed=false;
  t.mock.method(fs,'open',async(filename,...args)=>{
    const handle=await real.open(filename,...args);
    if(temporary(filename)&&!changed){const sync=handle.sync.bind(handle);handle.sync=async()=>{await sync();await real.rename(f.filename,f.filename+'.original');await real.writeFile(f.filename,f.next);changed=true;};}
    return handle;
  });
  await assert.rejects(writeMigrationArchive(f.filename,f.old,f.target),code('MIGRATION_EXPORT_FILE_CHANGED'));
  assert.equal(changed,true);assert.deepEqual(await real.readFile(f.filename),f.next);assert.deepEqual(await real.readFile(f.filename+'.original'),f.old);
});

test('a target removed between lookup and opening reports a changed export target',async t=>{
  const f=await fixture(t);let moved=false;
  t.mock.method(fs,'open',async(filename,...args)=>{if(filename===f.filename&&!moved){await real.rename(filename,filename+'.original');moved=true;}return real.open(filename,...args);});
  await assert.rejects(writeMigrationArchive(f.filename,f.next,f.target),code('MIGRATION_EXPORT_FILE_CHANGED'));
  assert.equal(moved,true);assert.deepEqual(await real.readFile(f.filename+'.original'),f.old);
});

test('claim or staging replacement is never removed as owned cleanup',async t=>{
  for(const replaced of ['claim','stage'])await t.test(replaced,async st=>{
    const f=await fixture(st);let stage,changed=false,foreign;
    st.mock.method(fs,'open',async(filename,...args)=>{
      const handle=await real.open(filename,...args);if(temporary(filename))stage=filename;
      if(filename===f.filename&&stage&&!changed){
        const names=await real.readdir(f.directory);foreign=replaced==='stage'?stage:path.join(f.directory,names.find(name=>name.endsWith('.lock')));
        await real.rename(foreign,foreign+'.owned');await real.writeFile(foreign,Buffer.from('synthetic foreign file'));changed=true;
      }
      return handle;
    });
    await assert.rejects(writeMigrationArchive(f.filename,f.next,f.target),code('MIGRATION_EXPORT_FILE_CHANGED'));
    assert.equal(changed,true);await unchanged(f);assert.equal((await real.readFile(foreign)).toString(),'synthetic foreign file');
  });
});

test('full Windows inode precision is retained in the confirmed snapshot',async t=>{
  const f=await fixture(t),inode=2n**60n;let changed=false;
  const inodeStat=stat=>{if(typeof stat.ino==='bigint')stat.ino=inode+(changed?1n:0n);return stat;};
  t.mock.method(fs,'lstat',async(filename,...args)=>{const stat=await real.lstat(filename,...args);return filename===f.filename?inodeStat(stat):stat;});
  t.mock.method(fs,'open',async(filename,...args)=>{const handle=await real.open(filename,...args);if(filename===f.filename){const stat=handle.stat.bind(handle);handle.stat=async(...args)=>inodeStat(await stat(...args));}return handle;});
  const target=await prepareMigrationExport(f.filename);changed=true;
  assert.equal(Number(inode),Number(inode+1n));
  await assert.rejects(writeMigrationArchive(f.filename,f.next,target),code('MIGRATION_EXPORT_FILE_CHANGED'));await unchanged(f);
});

test('exclusive staging cleanup keeps a replacement with an adjacent large Windows inode',async t=>{
  const f=await fixture(t),filename=path.join(f.directory,'new.agwenc'),inode=2n**60n;let changed=false;
  t.mock.method(fs,'lstat',async(name,...args)=>{const stat=await real.lstat(name,...args);if(name===filename)stat.ino=inode+(changed?1n:0n);return stat;});
  t.mock.method(fs,'open',async(name,...args)=>{
    const handle=await real.open(name,...args);if(name!==filename)return handle;
    const stat=handle.stat.bind(handle),sync=handle.sync.bind(handle);
    handle.stat=async(...args)=>{const value=await stat(...args);value.ino=inode;return value;};
    handle.sync=async()=>{await sync();await real.rename(filename,filename+'.owned');await real.writeFile(filename,f.old);changed=true;};return handle;
  });
  await assert.rejects(writeMigrationArchive(filename,f.next),code('MIGRATION_EXPORT_FILE_CHANGED'));
  assert.equal(changed,true);assert.deepEqual(await real.readFile(filename),f.old);await unchanged(f);
});

test('replacement claims coalesce competing snapshots and never overwrite the later result',async t=>{
  const f=await fixture(t), second=await prepareMigrationExport(f.filename);
  let release,started;const held=new Promise(r=>release=r),entered=new Promise(r=>started=r);let paused=false;
  t.mock.method(fs,'open',async(filename,...args)=>{const handle=await real.open(filename,...args);if(temporary(filename)&&!paused){paused=true;started();await held;}return handle;});
  const first=writeMigrationArchive(f.filename,f.next,f.target);await entered;
  await assert.rejects(writeMigrationArchive(f.filename,f.old,second),code('MIGRATION_EXPORT_BUSY'));
  await unchanged(f);release();await first;
  await assert.rejects(writeMigrationArchive(f.filename,f.old,second),code('MIGRATION_EXPORT_CONFIRM_REQUIRED'));
  const stale=await prepareMigrationExport(f.filename);await writeMigrationArchive(f.filename,f.old,await prepareMigrationExport(f.filename));
  await assert.rejects(writeMigrationArchive(f.filename,f.next,stale),code('MIGRATION_EXPORT_FILE_CHANGED'));await unchanged(f);
});

test('a failed commit releases its claim so the same filename can be confirmed and retried',async t=>{
  const f=await fixture(t);let failed=false;
  t.mock.method(fs,'rename',async(...args)=>{if(!failed){failed=true;throw Object.assign(Error('synthetic transient commit failure'),{code:'EIO'});}return real.rename(...args);});
  await assert.rejects(writeMigrationArchive(f.filename,f.next,f.target),code('MIGRATION_FILE_WRITE_FAILED'));
  await unchanged(f);assert.deepEqual(await real.readdir(f.directory),['accounts.agwenc']);
  await writeMigrationArchive(f.filename,f.next,await prepareMigrationExport(f.filename));assert.deepEqual(await real.readFile(f.filename),f.next);
});

test('independent export processes commit one complete file from competing confirmations',{timeout:30000},async t=>{
  const f=await fixture(t),entry=require.resolve('../out/account-migration');
  const program=`const api=require(${JSON.stringify(entry)});process.once('message',async m=>{try{const target=await api.prepareMigrationExport(m.filename);process.send({ready:true});process.once('message',async()=>{try{await api.writeMigrationArchive(m.filename,Buffer.from(m.bytes,'base64'),target);process.send({ok:true});}catch(e){process.send({code:e.code});}finally{process.disconnect();}});}catch(e){process.send({code:e.code});process.disconnect();}});`;
  const jobs=Array.from({length:2},()=>{
    const child=fork('-e',[program],{execArgv:[],stdio:['ignore','ignore','ignore','ipc']});
    t.after(()=>{if(child.exitCode===null)child.kill();});
    let readyResolve,doneResolve,reject;const ready=new Promise(r=>readyResolve=r),done=new Promise((r,j)=>{doneResolve=r;reject=j;});
    child.on('message',message=>{if(message.ready)readyResolve();else doneResolve(message);});child.on('error',reject);
    child.on('exit',code=>{if(code!==0)reject(Error('synthetic export child failure'));});
    child.send({filename:f.filename,bytes:f.next.toString('base64')});return {child,ready,done};
  });
  await Promise.all(jobs.map(job=>job.ready));for(const job of jobs)job.child.send({commit:true});
  const results=await Promise.all(jobs.map(job=>job.done));assert.equal(results.filter(result=>result.ok).length,1);
  assert.ok(results.some(result=>['MIGRATION_EXPORT_BUSY','MIGRATION_EXPORT_FILE_CHANGED'].includes(result.code)));
  assert.deepEqual(await real.readFile(f.filename),f.next);assert.deepEqual(await real.readdir(f.directory),['accounts.agwenc']);
});

test('replacement accepts broad modes and WSL-like mount paths without chmod or mount probing',async t=>{
  const f=await fixture(t,'账户 export.agwenc');await fs.chmod(f.directory,0o777);await fs.chmod(f.filename,0o666);
  const target=await prepareMigrationExport(f.filename);
  t.mock.method(fs,'chmod',async()=>{throw Error('must not chmod');});
  t.mock.method(fs,'readFile',async(filename,...args)=>{assert.notEqual(filename,'/proc/self/mountinfo');return real.readFile(filename,...args);});
  await writeMigrationArchive(f.filename,f.next,target);assert.deepEqual(await real.readFile(f.filename),f.next);
});

test('Win32 drive paths use the same guarded replacement with modeled filesystem paths',async t=>{
  const f=await fixture(t);const root=path.join(f.directory,'win-drive');await fs.mkdir(root);
  const win='C:\\账户 Directory\\accounts.agwenc';await fs.mkdir(path.join(root,'账户 Directory'));await real.writeFile(path.join(root,'账户 Directory','accounts.agwenc'),f.old);
  const mapped=name=>{assert.match(name,/^C:\\/);return path.join(root,...name.slice(3).split('\\').filter(Boolean));};
  const shim={...fs,lstat:(name,...args)=>real.lstat(mapped(name),...args),open:(name,...args)=>real.open(mapped(name),...args),unlink:name=>real.unlink(mapped(name)),rename:(from,to)=>real.rename(mapped(from),mapped(to))};
  const entry=require.resolve('../out/account-migration'),load=Module._load,previous=require.cache[entry];delete require.cache[entry];
  Module._load=function(name,parent,...args){return parent?.filename===entry&&name==='node:path'?path.win32:parent?.filename===entry&&name==='node:fs/promises'?shim:load.call(this,name,parent,...args);};
  let api;try{api=require(entry);}finally{Module._load=load;delete require.cache[entry];require.cache[entry]=previous;}
  await api.writeMigrationArchive(win,f.next,await api.prepareMigrationExport(win));assert.deepEqual(await real.readFile(mapped(win)),f.next);
  for(const name of ['relative.agwenc','\\\\server\\share\\file.agwenc','\\\\?\\C:\\file.agwenc','/C:/file.agwenc'])await assert.rejects(api.prepareMigrationExport(name),code('MIGRATION_PATH_UNSAFE'));
});
