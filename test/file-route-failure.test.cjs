const test = require('node:test'), assert = require('node:assert/strict');
const { explainWslFileRoute, parseWslFileRoute, createWslReadGuard, readWslStartup, wslFileRouteError } = require('../out/live-wsl-proof');
const { FILE_ROUTE_FAILURE_REASONS, fileRouteFailureReason } = require('../out/file-route-failure');
const { debugErrorData, sanitizeDebugData } = require('../out/debug-events');
const { readLastAccountFailure } = require('../out/last-account-failure');
const lines = ['I1001 12:34:56.000001      52 server.go:1] Starting language server process with pid 42', 'I1001 12:34:56.000002      52 server.go:2] Language server listening on random port at 45678 for HTTP', 'I1001 12:34:56.000003      52 composite_token_storage.go:3] Using file-based token storage because WSL environment detected'];
const base = { schema: 1, at: '2026-10-23T02:01:52.900Z', action: 'switch', stage: 'scope', phase: 'none', code: 'WSL_FILE_ROUTE_UNVERIFIED' };
for (const [reason, content] of [
 ['pid-marker-missing', lines.slice(1)], ['pid-marker-mismatch', [lines[0].replace('42','43'), ...lines.slice(1)]],
 ['port-marker-missing', [lines[0], lines[2]]], ['port-marker-mismatch', [lines[0], lines[1].replace('45678','12345'), lines[2]]],
 ['filemode-marker-missing', lines.slice(0,2)], ['filemode-marker-mismatch', [lines[0], lines[1], lines[2].replace('WSL environment detected','other route')]],
 ['marker-ambiguity', [...lines, lines[0]]], ['marker-order', [lines[1], lines[0], lines[2]]],
]) test(reason + ' retains false result and carries reason through scope error', async () => {
 const log = content.join('\n')+'\n'; assert.equal(explainWslFileRoute(log,42,45678),reason); assert.equal(parseWslFileRoute(log,42,45678),false);
 const guard=createWslReadGuard('/synthetic','/synthetic/agy',()=>({port:45678,csrfToken:'synthetic-capability-for-test'}),{process:async()=>({pid:42,startTicks:'1'}),startup:async()=>log});
 assert.equal(await guard(),false); assert.equal(guard.fileRouteFailureReason,reason);
 const error=wslFileRouteError(guard.fileRouteFailureReason); assert.equal(error.code,base.code); assert.equal(debugErrorData(error).fileRouteFailureReason,reason);
 assert.equal(readLastAccountFailure({...base,...debugErrorData(error)}).fileRouteFailureReason,reason);
});
test('matching proof still succeeds; previous failure reason is cleared',async()=>{
 let text='';const guard=createWslReadGuard('/synthetic','/synthetic/agy',()=>({port:45678,csrfToken:'synthetic-capability-for-test'}),{process:async()=>({pid:42,startTicks:'1'}),startup:async()=>text});
 assert.equal(await guard(),false);text=lines.join('\n')+'\n';assert.equal(await guard(),true);assert.equal(guard.fileRouteFailureReason,undefined);
});
test('host mismatch still rejects and exposes no original error',async()=>{
 const guard=createWslReadGuard('/synthetic','/synthetic/agy',()=>undefined);
 await assert.rejects(guard(),e=>e.code===base.code&&e.fileRouteFailureReason==='host-mismatch');
});
for (const reason of ['directory-permissions','open-log-count','log-file-metadata','inode-mismatch','read-stability']) test('reader branch '+reason+' reaches guard and persistence',async t=>{
 const fs=require('node:fs/promises'); const file='/synthetic/.gemini/antigravity/log/cli-20261001_123456.log';
 const stat={uid:process.getuid(),mode:0o700,dev:1,ino:2,size:3,isDirectory:()=>true,isFile:()=>true,isSymbolicLink:()=>false};
 t.mock.method(fs,'lstat',async p=>({...stat,...(reason==='directory-permissions'&&p==='/synthetic'?{mode:0o777}:{}),...(reason==='log-file-metadata'&&p===file?{isFile:()=>false}:{})}));
 t.mock.method(fs,'readdir',async()=>reason==='open-log-count'?[]:['1']);t.mock.method(fs,'readlink',async()=>file);
 t.mock.method(fs,'stat',async()=>({...stat,ino:reason==='inode-mismatch'?3:2}));
 t.mock.method(fs,'open',async()=>({stat:async()=>stat,read:async()=>({bytesRead:0}),close:async()=>{}}));
 const guard=createWslReadGuard('/synthetic','/synthetic/agy',()=>({port:45678,csrfToken:'synthetic-capability-for-test'}),{process:async()=>({pid:42,startTicks:'1'}),startup:(home,p)=>readWslStartup(home,p,'/synthetic-proc')});
 await assert.rejects(guard(),e=>{
  assert.equal(e.fileRouteFailureReason,reason);assert.equal(e.code,base.code);
  assert.equal(readLastAccountFailure({...base,...debugErrorData(e)}).fileRouteFailureReason,reason);return true;
 });
});
for(const reason of FILE_ROUTE_FAILURE_REASONS)test('closed whitelist survives persistence '+reason,()=>{
 const raw={...base,fileRouteFailureReason:reason,message:'PRIVATE_TOKEN',path:'/private',log:'PRIVATE_LOG'};
 assert.deepEqual(readLastAccountFailure(raw),{...base,fileRouteFailureReason:reason});assert.equal(sanitizeDebugData(raw).fileRouteFailureReason,reason);
 assert.doesNotMatch(JSON.stringify(debugErrorData(raw)),/PRIVATE|\/private/);
});
test('unknown strings and accessors never enter diagnostics; schema1 without reason remains valid',()=>{
 assert.deepEqual(readLastAccountFailure(base),base);
 for(const value of ['PRIVATE_TOKEN','/private/log',null,{},'marker-order\nPRIVATE']){
  const raw={...base,fileRouteFailureReason:value};assert.equal(fileRouteFailureReason(raw),undefined);assert.equal(debugErrorData(raw).fileRouteFailureReason,undefined);assert.deepEqual(readLastAccountFailure(raw),base);
 }
 const raw={...base};Object.defineProperty(raw,'fileRouteFailureReason',{get(){throw Error('must not execute');}});assert.deepEqual(readLastAccountFailure(raw),base);assert.equal(debugErrorData(raw).fileRouteFailureReason,undefined);
});
