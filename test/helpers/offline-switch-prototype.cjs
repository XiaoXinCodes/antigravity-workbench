// Research state machine only. Not referenced by product code. Production must
// supply OS identity census, native storage CAS, durable encrypted journal and
// cross-process lock adapters. A census is detection, NOT a global launch fence.
const {randomBytes,createCipheriv,createDecipheriv}=require('node:crypto');
function fail(code){const e=new Error(code);e.code=code;return e;}
function seal(key,scope,tx,payload){
 const iv=randomBytes(12),aad=Buffer.from(JSON.stringify([scope,tx]));
 const cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(aad);
 const bytes=Buffer.concat([cipher.update(JSON.stringify(payload),'utf8'),cipher.final()]);
 return {iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),bytes:bytes.toString('base64')};
}
function open(key,scope,tx,envelope){
 try{
  const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(envelope.iv,'base64'));
  decipher.setAAD(Buffer.from(JSON.stringify([scope,tx])));
  decipher.setAuthTag(Buffer.from(envelope.tag,'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.bytes,'base64')),decipher.final()]).toString('utf8'));
 }catch{throw fail('OFFLINE_HANDOFF_INVALID');}
}
async function execute(r){
 if(r.confirmed!==true)throw fail('OFFLINE_CONFIRMATION_REQUIRED');
 let attempted=false;
 const clear=async()=>{
  if(r.signal?.aborted)throw fail('CANCELLED');
  const state=await r.census();
  if(!state.complete||state.unknown)throw fail('OFFLINE_CENSUS_UNVERIFIED');
  if(state.hosts.length||state.hubs.length)throw fail('OFFLINE_INSTANCE_PRESENT');
 };
 // Caller holds the shared operation lock until the execution result is known.
 // Actual adapters must invoke clear before EACH native slot mutation.
 await clear();
 if(await r.read()!==r.backup)throw fail('OFFLINE_STORAGE_CHANGED');
 await r.journal('prepared');
 try{
  await clear();
  attempted=true;
  await r.compareAndWrite(r.target,r.backup,clear);
  if(await r.read()!==r.target)throw fail('OFFLINE_READBACK_FAILED');
  await clear();
  await r.journal('installed');
 }catch(error){
  if(!attempted)throw error;
  // Never roll back over a detected new instance or unknown concurrent writer.
  // Preserve journal; UI must request closure again before recovery.
  try{
   await clear();
   const current=await r.read();
   if(current!==r.backup&&current!==r.target)throw fail('OFFLINE_STORAGE_CHANGED');
   if(current===r.target)await r.compareAndWrite(r.backup,r.target,clear);
   if(await r.read()!==r.backup)throw fail('OFFLINE_READBACK_FAILED');
   await r.journal('restored');
  }catch{throw fail('OFFLINE_RECOVERY_REQUIRED');}
  throw error;
 }
 // Reopen failure does not trigger rollback after a client may have started.
 // installed remains until fresh online verification by the reopened Workbench.
 try{await r.reopen();}catch{throw fail('OFFLINE_REOPEN_REQUIRED');}
 return 'installed-awaiting-verification';
}
module.exports={seal,open,execute};

// Test-only anonymous-pipe receiver: no real credentials or native adapters.
// Returns only a fixed result; never reflects decrypted content or errors.
if(require.main===module){
 let bytes='';
 process.stdin.setEncoding('utf8');
 process.stdin.on('data',chunk=>{bytes+=chunk;if(bytes.length>65536)process.exit(2);});
 process.stdin.on('end',()=>{
  try{
   const p=JSON.parse(bytes),key=Buffer.from(p.key,'base64');
   const value=open(key,p.scope,p.tx,p.envelope);key.fill(0);
   if(value.marker!=='synthetic-target')throw Error();
   process.stdout.write('HANDOFF_OK');
  }catch{process.exitCode=2;}
 });
}
