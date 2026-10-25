const test=require('node:test'),assert=require('node:assert/strict'),{PassThrough}=require('node:stream');
const {readOfflinePassword,offlineCli}=require('../out/offline-cli');
function terminal(){const input=new PassThrough(),output=new PassThrough(),modes=[];input.isTTY=true;output.isTTY=true;input.setRawMode=value=>modes.push(value);let visible='';output.on('data',x=>{visible+=x.toString();});return{input,output,modes,visible:()=>visible};}
test('terminal accepts Unicode and spaces without echoing password, and restores normal mode',async()=>{
 const t=terminal(),pending=readOfflinePassword(t.input,t.output);t.input.write('测试 Unicode 密码 123\r');
 assert.equal(await pending,'测试 Unicode 密码 123');assert.deepEqual(t.modes,[true,false]);assert.doesNotMatch(t.visible(),/Unicode|123/);
});
test('Ctrl+C and Ctrl+D cancel password input, remove key listener and restore terminal mode',async()=>{
 for(const key of ['\x03','\x04']){const t=terminal(),pending=readOfflinePassword(t.input,t.output);t.input.write('synthetic-secret'+key);await assert.rejects(pending,{code:'CANCELLED'});assert.deepEqual(t.modes,[true,false]);assert.equal(t.input.listenerCount('keypress'),0);assert.doesNotMatch(t.visible(),/synthetic-secret/);}
});
test('redirected input and malformed CLI arguments are rejected before storage access',async()=>{
 const t=terminal();t.input.isTTY=false;await assert.rejects(readOfflinePassword(t.input,t.output),{code:'OFFLINE_EXTERNAL_TERMINAL_REQUIRED'});
 await assert.rejects(offlineCli(['../../other']),{code:'OFFLINE_ARGUMENT_INVALID'});assert.deepEqual(t.modes,[]);
});
