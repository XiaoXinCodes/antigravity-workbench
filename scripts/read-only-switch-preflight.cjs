// Operator diagnostic only. No credential contents, official exports/RPC, mutations,
// child processes or terminating signals (PID liveness uses signal 0). Output is bounded booleans/counts/fixed codes.
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {inspectOfflineLinuxProcesses}=require('../out/offline-process-census');
const {resolveOfficialStorageMode}=require('../out/live-environment');
const {probeProcessIdentity}=require('../out/live-lock');
async function report(knownPid,io={home:os.homedir(),uid:process.getuid?.(),platform:process.platform,stat:fs.lstat,mode:resolveOfficialStorageMode,probe:probeProcessIdentity,census:inspectOfflineLinuxProcesses}){
 if(!Number.isSafeInteger(knownPid)||knownPid<1)throw Error('DIAGNOSTIC_PID_REQUIRED');
 const result={schema:1,readOnly:true,tokenFileContentsRead:false,procMetadataRead:true,scopeProof:'NOT_CHECKED_REQUIRES_LIVE_HUB',platform:io.platform,route:await io.mode()};
 if(io.platform!=='linux'||io.uid===undefined)return{...result,code:'OFFLINE_PLATFORM_UNSUPPORTED'};
 const born=await io.probe(knownPid);if(born.state!=='alive')return{...result,code:'OFFLINE_CENSUS_UNVERIFIED',hostAlive:false};
 const census=await io.census({uid:io.uid,home:io.home,knownHosts:[{pid:knownPid,startIdentity:born.startIdentity}],scope:'file-only'});
 result.census={complete:census.complete,unknown:census.unknown,hosts:census.hosts.length,hubs:census.hubs.length};
 result.code=census.complete&&!census.unknown?'CENSUS_PASSED_ONLY':'OFFLINE_CENSUS_UNVERIFIED';
 result.paths={};
 for(const [name,rel]of [['directory','.gemini'],['tokenFile','.gemini/jetski-standalone-oauth-token']]){
  try{const info=await io.stat(path.join(io.home,rel));result.paths[name]={present:true,symlink:info.isSymbolicLink(),sameUser:info.uid===io.uid,regular: name==='directory'?info.isDirectory():info.isFile()};}
  catch(error){result.paths[name]={present:false,reason:error.code==='ENOENT'?'missing':error.code==='EACCES'?'access-denied':'unavailable'};}
 }
 return result;
}
module.exports={report};
if(require.main===module){if(process.argv.length!==3||!/^\d+$/.test(process.argv[2])){process.stderr.write('DIAGNOSTIC_PID_REQUIRED\n');process.exitCode=1;}else void report(Number(process.argv[2])).then(value=>process.stdout.write(JSON.stringify(value)+'\n')).catch(()=>{process.stderr.write('DIAGNOSTIC_UNAVAILABLE\n');process.exitCode=1;});}
