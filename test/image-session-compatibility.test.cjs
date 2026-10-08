const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {ImageSessionStore,readImageSession}=require('../out/image-session-store');
const {verifyImageOrigin,prepareImageOrigin,imageVersions}=require('../out/image-iteration');
const {sameImagePath,imageAncestorDirectories,readImageBytes}=require('../out/image-files');
const {png}=require('./fixtures/png-fixture.cjs');
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',C='33333333-3333-4333-8333-333333333333';
const draft={prompt:'synthetic in-progress revision',accountId:A,modelId:'gemini-3.1-flash-image',ratio:'16:9',count:2,size:'2K',quality:'detail',followCurrent:true};
function cloud(root){
 const parent={id:A,createdAt:'2026-10-05T01:00:00Z',prompt:'synthetic parent',promptSummary:'synthetic parent',accountId:A,modelId:draft.modelId,ratio:'1:1',size:'auto',quality:'auto',count:1,references:[],outputDirectory:root,phase:'complete',status:'saved',images:[{file:path.join(root,'parent.png'),width:2,height:2}]};
 const child={...parent,id:B,parentTaskId:A,parentImageIndex:0,references:[parent.images[0].file],images:[{file:path.join(root,'child.png'),width:2,height:2}]};
 return{schema:1,draft:{...draft},references:[child.images[0].file],outputDirectory:root,tasks:[parent,child],edit:{parentTaskId:B,parentImageIndex:0,backup:{draft:{...draft,prompt:'synthetic original unsent draft'},references:[],outputDirectory:root}}};
}
async function fixture(t){const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'ag-compat-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}
test('cloud schema 1 preserves chained lineage, original and current drafts, with no invented source digest',async t=>{
 const root=await fixture(t),old=cloud(root),before=structuredClone(old),next=readImageSession(old);
 assert.equal(next.schema,3);assert.deepEqual(old,before);assert.deepEqual(next.draft,old.draft);assert.deepEqual(next.references,old.references);
 assert.deepEqual(next.savedDrafts[0].draft,old.edit.backup.draft);assert.deepEqual(next.savedDrafts[0].references,old.edit.backup.references);
 assert.equal(next.tasks[1].origin.taskId,A);assert.equal(next.origin.taskId,B);assert.equal(next.origin.rootTaskId,A);assert.equal(next.origin.sha256,undefined);assert.equal(next.origin.legacyUnverified,true);
 assert.deepEqual(readImageSession(old),next);assert.deepEqual(readImageSession(next),next);
 const comparison=imageVersions(next.tasks,next.tasks[1],0);assert.equal(comparison.versions.length,2);assert.equal(comparison.left,`${A}:0`);
 await assert.rejects(verifyImageOrigin(next.origin),/SOURCE_UNVERIFIED/);
 await fs.writeFile(old.tasks[1].images[0].file,png());const pinned=await prepareImageOrigin(next.tasks[1],next.tasks[1].images[0],0);
 assert.match(pinned.sha256,/^[a-f0-9]{64}$/);assert.equal(pinned.legacyUnverified,undefined);await verifyImageOrigin(pinned);
});
test('loading cloud data leaves disk unchanged; explicit save and restart retain missing-image relationships and draft exactly',async t=>{
 const root=await fixture(t),dir=path.join(root,'storage');await fs.mkdir(dir,{mode:0o700});const file=path.join(dir,'session.json');
 const old=cloud(root);old.tasks.push({...old.tasks[1],id:C,parentTaskId:B,phase:'generating',images:[]});
 const raw=JSON.stringify(old);await fs.writeFile(file,raw,{mode:0o600});const store=new ImageSessionStore(dir),loaded=await store.load();
 assert.equal(await fs.readFile(file,'utf8'),raw);assert.equal(loaded.tasks[2].phase,'interrupted');assert.equal(loaded.tasks[2].origin.rootTaskId,A);
 await store.save(loaded);const again=await new ImageSessionStore(dir).load();assert.deepEqual(again,loaded);assert.equal(JSON.parse(await fs.readFile(file)).schema,3);
});
test('local schema 2 upgrades losslessly including hashes, project copies, deleted parent references and saved editing drafts',async t=>{
 const root=await fixture(t),s=cloud(root),parent=s.tasks[0];await fs.writeFile(parent.images[0].file,png());const origin=await prepareImageOrigin(parent,parent.images[0],0);
 const value={schema:2,draft:{...draft,followCurrent:false},references:[origin.file],outputDirectory:root,origin,tasks:[{...parent,id:B,origin,references:[origin.file],images:[{...parent.images[0],sha256:origin.sha256,projectCopy:{file:path.join(root,'copy.png'),sha256:origin.sha256}}]}],savedDrafts:[{id:C,savedAt:parent.createdAt,draft:{...draft,followCurrent:false},references:[origin.file],outputDirectory:root,origin}]};
 const next=readImageSession(value);assert.deepEqual(next,{...value,schema:3});assert.deepEqual(readImageSession(next),next);await verifyImageOrigin(next.origin);
});
test('invalid cloud parents, cycles, indexes, backup fields and untrusted origin flags reject without overwriting',async t=>{
 const root=await fixture(t),dir=path.join(root,'storage');await fs.mkdir(dir,{mode:0o700});const file=path.join(dir,'session.json');
 for(const change of [s=>s.tasks[1].parentTaskId=C,s=>s.tasks[0].parentTaskId=B,s=>s.tasks[1].parentTaskId=B,s=>s.tasks[1].parentImageIndex=32,s=>s.edit.parentImageIndex=1,s=>s.edit.backup.references=Array(4).fill(path.join(root,'x.png')),s=>s.edit.backup.draft.prompt='x'.repeat(12001),s=>s.schema=99]){
  const s=cloud(root);change(s);const raw=JSON.stringify(s);await fs.writeFile(file,raw,{mode:0o600});const store=new ImageSessionStore(dir);await assert.rejects(store.load(),/IMAGE_SESSION_/);assert.equal(await fs.readFile(file,'utf8'),raw);
 }
 const migrated=readImageSession(cloud(root));migrated.origin.sha256='0'.repeat(64);assert.throws(()=>readImageSession(migrated),/IMAGE_SESSION_INVALID/);
});
test('Windows drive checks are bounded on all hosts and preserve POSIX case and symlink rejection',async t=>{
 assert.equal(sameImagePath('C:\\work\\a.png','c:\\work\\a.png','win32'),true);
 assert.equal(sameImagePath('C:\\Work\\a.png','c:\\work\\a.png','win32'),false);
 assert.equal(sameImagePath('/A/a.png','/a/a.png','linux'),false);
 assert.deepEqual(imageAncestorDirectories('c:\\work\\sub\\a.png','C:\\work','win32'),['c:\\work\\sub']);
 assert.throws(()=>imageAncestorDirectories('C:\\work2\\a.png','c:\\work','win32'),/OUTSIDE/);
 assert.throws(()=>imageAncestorDirectories('D:\\work\\a.png','c:\\work','win32'),/OUTSIDE/);
 const root=await fixture(t),file=path.join(root,'source.png');await fs.writeFile(file,png());
 await assert.rejects(readImageBytes(file,root+'/missing'),/OUTSIDE/);
 if(process.platform!=='win32'){const link=path.join(root,'link.png');await fs.symlink(file,link);await assert.rejects(readImageBytes(link,root),/UNSAFE_FILE/);}
});
