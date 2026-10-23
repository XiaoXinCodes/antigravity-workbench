// Non-account acceptance fixture. MUST run as PID 1 in new PID+network
// namespaces. Only temporary HOME synthetic tokens are written. No VS Code or
// official extension is loaded. This tests native /proc census and detachment,
// not Windows window closure or official RPC.
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process'),{randomUUID}=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const {AutomaticOfflineKey,AutomaticOfflineControl,launchAutomaticOfflineHelper}=require(path.join(root,'out/offline-automatic'));
const {OfflineRecoveryStore}=require(path.join(root,'out/offline-recovery-store'));
const {LiveLocks,probeProcessIdentity}=require(path.join(root,'out/live-lock'));
const {resolveCredentialHostId}=require(path.join(root,'out/native-host'));
const {inspectOfflineLinuxProcesses}=require(path.join(root,'out/offline-process-census'));
async function isolated(){for(const name of ['pid','net']){const outer=process.env['AG_TEST_OUTER_'+name.toUpperCase()];if(!outer||await fs.readlink('/proc/self/ns/'+name)===outer)throw Error('ISOLATED_NAMESPACE_REQUIRED');}}
async function wait(fn){for(let n=0;n<1000;n++){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,20));}throw Error('SYNTHETIC_TIMEOUT');}
async function exists(file){try{await fs.stat(file);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
async function initiate(){
 await isolated();const home=process.env.HOME;if(!await exists(path.join(home,'synthetic-only')))throw Error('SYNTHETIC_HOME_REQUIRED');
 const host=await resolveCredentialHostId({extension:{extensionKind:2}},'wsl','wsl-file'),id=randomUUID(),owner='e'.repeat(64),p=await probeProcessIdentity(process.pid);
 assert.equal(p.state,'alive');const knownHosts=[{pid:process.pid,startIdentity:p.startIdentity}],slots=n=>({keyring:null,file:JSON.stringify({token:{refresh_token:'synthetic-'+n}}),keyringState:'unobserved'});
 await fs.mkdir(path.join(home,'.gemini'),{mode:0o700});await fs.writeFile(path.join(home,'.gemini','jetski-standalone-oauth-token'),slots('old').file,{mode:0o600});
 const census=await inspectOfflineLinuxProcesses({uid:process.getuid(),home,knownHosts,scope:'file-only'});assert.equal(census.complete,true);assert.equal(census.unknown,false);assert.deepEqual(census.hosts,knownHosts);
 const record={schema:1,hostId:host,id,phase:'prepared',backup:slots('old'),target:slots('target'),expectedEmail:'fixture@example.test',originalEmail:'original@example.test',execution:{owner,extensionKind:2,remoteName:'wsl',knownHosts,initialHosts:census.hosts,participants:census.hosts}};
 const control=new AutomaticOfflineControl(home,id),locks=new LiveLocks(path.join(home,'.gemini'),owner);
 await locks.withOperation(async()=>{const key=await new AutomaticOfflineKey(home,host,id).create();await control.reset();await new OfflineRecoveryStore(path.join(home,'.gemini','antigravity-workbench-offline',id),key,host,id).save(record,undefined);await locks.beginOfflineRecovery(id);});
 await fs.writeFile(path.join(home,'metadata.json'),JSON.stringify({host,id,owner}));
 await launchAutomaticOfflineHelper(path.join(root,'out/offline-automatic-helper.js'),id,host,2,'wsl','install',(await control.read()).attempt);
 await fs.writeFile(path.join(home,'ready'),'synthetic');await wait(()=>exists(path.join(home,'close')));
}
async function cleanupFixture(home){if(home===os.homedir()||!home.startsWith(path.join(os.tmpdir(),'native-offline-acceptance-'))||(await fs.lstat(home)).isSymbolicLink())throw Error('UNSAFE_FIXTURE_CLEANUP');await fs.rm(home,{recursive:true,force:true});}
async function main(){
 await isolated();if(process.pid!==1)throw Error('ISOLATED_PID_ONE_REQUIRED');
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'native-offline-acceptance-'));
 try{
  await fs.writeFile(path.join(home,'synthetic-only'),'fixture');
  const child=spawn(process.execPath,[__filename,'--initiator'],{env:{...process.env,HOME:home,WSL_DISTRO_NAME:'SyntheticFixture',VSCODE_ESM_ENTRYPOINT:'vs/workbench/api/node/extensionHostProcess'},stdio:['ignore','ignore','pipe']});
  let errors='';child.stderr.on('data',b=>{errors+=b.toString();});const exit=new Promise(resolve=>child.once('exit',resolve));
  await wait(async()=>{if(child.exitCode!==null)throw Error('INITIATOR_EXIT_'+child.exitCode+':'+errors);return exists(path.join(home,'ready'));});const {host,id,owner}=JSON.parse(await fs.readFile(path.join(home,'metadata.json'),'utf8'));
  await fs.writeFile(path.join(home,'close'),'close');assert.equal(await exit,0,errors);
  const control=new AutomaticOfflineControl(home,id);await wait(async()=>{const state=await control.read();if(state.status==='INSTALLED')return true;if(state.status!=='WAITING_FOR_CLOSE')throw Error(state.status);return false;});
  const key=await new AutomaticOfflineKey(home,host,id).read(),record=await new OfflineRecoveryStore(path.join(home,'.gemini','antigravity-workbench-offline',id),key,host,id).read();
  assert.equal(record.phase,'installed');assert.equal(await fs.readFile(path.join(home,'.gemini','jetski-standalone-oauth-token'),'utf8'),record.target.file);
  await new LiveLocks(path.join(home,'.gemini'),owner).withOperation(async()=>{});
  process.stdout.write('PASS: native isolated census, parent exit, detached production helper, synthetic commit, preserved backup and key. No Windows/official RPC claim.\n');
 }finally{await cleanupFixture(home);}
}
(process.argv[2]==='--initiator'?initiate:main)().catch(error=>{process.stderr.write((error.code||error.message)+'\n');process.exitCode=1;});
