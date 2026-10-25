const vscode=require('vscode'),fs=require('node:fs/promises'),path=require('node:path'),{spawn}=require('node:child_process'),{configuration,launcher}=require('./common.cjs');
exports.activate=async context=>{
 const root=path.dirname(context.extensionPath),c=await configuration(root);
 try{
  if(vscode.env.remoteName!=='wsl'||vscode.workspace.workspaceFolders?.length!==1||vscode.workspace.workspaceFolders[0].uri.toString()!==c.workspaceUri||vscode.extensions.all.some(e=>e.isActive&&/antigravity/i.test(e.id)))throw Error('FIXTURE_BOUNDARY');
  const {WindowReopen}=require(path.join(root,'out/window-reopen.js')),{captureCurrentWindow,requestCurrentWindowClose}=require(path.join(root,'out/vscode-window-participant.js'));
  const current=await captureCurrentWindow(),receipts=new WindowReopen(root);
  if(await receipts.hasAttempt(c.id)){
   if(!await receipts.claim(c.workspaceUri,'wsl',current.host))throw Error('REJOIN_NOT_CLAIMED');
   await fs.writeFile(path.join(root,'rejoined.json'),JSON.stringify({attempt:c.id,host:current.host,workspaceMatched:true,accountOperations:false}));
   const deadline=Date.now()+70000;while(Date.now()<deadline){if(await fs.stat(path.join(root,'passed.json')).then(()=>true,()=>false)){await requestCurrentWindowClose(current,async()=>{});return;}await new Promise(r=>setTimeout(r,100));}throw Error('HELPER_COMPLETION_TIMEOUT');
  }
  const plan=await launcher(root,c).discover({kind:'folder',uri:c.workspaceUri});
  const doc=await vscode.workspace.openTextDocument(vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri,'synthetic.txt'));await vscode.window.showTextDocument(doc);
  const edit=new vscode.WorkspaceEdit();edit.insert(doc.uri,new vscode.Position(0,0),'saved-by-fixture\n');await vscode.workspace.applyEdit(edit);
  await receipts.prepare(c.id,plan,current.host);await fs.writeFile(path.join(root,'plan.json'),JSON.stringify(plan));
  const child=spawn(process.execPath,[path.join(context.extensionPath,'helper.cjs'),root],{detached:true,stdio:['ignore','pipe','ignore'],env:{PATH:process.env.PATH,WSL_INTEROP:process.env.WSL_INTEROP,ELECTRON_RUN_AS_NODE:'1'}});
  const ready=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('ACK_TIMEOUT')),10000);child.once('error',reject);child.stdout.once('data',b=>{clearTimeout(timer);resolve(b.toString());});});
  if(ready!=='READY\n')throw Error('ACK_INVALID');child.stdout.destroy();child.unref();
  await requestCurrentWindowClose(current,async()=>{},()=>receipts.markCloseRequested(c.id));
 }catch(e){await fs.writeFile(path.join(root,'failure.json'),JSON.stringify({code:e.code??'FIXTURE_FAILED'}));}
};
