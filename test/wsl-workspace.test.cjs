const test=require('node:test'),assert=require('node:assert/strict');
const {bindWslWorkspace}=require('../out/wsl-workspace');
const ws=uri=>({kind:'folder',uri});
test('WSL file URI and remote URI canonicalize identically with explicit distro binding',()=>{
 const file=bindWslWorkspace(ws('file:///home/test/a%20b%23c'),'wsl','Ubuntu-24.04','wsl+ubuntu-24.04');
 assert.equal(file.uri,'vscode-remote://wsl+ubuntu-24.04/home/test/a%20b%23c');
 assert.deepEqual(bindWslWorkspace(ws(file.uri),'wsl','Ubuntu-24.04'),file);
 assert.equal(bindWslWorkspace({kind:'workspace',uri:'file:///home/test/saved.code-workspace'},'wsl','Ubuntu').kind,'workspace');
});
test('remoteName alone, wrong distro, foreign file authority and unsupported schemes refuse',()=>{
 for(const [uri,name,distro,expected] of [['file:///home/x','wsl',undefined],['file:///home/x','ssh-remote','Ubuntu'],['vscode-remote://wsl+other/home/x','wsl','Ubuntu'],['file://other/home/x','wsl','Ubuntu'],['untitled:/home/x','wsl','Ubuntu'],['file:///home/x','wsl','Ubuntu','wsl+other']])assert.throws(()=>bindWslWorkspace(ws(uri),name,distro,expected),{code:'WINDOW_WORKSPACE_BINDING_UNVERIFIED'});
});
test('path traversal, separators, query and root never become matching workspace',()=>{
 for(const p of ['file:///home/x/../y','file:///home/%2e%2e/y','file:///home/x%2fy','file:///home/x%5cy','file:///home/x?token=x','file:///home/x#frag','file:///','file:///home//x','file:///home/%00'])assert.throws(()=>bindWslWorkspace(ws(p),'wsl','Ubuntu'));
});
test('distinct exact workspace paths remain distinct',()=>{
 assert.notEqual(bindWslWorkspace(ws('file:///home/a'),'wsl','Ubuntu').uri,bindWslWorkspace(ws('file:///home/b'),'wsl','Ubuntu').uri);
});
