const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {nativeWslLauncherIO,parseOfficialCliOperand}=require('../out/wsl-window-launcher.js');
// The inspector runs in Linux WSL. Preserve actual filesystem metadata while
// translating only this fixture's POSIX mounted path into its native temp root.
async function inspect(root) {
 const vm=require('node:vm'),{createRequire}=require('node:module'),file=require.resolve('../out/wsl-window-launcher.js'),localRequire=createRequire(file),module={exports:{}};
 const mount='/synthetic-mounted-layout';
 const translate=value=>{assert.ok(value===mount||value.startsWith(mount+'/'));return path.join(root,...value.slice(mount.length).split('/').filter(Boolean));};
 const io={lstat:value=>fs.lstat(translate(value)),readFile:value=>fs.readFile(translate(value))};
 vm.runInThisContext(`(function(require,module,exports){${require('node:fs').readFileSync(file,'utf8')}\n})`,{filename:file})(id=>id==='node:path'?path.posix:id==='node:fs/promises'?io:localRequire(id),module,module.exports);
 return module.exports.nativeWslLauncherIO.inspect(mount+'/Code.exe');
}
const commit='e646868227c3e3a9e3f24277c8c7220be42c0be7';
async function layout(prefix){const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'launcher-layout-'));await fs.mkdir(path.join(root,'bin'));await fs.mkdir(path.join(root,prefix,'resources/app/out'),{recursive:true});await fs.writeFile(path.join(root,'Code.exe'),'MZsynthetic');await fs.writeFile(path.join(root,'bin/code.cmd'),'"%~dp0..\\Code.exe" "%~dp0..\\'+(prefix?prefix+'\\':'')+'resources\\app\\out\\cli.js" %*');await fs.writeFile(path.join(root,prefix,'resources/app/out/cli.js'),'// synthetic');await fs.writeFile(path.join(root,prefix,'resources/app/product.json'),JSON.stringify({applicationName:'code',commit}));return root;}
for(const prefix of ['',commit.slice(0,10)])test('inspect literal official layout '+(prefix||'legacy'),async()=>{const root=await layout(prefix);try{const p=await inspect(root);assert.equal(p.cli,(prefix?prefix+'/':'')+'resources/app/out/cli.js');assert.match(p.fingerprint,/^[a-f0-9]{64}$/);}finally{await fs.rm(root,{recursive:true,force:true});}});
test('reject ambiguous or variable layouts',()=>{for(const s of ['%~dp0..\\%VERSION%\\resources\\app\\out\\cli.js','%~dp0..\\..\\resources\\app\\out\\cli.js','"%~dp0..\\resources\\app\\out\\cli.js" " %~dp0..\\e646868227\\resources\\app\\out\\cli.js"'])assert.throws(()=>parseOfficialCliOperand(s));});
test('reject commit mismatch and directory symlink',async()=>{const root=await layout('aaaaaaaaaa');try{await assert.rejects(inspect(root));await fs.rename(path.join(root,'aaaaaaaaaa'),path.join(root,'real'));await fs.symlink(path.join(root,'real'),path.join(root,'aaaaaaaaaa'),process.platform==='win32'?'junction':'dir');await assert.rejects(inspect(root));}finally{await fs.rm(root,{recursive:true,force:true});}});
test('batch changes invalidate fingerprint',async()=>{const root=await layout('');try{const p=await inspect(root);await fs.appendFile(path.join(root,'bin/code.cmd'),'\r\nrem changed');assert.notEqual((await inspect(root)).fingerprint,p.fingerprint);}finally{await fs.rm(root,{recursive:true,force:true});}});

test('comments and operand suffix are not executable CLI operands',()=>{for(const s of ['rem "%~dp0..\\Code.exe" "%~dp0..\\resources\\app\\out\\cli.js" %*','"%~dp0..\\Code.exe" "%~dp0..\\resources\\app\\out\\cli.js.old" %*','echo "%~dp0..\\resources\\app\\out\\cli.js"'])assert.throws(()=>parseOfficialCliOperand(s));});

test('WSL inspector rejects native Windows drive paths instead of pretending they are mounted paths',async()=>{await assert.rejects(nativeWslLauncherIO.inspect('C:\\Synthetic\\Code.exe'),{code:'WINDOW_LAUNCHER_UNSUPPORTED'});});
