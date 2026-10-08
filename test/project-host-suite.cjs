// Run only in the separately launched synthetic workspace; never activates Workbench or official accounts.
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),vscode=require('vscode');
const {png}=require('./fixtures/png-fixture.cjs');
exports.run=async()=>{
 const trace=async name=>{if(process.env.AG_PROJECT_TRACE)await fs.appendFile(process.env.AG_PROJECT_TRACE,name+'\n')};await trace('entered');
 const roots=vscode.workspace.workspaceFolders??[];assert.equal(roots.length,2);const root=roots[0].uri.fsPath;assert.match(root,/ag-iteration-host-[a-f0-9]+/i);
 const {ImageProjectActions,markdownImage}=require('../out/image-project-actions');const imagePath=path.join(root,'图片 (1).png'),file=path.join(root,'说明 (draft).md');
 await fs.writeFile(imagePath,png());await fs.writeFile(file,'prefix KEEP suffix\nsecond line\n');
 const document=await vscode.workspace.openTextDocument(vscode.Uri.file(file)),editor=await vscode.window.showTextDocument(document,{preview:false});
 const subscriptions=[],actions=new ImageProjectActions({subscriptions},()=>{});
 const settle=()=>new Promise(r=>setTimeout(r,100));
 const image={file:imagePath,width:2,height:2};const checks={};
 const projectFile=actions.projectFile.bind(actions);actions.projectFile=async image=>{await trace('image-read-start');const result=await projectFile(image);await trace('image-read-done');return result};
 try{
  await editor.edit(b=>b.insert(new vscode.Position(1,0),'unsaved '));editor.selection=new vscode.Selection(0,7,0,11);await settle();assert.equal(document.isDirty,true);
  await trace('dirty-selection-ready');const pinned=actions.state();assert.equal(pinned.canInsert,true,JSON.stringify(pinned));assert.equal(pinned.replacesSelection,true);
  const panel=vscode.window.createWebviewPanel('syntheticResultFocus','Synthetic image result',vscode.ViewColumn.Beside,{});panel.webview.html='<html><body>Isolated result focus test — no accounts or requests</body></html>';await settle();assert.equal(actions.state().id,pinned.id);
  await trace('webview-focused');await vscode.workspace.fs.stat(document.uri);await trace('document-stat-done');await actions.insertMarkdown(image,pinned.id);await trace('insert-complete');await settle();const expected=markdownImage(imagePath,'图片 (1).png');assert.equal(document.getText(),'prefix '+expected+' suffix\nunsaved second line\n');assert.equal(document.isDirty,true);assert.equal(await fs.readFile(file,'utf8'),'prefix KEEP suffix\nsecond line\n');checks.webviewFocusPreserved=true;checks.replacesSelectedText=true;checks.unsavedBufferPreserved=true;checks.noAutoSave=true;
  await trace('before-undo');await vscode.window.showTextDocument(document,{viewColumn:editor.viewColumn,preview:false,preserveFocus:false});await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');await settle();await vscode.commands.executeCommand('undo');await trace('undo-complete');await settle();assert.equal(document.getText(),'prefix KEEP suffix\nunsaved second line\n');checks.singleUndo=true;
  await trace('before-multiple');editor.selections=[new vscode.Selection(0,0,0,0),new vscode.Selection(1,0,1,0)];await settle();await actions.insertMarkdown(image,actions.state().id);await settle();assert.equal(document.getText().split(expected).length-1,2);checks.multipleSelections=true;
  await trace('multiple-complete');const stale=actions.state().id;editor.selection=new vscode.Selection(0,1,0,1);await settle();await assert.rejects(actions.insertMarkdown(image,stale),/TARGET_CHANGED/);checks.staleSelectionBlocked=true;
  await trace('stale-blocked');const secondImage=path.join(roots[1].uri.fsPath,'other.png');await fs.writeFile(secondImage,png());const before=document.getText();editor.selection=new vscode.Selection(0,0,0,0);await settle();await actions.insertMarkdown({file:secondImage,width:2,height:2},actions.state().id);assert.ok(document.getText().endsWith(before));assert.match(document.getText(),/\.\.\/project-b\/other\.png/);checks.multiRootDocumentRelative=true;
  await trace('multi-root-complete');const untitled=await vscode.workspace.openTextDocument({content:'not saved'});await vscode.window.showTextDocument(untitled);await settle();await assert.rejects(actions.insertMarkdown(image,actions.state().id),/TARGET_UNSAVED/);checks.untitledBlocked=true;
  assert.deepEqual(await fs.readFile(imagePath),png());checks.originalImagePreserved=true;
  await trace('untitled-blocked');panel.dispose();
  const result={passed:true,version:vscode.version,platform:process.platform,checks,syntheticWorkspace:true,workbenchActivated:false,realGeneration:false,accountRequests:false,settingsChanged:false};
  if(process.env.AG_PROJECT_EVIDENCE)await fs.writeFile(process.env.AG_PROJECT_EVIDENCE,JSON.stringify(result,null,2));console.log('PROJECT_HOST_RESULT '+JSON.stringify(result));
 }finally{for(const sub of subscriptions)sub.dispose()}
};
