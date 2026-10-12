require('./helpers/offline-only.cjs');
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),{createHash}=require('node:crypto');
const {database,generation,stepMetadata,workspaceMetadata,runPython}=require('./helpers/generation-fixture.cjs'),{readLocalGenerationDb}=require('../out/local-generation-db'),{buildLocalGenerationStats}=require('../out/local-generation-stats'),{generationStatsExportContent}=require('../out/local-generation-export');
const signal=()=>new AbortController().signal,now=Date.UTC(2026,9,11,12),uri='file:///synthetic/private/Workspace%20A';
// This file runs in a separate test process. Isolate its private snapshots from
// the existing concurrent file's assertions about temp-directory cleanup.
const tempRoot=require('node:fs').realpathSync(require('node:fs').mkdtempSync(path.join(os.tmpdir(),'ag-metadata-suite-')));
process.env.TMPDIR=tempRoot;process.env.TEMP=tempRoot;process.env.TMP=tempRoot;
test.after(()=>fs.rm(tempRoot,{recursive:true,force:true}));
async function directory(t){const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'ag-metadata-test-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root}
const digest=async names=>Promise.all(names.map(async name=>{const s=await fs.stat(name);return [s.size,s.mtimeMs,s.ctimeMs,createHash('sha256').update(await fs.readFile(name)).digest('hex')]}));
test('native and WASM read exact canonical token, unique step time and workspace metadata without source writes',async t=>{
 const root=await directory(t),file=path.join(root,'synthetic.db'),db=await database(file,[generation(),generation({id:'second',usage:{2:0,3:0}})],'wal',4096,{steps:[stepMetadata({createdAt:now}),stepMetadata({id:'second',createdAt:now-86400000})],workspace:workspaceMetadata([uri])});
 try{const names=[file,file+'-wal'],before=await digest(names);const native=await readLocalGenerationDb(file,signal()),wasm=await readLocalGenerationDb(file,signal(),{engine:'wasm'});assert.deepEqual(wasm,native);assert.deepEqual(await digest(names),before);assert.equal(native.limited,false);const first=native.rows[0];assert.equal(first.tokens.input.value,7);assert.equal(first.tokens.outputTotal.value,9);assert.equal(first.tokens.cacheWrite.status,'missing');assert.equal(first.timestamp.value,now);assert.equal(first.timestamp.source,'step-created');assert.equal(first.project.values[0].label,'Workspace A');assert.doesNotMatch(JSON.stringify(native),/file:\/\/|synthetic\/private|STEP_PAYLOAD|SYNTHETIC_PROMPT/);const stats=buildLocalGenerationStats(native.rows,{range:'today',now,timeZone:'UTC',model:'model:synthetic-return-a',project:first.project.values[0].key});assert.equal(stats.rows.length,1);assert.equal(stats.summary.tokens.input.sum,7);const json=JSON.parse(generationStatsExportContent(stats,'json'));assert.equal(json.records.length,1);assert.equal(json.records[0].timestamp.source,'step-created');assert.equal(json.records[0].tokens.cacheWrite.value,undefined);assert.match(generationStatsExportContent(stats,'csv'),/"timestamp_source"/);assert.match(generationStatsExportContent(stats,'csv'),/"step-created"/)}finally{await db.close()}
});
test('same response ID and filename in different DBs never mix time, workspace or deduplication',async t=>{
 const root=await directory(t),rows=[];
 for(const [name,time,workspace] of [['one',now,'Workspace%20A'],['two',now-86400000,'Workspace%20B']]){const folder=path.join(root,name);await fs.mkdir(folder);const file=path.join(folder,'11111111-1111-4111-8111-111111111111.db'),db=await database(file,[generation()],'delete',4096,{steps:[stepMetadata({createdAt:time})],workspace:workspaceMetadata(['file:///synthetic/private/'+workspace])});await db.close();rows.push(...(await readLocalGenerationDb(file,signal())).rows)}
 assert.notEqual(rows[0].session,rows[1].session);assert.equal(rows[0].timestamp.value,now);assert.equal(rows[1].timestamp.value,now-86400000);assert.notEqual(rows[0].project.values[0].key,rows[1].project.values[0].key);const all=buildLocalGenerationStats(rows,{range:'all',now,timeZone:'UTC'});assert.equal(all.rows.length,2);assert.equal(all.summary.tokens.input.sum,14);assert.equal(all.projectOptions.length,2);
});
test('multiple matching steps, missing IDs/times and different workspace URIs remain explicit',async t=>{
 const root=await directory(t);
 for(const [name,steps,workspaces,timeStatus,projectStatus] of [
  ['multi',[stepMetadata({createdAt:now}),stepMetadata({createdAt:now})],[uri],'conflict','provided'],
  ['nomatch',[stepMetadata({id:'other',createdAt:now})],[uri],'missing','provided'],
  ['notime',[stepMetadata()],[uri],'missing','provided'],
  ['workspaces',[stepMetadata({createdAt:now})],[uri,'file:///synthetic/private/Workspace%20B'],'provided','conflict'],
  ['absent',[],[],'missing','missing']]){const file=path.join(root,name+'.db'),db=await database(file,[generation()],'delete',4096,{steps,workspace:workspaceMetadata(workspaces)});await db.close();const row=(await readLocalGenerationDb(file,signal())).rows[0];assert.equal(row.timestamp.status,timeStatus,name);assert.equal(row.project.status,projectStatus,name);assert.equal(row.tokens.input.value,7);if(timeStatus!=='provided')assert.equal(row.timestamp.value,undefined);}
});
test('truncated or unsupported optional step metadata cannot prove a unique match',async t=>{
 const root=await directory(t),file=path.join(root,'limited.db'),steps=Array.from({length:2001},()=>Buffer.alloc(0));steps[0]=stepMetadata({createdAt:now});steps[2000]=stepMetadata({createdAt:now});const db=await database(file,[generation()],'delete',4096,{steps});await db.close();const limited=await readLocalGenerationDb(file,signal());assert.equal(limited.limited,true);assert.equal(limited.rows[0].timestamp.status,'missing');assert.equal(limited.rows[0].tokens.input.value,7);
 runPython(['-I','-c',"import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);c.execute('ALTER TABLE steps RENAME TO old_steps');c.execute('CREATE VIEW steps AS SELECT idx,metadata FROM old_steps');c.commit();c.close()",file]);const unsupported=await readLocalGenerationDb(file,signal());assert.equal(unsupported.rows[0].timestamp.status,'missing');assert.equal(unsupported.rows[0].tokens.input.value,7);
});
test('oversized step metadata is bounded and cannot hide later duplicate joins',async t=>{
 const root=await directory(t),file=path.join(root,'large.db'),db=await database(file,[generation()],'delete',4096,{steps:[stepMetadata({createdAt:now}),Buffer.alloc(0)]});await db.close();runPython(['-I','-c',"import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);c.execute('UPDATE steps SET metadata=zeroblob(1048577) WHERE idx=1');c.commit();c.close()",file]);const result=await readLocalGenerationDb(file,signal(),{engine:'wasm'});assert.equal(result.limited,true);assert.equal(result.rows[0].timestamp.status,'missing');assert.equal(result.rows[0].tokens.input.value,7);
});
test('explicit SQL NULL optional metadata is absent rather than an unreadable linkage or truncation',async t=>{
 const root=await directory(t),file=path.join(root,'null.db'),db=await database(file,[generation()],'delete',4096,{steps:[stepMetadata({createdAt:now}),Buffer.alloc(0)],workspace:workspaceMetadata([uri])});await db.close();runPython(['-I','-c',"import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);c.execute('UPDATE steps SET metadata=NULL WHERE idx=1');c.execute('UPDATE trajectory_metadata_blob SET data=NULL');c.commit();c.close()",file]);
 for(const engine of ['auto','wasm']){const result=await readLocalGenerationDb(file,signal(),{engine});assert.equal(result.limited,false);assert.equal(result.rows[0].timestamp.value,now);assert.equal(result.rows[0].timestamp.source,'step-created');assert.equal(result.rows[0].project.status,'missing');}
});
