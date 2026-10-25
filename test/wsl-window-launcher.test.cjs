const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {WslWindowLauncher,validateWslLaunchPlan}=require('../out/wsl-window-launcher');
const {WindowReopen}=require('../out/window-reopen');
const executable='/mnt/d/Programs/Microsoft VS Code/Code.exe',fingerprint='a'.repeat(64),workspace={kind:'folder',uri:'vscode-remote://wsl+fixture/home/test/a%20%26%20b'};
function launcher(){const calls=[],state={fingerprint,code:0};const io={inspect:async()=>({cwd:path.dirname(executable),cli:'resources/app/out/cli.js',fingerprint:state.fingerprint}),run:async(exe,args,cwd,env,probe)=>{calls.push({exe,args,cwd,env,probe});return{code:state.code,output:probe?'1.143.0\n'+'b'.repeat(40)+'\nx64\n':''};}};const env={VSCODE_CLIENT_COMMAND:executable,WSL_INTEROP:'/run/WSL/synthetic_interop',VSCODE_IPC_HOOK_CLI:'old-socket',SECRET_TOKEN:'not-forwarded',NODE_OPTIONS:'not-forwarded',WSLENV:'SECRET_TOKEN/w',PATH:'/usr/bin'};return{api:new WslWindowLauncher(io,env),state,calls,env};}
test('Windows external CLI uses argv, exact workspace URI, associated profile, no shell payload or inherited secrets',async()=>{
 const f=launcher(),plan=await f.api.discover(workspace);await f.api.launch(plan);const c=f.calls.at(-1);
 assert.deepEqual(c.args,['resources/app/out/cli.js','--new-window','--folder-uri',workspace.uri]);assert.equal(c.exe,executable);assert.equal(c.cwd,path.dirname(executable));
 assert.equal(c.env.WSLENV,'ELECTRON_RUN_AS_NODE/w');for(const name of ['SECRET_TOKEN','NODE_OPTIONS','VSCODE_IPC_HOOK_CLI'])assert.equal(c.env[name],undefined);assert.ok(!c.args.includes('--profile'));assert.equal(plan.profilePolicy,'workspace-association');
});
test('changed executable and nonzero version probe reject before window launch',async()=>{
 const f=launcher(),plan=await f.api.discover(workspace);f.state.fingerprint='c'.repeat(64);await assert.rejects(f.api.launch(plan),{code:'WINDOW_LAUNCH_NOT_DISPATCHED'});assert.equal(f.calls.filter(c=>!c.probe).length,0);
 f.state.fingerprint=fingerprint;f.state.code=1;await assert.rejects(f.api.launch(plan),{code:'WINDOW_LAUNCH_NOT_DISPATCHED'});
});
test('missing independent command or WSL interop never falls back to remote IPC/PATH',async()=>{
 const f=launcher();delete f.env.VSCODE_CLIENT_COMMAND;await assert.rejects(f.api.discover(workspace),{code:'WINDOW_CLIENT_COMMAND_UNAVAILABLE'});assert.equal(f.calls.length,0);
 f.env.VSCODE_CLIENT_COMMAND=executable;delete f.env.WSL_INTEROP;await assert.rejects(f.api.discover(workspace),{code:'WINDOW_INTEROP_UNAVAILABLE'});
});
test('untrusted URI/argument plans and cmd launchers refuse',async()=>{
 const f=launcher(),plan=await f.api.discover(workspace);
 for(const alter of [p=>{p.executable='/mnt/d/code.cmd';},p=>{p.argv=['evil'];},p=>{p.workspace.uri+='?token=synthetic';},p=>{p.workspace.uri='command:evil';},p=>{p.authority='wsl+other';},p=>{p.profilePolicy='guess-default';}]){const p=structuredClone(plan);alter(p);assert.throws(()=>validateWslLaunchPlan(p),{code:'WINDOW_LAUNCH_PLAN_INVALID'});}
});
async function receipts(t){const home=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'window-rejoin-fixture-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));const state={oldAlive:true,newAlive:true,time:0};const old={pid:10,startIdentity:'old'},fresh={pid:11,startIdentity:'new'};const io={exited:async b=>b.pid===10&&!state.oldAlive,alive:async b=>b.pid===11?state.newAlive:state.oldAlive,now:()=>state.time,wait:async()=>{state.time+=10;}};const store=new WindowReopen(home,io),plan=await launcher().api.discover(workspace),attempt='11111111-1111-4111-8111-111111111111';await store.prepare(attempt,plan,old);return{home,store,state,old,fresh,io,attempt};}
test('live initiating host prevents any launch; mismatched rejoin cannot claim',async t=>{
 const f=await receipts(t);let calls=0;await assert.rejects(f.store.reopen(f.attempt,{launch:async()=>{calls++;}},20),{code:'WINDOW_OLD_HOST_ALIVE'});assert.equal(calls,0);assert.equal(await f.store.claim(workspace.uri,'wsl',f.fresh),false);
});
test('fresh matching host registers after exit; lost launch ACK never causes another spawn',async t=>{
 const f=await receipts(t);f.state.oldAlive=false;let calls=0;
 const adapter={launch:async()=>{calls++;assert.equal(await f.store.claim('vscode-remote://wsl+other/path','wsl',f.fresh),false);assert.equal(await f.store.claim(workspace.uri,'wsl',f.fresh),true);throw Error('ACK lost after open');}};
 assert.deepEqual(await f.store.reopen(f.attempt,adapter,20),f.fresh);assert.deepEqual(await new WindowReopen(f.home,f.io).reopen(f.attempt,adapter,20),f.fresh);assert.equal(calls,1);
 await f.store.clearVerified(f.attempt);
});
test('spawn success without registration times out and preserves launch intent across retry',async t=>{
 const f=await receipts(t);f.state.oldAlive=false;let calls=0;const adapter={launch:async()=>{calls++;}};
 await assert.rejects(f.store.reopen(f.attempt,adapter,20),{code:'WINDOW_REOPEN_REGISTRATION_TIMEOUT'});
 await assert.rejects(new WindowReopen(f.home,f.io).reopen(f.attempt,adapter,20),{code:'WINDOW_REOPEN_REGISTRATION_TIMEOUT'});assert.equal(calls,1);
 await assert.rejects(f.store.clearVerified(f.attempt),{code:'WINDOW_REOPEN_PENDING'});
});
test('same birth and wrong remote cannot impersonate a replacement',async t=>{
 const f=await receipts(t);f.state.oldAlive=false;const adapter={launch:async()=>{assert.equal(await f.store.claim(workspace.uri,'wsl',f.old),false);assert.equal(await f.store.claim(workspace.uri,'ssh-remote',f.fresh),false);}};
 await assert.rejects(f.store.reopen(f.attempt,adapter,20),{code:'WINDOW_REOPEN_REGISTRATION_TIMEOUT'});
});
test('known not-dispatched failure is retryable, unlike unknown launch acknowledgment',async t=>{
 const {WindowLaunchNotDispatched}=require('../out/wsl-window-launcher');const f=await receipts(t);f.state.oldAlive=false;
 await assert.rejects(f.store.reopen(f.attempt,{launch:async()=>{throw new WindowLaunchNotDispatched('WINDOW_LAUNCH_NOT_DISPATCHED');}},20),{code:'WINDOW_LAUNCH_NOT_DISPATCHED'});
 let calls=0;const adapter={launch:async()=>{calls++;await f.store.claim(workspace.uri,'wsl',f.fresh);}};
 assert.deepEqual(await f.store.reopen(f.attempt,adapter,20),f.fresh);assert.equal(calls,1);
});
test('verified original can release an undispatched request, never a pending native close',async t=>{
 const f=await receipts(t);await f.store.clearVerified(f.attempt);assert.equal(await f.store.hasAttempt(f.attempt),false);
 await f.store.prepare(f.attempt,await launcher().api.discover(workspace),f.old);await f.store.markCloseRequested(f.attempt);
 await assert.rejects(f.store.clearVerified(f.attempt),{code:'WINDOW_REOPEN_PENDING'});assert.equal(await f.store.hasAttempt(f.attempt),true);
});
test('early manual reopen after old birth exits registers without opening a duplicate',async t=>{
 const f=await receipts(t);f.state.oldAlive=false;assert.equal(await f.store.claim(workspace.uri,'wsl',f.fresh),true);
 let calls=0;assert.deepEqual(await f.store.reopen(f.attempt,{launch:async()=>{calls++;}},20),f.fresh);assert.equal(calls,0);
});
test('registered window can hand off to backup recovery without authenticating failed target',async t=>{
 const f=await receipts(t);f.state.oldAlive=false;await f.store.claim(workspace.uri,'wsl',f.fresh);
 await assert.rejects(f.store.releaseForRecovery(f.attempt,{pid:12,startIdentity:'unrelated'}),{code:'WINDOW_REOPEN_PENDING'});
 await f.store.releaseForRecovery(f.attempt,f.fresh);assert.equal(await f.store.hasAttempt(f.attempt),false);
 const next='22222222-2222-4222-8222-222222222222';await f.store.prepare(next,await launcher().api.discover(workspace),f.fresh);assert.equal(await f.store.hasAttempt(next),true);
});
test('registered host crash allows exact-workspace successor to recover failed login; live host cannot be displaced',async t=>{
 const f=await receipts(t);f.state.oldAlive=false;await f.store.claim(workspace.uri,'wsl',f.fresh);
 const successor={pid:12,startIdentity:'successor'};f.io.alive=async h=>h.pid===12||h.pid===11&&f.state.newAlive;
 f.io.exited=async h=>h.pid===10||h.pid===11&&!f.state.newAlive;
 assert.equal(await f.store.claim(workspace.uri,'wsl',successor),false);
 f.state.newAlive=false;assert.equal(await f.store.claim(workspace.uri,'wsl',successor),true);
 await f.store.releaseForRecovery(f.attempt,successor);assert.equal(await f.store.hasAttempt(f.attempt),false);
});
