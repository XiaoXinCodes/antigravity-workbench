const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');
const {OfflineRecoveryStore}=require('../out/offline-recovery-store');
const token=n=>JSON.stringify({token:{refresh_token:'synthetic-'+n}});
const record={schema:1,hostId:'synthetic-host',id:'18b6b550-6e0d-4b57-b5be-9d70810f07a9',phase:'prepared',backup:{keyring:null,file:token('old')},target:{keyring:null,file:token('new')},expectedEmail:'synthetic@example.test'};
const password='synthetic recovery password';
async function waitFile(root,name){for(let n=0;n<500;n++){try{return await fs.readFile(path.join(root,name),'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}await new Promise(r=>setTimeout(r,10));}throw Error('SYNTHETIC_TIMEOUT');}
for(const injectNewInstance of [false,true])test('standalone closed-loop '+(injectNewInstance?'aborts new instance':'switches after initiating host exits'),{skip:process.platform==='win32'},async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'offline-loop-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.mkdir(path.join(root,'.gemini'),{mode:0o700});const file=path.join(root,'.gemini','jetski-standalone-oauth-token');await fs.writeFile(file,record.backup.file,{mode:0o600});
 await fs.writeFile(path.join(root,'census.json'),JSON.stringify({complete:true,unknown:false,hosts:[],hubs:[]}));
 const worker=path.join(__dirname,'helpers/offline-closed-loop-worker.cjs');
 const launcher=`const fs=require('node:fs'),{spawn}=require('node:child_process');const child=spawn(process.execPath,[${JSON.stringify(worker)}],{detached:true,stdio:['pipe','ignore','ignore']});child.stdin.end(fs.readFileSync(0));child.unref();`;
 const initiatingHost=spawnSync(process.execPath,['-e',launcher],{input:JSON.stringify({root,record,password,injectNewInstance}),timeout:3000});assert.equal(initiatingHost.status,0);
 await waitFile(root,'ready');
 const journal=new OfflineRecoveryStore(path.join(root,'recovery'),password,record.hostId,record.id);
 assert.equal((await journal.read()).phase,'prepared');assert.equal(await fs.readFile(file,'utf8'),record.backup.file);
 await fs.writeFile(path.join(root,'go'),'go');
 const result=JSON.parse(await waitFile(root,'status.json'));
 if(injectNewInstance){assert.equal(result.code,'OFFLINE_RECOVERY_REQUIRED');assert.equal(await fs.readFile(file,'utf8'),record.backup.file);assert.equal((await journal.read()).phase,'prepared');}
 else{assert.equal(result.result,'installed-awaiting-verification');assert.equal(await fs.readFile(file,'utf8'),record.target.file);assert.equal((await journal.read()).phase,'installed');assert.equal(await waitFile(root,'reopen-request'),'SYNTHETIC_ONLY');}
});
