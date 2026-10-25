// Synthetic fixture only. Production helper/session/locks/key/file I/O execute
// unchanged. Census input is isolated to fixture-owned processes; no real
// account, official component or unrelated user process is observed or stopped.
const fs=require('node:fs/promises'),path=require('node:path'),Module=require('node:module');
const {probeProcessIdentity}=require('../../out/live-lock');
const rename=fs.rename.bind(fs);
fs.rename=async(source,target)=>{
 if(target===path.join(process.env.HOME,'.gemini','jetski-standalone-oauth-token')){
  let delay=false;try{await fs.stat(path.join(process.env.HOME,'delay-write'));delay=true;}catch(e){if(e.code!=='ENOENT')throw e;}
  if(delay){await fs.writeFile(path.join(process.env.HOME,'write-started'),'fixture');for(let i=0;;i++){try{await fs.stat(path.join(process.env.HOME,'allow-write'));break;}catch(e){if(e.code!=='ENOENT')throw e;}if(i>600)throw Error('SYNTHETIC_TIMEOUT');await new Promise(r=>setTimeout(r,20));}}
 }
 return rename(source,target);
};
const old=Module._load;
Module._load=function(name,...args){
 if(name==='./offline-process-census')return{inspectOfflineLinuxProcesses:async({knownHosts})=>{
   const hosts=[];for(const known of knownHosts){const p=await probeProcessIdentity(known.pid);if(p.state==='alive'&&p.startIdentity===known.startIdentity)hosts.push(known);}
   try{const injected=JSON.parse(await fs.readFile(path.join(process.env.HOME,'new-instance.json'),'utf8'));hosts.push(injected);}catch(e){if(e.code!=='ENOENT')throw e;}
   return{complete:true,unknown:false,hosts,hubs:[]};
 }};
 return old.call(this,name,...args);
};
const {automaticOfflineHelper}=require('../../out/offline-automatic-helper');Module._load=old;
process.stdout.on('error',()=>{});
automaticOfflineHelper(process.argv.slice(2)).catch(()=>{process.exitCode=1;});
