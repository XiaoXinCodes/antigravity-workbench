const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{randomUUID}=require('node:crypto');
const {ImageSessionStore,readImageSession,checkSessionImages,SESSION_MAX_TASKS}=require('../out/image-session-store');
const draft={prompt:'private synthetic draft',accountId:'account-A',modelId:'gemini-3.1-flash-image',ratio:'16:9',count:2,size:'2K',quality:'detail',followCurrent:false};
const task=(root,phase='complete')=>({id:randomUUID(),createdAt:'2026-10-04T12:00:00.000Z',prompt:'full submitted synthetic prompt',promptSummary:'submitted synthetic prompt',accountId:'account-A',accountLabel:'Synthetic account',accountSource:'saved',endpoint:'daily',modelId:draft.modelId,ratio:'1:1',size:'auto',quality:'auto',count:1,references:[],phase,status:'synthetic',outputDirectory:root,images:[{file:path.join(root,'saved.png'),width:2,height:2}]});
const value=root=>({schema:3,savedDrafts:[],draft:{...draft},outputDirectory:root,references:[],tasks:[task(root)]});
async function fixture(t){const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'ag-session-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));const dir=path.join(root,'host-storage','image-session'),store=new ImageSessionStore(dir);return{root,dir,store,file:path.join(dir,'session.json')}}
test('workspace session survives a new host/version with exact prompts, request snapshots and artifact references',async t=>{
 const f=await fixture(t),state=value(f.root);assert.equal(await f.store.load(),undefined);await f.store.save(state);await f.store.flush();
 assert.deepEqual(await new ImageSessionStore(f.dir).load(),state);if(process.getuid){assert.equal((await fs.stat(f.file)).mode&0o777,0o600);assert.equal((await fs.stat(f.dir)).mode&0o777,0o700);}
 assert.deepEqual((await fs.readdir(f.dir)),['session.json']);assert.equal(await new ImageSessionStore(path.join(f.root,'other-workspace')).load(),undefined);
});
test('restart marks every unfinished phase interrupted; completed and cancelled outcomes remain, no duplicates',async t=>{
 const f=await fixture(t),s=value(f.root);s.tasks=['confirming','preparing','generating','validating','complete','partial','failed','cancelled'].map(p=>task(f.root,p));
 await f.store.load();await f.store.save(s);const recovered=await new ImageSessionStore(f.dir).load();assert.deepEqual(recovered.tasks.map(t=>t.phase),['interrupted','interrupted','interrupted','interrupted','complete','partial','failed','cancelled']);
 assert.match(recovered.tasks[0].status,/未提交/);assert.match(recovered.tasks[2].status,/结果未确认.*不会自动重发/);
 const again=new ImageSessionStore(f.dir);await again.load();await again.save(recovered);assert.equal((await new ImageSessionStore(f.dir).load()).tasks.length,8);
});
test('queued saves freeze snapshots and retain the last edit; stale second-window writer is rejected',async t=>{
 const f=await fixture(t),s=value(f.root);await f.store.load();const stale=new ImageSessionStore(f.dir);await stale.load();
 const work=[];for(let i=0;i<12;i++){s.draft.prompt='revision '+i;work.push(f.store.save(s))}s.draft.prompt='unsaved edit';await Promise.all(work);
 assert.equal((await new ImageSessionStore(f.dir).load()).draft.prompt,'revision 11');await assert.rejects(stale.save(s),/IMAGE_SESSION_CHANGED/);
 assert.equal((await new ImageSessionStore(f.dir).load()).draft.prompt,'revision 11');
});
test('invalid, older and future schemas, truncated JSON, duplicates and out-of-scope paths preserve original bytes',async t=>{
 const f=await fixture(t);await f.store.load();
 const duplicate=value(f.root);duplicate.tasks.push(duplicate.tasks[0]);const outside=value(f.root);outside.tasks[0].images[0].file='/outside/image.png';
 for(const raw of ['{"schema":',JSON.stringify({...value(f.root),schema:0}),JSON.stringify({...value(f.root),schema:4}),JSON.stringify(duplicate),JSON.stringify(outside)]){
  await fs.writeFile(f.file,raw,{mode:0o600});const store=new ImageSessionStore(f.dir);await assert.rejects(store.load(),/IMAGE_SESSION_/);await assert.rejects(store.save(value(f.root)),/IMAGE_SESSION_STORAGE_UNAVAILABLE/);assert.equal(await fs.readFile(f.file,'utf8'),raw);
 }
});
test('capacity never silently evicts records; removing a record permits save without deleting its image',async t=>{
 const f=await fixture(t),s=value(f.root);await fs.writeFile(s.tasks[0].images[0].file,'image sentinel');await f.store.load();await f.store.save(s);
 const over={...s,tasks:Array.from({length:SESSION_MAX_TASKS+1},()=>task(f.root))};await assert.rejects(f.store.save(over),/IMAGE_SESSION_LIMIT/);assert.equal((await new ImageSessionStore(f.dir).load()).tasks.length,1);
 s.tasks=[];await f.store.save(s);assert.equal((await new ImageSessionStore(f.dir).load()).tasks.length,0);assert.equal(await fs.readFile(path.join(f.root,'saved.png'),'utf8'),'image sentinel');
});
test('only whitelisted session fields persist, no diagnostic or credential fields',()=>{
 const s=value('/home/synthetic/WSL workspace');s.token='secret sentinel';s.draft.accessToken='secret sentinel';s.tasks[0].bearer='secret sentinel';s.tasks[0].images[0].data='base64 sentinel';
 const safe=readImageSession(s);assert.doesNotMatch(JSON.stringify(safe),/sentinel|accessToken|bearer/);assert.equal(safe.draft.prompt,draft.prompt);assert.equal(safe.outputDirectory,'/home/synthetic/WSL workspace');
});
test('missing, linked and inaccessible images retain their record with explicit unavailable message',async t=>{
 const f=await fixture(t),s=value(f.root);await checkSessionImages(s.tasks);assert.match(s.tasks[0].images[0].unavailable,/文件不存在/);assert.equal(s.tasks.length,1);
 const image=s.tasks[0].images[0];await fs.writeFile(image.file,'synthetic');await checkSessionImages(s.tasks);assert.equal(image.unavailable,undefined);
 if(process.platform!=='win32'){await fs.unlink(image.file);await fs.symlink('/etc/passwd',image.file);await checkSessionImages(s.tasks);assert.match(image.unavailable,/不可读取/);assert.equal((await fs.lstat(image.file)).isSymbolicLink(),true);}
});
test('nonprivate POSIX files and symlinks fail closed without replacing the original file',{skip:process.platform==='win32'},async t=>{
 const f=await fixture(t),s=value(f.root);await f.store.load();await f.store.save(s);const raw=await fs.readFile(f.file,'utf8');await fs.chmod(f.file,0o644);
 await assert.rejects(new ImageSessionStore(f.dir).load(),/IMAGE_SESSION_PATH_UNSAFE/);await assert.rejects(f.store.save(s),/IMAGE_SESSION_PATH_UNSAFE/);assert.equal(await fs.readFile(f.file,'utf8'),raw);
 await fs.chmod(f.file,0o600);await fs.rename(f.file,path.join(f.root,'original'));await fs.symlink(path.join(f.root,'original'),f.file);await assert.rejects(f.store.save(s),/IMAGE_SESSION_/);assert.equal(await fs.readFile(path.join(f.root,'original'),'utf8'),raw);
 const alias=path.join(f.root,'storage-alias');await fs.symlink(f.dir,alias,'dir');await assert.rejects(new ImageSessionStore(alias).load(),/IMAGE_SESSION_PATH_UNSAFE/);
 const unready=new ImageSessionStore(undefined);await assert.rejects(unready.load(),/IMAGE_SESSION_STORAGE_UNAVAILABLE/);
});
