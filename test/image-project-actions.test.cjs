const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),Module=require('node:module');
const {png}=require('./fixtures/png-fixture.cjs');
const uri=file=>({scheme:'file',authority:'',path:file,fsPath:file});
const selection=(start=1,end=start)=>({isEmpty:start===end,anchor:{line:0,character:start},active:{line:0,character:end},isEqual(other){return JSON.stringify(this.anchor)===JSON.stringify(other.anchor)&&JSON.stringify(this.active)===JSON.stringify(other.active)}});
async function fixture(t){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'ag-project-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));const projectRoot=path.join(root,'项目 (A)'),other=path.join(root,'other');await fs.mkdir(projectRoot);await fs.mkdir(other);await fs.mkdir(path.join(projectRoot,'docs'));const file=path.join(projectRoot,'图 [one] (1).png');await fs.writeFile(file,png());
 const listeners={},clipboard=[],edits=[],folders=[{name:'项目 A',uri:uri(projectRoot)},{name:'other',uri:uri(other)}];let dialog,permissions=0,writable=true,applied=true,onShow=()=>{};
 const doc={uri:uri(path.join(projectRoot,'docs','笔记 (1).md')),version:1,isClosed:false,isUntitled:false,isDirty:true,save:()=>{throw Error('must not autosave')}};
 const editor={document:doc,selections:[selection()],viewColumn:2,edit:async(fn,options)=>{const replacements=[];fn({replace:(range,text)=>replacements.push({range,text})});if(applied)edits.push({replacements,options});return applied}};
 const hook=name=>fn=>{listeners[name]=fn;return{dispose(){}}};
 const v={env:{remoteName:'wsl',clipboard:{writeText:async s=>clipboard.push(s)}},FilePermission:{Readonly:1},Uri:{file:uri,joinPath:(u,n)=>({...u,path:path.join(u.path,n),fsPath:path.join(u.fsPath,n)})},
 workspace:{workspaceFolders:folders,asRelativePath:u=>path.relative(projectRoot,u.fsPath),getWorkspaceFolder:u=>folders.find(f=>u.fsPath.startsWith(f.uri.fsPath+path.sep)),onDidChangeTextDocument:hook('change'),onDidCloseTextDocument:hook('close'),fs:{isWritableFileSystem:()=>writable,stat:async()=>({permissions})}},
 window:{activeTextEditor:editor,onDidChangeActiveTextEditor:hook('active'),onDidChangeTextEditorSelection:hook('selection'),showTextDocument:async()=>{onShow();listeners.active(editor);return editor},showSaveDialog:async()=>dialog}};
 const entry=require.resolve('../out/image-project-actions'),old=Module._load;let api;
 try{Module._load=function(name,...args){return name==='vscode'?v:old.call(this,name,...args)};delete require.cache[entry];api=require(entry)}finally{Module._load=old;delete require.cache[entry]}
 const actions=new api.ImageProjectActions({subscriptions:[]},()=>{}),image={file,width:2,height:2};
 return{root,projectRoot,other,image,api,actions,v,doc,editor,listeners,clipboard,edits,setDialog:x=>dialog=x,setReadonly:x=>permissions=x?1:0,setWritable:x=>writable=x,setApplied:x=>applied=x,onShow:fn=>onShow=fn,select:s=>{editor.selections=s;listeners.selection({textEditor:editor})}};
}
test('multiroot paths, encoded Markdown and webview focus retain the exact dirty-document target and selection',async t=>{
 const f=await fixture(t);await f.actions.copyPath(f.image);assert.equal(f.clipboard[0],path.basename(f.image.file));
 const first=f.actions.state();f.listeners.active(undefined);assert.equal(f.actions.state().id,first.id);await f.actions.copyMarkdown(f.image,first.id);assert.match(f.clipboard[1],/\.\.\/.*%20%5Bone%5D%20%281%29\.png/);assert.match(f.clipboard[1],/图 \\\[one\\\] \(1\)/);
 f.select([selection(1,3),selection(6)]);const id=f.actions.state().id;await f.actions.insertMarkdown(f.image,id);assert.equal(f.edits.length,1);assert.equal(f.edits[0].replacements.length,2);assert.equal(f.edits[0].replacements[0].range.anchor.character,1);assert.deepEqual(f.edits[0].options,{undoStopBefore:true,undoStopAfter:true});assert.equal(f.doc.isDirty,true);
 const second=path.join(f.other,'图.png');await fs.writeFile(second,png());await f.actions.copyPath({...f.image,file:second});assert.equal(f.clipboard.at(-1),'图.png');assert.equal(f.api.workspaceImage(second).folder.name,'other');
});
test('read-only, rejected edits, unsaved documents and changed selection/version all stop without insertion',async t=>{
 const f=await fixture(t);const attempt=()=>f.actions.insertMarkdown(f.image,f.actions.state().id);
 f.setReadonly(true);await assert.rejects(attempt(),/READONLY/);f.setReadonly(false);f.setWritable(false);await assert.rejects(attempt(),/READONLY/);f.setWritable(true);
 f.setApplied(false);await assert.rejects(attempt(),/READONLY/);f.setApplied(true);
 f.doc.isUntitled=true;await assert.rejects(attempt(),/TARGET_UNSAVED/);f.doc.isUntitled=false;
 const old=f.actions.state().id;f.select([selection(3)]);await assert.rejects(f.actions.insertMarkdown(f.image,old),/TARGET_CHANGED/);
 f.v.window.activeTextEditor=undefined;f.doc.version++;f.listeners.change({document:f.doc});assert.equal(f.actions.state().canInsert,false);await assert.rejects(attempt(),/TARGET_CHANGED/);f.select([selection(4)]);
 f.onShow(()=>{f.editor.selections=[selection(10)]});await assert.rejects(attempt(),/TARGET_CHANGED/);assert.equal(f.edits.length,0);
 f.listeners.close(f.doc);await assert.rejects(attempt(),/TARGET_MISSING/);
});
test('no text target falls back to root-relative Markdown, never a hidden or untitled editor',async t=>{
 const f=await fixture(t);f.listeners.close(f.doc);await f.actions.copyMarkdown(f.image,0);assert.doesNotMatch(f.clipboard.at(-1),/\.\.\//);await assert.rejects(f.actions.insertMarkdown(f.image,0),/TARGET_MISSING/);assert.equal(f.edits.length,0);
});
test('external files need an explicit project copy; copy is no-clobber and checks cancellation and modified copies',async t=>{
 const f=await fixture(t),external=path.join(f.root,'outside.png'),bytes=png();await fs.writeFile(external,bytes);const image={...f.image,file:external};
 await assert.rejects(f.actions.copyPath(image),/PROJECT_OUTSIDE/);await assert.rejects(f.actions.copyMarkdown(image,f.actions.state().id),/PROJECT_OUTSIDE/);assert.equal(f.clipboard.length,0);
 f.setDialog(uri(path.join(f.other,'copied.png')));const copy=await f.actions.copyIntoProject(image);assert.deepEqual(await fs.readFile(external),bytes);assert.deepEqual(await fs.readFile(copy.file),bytes);assert.equal((await fs.stat(copy.file)).nlink,1);
 await assert.rejects(f.actions.copyIntoProject(image),/PROJECT_EXISTS/);assert.deepEqual(await fs.readFile(copy.file),bytes);
 image.projectCopy=copy;await f.actions.copyPath(image);assert.equal(f.clipboard.at(-1),'copied.png');await fs.writeFile(copy.file,png({value:80}));await assert.rejects(f.actions.copyPath(image),/COPY_CHANGED/);
 f.setDialog(uri(path.join(f.root,'outside-copy.png')));await assert.rejects(f.actions.copyIntoProject(image),/PROJECT_OUTSIDE/);
 f.setDialog(uri(path.join(f.other,'cancelled.png')));await assert.rejects(f.actions.copyIntoProject(image,()=>{throw Error('IMAGE_CANCELLED')}),/CANCELLED/);await assert.rejects(fs.stat(path.join(f.other,'cancelled.png')),/ENOENT/);assert.deepEqual((await fs.readdir(f.other)).sort(),['copied.png']);
});
test('remote URIs require the matching host, including WSL distro; cancelled actions never touch clipboard/editor',async t=>{
 const f=await fixture(t),remote={scheme:'vscode-remote',authority:'wsl+'+process.env.WSL_DISTRO_NAME,path:f.projectRoot,fsPath:f.projectRoot};f.v.workspace.workspaceFolders=[{uri:remote,name:'remote'}];
 assert.equal(f.api.hostPath(remote),process.platform==='linux'&&process.env.WSL_DISTRO_NAME?f.projectRoot:undefined);assert.equal(f.api.hostPath({...remote,authority:'wsl+other'}),undefined);assert.equal(f.api.hostPath({...remote,scheme:'https'}),undefined);
 f.v.workspace.workspaceFolders=[{uri:uri(f.projectRoot),name:'local'}];await assert.rejects(f.actions.copyPath(f.image,()=>{throw Error('IMAGE_CANCELLED')}),/CANCELLED/);await assert.rejects(f.actions.insertMarkdown(f.image,f.actions.state().id,()=>{throw Error('IMAGE_CANCELLED')}),/CANCELLED/);assert.equal(f.clipboard.length,0);assert.equal(f.edits.length,0);
});
