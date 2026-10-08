const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{randomUUID}=require('node:crypto');
const {png}=require('./fixtures/png-fixture.cjs'),{jpeg}=require('./fixtures/jpeg-fixture.cjs');
const {resultImage,prepareImageOrigin,verifyImageOrigin,imageVersions,inspectVersion}=require('../out/image-iteration');
const {ImageSessionStore,readImageSession}=require('../out/image-session-store');
const {buildDirectImageBody,generateDirectImage}=require('../out/direct-image-core');
const draft={prompt:'synthetic editable draft',accountId:'11111111-1111-4111-8111-111111111111',modelId:'gemini-3.1-flash-image',ratio:'1:1',count:1,size:'auto',quality:'auto',followCurrent:false};
async function fixture(t){const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'ag-iteration-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));const file=path.join(root,'source.png');await fs.writeFile(file,png());const task={id:randomUUID(),createdAt:'2026-10-05T00:00:00Z',...draft,promptSummary:'synthetic result',references:[],outputDirectory:root,phase:'complete',status:'saved',images:[{file,width:2,height:2}]};return{root,file,task}}
test('version family isolates siblings by root image and excludes failed, cancelled and interrupted outputs',async t=>{
 const {task,root}=await fixture(t);task.images.push({...task.images[0],file:path.join(root,'other.png')});await fs.writeFile(task.images[1].file,png({value:90}));
 const origin=await prepareImageOrigin(task,task.images[0],0),child={...task,id:randomUUID(),origin,references:[origin.file],phase:'partial',images:[task.images[0]]};
 const other={...child,id:randomUUID(),origin:await prepareImageOrigin(task,task.images[1],1)};
 const failed=['failed','cancelled','interrupted'].map(phase=>({...child,id:randomUUID(),phase}));
 const tasks=[task,child,other,...failed],family=imageVersions(tasks,child,0);
 assert.equal(family.versions.length,2);assert.match(family.versions[1].label,/部分完成/);assert.equal(family.left,`${task.id}:0`);assert.equal(family.right,`${child.id}:0`);
 for(const f of failed)assert.throws(()=>resultImage(tasks,f.id,0),/RESULT_UNAVAILABLE/);
 assert.throws(()=>resultImage(tasks,task.id,-1),/RESULT_UNAVAILABLE/);assert.throws(()=>resultImage(tasks,task.id,'0'),/RESULT_UNAVAILABLE/);
 const orphan=imageVersions([child],child,0);assert.equal(orphan.versions.length,2);assert.match(orphan.versions[0].label,/原记录已删除/);assert.equal(await inspectVersion(orphan.versions[0]),undefined);
});
test('source digest pins bytes; missing or changed sources fail without modifying the original',async t=>{
 const {task,file}=await fixture(t),origin=await prepareImageOrigin(task,task.images[0],0);await verifyImageOrigin(origin);
 await fs.writeFile(file,png({value:91}));await assert.rejects(verifyImageOrigin(origin),/SOURCE_CHANGED/);
 const version=imageVersions([{...task,images:[{...task.images[0],sha256:origin.sha256}]}],task,0).versions[0];assert.match(await inspectVersion(version),/已变化/);
 await fs.unlink(file);assert.match(await inspectVersion(version),/已丢失/);
});
test('schema 1 upgrades without losing draft, tasks or source fields; lineage and saved drafts survive repeated schema 3 loads',async t=>{
 const {root,task}=await fixture(t),legacy={schema:1,draft,outputDirectory:root,references:[],tasks:[task]};delete task.followCurrent;
 const dir=path.join(root,'storage');await fs.mkdir(dir,{mode:0o700});const file=path.join(dir,'session.json');await fs.writeFile(file,JSON.stringify(legacy),{mode:0o600});
 const store=new ImageSessionStore(dir),upgraded=await store.load();assert.equal(upgraded.schema,3);assert.deepEqual(upgraded.savedDrafts,[]);assert.deepEqual(upgraded.tasks,legacy.tasks);assert.deepEqual(upgraded.draft,legacy.draft);assert.equal(JSON.parse(await fs.readFile(file)).schema,1);
 const origin=await prepareImageOrigin(task,task.images[0],0);upgraded.origin=origin;upgraded.references=[origin.file];upgraded.savedDrafts=[{id:randomUUID(),savedAt:task.createdAt,draft,outputDirectory:root,references:[]}];
 upgraded.tasks.push({...task,id:randomUUID(),origin,references:[origin.file],phase:'generating',images:[]});
 await store.save(upgraded);const again=new ImageSessionStore(dir),loaded=await again.load();assert.deepEqual(loaded.origin,origin);assert.deepEqual(loaded.savedDrafts,upgraded.savedDrafts);assert.equal(loaded.tasks[1].phase,'interrupted');await again.save(loaded);assert.deepEqual(await new ImageSessionStore(dir).load(),loaded);
 for(const change of [s=>s.origin.sha256='invalid',s=>s.draft.followCurrent=true,s=>s.draft.accountId='account-B',s=>s.tasks[1].origin.taskId=s.tasks[1].id,s=>s.tasks[1].origin.rootImageIndex=1,s=>s.savedDrafts=Array.from({length:11},()=>({...s.savedDrafts[0],id:randomUUID()}))]){const bad=structuredClone(upgraded);change(bad);assert.throws(()=>readImageSession(bad),/IMAGE_SESSION_/)}
});
test('JPEG references use their actual MIME; changed pinned references block before bind or send',async t=>{
 const {root}=await fixture(t),file=path.join(root,'source.jpg'),bytes=jpeg();await fs.writeFile(file,bytes);
 const bound={token:'synthetic',projectId:'synthetic-project',modelId:draft.modelId,accountId:draft.accountId,verify:async()=>{}};
 const request={...draft,aspectRatio:'1:1',outputDirectory:root,references:[file],endpoint:'daily'};
 const body=buildDirectImageBody(request,bound,[{data:bytes,mime:'image/jpeg'}]);assert.equal(body.request.contents[0].parts[1].inlineData.mimeType,'image/jpeg');assert.equal(body.request.contents[0].parts[1].inlineData.data,bytes.toString('base64'));
 let boundCalls=0,sent=0;await assert.rejects(generateDirectImage({...request,referenceHashes:{[file]:'0'.repeat(64)}},new AbortController().signal,{bind:async()=>{boundCalls++;return bound},send:async()=>{sent++}}),/SOURCE_CHANGED/);assert.equal(boundCalls,0);assert.equal(sent,0);assert.deepEqual(await fs.readFile(file),bytes);
});
