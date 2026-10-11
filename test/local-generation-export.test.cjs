const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { responseModels } = require('../out/model-observation');
const { buildLocalGenerationStats } = require('../out/local-generation-stats');
const { generationStatsExportContent, generationExportCsvCell, prepareGenerationExport, writeGenerationExport } = require('../out/local-generation-export');
const metrics = ['input', 'cacheWrite', 'cacheRead', 'outputText', 'reasoning', 'outputTotal'];
function fixture() {
 const now = Date.parse('2026-10-11T12:00:00Z');
 const row = { client:'cli',session:'/private/never-export.db',key:'private:response:'+'a'.repeat(64),index:123,usageInterpretation:'verified',
  requested:responseModels({}),returned:responseModels({model:'synthetic-returned'}),
  timestamp:{status:'provided',value:now,source:'generation',fields:['raw.timestamp']},
  project:{status:'provided',values:[{key:'b'.repeat(64),label:'=SUM(1+1)'}],fields:['raw.workspace_uri']},
  tokens:Object.fromEntries(metrics.map((key,index)=>[key,{status:'provided',value:index,fields:['raw.'+key]}])),
  prompt:'private-prompt',credentials:'private-credential',sourcePath:'/private/source.db'};
 row.tokens.input={status:'missing',fields:[]}; row.tokens.cacheWrite={status:'invalid',fields:['raw.cacheWrite']}; row.tokens.cacheRead={status:'conflict',fields:['raw.cacheRead']};
 return buildLocalGenerationStats([row],{range:'all',now,timeZone:'UTC'});
}
async function directory(t) { const dir=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'agw-stats-export-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir; }
const code = value => error => error.code===value && error.message===value && !error.message.includes(path.sep);

test('JSON exports only safe filtered statistics and local ordinal IDs, preserving missing statuses',()=>{
 const input=fixture(),before=JSON.stringify(input),content=generationStatsExportContent(input,'json'),data=JSON.parse(content);
 for(const secret of ['/private/','private-prompt','private-credential','raw.','a'.repeat(64),'b'.repeat(64)]) assert.equal(content.includes(secret),false,secret);
 assert.equal(data.countUnit,'metadata-records');assert.equal(data.modelEvidence,'server-declaration');assert.equal(data.summary.recordCount,1);
 assert.equal(data.records[0].id,1);assert.equal(data.records[0].session,1);assert.equal(data.records[0].returnedModel.values[0],'synthetic-returned');
 assert.deepEqual(data.records[0].tokens.input,{status:'missing'});assert.deepEqual(data.records[0].tokens.cacheWrite,{status:'invalid'});assert.deepEqual(data.records[0].tokens.cacheRead,{status:'conflict'});
 assert.equal(data.records[0].tokens.outputTotal.value,5);assert.equal(data.scope.timeZone,'UTC');assert.equal(data.scope.unknownTimeCount,0);
 assert.equal(JSON.stringify(input),before);
});
test('CSV quotes all cells, neutralizes formulas including control prefixes, and exports no provenance',()=>{
 for(const value of ['=1+1',' +SUM(1)','\t-1','\r\n@SUM(1)','\u200b=1','\u0000+2']) assert.equal(generationExportCsvCell(value),'"\''+value+'"');
 assert.equal(generationExportCsvCell('a,"b"\nc'),'"a,""b""\nc"');assert.equal(generationExportCsvCell(undefined),'""');assert.equal(generationExportCsvCell(0),'"0"');
 const content=generationStatsExportContent(fixture(),'csv');assert.ok(content.includes('"\'=SUM(1+1)"'));assert.ok(content.includes('"missing","","invalid","","conflict",""'));
 assert.ok(content.startsWith('"row_id","session_id"'));assert.ok(content.endsWith('\r\n'));assert.equal(content.includes('/private'),false);assert.equal(content.includes('raw.'),false);
});
test('absolute project paths are omitted and never exported as labels',()=>{
 const input=fixture();input.rows[0].project.values[0].label='/private/workspace';const data=JSON.parse(generationStatsExportContent(input,'json'));
 assert.deepEqual(data.records[0].project,{status:'invalid'});assert.equal(JSON.stringify(data).includes('/private'),false);
});
test('unverified usage never exports stale provided token values or old summary totals',()=>{
 const input=fixture();input.rows[0].usageInterpretation='unverified';input.summary.tokens.outputTotal={status:'complete',sum:987654,knownCount:1,missingCount:0,invalidCount:0,conflictCount:0,totalCount:1};
 const data=JSON.parse(generationStatsExportContent(input,'json'));
 assert.equal(data.records[0].usageStatus,'unverified');
 for(const metric of metrics) {assert.deepEqual(data.records[0].tokens[metric],{status:'missing'});assert.equal(data.summary.tokens[metric].sum,undefined);assert.equal(data.summary.tokens[metric].missingCount,1);}
 assert.equal(JSON.stringify(data).includes('987654'),false);assert.equal(data.records[0].returnedModel.values[0],'synthetic-returned');
 const csv=generationStatsExportContent(input,'csv');assert.ok(csv.includes('"unverified"'));assert.equal(csv.includes('987654'),false);assert.equal(csv.includes('"provided","5"'),false);
});
test('missing and unknown usage markers fail closed despite stale provided values',()=>{
 for(const marker of [undefined,'unknown','VERIFIED',null]) {
  const input=fixture();if(marker===undefined)delete input.rows[0].usageInterpretation;else input.rows[0].usageInterpretation=marker;
  const data=JSON.parse(generationStatsExportContent(input,'json'));
  assert.equal(data.records[0].usageStatus,'unverified');
  for(const metric of metrics) {assert.deepEqual(data.records[0].tokens[metric],{status:'missing'});assert.equal(data.summary.tokens[metric].sum,undefined);}
  const csv=generationStatsExportContent(input,'csv');assert.ok(csv.includes('"unverified"'));assert.equal(csv.includes('"provided","5"'),false);
 }
});
test('empty filtered snapshot yields valid schema and only CSV headings',()=>{
 const input=buildLocalGenerationStats([],{range:'today',now:Date.parse('2026-10-11T00:00:00Z'),timeZone:'UTC'});
 assert.deepEqual(JSON.parse(generationStatsExportContent(input,'json')).records,[]);assert.equal(generationStatsExportContent(input,'csv').split('\r\n').length,2);
});
test('trusted read coverage is allowlisted and never implies complete history',()=>{
 const input=fixture(),scope={files:4,skipped:2,limited:true,host:'private-host',sourcePath:'/private/database',gaps:['private-gap']};
 const content=generationStatsExportContent(input,'json',scope),data=JSON.parse(content);
 assert.deepEqual(data.sourceCoverage,{kind:'bounded-read',recordsRead:1,filesRead:4,skipped:2,limited:true,historyComplete:false});
 for(const secret of ['private-host','/private/database','private-gap'])assert.equal(content.includes(secret),false);
 const unknown=JSON.parse(generationStatsExportContent(input,'json')).sourceCoverage;
 assert.deepEqual(unknown,{kind:'unknown',recordsRead:1,historyComplete:false});
 const csv=generationStatsExportContent(input,'csv',scope);assert.ok(csv.includes('"range_start","range_end","observed_through","read_records","read_files","read_skipped","read_limited","read_scope"'));
 assert.ok(csv.includes('"all","UTC","","2026-10-11","2026-10-11T12:00:00.000Z","1","4","2","true","bounded-read"'));
 assert.ok(generationStatsExportContent(input,'csv').includes('"1","","","","unknown"'));
});
test('export freezes calendar boundaries and observed time from the filtered snapshot',()=>{
 const input=fixture();input.range='7d';input.startLocalDate='2026-10-05';
 const firstJson=generationStatsExportContent(input,'json'),firstCsv=generationStatsExportContent(input,'csv');
 const original=Date.now;Date.now=()=>Date.parse('2030-01-01T00:00:00Z');
 try {assert.equal(generationStatsExportContent(input,'json'),firstJson);assert.equal(generationStatsExportContent(input,'csv'),firstCsv);}finally{Date.now=original;}
 assert.ok(firstCsv.includes('"7d","UTC","2026-10-05","2026-10-11","2026-10-11T12:00:00.000Z"'));
 const data=JSON.parse(firstJson);assert.equal(data.scope.startLocalDate,'2026-10-05');assert.equal(data.scope.throughLocalDate,'2026-10-11');assert.equal(data.scope.observedThrough,'2026-10-11T12:00:00.000Z');
});
test('time provenance exports only the explicit generation or step-created enum',()=>{
 for(const source of ['generation','step-created',undefined,'raw.private.timestamp','/private/time-source','created','STEP-CREATED',null]) {
  const input=fixture();if(source===undefined)delete input.rows[0].timestamp.source;else input.rows[0].timestamp.source=source;
  const content=generationStatsExportContent(input,'json'),data=JSON.parse(content),csv=generationStatsExportContent(input,'csv');
  if(source==='generation'||source==='step-created') {
   assert.equal(data.records[0].timestamp.source,source);assert.ok(csv.includes('"2026-10-11T12:00:00.000Z","'+source+'"'));
  } else {
   assert.equal(Object.hasOwn(data.records[0].timestamp,'source'),false);assert.ok(csv.includes('"2026-10-11T12:00:00.000Z","","provided"'));
   if(typeof source==='string') {assert.equal(content.includes(source),false);assert.equal(csv.includes(source),false);}
  }
  assert.ok(csv.split('\r\n')[0].includes('"timestamp_source"'));
 }
 const missing=fixture();missing.rows[0].timestamp={status:'missing',source:'step-created',fields:[]};
 assert.deepEqual(JSON.parse(generationStatsExportContent(missing,'json')).records[0].timestamp,{status:'missing'});
});
test('exports exactly the filtered records with associated step time and missing cache values intact',()=>{
 const seed=fixture(),now=seed.now,first=structuredClone(seed.rows[0]),second=structuredClone(first),outsideModel=structuredClone(first),outsideRange=structuredClone(first);
 first.key='selected:response:'+'1'.repeat(64);first.timestamp={status:'provided',value:now,source:'step-created',fields:['raw.step-created']};
 first.tokens.cacheRead={status:'missing',fields:[]};first.tokens.cacheWrite={status:'missing',fields:[]};
 second.key='selected:response:'+'2'.repeat(64);second.timestamp={status:'provided',value:now-86400000,source:'generation',fields:['raw.generation']};
 outsideModel.key='selected:response:'+'3'.repeat(64);outsideModel.returned=responseModels({model:'other-synthetic-model'});
 outsideRange.key='selected:response:'+'4'.repeat(64);outsideRange.timestamp.value=now-31*86400000;
 const input=buildLocalGenerationStats([first,second,outsideModel,outsideRange],{range:'7d',model:'model:synthetic-returned',now,timeZone:'UTC'}),before=JSON.stringify(input);
 assert.equal(input.rows.length,2);
 const data=JSON.parse(generationStatsExportContent(input,'json'));
 assert.equal(data.records.length,input.rows.length);assert.deepEqual(data.records.map(row=>row.timestamp.value),input.rows.map(row=>new Date(row.timestamp.value).toISOString()));
 assert.deepEqual(data.records.map(row=>row.timestamp.source),['step-created','generation']);
 assert.deepEqual(data.records[0].tokens.cacheRead,{status:'missing'});assert.deepEqual(data.records[0].tokens.cacheWrite,{status:'missing'});
 assert.equal(data.records[0].returnedModel.values[0],first.returned.values[0]);
 const csv=generationStatsExportContent(input,'csv');assert.equal(csv.trimEnd().split('\r\n').length,input.rows.length+1);assert.equal(csv.includes('other-synthetic-model'),false);
 assert.ok(csv.includes('"missing","","missing",""'));assert.equal(csv.includes('raw.'),false);assert.equal(JSON.stringify(input),before);
});
test('new export commits complete private bytes and leaves no temporary files',async t=>{
 const dir=await directory(t),filename=path.join(dir,'stats.json'),target=await prepareGenerationExport(filename);
 assert.equal(target.exists,false);assert.deepEqual(await fs.readdir(dir),[]);
 const content=generationStatsExportContent(fixture(),'json');await writeGenerationExport(target,content);
 assert.equal(await fs.readFile(filename,'utf8'),content);assert.deepEqual(await fs.readdir(dir),['stats.json']);assert.equal((await fs.stat(filename)).nlink,1);
 if(process.platform!=='win32') assert.equal((await fs.stat(filename)).mode&0o777,0o600);
 await assert.rejects(writeGenerationExport(target,'second'),code('LOCAL_EXPORT_CONFIRM_REQUIRED'));
});
test('existing file requires explicit overwrite and is atomically replaced only with fresh approval',async t=>{
 const dir=await directory(t),filename=path.join(dir,'stats.csv');await fs.writeFile(filename,'original');
 const target=await prepareGenerationExport(filename);assert.equal(target.exists,true);
 await assert.rejects(writeGenerationExport(target,'unapproved'),code('LOCAL_EXPORT_CONFIRM_REQUIRED'));assert.equal(await fs.readFile(filename,'utf8'),'original');
 const fresh=await prepareGenerationExport(filename),before=await fs.stat(filename);await writeGenerationExport(fresh,'approved',{allowOverwrite:true});
 assert.equal(await fs.readFile(filename,'utf8'),'approved');assert.notEqual((await fs.stat(filename)).ino,before.ino);assert.deepEqual(await fs.readdir(dir),['stats.csv']);
});
test('changed target identity or content refuses overwrite and keeps latest bytes',async t=>{
 const dir=await directory(t),filename=path.join(dir,'stats.json');await fs.writeFile(filename,'original');
 const target=await prepareGenerationExport(filename);await fs.rename(filename,path.join(dir,'previous.json'));await fs.writeFile(filename,'replacement');
 await assert.rejects(writeGenerationExport(target,'new',{allowOverwrite:true}),code('LOCAL_EXPORT_CHANGED'));assert.equal(await fs.readFile(filename,'utf8'),'replacement');
 const again=await prepareGenerationExport(filename);await fs.writeFile(filename,'mutated-content-longer');
 await assert.rejects(writeGenerationExport(again,'new',{allowOverwrite:true}),code('LOCAL_EXPORT_CHANGED'));assert.equal(await fs.readFile(filename,'utf8'),'mutated-content-longer');
 assert.equal((await fs.readdir(dir)).some(name=>name.startsWith('.agw-stats-')),false);
});
test('concurrent creation refuses overwrite for a previously absent target',async t=>{
 const dir=await directory(t),filename=path.join(dir,'stats.csv'),target=await prepareGenerationExport(filename);await fs.writeFile(filename,'other');
 await assert.rejects(writeGenerationExport(target,'new'),code('LOCAL_EXPORT_CHANGED'));assert.equal(await fs.readFile(filename,'utf8'),'other');assert.deepEqual(await fs.readdir(dir),['stats.csv']);
});
test('cancellation and stale panel snapshot before write leave no effects',async t=>{
 const dir=await directory(t),filename=path.join(dir,'stats.json'),controller=new AbortController();controller.abort();
 await assert.rejects(writeGenerationExport(await prepareGenerationExport(filename),'new',{signal:controller.signal}),code('LOCAL_EXPORT_CANCELLED'));
 await assert.rejects(writeGenerationExport(await prepareGenerationExport(filename),'new',{isCurrent:()=>false}),code('LOCAL_EXPORT_CANCELLED'));assert.deepEqual(await fs.readdir(dir),[]);
});
test('cancellation after staging leaves the approved original untouched and cleans temporary bytes',async t=>{
 const dir=await directory(t),filename=path.join(dir,'stats.json');await fs.writeFile(filename,'original');const target=await prepareGenerationExport(filename),controller=new AbortController(),originalOpen=fs.open;
 fs.open=async(...args)=>{const handle=await originalOpen(...args);if(String(args[0]).includes('.agw-stats-')){const originalWrite=handle.writeFile.bind(handle);handle.writeFile=async(...args)=>{await originalWrite(...args);controller.abort();};}return handle;};t.after(()=>{fs.open=originalOpen;});
 try { await assert.rejects(writeGenerationExport(target,'staged-new',{allowOverwrite:true,signal:controller.signal}),code('LOCAL_EXPORT_CANCELLED')); } finally { fs.open=originalOpen; }
 assert.equal(await fs.readFile(filename,'utf8'),'original');assert.deepEqual(await fs.readdir(dir),['stats.json']);
});
test('atomic commit failure cleans staged bytes, sanitizes error and never truncates original',async t=>{
 const dir=await directory(t),filename=path.join(dir,'stats.json');await fs.writeFile(filename,'original');const target=await prepareGenerationExport(filename),originalRename=fs.rename;
 fs.rename=async()=>{throw Object.assign(new Error('private path and OS detail'),{code:'EACCES'});};t.after(()=>{fs.rename=originalRename;});
 try { await assert.rejects(writeGenerationExport(target,'new',{allowOverwrite:true}),code('LOCAL_EXPORT_WRITE_FAILED')); } finally { fs.rename=originalRename; }
 assert.equal(await fs.readFile(filename,'utf8'),'original');assert.deepEqual(await fs.readdir(dir),['stats.json']);
});
test('exclusive new-file commit never overwrites a file created after staging',async t=>{
 const dir=await directory(t),filename=path.join(dir,'stats.json'),target=await prepareGenerationExport(filename),originalLink=fs.link;
 fs.link=async(...args)=>{await fs.writeFile(filename,'concurrent-writer',{flag:'wx'});return originalLink(...args);};t.after(()=>{fs.link=originalLink;});
 try { await assert.rejects(writeGenerationExport(target,'staged-new'),code('LOCAL_EXPORT_CHANGED')); } finally { fs.link=originalLink; }
 assert.equal(await fs.readFile(filename,'utf8'),'concurrent-writer');assert.deepEqual(await fs.readdir(dir),['stats.json']);
});
test('file symlinks, hardlinks, directory symlinks and database extensions are refused',async t=>{
 const dir=await directory(t),original=path.join(dir,'original.json');await fs.writeFile(original,'never-change');
 const hard=path.join(dir,'hard.json');await fs.link(original,hard);await assert.rejects(prepareGenerationExport(hard),code('LOCAL_EXPORT_PATH_UNSAFE'));await fs.unlink(hard);
 const symbolic=path.join(dir,'symbolic.json');await fs.symlink(original,symbolic);await assert.rejects(prepareGenerationExport(symbolic),code('LOCAL_EXPORT_PATH_UNSAFE'));
 const ancestor=path.join(dir,'linked');await fs.symlink(dir,ancestor,process.platform==='win32'?'junction':'dir');await assert.rejects(prepareGenerationExport(path.join(ancestor,'new.json')),code('LOCAL_EXPORT_PATH_UNSAFE'));
 for(const name of ['session.db','session.db-wal','session.db-shm','session.db-journal','session.json.db','CON.csv']) await assert.rejects(prepareGenerationExport(path.join(dir,name)),code('LOCAL_EXPORT_PATH_UNSAFE'));
 assert.equal(await fs.readFile(original,'utf8'),'never-change');
});
test('ancestor replacement after approval is detected without writing into either directory',async t=>{
 const dir=await directory(t),parent=path.join(dir,'parent');await fs.mkdir(parent);const target=await prepareGenerationExport(path.join(parent,'stats.json'));
 await fs.rename(parent,path.join(dir,'previous'));await fs.mkdir(parent);await assert.rejects(writeGenerationExport(target,'new'),code('LOCAL_EXPORT_CHANGED'));
 assert.deepEqual(await fs.readdir(parent),[]);assert.deepEqual(await fs.readdir(path.join(dir,'previous')),[]);
});
