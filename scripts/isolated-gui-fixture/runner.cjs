// Node built-ins only; no download, install, remote connect, process termination,
// production account import or SecretStorage access. Keep evidence after failure.
const fs=require('node:fs/promises'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
const inside=(root,value)=>{const r=path.relative(root,value);return r!==''&&!r.startsWith('..')&&!path.isAbsolute(r);};
const absent=async file=>{try{await fs.lstat(file);return false;}catch(e){if(e.code==='ENOENT')return true;throw e;}};
function options(args){const result={};for(let i=0;i<args.length;i++){const key=args[i];if(!['--root','--code','--phase','--isolated-os','--auto-close-fixture','--allow-no-sandbox'].includes(key)||Object.hasOwn(result,key))throw Error('ARGUMENT_INVALID');result[key]=['--root','--code','--phase'].includes(key)?args[++i]:true;}return result;}
function environment(root){const env={};for(const key of ['PATH','SystemRoot','WINDIR','ComSpec','PATHEXT','DISPLAY','XAUTHORITY','WAYLAND_DISPLAY','XDG_RUNTIME_DIR','LANG','LC_ALL'])if(process.env[key])env[key]=process.env[key];return {...env,HOME:path.join(root,'home'),USERPROFILE:path.join(root,'home'),APPDATA:path.join(root,'appdata'),LOCALAPPDATA:path.join(root,'localappdata'),TMP:path.join(root,'tmp'),TEMP:path.join(root,'tmp'),TMPDIR:path.join(root,'tmp'),XDG_CONFIG_HOME:path.join(root,'config'),XDG_CACHE_HOME:path.join(root,'cache'),XDG_DATA_HOME:path.join(root,'data'),VSCODE_AGENT_FOLDER:path.join(root,'server'),AG_GUI_FIXTURE_ROOT:root};}
async function prepare(o){
 const root=path.resolve(o['--root']||''),code=await fs.realpath(o['--code']||'');
 if(!o['--root']||!['linux','win32'].includes(process.platform)||!inside(path.join(root,'runtime'),code)||!await absent(path.join(root,'manifest.json')))throw Error('FRESH_RUNTIME_ROOT_REQUIRED');
 const actual=await fs.realpath(root);if(actual!==root)throw Error('SYMLINK_ROOT_REJECTED');
 if(!await absent(path.join(path.dirname(code),'data')))throw Error('PORTABLE_DATA_OVERRIDES_FLAGS');
 const initial=await fs.readdir(root);if(initial.some(name=>name!=='runtime'))throw Error('ROOT_MUST_ONLY_CONTAIN_RUNTIME');
 for(const name of ['home','profile','extensions','workspace','fixture','appdata','localappdata','tmp','config','cache','data','server'])await fs.mkdir(path.join(root,name),{mode:0o700});
 await fs.mkdir(path.join(root,'home','.gemini'),{mode:0o700});await fs.mkdir(path.join(root,'profile','User'),{recursive:true});
 await fs.writeFile(path.join(root,'profile','User','settings.json'),JSON.stringify({'telemetry.telemetryLevel':'off','update.mode':'none','extensions.autoCheckUpdates':false,'extensions.autoUpdate':false,'workbench.enableExperiments':false,'workbench.startupEditor':'none'}));
 await fs.writeFile(path.join(root,'fixture','package.json'),JSON.stringify({name:'offline-boundary',publisher:'synthetic',version:'0.0.1',engines:{vscode:'^1.95.0'},main:'main.cjs',activationEvents:['onStartupFinished'],extensionKind:['workspace'],capabilities:{untrustedWorkspaces:{supported:true}}}));
 await fs.copyFile(path.join(__dirname,'fixture-extension.cjs'),path.join(root,'fixture','main.cjs'));
 await fs.writeFile(path.join(root,'workspace','SYNTHETIC-ONLY.txt'),'Disposable GUI fixture. No production accounts or official extension.\n');
 await fs.writeFile(path.join(root,'home','.gemini','jetski-standalone-oauth-token'),'synthetic-old',{mode:0o600});
 const m={kind:'synthetic-gui-boundary-v1',root,code,nonce:crypto.randomBytes(16).toString('hex'),runtimeSha256:crypto.createHash('sha256').update(await fs.readFile(code)).digest('hex')};
 await fs.writeFile(path.join(root,'manifest.json'),JSON.stringify(m,null,2),{flag:'wx',mode:0o600});console.log('PREPARED: synthetic only; no GUI launched.');
}
async function run(o){
 if(!o['--isolated-os'])throw Error('ISOLATED_OS_ATTESTATION_REQUIRED');
 if(!o['--auto-close-fixture']&&(!process.stdin.isTTY||!process.stdout.isTTY||process.env.TERM_PROGRAM==='vscode'||process.env.VSCODE_IPC_HOOK_CLI))throw Error('EXTERNAL_TERMINAL_REQUIRED');
 const root=path.resolve(o['--root']||''),m=JSON.parse(await fs.readFile(path.join(root,'manifest.json'),'utf8')),phase=o['--phase'];
 if(m.kind!=='synthetic-gui-boundary-v1'||m.root!==root||!['initial','reopened'].includes(phase)||!inside(path.join(root,'runtime'),await fs.realpath(m.code)))throw Error('MANIFEST_INVALID');
 if(crypto.createHash('sha256').update(await fs.readFile(m.code)).digest('hex')!==m.runtimeSha256)throw Error('RUNTIME_CHANGED');
 if(!await absent(path.join(root,`ready-${phase}.json`)))throw Error('PHASE_ALREADY_RUN');
 if(phase==='reopened'&&await absent(path.join(root,'closed-initial.json')))throw Error('INITIAL_CLOSE_NOT_PROVEN');
 const lease=await fs.open(path.join(root,'runner-active'),'wx',0o600);await lease.close();
 const credentials=path.join(root,'home','.gemini','jetski-standalone-oauth-token'),expected=phase==='initial'?'synthetic-old':'synthetic-new';
 if(await fs.readFile(credentials,'utf8')!==expected)throw Error('FIXTURE_CREDENTIAL_CHANGED');
 let requests=0;
 const server=http.createServer((req,res)=>{const url=new URL(req.url,'http://127.0.0.1');const challenge=url.searchParams.get('challenge');if(url.pathname!=='/identity'||!/^[a-f0-9]{32}$/.test(challenge||'')){res.writeHead(400).end();return;}requests++;res.setHeader('content-type','application/json');res.end(JSON.stringify({nonce:m.nonce,phase,challenge,synthetic:true}));});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 await fs.writeFile(path.join(root,'endpoint.json'),JSON.stringify({port:server.address().port,phase,autoClose:!!o['--auto-close-fixture']}));
 const args=['--user-data-dir',path.join(root,'profile'),'--extensions-dir',path.join(root,'extensions'),'--extensionDevelopmentPath',path.join(root,'fixture'),'--disable-extensions','--skip-welcome','--skip-release-notes','--disable-telemetry','--disable-gpu','--new-window',path.join(root,'workspace')];
 if(o['--allow-no-sandbox'])args.unshift('--no-sandbox');
 const log=await fs.open(path.join(root,`gui-${phase}.log`),'wx',0o600);
 const child=spawn(m.code,args,{cwd:path.join(root,'workspace'),env:environment(root),stdio:['ignore',log.fd,log.fd],shell:false,windowsHide:false});
 let exit,spawnError=false;child.once('error',()=>{spawnError=true;});child.once('exit',(code,signal)=>{exit={code,signal};});
 const deadline=Date.now()+180000;let report;
 console.log('WAITING: close only the synthetic test window after its READY message. No process will be killed.');
 try{
  while(Date.now()<deadline){
   if(spawnError)throw Error('GUI_SPAWN_FAILED');
   if(!await absent(path.join(root,'fixture-error.json')))throw Error('EXTENSION_BOUNDARY_FAILED');
   if(!report&&!await absent(path.join(root,`ready-${phase}.json`))){report=JSON.parse(await fs.readFile(path.join(root,`ready-${phase}.json`),'utf8'));if(report.nonce!==m.nonce||report.phase!==phase||report.remoteName!==null||!Number.isSafeInteger(report.pid)||report.pid<1||report.pid===process.pid)throw Error('REPORT_INVALID');console.log(`READY ${phase}: real GUI and synthetic fresh loopback passed; closeMode=${report.closeMode}`);}
   if(exit){if(exit.code!==0||!report||requests!==1)throw Error('GUI_EXIT_UNVERIFIED');let dead=false;try{process.kill(report.pid,0);}catch(e){if(e.code==='ESRCH')dead=true;else throw Error('HOST_EXIT_UNKNOWN');}if(dead)break;}
   await new Promise(resolve=>setTimeout(resolve,100));
  }
  if(!exit||Date.now()>=deadline)throw Error('GUI_CLOSE_TIMEOUT');
  if(await fs.readFile(credentials,'utf8')!==expected)throw Error('FIXTURE_CREDENTIAL_CHANGED');
  if(phase==='initial'){const staged=credentials+'.tmp',handle=await fs.open(staged,'wx',0o600);try{await handle.writeFile('synthetic-new');await handle.sync();}finally{await handle.close();}await fs.rename(staged,credentials);}
  await fs.writeFile(path.join(root,`closed-${phase}.json`),JSON.stringify({phase,guiExit:exit,hostExited:true,closeMode:report.closeMode,syntheticLoopbackFresh:true,officialRpc:false,remoteWsl:false,productTransaction:false}),{flag:'wx',mode:0o600});
  console.log(`PASS ${phase}: GUI and host exited. ${phase==='initial'?'Synthetic file replaced; launch reopened phase manually.':'Profile persisted and synthetic fresh reply verified.'} NOT official RPC or remote WSL acceptance.`);
 }finally{server.close();await log.close();if(exit)await fs.unlink(path.join(root,'runner-active'));else{console.error('GUI MAY STILL BE OPEN: preserve runner-active and evidence; close only the fixture window manually.');child.unref();}}
}
async function main(args){const [action,...rest]=args,o=options(rest);if(action==='prepare')return prepare(o);if(action==='run')return run(o);throw Error('USE_PREPARE_OR_RUN');}
module.exports={options,environment,inside,prepare,run};
if(require.main===module)void main(process.argv.slice(2)).catch(e=>{console.error(/^[A-Z_]+$/.test(e.message)?e.message:'FIXTURE_FAILED');process.exitCode=1;});
