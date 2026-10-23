// Synthetic development extension only. Never imports Workbench or official code.
const vscode=require('vscode'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),http=require('node:http'),crypto=require('node:crypto');
const inside=(root,value)=>{const r=path.relative(root,value);return r===''||(!r.startsWith('..')&&!path.isAbsolute(r));};
exports.activate=async context=>{
 const root=process.env.AG_GUI_FIXTURE_ROOT;
 if(!root||!path.isAbsolute(root))throw Error('FIXTURE_ROOT_REQUIRED');
 const m=JSON.parse(await fs.readFile(path.join(root,'manifest.json'),'utf8'));
 try{
  if(m.kind!=='synthetic-gui-boundary-v1'||vscode.env.remoteName||path.resolve(os.homedir())!==path.join(root,'home'))throw Error('HOST_BOUNDARY_FAILED');
  for(const p of [context.extensionPath,context.globalStorageUri.fsPath,...(vscode.workspace.workspaceFolders||[]).map(f=>f.uri.fsPath)])if(!inside(root,await fs.realpath(p).catch(()=>path.resolve(p))))throw Error('PATH_BOUNDARY_FAILED');
  if(vscode.extensions.getExtension('google.google-antigravity'))throw Error('OFFICIAL_EXTENSION_PRESENT');
  if(vscode.extensions.all.some(e=>!inside(root,e.extensionPath)))throw Error('EXTERNAL_EXTENSION_PRESENT');
  const config=JSON.parse(await fs.readFile(path.join(root,'endpoint.json'),'utf8'));
  const challenge=crypto.randomBytes(16).toString('hex');
  const reply=await new Promise((resolve,reject)=>{
   const req=http.get({host:'127.0.0.1',port:config.port,path:`/identity?challenge=${challenge}`,timeout:5000},res=>{let body='';res.on('data',b=>{body+=b;if(body.length>4096)req.destroy(Error('LIMIT'));});res.on('end',()=>{try{resolve(JSON.parse(body));}catch{reject(Error('INVALID'));}});});req.on('timeout',()=>req.destroy(Error('TIMEOUT')));req.on('error',reject);
  });
  if(reply.challenge!==challenge||reply.nonce!==m.nonce||reply.phase!==config.phase)throw Error('SYNTHETIC_RPC_FAILED');
  if(config.phase==='reopened'&&context.globalState.get('prior-window')!==m.nonce)throw Error('PROFILE_NOT_PERSISTED');
  await context.globalState.update('prior-window',m.nonce);
  const report={kind:m.kind,nonce:m.nonce,phase:config.phase,pid:process.pid,home:os.homedir(),storage:context.globalStorageUri.fsPath,extension:context.extensionPath,remoteName:vscode.env.remoteName??null,vscodeVersion:vscode.version,syntheticLoopbackFresh:true,officialRpc:false,closeMode:config.autoClose?'fixture-command':'manual'};
  await fs.writeFile(path.join(root,`ready-${config.phase}.json`),JSON.stringify(report),{flag:'wx',mode:0o600});
  void vscode.window.showInformationMessage('SYNTHETIC GUI TEST: identity roundtrip passed. Close only this test window to continue. No real account is used.');
  if(config.autoClose)setTimeout(()=>{void vscode.commands.executeCommand('workbench.action.closeWindow');},1000);
 }catch(error){await fs.writeFile(path.join(root,'fixture-error.json'),JSON.stringify({code:/^[A-Z_]+$/.test(error.message)?error.message:'FIXTURE_FAILED'}));throw Error('SYNTHETIC_FIXTURE_FAILED');}
};
