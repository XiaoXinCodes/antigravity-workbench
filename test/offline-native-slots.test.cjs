const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {OfficialTokenSlots}=require('../out/live-storage');
async function fixture(t){
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'offline-slots-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));await fs.mkdir(path.join(home,'.gemini'),{mode:0o700});
 const file=path.join(home,'.gemini','jetski-standalone-oauth-token');await fs.writeFile(file,'synthetic-old',{mode:0o600});
 const f={keyring:'synthetic-old',file};f.slots=new OfficialTokenSlots(home,{read:async()=>f.keyring,write:async v=>{f.keyring=v;}});return f;
}
test('native slots invoke guard before each actual keyring/file mutation',async t=>{
 const f=await fixture(t);let guards=0;
 await f.slots.write({keyring:'synthetic-new',file:'synthetic-new'},{keyring:'synthetic-old',file:'synthetic-old'},async()=>{guards++;});
 assert.equal(guards,2);assert.deepEqual(await f.slots.read(),{keyring:'synthetic-new',file:'synthetic-new'});
});
test('new instance before file replacement preserves old file and removes staged temp',async t=>{
 const f=await fixture(t);let guards=0;
 await assert.rejects(f.slots.write({keyring:'synthetic-new',file:'synthetic-new'},{keyring:'synthetic-old',file:'synthetic-old'},async()=>{if(++guards===2)throw Error('OFFLINE_INSTANCE_PRESENT');}),/OFFLINE_INSTANCE_PRESENT/);
 assert.equal(f.keyring,'synthetic-new');assert.equal(await fs.readFile(f.file,'utf8'),'synthetic-old');assert.deepEqual(await fs.readdir(path.dirname(f.file)),['jetski-standalone-oauth-token']);
});
test('external file change during awaited guard is not overwritten',async t=>{
 const f=await fixture(t);
 await assert.rejects(f.slots.write({keyring:'synthetic-old',file:'synthetic-new'},{keyring:'synthetic-old',file:'synthetic-old'},async()=>{await fs.writeFile(f.file,'synthetic-external');}),/OFFICIAL_STORAGE_CHANGED/);
 assert.equal(await fs.readFile(f.file,'utf8'),'synthetic-external');
});
