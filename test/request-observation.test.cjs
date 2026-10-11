const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{createHash,randomUUID}=require('node:crypto'),{EventEmitter}=require('node:events');
const {responseModels,mergeModels,missingModel,readModelObservation}=require('../out/model-observation'),{parseWakeStream,sendWake}=require('../out/wake-transport'),{parseLocalGeneration,mergeLocalRecords}=require('../out/local-generation-record'),{readLocalGenerationDb}=require('../out/local-generation-db'),{readImageSession}=require('../out/image-session-store'),{initialWakeState,parseWakeState}=require('../out/wake-state'),{responseModelDetails}=require('../out/request-observation-view'),{setLanguage}=require('../out/i18n');
const {generation,buf,database}=require('./helpers/generation-fixture.cjs');
const signal=()=>new AbortController().signal;
test('raw response declarations preserve field/value pairs, reject arbitrary bodies and never read accessors',()=>{
 const v=responseModels({model:'synthetic-request-declaration',response:{modelVersion:'synthetic-return-version'},prompt:'secret prompt',usageMetadata:{model:'not-a-model-source'}});
 assert.equal(v.status,'conflict');assert.deepEqual(v.entries,[{field:'model',value:'synthetic-request-declaration'},{field:'response.modelVersion',value:'synthetic-return-version'}]);assert.deepEqual(readModelObservation(v),v);assert.doesNotMatch(JSON.stringify(v),/secret|not-a-model-source/);
 const guarded={get model(){throw Error('GETTER_EXECUTED')},get response(){throw Error('GETTER_EXECUTED')}};assert.equal(responseModels(guarded).status,'missing');
 for(const raw of [null,123,{},[],true,'','  synthetic-model','secret prompt with spaces','x'.repeat(129)]){const invalid=responseModels({response:{modelVersion:raw}});assert.equal(invalid.status,'invalid');assert.deepEqual(invalid.values,[]);assert.deepEqual(readModelObservation(invalid),invalid)}
 assert.equal(responseModels({modelId:'synthetic-ui-selection',modelName:'Synthetic display'}).status,'missing');
 const access=[];Object.defineProperty(access,0,{get(){throw Error('GETTER_EXECUTED')}});assert.equal(readModelObservation({status:'provided',values:access,fields:['model']}).status,'invalid');
 assert.equal(readModelObservation({...v,entries:[{field:'model',value:'forged-source'}]}).status,'invalid');
});
test('friendly model details preserve declarations and keep raw provenance explicitly optional in both languages',()=>{
 const {modelObservationClientScript}=require('../out/request-observation-view'),{clientI18n}=require('../out/i18n'),vm=require('node:vm');
 const declared=responseModels({model:'synthetic-return-a',response:{modelVersion:'synthetic-return-b'}}),local=parseLocalGeneration('session',0,generation()),before=JSON.stringify([declared,local]);
 try{for(const lang of ['zh-CN','en']){
  setLanguage(lang);
  for(const value of [declared,local.returned,missingModel(),responseModels({model:null})]){
   const friendly=responseModelDetails('synthetic-request',[value]);assert.doesNotMatch(friendly,/gen_metadata|response\.modelVersion|Source fields|来源字段/);
   assert.equal(vm.runInNewContext(clientI18n()+modelObservationClientScript()+'observationDetails("synthetic-request",values)',{values:[value]}),friendly);
   const technical=responseModelDetails('synthetic-request',[value],true);assert.equal(vm.runInNewContext(clientI18n()+modelObservationClientScript()+'observationDetails("synthetic-request",values,true)',{values:[value]}),technical);
  }
  assert.match(responseModelDetails('synthetic-request',[declared]),/synthetic-return-a.*synthetic-return-b/);
  assert.match(responseModelDetails('synthetic-request',[local.returned],true),/gen_metadata\.chatModel\.responseModel = synthetic-return-a/);
  assert.match(responseModelDetails('synthetic-request',[declared],true),/response\.modelVersion = synthetic-return-b/);
 }
 assert.equal(JSON.stringify([declared,local]),before);
 }finally{setLanguage('zh-CN')}
});
test('SSE repeated and conflicting model declarations never use last-wins, including truncated and failed streams',async()=>{
 const frame=value=>'data: '+JSON.stringify(value)+'\n\n';let text=frame({response:{modelVersion:'synthetic-route-a'}})+frame({response:{modelVersion:'synthetic-route-a'}});
 assert.equal(parseWakeStream(text).responseModel.status,'provided');text+=frame({response:{modelVersion:'synthetic-route-b'}})+frame({response:{modelVersion:'synthetic-route-c'}})+'data: [DONE]\n';
 const parsed=parseWakeStream(text);assert.equal(parsed.phase,'succeeded');assert.equal(parsed.responseModel.status,'conflict');assert.deepEqual(parsed.responseModel.values,['synthetic-route-a','synthetic-route-b']);assert.equal(parsed.responseModel.truncated,true);assert.equal(parsed.responseModel.entries.length,3);assert.deepEqual(readModelObservation(parsed.responseModel),parsed.responseModel);
 assert.equal(parseWakeStream(text+'data: broken\n').responseModel.status,'conflict');assert.equal(parseWakeStream(frame({model:'synthetic-route-a'})+frame({error:{message:'private error'}})).responseModel.values[0],'synthetic-route-a');assert.equal(parseWakeStream('data: [DONE]\n').responseModel,undefined);
 let sends=0;const transport=(_options,receive)=>{const req=new EventEmitter();req.destroy=()=>{};req.end=()=>{sends++;const res=new EventEmitter();res.statusCode=200;receive(res);res.emit('data',Buffer.from(text));res.emit('aborted')};return req};
 const result=await sendWake({token:'synthetic-token',projectId:'synthetic-project',modelId:'synthetic-request-a',endpoint:'daily',verify:async()=>{}},8,signal(),async()=>{},transport);assert.equal(sends,1);assert.equal(result.phase,'unknown');assert.equal(result.responseModel.status,'conflict');
 assert.equal(mergeModels(responseModels({model:null}),missingModel()).status,'invalid');
});
test('confirmed usage contract reads numbers independently of model declarations and identities',()=>{
 const r=parseLocalGeneration('session-a',1,generation());assert.equal(r.requested.status,'missing');assert.equal(r.returned.values[0],'synthetic-return-a');assert.equal(r.usageInterpretation,'verified');assert.equal(r.tokens.input.value,7);assert.equal(r.tokens.outputTotal.value,9);assert.equal(r.tokens.cacheWrite.status,'missing');
 const missing=parseLocalGeneration('session-a',2,generation({models:[],usage:{1:3,9:0},id:'other'}));assert.equal(missing.returned.status,'missing');assert.equal(missing.tokens.reasoning.value,0);assert.equal(missing.tokens.input.status,'missing');
 const modelDuplicate=mergeLocalRecords([r,parseLocalGeneration('session-a',7,generation({models:[]}))]);assert.equal(modelDuplicate.length,1);assert.equal(modelDuplicate[0].returned.status,'conflict');assert.equal(modelDuplicate[0].returned.truncated,undefined);assert.deepEqual(readModelObservation(modelDuplicate[0].returned),modelDuplicate[0].returned);
 for(const usage of [{3:10,9:5,10:4},{1:Number.MAX_SAFE_INTEGER,2:1},{1:1132,2:1000,4:12,5:20,9:4,10:5}]){const parsed=parseLocalGeneration('session-a',3,generation({usage}));assert.equal(parsed.tokens.input.value,usage[2]);assert.equal(parsed.tokens.outputTotal.value,usage[3]);}
 const ambiguous=parseLocalGeneration('session-a',3,generation({models:['synthetic-route-a','synthetic-route-b']}));assert.equal(ambiguous.returned.status,'conflict');
 const records=mergeLocalRecords([r,{...r,index:2},missing]);assert.equal(records.length,2);assert.equal(records[1].returned.status,'missing');
 for(const blob of [Buffer.from([10,255]),Buffer.from([15]),Buffer.alloc(1024*1024+1),buf(1,buf(4,buf(1,'wrong-wire')))]){const row=parseLocalGeneration('session-a',0,blob);assert.ok(Object.values(row.tokens).every(v=>v.value===undefined));assert.equal(row.requested.status,'missing')}
});
async function fixture(t){const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'ag-generation-test-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));return{root,file:path.join(root,randomUUID()+'.db')}}
// Windows byte-range locks reject ReadFile on an active SQLite SHM. Read the
// synthetic fixture's whole SHM through a read-only mapping, as SQLite does;
// keep the same full-content hash and metadata preservation assertions.
const fingerprint=async file=>{const s=await fs.lstat(file);const bytes=file.endsWith('-shm')?require('./helpers/generation-fixture.cjs').runPython(['-I','-c','import mmap,sys;f=open(sys.argv[1],"rb");m=mmap.mmap(f.fileno(),0,access=mmap.ACCESS_READ);sys.stdout.buffer.write(m[:]);m.close();f.close()',file]):await fs.readFile(file);return{size:s.size,ino:s.ino,mtime:s.mtimeMs,ctime:s.ctimeMs,hash:createHash('sha256').update(bytes).digest('hex')}};
test('live WAL snapshot reads committed generation metadata and never writes original DB/WAL/SHM or locks',async t=>{
 const f=await fixture(t),db=await database(f.file,[generation(),generation({models:[],id:'second-response'})]);try{
 const files=[f.file,f.file+'-wal',f.file+'-shm'],before=await Promise.all(files.map(fingerprint)),names=await fs.readdir(f.root);
 const result=await readLocalGenerationDb(f.file,signal());assert.equal(result.rows.length,2);assert.equal(result.rows[1].returned.status,'missing');assert.equal(result.limited,false);assert.doesNotMatch(JSON.stringify(result),/SYNTHETIC_PROMPT|prompts|text TEXT/);assert.deepEqual(await Promise.all(files.map(fingerprint)),before);assert.deepEqual(await fs.readdir(f.root),names);
 await db.add();assert.equal((await readLocalGenerationDb(f.file,signal())).rows.length,3);
 }finally{await db.close()}
});
test('schema changes and unsafe links/rollback journals fail closed; private snapshots are removed',async t=>{
 const f=await fixture(t),db=await database(f.file,[generation()],'journal');try{await assert.rejects(readLocalGenerationDb(f.file,signal()),/LOCAL_DB_CHANGED/)}finally{await db.close()}
 const safe=await readLocalGenerationDb(f.file,signal());assert.equal(safe.rows.length,1);
 const link=path.join(f.root,'link.db');await fs.symlink(f.file,link);await assert.rejects(readLocalGenerationDb(link,signal()),/LOCAL_DB_UNSAFE/);await fs.unlink(link);await fs.link(f.file,link);await assert.rejects(readLocalGenerationDb(f.file,signal()),/LOCAL_DB_UNSAFE/);await fs.unlink(link);
 const {runPython}=require('./helpers/generation-fixture.cjs');runPython(['-I','-c',"import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);c.execute('ALTER TABLE gen_metadata RENAME TO old');c.execute('CREATE VIEW gen_metadata AS SELECT * FROM old');c.commit();c.close()",f.file]);const before=await fs.readdir(os.tmpdir());await assert.rejects(readLocalGenerationDb(f.file,signal()),/LOCAL_DB_UNSUPPORTED/);assert.deepEqual((await fs.readdir(os.tmpdir())).filter(x=>x.startsWith('ag-generation-')),before.filter(x=>x.startsWith('ag-generation-')));
});
test('source change during copying and cancellation are detected without querying original',async t=>{
 const f=await fixture(t),db=await database(f.file,[generation()],'delete');await db.close();const original=fs.open;let changed=false;
 fs.open=async(...args)=>{const handle=await original(...args);if(args[0]===f.file){const read=handle.read.bind(handle);handle.read=async(...params)=>{const result=await read(...params);if(!changed){changed=true;await fs.appendFile(f.file,Buffer.from([0]))}return result}}return handle};try{await assert.rejects(readLocalGenerationDb(f.file,signal()),/LOCAL_DB_CHANGED/)}finally{fs.open=original}
 const controller=new AbortController();controller.abort();await assert.rejects(readLocalGenerationDb(f.file,controller.signal),/LOCAL_DB_CANCELLED/);
});
test('optional model metadata survives task persistence without breaking old image/wake histories or exposing raw bodies',()=>{
 const root='/tmp/synthetic-images',task={id:randomUUID(),createdAt:new Date().toISOString(),prompt:'Synthetic prompt',promptSummary:'Synthetic',modelId:'synthetic-request-a',ratio:'1:1',size:'auto',quality:'auto',count:2,references:[],phase:'complete',status:'ok',outputDirectory:root,images:[],responseModels:[responseModels({response:{modelVersion:'synthetic-return-a'}}),missingModel()]},draft={prompt:'',accountId:'',modelId:'synthetic-request-a',ratio:'1:1',count:1,size:'auto',quality:'auto',followCurrent:true};
 const state={schema:3,tasks:[task],draft,outputDirectory:root,references:[],savedDrafts:[]};assert.deepEqual(readImageSession(state).tasks[0].responseModels,task.responseModels);delete task.responseModels;assert.equal(readImageSession(state).tasks[0].responseModels,undefined);task.responseModels=[{status:'provided',values:['secret body with spaces'],fields:['model']}];assert.equal(readImageSession(state).tasks[0].responseModels[0].status,'invalid');
 const wake=initialWakeState();wake.instances.push({id:'synthetic',taskId:randomUUID(),revision:randomUUID(),accountId:randomUUID(),modelId:'synthetic-request-a',due:1,manual:true,nonce:randomUUID(),leaseUntil:2,phase:'succeeded',code:'WAKE_COMPLETE',responseModel:responseModels({model:'synthetic-return-a'})});assert.deepEqual(parseWakeState(wake).instances[0].responseModel,wake.instances[0].responseModel);delete wake.instances[0].responseModel;assert.equal(parseWakeState(wake).instances[0].responseModel,undefined);
 setLanguage('en');assert.match(responseModelDetails('synthetic-request-a'),/Not provided/);setLanguage('zh-CN');assert.match(responseModelDetails('synthetic-request-a'),/未提供/);
});
const {officialConversationRoots,readNativeGenerations}=require('../out/local-generation-discovery');
test('native discovery is explicit, CLI home aware and never substitutes Windows home for a WSL host',()=>{
 const roots=officialConversationRoots({home:'/synthetic/linux-home',platform:'linux',remoteName:'wsl',cliHome:'/synthetic/custom-cli'});assert.deepEqual(roots,[{directory:'/synthetic/custom-cli/antigravity-cli/conversations',client:'cli'},{directory:'/synthetic/linux-home/.gemini/antigravity/conversations',client:'ide'}]);
 assert.throws(()=>officialConversationRoots({home:'C:\\Synthetic',platform:'win32',remoteName:'wsl'}),/LOCAL_DB_HOST_UNSUPPORTED/);assert.throws(()=>officialConversationRoots({home:'/synthetic/home',platform:'linux',cliHome:'C:\\Synthetic'}),/LOCAL_DB_UNSAFE/);
 assert.ok(officialConversationRoots({home:'C:\\Synthetic',platform:'win32'})[0].directory.startsWith('C:\\Synthetic\\'));
});
test('automatic discovery uses synthetic official directories, preserves client scope and retries changed WAL once',async t=>{
 const f=await fixture(t),runtime={home:f.root,platform:process.platform},roots=officialConversationRoots(runtime);for(const r of roots)await fs.mkdir(r.directory,{recursive:true,mode:0o700});const id=path.basename(f.file),cli=path.join(roots[0].directory,id),ide=path.join(roots[1].directory,id),first=await database(cli,[generation()]),second=await database(ide,[generation({models:[]})],'delete');await second.close();try{
 await fs.writeFile(path.join(roots[0].directory,'private-prompt.json'),'SYNTHETIC_PROMPT_MUST_NOT_BE_READ');let changed=false;const original=fs.open;
 fs.open=async(...args)=>{const handle=await original(...args);if(args[0]===cli+'-wal'){const read=handle.read.bind(handle);handle.read=async(...params)=>{const result=await read(...params);if(!changed){changed=true;await first.add()}return result}}return handle};let calls=0;let result;try{result=await readNativeGenerations(signal(),{runtime,read:async(...args)=>{calls++;return readLocalGenerationDb(...args)}})}finally{fs.open=original}
 assert.equal(changed,true);assert.equal(calls,3);assert.equal(result.scope.files,2);assert.equal(result.rows.length,2);assert.deepEqual(new Set(result.rows.map(r=>r.client)),new Set(['cli','ide']));assert.equal(result.rows.find(r=>r.client==='ide').returned.status,'missing');assert.doesNotMatch(JSON.stringify(result),/SYNTHETIC_PROMPT|private-prompt/);
 const concurrent=await Promise.all([readLocalGenerationDb(cli,signal()),readLocalGenerationDb(cli,signal())]);assert.ok(concurrent.every(r=>r.rows.length===2));
 let retries=0;const fail=await readNativeGenerations(signal(),{runtime,read:async()=>{retries++;throw Error('LOCAL_DB_CHANGED')}});assert.equal(retries,4);assert.equal(fail.scope.skipped,2);assert.equal(fail.scope.files,0);
 }finally{await first.close()}
});
test('discovery caps work, exposes scope limits and cancels without reading remaining files',async t=>{
 const f=await fixture(t),runtime={home:f.root,platform:process.platform},directory=officialConversationRoots(runtime)[0].directory;await fs.mkdir(directory,{recursive:true,mode:0o700});for(let i=0;i<23;i++)await fs.writeFile(path.join(directory,randomUUID()+'.db'),'synthetic');let calls=0;
 const capped=await readNativeGenerations(signal(),{runtime,read:async()=>{calls++;return{rows:[],limited:false}}});assert.equal(calls,20);assert.equal(capped.scope.limited,true);assert.equal(capped.scope.files,20);
 const controller=new AbortController();calls=0;await assert.rejects(readNativeGenerations(controller.signal,{runtime,read:async()=>{calls++;controller.abort();return{rows:[],limited:false}}}),/LOCAL_DB_CANCELLED/);assert.equal(calls,1);
});
test('panel activation/open never scans; duplicate clicks and cancellation are bounded and old panel cannot publish late rows',async t=>{
 const f=await fixture(t),runtime={home:f.root,platform:process.platform},directory=officialConversationRoots(runtime)[0].directory;await fs.mkdir(directory,{recursive:true,mode:0o700});await fs.writeFile(path.join(directory,path.basename(f.file)),'synthetic');const Module=require('node:module'),original=Module._load,entry=require.resolve('../out/request-observation-ui'),commands=new Map(),panels=[],subscriptions=[];let reads=0,finish;
 const mock={workspace:{isTrusted:true},env:{},ViewColumn:{Active:1},commands:{registerCommand:(id,fn)=>{commands.set(id,fn);return{dispose(){}}}},window:{createWebviewPanel:()=>{const p={webview:{postMessage:async s=>p.states.push(structuredClone(s)),onDidReceiveMessage:fn=>{p.receive=fn;return{dispose(){}}}},states:[],onDidDispose:fn=>{p.close=fn;return{dispose(){}}},reveal(){},dispose(){p.close()}};panels.push(p);return p}}};
 Module._load=function(name,...args){return name==='vscode'?mock:original.call(this,name,...args)};try{delete require.cache[entry];require(entry).registerObservationsUi({subscriptions},{runtime,read:async(_file,abort)=>{reads++;await new Promise(resolve=>finish=resolve);if(abort.aborted)throw Error('LOCAL_DB_CANCELLED');return{rows:[parseLocalGeneration('synthetic',0,generation())],limited:false}}})}finally{Module._load=original;delete require.cache[entry]}
 const until=async fn=>{const deadline=Date.now()+3000;while(Date.now()<deadline){if(fn())return;await new Promise(resolve=>setTimeout(resolve,5))}assert.fail('async panel timeout')};assert.equal(reads,0);commands.get('antigravityAccounts.observations.open')();const first=panels[0];first.receive({type:'ready'});assert.equal(reads,0);first.receive({type:'read'});first.receive({type:'read'});await until(()=>finish);assert.equal(reads,1);first.receive({type:'cancel'});finish();await until(()=>first.states.at(-1)?.busy===false);assert.equal(first.states.at(-1).notice,'cancelled');assert.equal(first.states.at(-1).rows.length,0);
 finish=undefined;first.receive({type:'read'});await until(()=>finish);first.close();commands.get('antigravityAccounts.observations.open')();const second=panels[1];second.receive({type:'ready'});finish();await until(()=>second.states.at(-1)?.busy===false);assert.equal(second.states.at(-1).rows.length,0);assert.equal(second.states.at(-1).notice,'');for(const d of subscriptions)d.dispose();
});

test('packaged WASM has the same committed WAL results as native SQLite across pending, rollback, commit and checkpoint reset',async t=>{
 for(const pageSize of [512,4096,65536]){
  const f=await fixture(t),db=await database(f.file,[generation()],'wal',pageSize);
  const compare=async count=>{
   const names=[f.file,f.file+'-wal',f.file+'-shm'],before=await Promise.all(names.map(fingerprint)),original=fs.open,opened=[];
   // Exercise the real product while the SQLite writer holds pending WAL/SHM
   // locks. It must read only source DB/WAL, never source SHM or a SQLite handle.
   fs.open=async(...args)=>{if(args[0]===f.file+'-shm')assert.fail('Product opened source SHM');if(args[0]===f.file||args[0]===f.file+'-wal'){opened.push(args[0]);assert.equal(typeof args[1],'number');assert.equal(args[1]&(require('node:fs').constants.O_WRONLY|require('node:fs').constants.O_RDWR|require('node:fs').constants.O_CREAT|require('node:fs').constants.O_TRUNC|require('node:fs').constants.O_APPEND),0)}return original(...args)};
   try{const native=await readLocalGenerationDb(f.file,signal()),wasm=await readLocalGenerationDb(f.file,signal(),{engine:'wasm'});assert.deepEqual(wasm,native);assert.equal(wasm.rows.length,count);assert.deepEqual(opened,[f.file,f.file+'-wal',f.file,f.file+'-wal'])}finally{fs.open=original}
   assert.deepEqual(await Promise.all(names.map(fingerprint)),before);
  };
  try{await compare(1);const size=(await fs.stat(f.file+'-wal')).size;await db.command('pending');assert.ok((await fs.stat(f.file+'-wal')).size>size);await compare(1);await db.command('rollback');await compare(1);await db.command('pending');await db.command('commit');await compare(2);await db.command('restart');await db.add();await compare(3);await db.command('truncate');await compare(3)}finally{await db.close()}
 }
});
test('WASM recovery checks WAL header and ignores incomplete, checksum-invalid, stale-salt and uncommitted tails like SQLite',async t=>{
 const f=await fixture(t),db=await database(f.file,[generation()]);try{
  await db.add();const main=await fs.readFile(f.file),wal=await fs.readFile(f.file+'-wal'),size=wal.readUInt32BE(8),frame=24+size;
  const variants=[wal.subarray(0,wal.length-1),Buffer.from(wal),Buffer.from(wal),Buffer.concat([wal,wal.subarray(wal.length-frame,wal.length-3)])];variants[1][wal.length-1]^=1;variants[2][wal.length-frame+8]^=1;
  for(const changed of variants){const dir=await fs.mkdtemp(path.join(f.root,'copy-')),file=path.join(dir,'copy.db');await fs.writeFile(file,main);await fs.writeFile(file+'-wal',changed);const wasm=await readLocalGenerationDb(file,signal(),{engine:'wasm'}),native=await readLocalGenerationDb(file,signal());assert.deepEqual(wasm,native);assert.ok(wasm.rows.length>=1&&wasm.rows.length<=2)}
  for(const offset of [0,4,8,24]){const changed=Buffer.from(wal);changed[offset]^=1;const dir=await fs.mkdtemp(path.join(f.root,'bad-')),file=path.join(dir,'copy.db');await fs.writeFile(file,main);await fs.writeFile(file+'-wal',changed);await assert.rejects(readLocalGenerationDb(file,signal(),{engine:'wasm'}),/LOCAL_DB_UNSUPPORTED/)}
 }finally{await db.close()}
});
test('WAL disappearance, inode replacement and creation during copying fail closed without source SQLite opens',async t=>{
 const f=await fixture(t),db=await database(f.file,[generation()]);let main,wal;try{main=await fs.readFile(f.file);wal=await fs.readFile(f.file+'-wal')}finally{await db.close()}
 const original=fs.open;
 // A separate committed DB/WAL fixture isolates the intended copying race from
 // the live writer's Windows file-sharing restrictions. The active-writer
 // path remains covered above, including pending writes and checkpoint resets.
 for(const mode of ['replace','remove']){
  const dir=await fs.mkdtemp(path.join(f.root,'race-')),file=path.join(dir,'copy.db');await fs.writeFile(file,main);await fs.writeFile(file+'-wal',wal);let changed=false;
  fs.open=async(...args)=>{const handle=await original(...args);if(args[0]===file+'-wal'){const unchanged=await handle.stat();if(mode==='remove')handle.stat=async()=>unchanged;const read=handle.read.bind(handle);handle.read=async(...params)=>{const result=await read(...params);if(!changed){
   // Windows rejects replacement of this open fixture's destination. Once its
   // complete bytes have been copied, release the fixture handle and retain
   // the old descriptor metadata: this models the stale-handle case while
   // still performing and checking the real on-disk name replacement.
   if(process.platform==='win32'){assert.equal(result.bytesRead,unchanged.size);await handle.close();handle.close=async()=>{};handle.stat=async()=>unchanged}
   if(mode==='replace'){const replacement=file+'-wal.new';await fs.copyFile(file+'-wal',replacement);await fs.rename(replacement,file+'-wal')}else await fs.rename(file+'-wal',file+'-wal.moved');changed=true}return result}}return handle};
  try{await assert.rejects(readLocalGenerationDb(file,signal()),/LOCAL_DB_CHANGED/);assert.equal(changed,true,'Intended WAL mutation must have succeeded');if(mode==='remove')await fs.rename(file+'-wal.moved',file+'-wal')}finally{fs.open=original}
 }
 const clean=await fixture(t),closed=await database(clean.file,[generation()],'delete');await closed.close();let changed=false;fs.open=async(...args)=>{const h=await original(...args);if(args[0]===clean.file){const read=h.read.bind(h);h.read=async(...params)=>{const result=await read(...params);if(!changed){changed=true;await fs.writeFile(clean.file+'-wal',Buffer.alloc(0))}return result}}return h};try{await assert.rejects(readLocalGenerationDb(clean.file,signal()),/LOCAL_DB_CHANGED/)}finally{fs.open=original}
});
test('worker cancellation and timeout terminate execution before cleaning private snapshots',async t=>{
 const f=await fixture(t),db=await database(f.file,[generation()]);await db.close();const original=fs.open,before=(await fs.readdir(os.tmpdir())).filter(x=>x.startsWith('ag-generation-'));const controller=new AbortController();
 fs.open=async(...args)=>{const handle=await original(...args);if(path.basename(args[0])==='conversation.db'){const close=handle.close.bind(handle);handle.close=async()=>{await close();controller.abort()}}return handle};try{await assert.rejects(readLocalGenerationDb(f.file,controller.signal,{engine:'wasm'}),/LOCAL_DB_CANCELLED/)}finally{fs.open=original}
 await assert.rejects(readLocalGenerationDb(f.file,signal(),{engine:'wasm',timeoutMs:1}),/LOCAL_DB_UNAVAILABLE/);assert.deepEqual((await fs.readdir(os.tmpdir())).filter(x=>x.startsWith('ag-generation-')),before);
 const {queryGenerationSnapshot}=require('../out/local-generation-db'),active=new AbortController();const work=queryGenerationSnapshot(f.file,active.signal,{engine:'wasm'});active.abort();await assert.rejects(work,/LOCAL_DB_CANCELLED/);
});
test('missing fields and unsupported source gaps retain their origins without rescans, network or default zeros',async t=>{
 const f=await fixture(t),runtime={home:f.root,platform:process.platform},root=officialConversationRoots(runtime)[0].directory;await fs.mkdir(root,{recursive:true,mode:0o700});const missingFile=path.join(root,path.basename(f.file)),unsupportedFile=path.join(root,randomUUID()+'.db');const missing=await database(missingFile,[generation({models:[],usage:{},id:'missing-response'})],'delete'),bad=await database(unsupportedFile,[Buffer.from([15])],'delete');await missing.close();await bad.close();
 const result=await readNativeGenerations(signal(),{runtime});assert.equal(result.scope.files,2);assert.equal(result.rows.length,2);const absent=result.rows.find(r=>r.issue!=='schemaUnsupported');assert.equal(absent.returned.status,'missing');assert.ok(Object.values(absent.tokens).every(x=>x.status==='missing'&&x.value===undefined));assert.equal(result.rows.find(r=>r.session!==absent.session).issue,'schemaUnsupported');
 let calls=0;const gap=await readNativeGenerations(signal(),{runtime,read:async()=>{calls++;throw Error('LOCAL_DB_UNSUPPORTED')}});assert.equal(calls,2);assert.deepEqual(gap.scope.gaps,{unsupported:2});assert.equal(gap.scope.rows,0);assert.doesNotMatch(JSON.stringify(gap.scope),/\.db|session-|SYNTHETIC/);
});
test('model declaration filtering drops exact token/project/prompt reflections and settled SSE ignores late buffers',async()=>{
 const token='synthetic-sensitive-bearer';assert.equal(responseModels({model:token},[token]).status,'invalid');assert.equal(responseModels({model:'prefix-'+token},[token]).values.length,0);assert.equal(responseModels({model:'synthetic-model'},['a']).status,'provided');let response;
 const transport=(_options,receive)=>{const request=new EventEmitter();request.destroy=()=>{};request.end=()=>{response=new EventEmitter();response.statusCode=200;response.resume=()=>{};receive(response);response.emit('data','data: '+JSON.stringify({model:token})+'\n');response.emit('aborted')};return request};
 const result=await sendWake({token,projectId:'synthetic-project',modelId:'synthetic-model',endpoint:'daily',verify:async()=>{}},8,signal(),async()=>{},transport);assert.equal(result.responseModel.status,'invalid');assert.doesNotMatch(JSON.stringify(result),new RegExp(token));const late={get length(){throw Error('LATE_BUFFER_READ')}};response.emit('data',late);response.emit('end');assert.equal(result.phase,'unknown');
});

test('single-file cancel and close release the current panel; uncooperative late readers cannot replace new state',async t=>{
 const f=await fixture(t),Module=require('node:module'),original=Module._load,entry=require.resolve('../out/request-observation-ui'),commands=new Map(),panels=[],subscriptions=[],pending=[];let picks=0,latePick;
 const mock={workspace:{isTrusted:true},env:{},ViewColumn:{Active:1},commands:{registerCommand:(id,fn)=>{commands.set(id,fn);return{dispose(){}}}},window:{createWebviewPanel:()=>{const p={webview:{postMessage:async s=>p.states.push(structuredClone(s)),onDidReceiveMessage:fn=>{p.receive=fn;return{dispose(){}}}},states:[],onDidDispose:fn=>{p.close=fn;return{dispose(){}}},reveal(){},dispose(){p.close()}};panels.push(p);return p}}};
 Module._load=function(name,...args){return name==='vscode'?mock:original.call(this,name,...args)};try{delete require.cache[entry];require(entry).registerObservationsUi({subscriptions},{runtime:{home:f.root,platform:process.platform},pick:async()=>{picks++;if(picks===1)return new Promise(resolve=>latePick=resolve);return[{scheme:'file',authority:'',fsPath:f.file}]},read:async()=>new Promise(resolve=>pending.push(resolve))})}finally{Module._load=original;delete require.cache[entry]}
 const until=async predicate=>{const deadline=Date.now()+3000;while(!predicate()){assert.ok(Date.now()<deadline,'panel deadline');await new Promise(resolve=>setTimeout(resolve,5))}};
 commands.get('antigravityAccounts.observations.open')();const first=panels[0];first.receive({type:'choose'});await until(()=>latePick);first.receive({type:'cancel'});latePick([{scheme:'file',authority:'',fsPath:f.file}]);await until(()=>first.states.at(-1)?.busy===false);assert.equal(first.states.at(-1).notice,'cancelled');assert.equal(pending.length,0);
 first.receive({type:'choose'});await until(()=>pending.length===1);first.receive({type:'cancel'});pending.shift()({rows:[parseLocalGeneration('old',0,generation())],limited:false});await until(()=>first.states.at(-1)?.busy===false);assert.equal(first.states.at(-1).notice,'cancelled');assert.deepEqual(first.states.at(-1).rows,[]);
 first.receive({type:'choose'});await until(()=>pending.length===1);const old=pending.shift();first.close();commands.get('antigravityAccounts.observations.open')();const second=panels[1];second.receive({type:'choose'});await until(()=>pending.length===1);pending.shift()({rows:[parseLocalGeneration('new',0,generation())],limited:false});await until(()=>second.states.at(-1)?.rows.length===1);old({rows:[parseLocalGeneration('old',0,generation())],limited:false});await new Promise(resolve=>setImmediate(resolve));assert.equal(second.states.at(-1).rows[0].session,'new');assert.equal(second.states.at(-1).notice,'');for(const disposable of subscriptions)disposable.dispose();
});

test('large sources report a file-limit gap before copying, without source or temp changes',async t=>{
 const f=await fixture(t),handle=await fs.open(f.file,'wx',0o600);await handle.truncate(32*1024*1024+1);await handle.close();const before=await fingerprint(f.file),names=(await fs.readdir(os.tmpdir())).filter(x=>x.startsWith('ag-generation-'));await assert.rejects(readLocalGenerationDb(f.file,signal()),/LOCAL_DB_LIMIT/);assert.deepEqual(await fingerprint(f.file),before);assert.deepEqual((await fs.readdir(os.tmpdir())).filter(x=>x.startsWith('ag-generation-')),names);
});

test('WASM main-file sizes follow SQLite version-valid header rules and cannot repair corrupt declared sizes',async t=>{
 const f=await fixture(t),db=await database(f.file,[generation()],'delete');await db.close();const main=await fs.readFile(f.file),physical=main.length/main.readUInt16BE(16);
 for(const [pages,valid] of [[1,true],[physical+10,true],[1,false],[physical+10,false],[0,true]]){const bytes=Buffer.from(main);bytes.writeUInt32BE(pages,28);if(!valid)bytes.writeUInt32BE((bytes.readUInt32BE(24)+1)>>>0,92);const dir=await fs.mkdtemp(path.join(f.root,'header-')),file=path.join(dir,'copy.db');await fs.writeFile(file,bytes);const load=async engine=>{try{return await readLocalGenerationDb(file,signal(),{engine})}catch(error){return{error:error.message}}};assert.deepEqual(await load('wasm'),await load('auto'))}
});

test('WASM accepts SQLite big-endian WAL checksums with the same native committed result',async t=>{
 const f=await fixture(t),db=await database(f.file,[generation()]);try{
  await db.add();const main=await fs.readFile(f.file),wal=await fs.readFile(f.file+'-wal'),size=wal.readUInt32BE(8);wal.writeUInt32BE(0x377f0683,0);let a=0,b=0;
  const sum=(start,end)=>{for(let i=start;i<end;i+=8){a=(a+wal.readUInt32BE(i)+b)>>>0;b=(b+wal.readUInt32BE(i+4)+a)>>>0}};sum(0,24);wal.writeUInt32BE(a,24);wal.writeUInt32BE(b,28);for(let i=32;i+24+size<=wal.length;i+=24+size){sum(i,i+8);sum(i+24,i+24+size);wal.writeUInt32BE(a,i+16);wal.writeUInt32BE(b,i+20)}
  const dir=await fs.mkdtemp(path.join(f.root,'big-endian-')),file=path.join(dir,'copy.db');await fs.writeFile(file,main);await fs.writeFile(file+'-wal',wal);const native=await readLocalGenerationDb(file,signal()),wasm=await readLocalGenerationDb(file,signal(),{engine:'wasm'});assert.equal(native.rows.length,2);assert.deepEqual(wasm,native);
 }finally{await db.close()}
});

test('checkpoint truncate and restart overlapping source copy are detected before any rows are returned',async t=>{
 const original=fs.open;
 for(const mode of ['truncate','restart']){const f=await fixture(t),db=await database(f.file,[generation()]);let changed=false;fs.open=async(...args)=>{const handle=await original(...args);if(args[0]===f.file){const read=handle.read.bind(handle);handle.read=async(...params)=>{const result=await read(...params);if(!changed){changed=true;await db.command(mode);await db.add()}return result}}return handle};try{await assert.rejects(readLocalGenerationDb(f.file,signal()),/LOCAL_DB_CHANGED/);assert.equal(changed,true)}finally{fs.open=original;await db.close()}}
});
