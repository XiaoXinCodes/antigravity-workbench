// Test-only standalone executor. Paths/accounts/census are synthetic fixtures.
// No code in this file is referenced by the production extension.
const fs=require('node:fs/promises'),path=require('node:path');
const {createHash}=require('node:crypto');
const {OfflineRecoveryStore}=require('../../out/offline-recovery-store');
const {OfflineSwitchCoordinator}=require('../../out/offline-switch');
const {OfficialTokenSlots}=require('../../out/live-storage');
const {LiveLocks}=require('../../out/live-lock');
let bytes='';process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>{bytes+=chunk;if(bytes.length>32768)process.exit(2);});
process.stdin.on('end',()=>{void run();});
async function run(){
 let root;
 try{
  const request=JSON.parse(bytes);bytes='';root=request.root;
  const {record,password}=request;
  const journal=new OfflineRecoveryStore(path.join(root,'recovery'),password,record.hostId,record.id);
  const native=new OfficialTokenSlots(root,{read:async()=>null,write:async()=>{throw Error('UNEXPECTED_KEYRING');}});
  const locks=new LiveLocks(root,createHash('sha256').update(record.hostId).digest('hex'));
  // Preparation is durable before the initiating synthetic host has to close.
  await journal.save(record,undefined);
  await fs.writeFile(path.join(root,'ready'),'READY');
  let go=false;
  for(let n=0;n<500;n++){
   try{await fs.stat(path.join(root,'go'));go=true;break;}catch(e){if(e.code!=='ENOENT')throw e;}
   await new Promise(r=>setTimeout(r,10));
  }
  if(!go)throw Error('SYNTHETIC_TIMEOUT');
  let scans=0;
  const runtime={hostId:record.hostId,journal,withLock:fn=>locks.withOperation(fn),assertWritersSettled:async()=>{},
   census:async()=>{
    const state=JSON.parse(await fs.readFile(path.join(root,'census.json'),'utf8'));
    if(request.injectNewInstance&&++scans===3)state.hosts=[{pid:999,startIdentity:'synthetic-new'}];
    return state;
   },
   slots:{read:()=>native.read(),write:(v,e,guard)=>native.write(v,e,guard)},
   reopen:async()=>{await fs.writeFile(path.join(root,'reopen-request'),'SYNTHETIC_ONLY');}};
  const result=await new OfflineSwitchCoordinator(runtime).install({confirmed:true,transactionId:record.id,backup:record.backup,target:record.target,expectedEmail:record.expectedEmail});
  await fs.writeFile(path.join(root,'status.json'),JSON.stringify({result}));
 }catch(error){if(root)await fs.writeFile(path.join(root,'status.json'),JSON.stringify({result:'failed',code:typeof error.code==='string'?error.code:'SYNTHETIC_FAILED'})).catch(()=>{});process.exitCode=2;}
}
