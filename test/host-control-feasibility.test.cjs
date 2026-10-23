// Research-only process prototype. Every subprocess is created here and only
// synthetic markers in a fresh temporary directory are read/written. This is
// NOT the product credential writer or evidence of a VS Code launch fence.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn, spawnSync} = require('node:child_process');
const {once} = require('node:events');

const worker = String.raw`
const fs=require('node:fs'),path=require('node:path');
const [root,mode]=process.argv.slice(1);
const p=n=>path.join(root,n);
if(mode==='recover') {
 if(fs.existsSync(p('journal'))) {
  fs.writeFileSync(p('state'),fs.readFileSync(p('backup')));
  fs.unlinkSync(p('journal'));
 }
 process.exit(0);
}
fs.writeFileSync(p('ready'),'synthetic');
// Bounded lifetime even if the research runner exits unexpectedly.
let attempts=0;
const timer=setInterval(()=>{
 if(++attempts>300){clearInterval(timer);process.exit(3);}
 if(!fs.existsSync(p('go')))return;
 clearInterval(timer);
 fs.writeFileSync(p('backup'),fs.readFileSync(p('state')));
 fs.writeFileSync(p('journal'),'prepared');
 fs.writeFileSync(p('next'),'synthetic-new');
 fs.renameSync(p('next'),p('state'));
 if(mode==='crash')process.exit(17);
 try {
  if(mode==='rollback')throw new Error('SYNTHETIC_VERIFICATION_FAILURE');
 } catch {
  fs.writeFileSync(p('state'),fs.readFileSync(p('backup')));
 }
 fs.unlinkSync(p('journal'));
 fs.writeFileSync(p('done'),'synthetic');
},10);
`;
function fixture(t) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ag-host-research-'));
 fs.writeFileSync(path.join(root,'state'),'synthetic-old');
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 return root;
}
async function untilFile(root,name) {
 for(let n=0;n<200;n++) {
  if(fs.existsSync(path.join(root,name)))return;
  await new Promise(r=>setTimeout(r,10));
 }
 throw Error('RESEARCH_TIMEOUT');
}
function launch(t,root,mode='normal') {
 const child=spawn(process.execPath,['-e',worker,root,mode],{stdio:'ignore'});
 const exited=once(child,'exit');
 t.after(async()=>{if(child.exitCode===null){child.kill('SIGCONT');child.kill();}await exited;});
 return {child,exited};
}
test('independent detached executor completes after its synthetic initiating host exits',async t=>{
 const root=fixture(t);
 const launcher=`const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(worker)},${JSON.stringify(root)},'normal'],{detached:true,stdio:'ignore'});c.unref();`;
 const result=spawnSync(process.execPath,['-e',launcher],{timeout:3000});
 assert.equal(result.status,0);
 await untilFile(root,'ready');
 fs.writeFileSync(path.join(root,'go'),'go');
 await untilFile(root,'done');
 assert.equal(fs.readFileSync(path.join(root,'state'),'utf8'),'synthetic-new');
});
test('independent executor works while a synthetic host is OS-stopped',{skip:process.platform!=='linux'},async t=>{
 const root=fixture(t);
 const host=spawn(process.execPath,['-e',"process.stdout.write('ready');setTimeout(()=>{},5000)"],{stdio:['ignore','pipe','ignore']});
 const hostExit=once(host,'exit');
 t.after(async()=>{if(host.exitCode===null){host.kill('SIGCONT');host.kill();}await hostExit;});
 await once(host.stdout,'data');
 host.kill('SIGSTOP');
 // Confirm actual kernel stopped state, not elapsed time. This is our child.
 let stopped=false;
 for(let n=0;n<100;n++) {
  if(/^State:\s+T/m.test(fs.readFileSync(`/proc/${host.pid}/status`,'utf8'))){stopped=true;break;}
  await new Promise(r=>setTimeout(r,5));
 }
 assert.equal(stopped,true);
 const helper=launch(t,root);
 await untilFile(root,'ready');fs.writeFileSync(path.join(root,'go'),'go');
 assert.equal((await helper.exited)[0],0);
 assert.equal(fs.readFileSync(path.join(root,'state'),'utf8'),'synthetic-new');
 host.kill('SIGCONT');
});
test('injected post-write verification exception rolls back before marking completion',async t=>{
 const root=fixture(t),helper=launch(t,root,'rollback');
 await untilFile(root,'ready');fs.writeFileSync(path.join(root,'go'),'go');
 assert.equal((await helper.exited)[0],0);
 assert.equal(fs.readFileSync(path.join(root,'state'),'utf8'),'synthetic-old');
 assert.equal(fs.existsSync(path.join(root,'journal')),false);
});
test('helper exit after replacement leaves a journal for a separate recovery process',async t=>{
 const root=fixture(t),helper=launch(t,root,'crash');
 await untilFile(root,'ready');fs.writeFileSync(path.join(root,'go'),'go');
 assert.equal((await helper.exited)[0],17);
 assert.equal(fs.existsSync(path.join(root,'journal')),true);
 const recovery=spawnSync(process.execPath,['-e',worker,root,'recover'],{timeout:3000});
 assert.equal(recovery.status,0);
 assert.equal(fs.readFileSync(path.join(root,'state'),'utf8'),'synthetic-old');
});
test('stopping a known host does not close the supervisor or external launch path',()=>{
 const hosts=new Map([['old-birth','stopped']]);
 assert.ok([...hosts.values()].every(s=>s==='stopped'));
 // Both supervisor replacement and a new window bypass a PID snapshot.
 hosts.set('supervisor-new-birth','running');hosts.set('new-window-birth','running');
 assert.equal([...hosts.values()].filter(s=>s==='running').length,2);
});
