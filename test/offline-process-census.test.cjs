const test=require('node:test'),assert=require('node:assert/strict');
const {inspectOfflineLinuxProcesses}=require('../out/offline-process-census');
const boot='11111111-1111-4111-8111-111111111111';
function fixture(rows){return {
 uid:1000,home:'/synthetic/home',knownHosts:[],scope:'file-only',
 io:{pids:async()=>Object.keys(rows).map(Number),boot:async()=>boot,canonicalHome:async home=>home,credentialScope:async home=>({directory:home,file:home+'/token'}),
  read:async pid=>{const row=rows[pid];if(!row)throw Object.assign(Error(),{code:'ENOENT'});if(row.error)throw Error('unreadable');return {uid:1000,startTicks:'77',parentPid:1,args:['node'],environment:{HOME:'/synthetic/home'},comm:'node',...row};}},
};}
test('hubless VS Code server extension host is included',async()=>{
 const r=await inspectOfflineLinuxProcesses(fixture({42:{args:['node','bootstrap-fork','--type=extensionHost']}}));
 assert.equal(r.hosts.length,1);assert.equal(r.hubs.length,0);assert.equal(r.complete,true);
});
test('Electron utility extension host identified by entrypoint',async()=>{
 const r=await inspectOfflineLinuxProcesses(fixture({42:{environment:{HOME:'/synthetic/home',VSCODE_ESM_ENTRYPOINT:'vs/workbench/api/node/extensionHostProcess'}}}));assert.equal(r.hosts.length,1);
});
test('known original host still blocks even without a recognizable launch marker',async()=>{
 const f=fixture({42:{}});f.knownHosts=[{pid:42,startIdentity:`linux:${boot}:77`}];assert.equal((await inspectOfflineLinuxProcesses(f)).hosts.length,1);
});
test('PID reused for an unrelated process is not treated as the original host',async()=>{
 const f=fixture({42:{startTicks:'88'}});f.knownHosts=[{pid:42,startIdentity:`linux:${boot}:77`}];assert.equal((await inspectOfflineLinuxProcesses(f)).hosts.length,0);
});
test('new host birth and orphan Hub remain blockers',async()=>{
 const r=await inspectOfflineLinuxProcesses(fixture({42:{args:['node','--type=extensionHost'],startTicks:'88'},43:{comm:'agy',args:['agy','--hub']}}));assert.equal(r.hosts.length,1);assert.equal(r.hubs.length,1);
});
test('missing HOME or unreadable same-user evidence is uncertain',async()=>{
 const a=await inspectOfflineLinuxProcesses(fixture({42:{args:['node','--type=extensionHost'],environment:{}}}));assert.equal(a.unknown,true);
 const b=await inspectOfflineLinuxProcesses(fixture({42:{error:true}}));assert.equal(b.complete,false);
});
test('known identity not in enumeration is probed directly',async()=>{
 const f=fixture({42:{}});f.knownHosts=[{pid:42,startIdentity:`linux:${boot}:77`}];f.io.pids=async()=>[];
 assert.equal((await inspectOfflineLinuxProcesses(f)).hosts.length,1);
});
test('other OS users and positively different HOME are outside this credential scope',async()=>{
 const r=await inspectOfflineLinuxProcesses(fixture({42:{uid:1001,args:['node','--type=extensionHost']},43:{args:['node','--type=extensionHost'],environment:{HOME:'/other/home'}}}));assert.equal(r.hosts.length,0);assert.equal(r.unknown,false);
});
test('native keyring scope includes a same-user host with different HOME',async()=>{
 const f=fixture({42:{args:['node','--type=extensionHost'],environment:{HOME:'/other/home'}}});f.scope='native-keyring';assert.equal((await inspectOfflineLinuxProcesses(f)).hosts.length,1);
});
test('HOME aliases resolve to the same scope and overrides block exclusion',async()=>{
 const f=fixture({42:{args:['node','--type=extensionHost'],environment:{HOME:'/alias/home'}}});f.io.canonicalHome=async()=>'/synthetic/home';assert.equal((await inspectOfflineLinuxProcesses(f)).hosts.length,1);
 const r=await inspectOfflineLinuxProcesses(fixture({42:{args:['node','--type=extensionHost'],environment:{HOME:'/other/home',XDG_CONFIG_HOME:'present'}}}));assert.equal(r.unknown,false);assert.equal(r.hosts.length,1);
});
test('missing HOME path is uncertainty, not proof that the live host exited',async()=>{
 const f=fixture({42:{args:['node','--type=extensionHost'],environment:{HOME:'/deleted'}}});
 f.io.canonicalHome=async p=>{if(p==='/deleted')throw Object.assign(Error(),{code:'ENOENT'});return p;};
 const r=await inspectOfflineLinuxProcesses(f);assert.equal(r.complete,false);assert.equal(r.unknown,true);
});
for(const shared of ['directory','file'])test('different HOME with shared credential '+shared+' remains a blocker',async()=>{
 const f=fixture({42:{args:['node','--type=extensionHost'],environment:{HOME:'/other/home'}}});
 f.io.credentialScope=async home=>({directory:shared==='directory'?'same-directory':home,file:shared==='file'?'same-file':null});
 assert.equal((await inspectOfflineLinuxProcesses(f)).hosts.length,1);
});
test('missing token identities cannot exclude a peer with a potential dangling alias',async()=>{
 const f=fixture({42:{args:['node','--type=extensionHost'],environment:{HOME:'/other/home'}}});
 f.io.credentialScope=async home=>({directory:home,file:null});
 const r=await inspectOfflineLinuxProcesses(f);assert.equal(r.hosts.length,1);assert.equal(r.unknown,true);
});
function nativeFixture(overrides={}){
 const calls=[];let exeReads=0,statReads=0;
 const info={uid:0,mode:0o100755,dev:1,ino:9,size:100,ctimeMs:1,isFile:()=>true,isDirectory:()=>true,isSymbolicLink:()=>false};
 const statText=()=>{const fields=Array(25).fill('0');fields[1]='1';fields[19]=overrides.reused&&++statReads>1?'88':'77';return '42 ('+(overrides.comm??'systemd')+') '+fields.join(' ');};
 const files={stat:async p=>p==='/proc/42'?{...info,uid:1000}:({...info,uid:overrides.writable?1000:0}),lstat:async()=>({...info,uid:overrides.writable?1000:0}),realpath:async p=>p==='/lib/systemd/systemd'?'/usr/lib/systemd/systemd':p,
 readlink:async()=>{calls.push('exe');exeReads++;if(overrides.exeDenied)throw Object.assign(Error(),{code:'EACCES'});return overrides.exeChanged&&exeReads>1?'/tmp/imposter':overrides.exe??'/usr/lib/systemd/systemd';},
 readFile:async p=>p.endsWith('/stat')?statText():(overrides.comm??'systemd')+'\n',
 open:async p=>{calls.push(p.split('/').at(-1));if(p.endsWith('/environ'))throw Object.assign(Error(),{code:overrides.gone?'ENOENT':'EACCES'});const bytes=Buffer.from((overrides.args??['/usr/lib/systemd/systemd','--user']).join('\0')+'\0');return{read:async(buf,offset,length,pos)=>{const n=Math.min(length,Math.max(0,bytes.length-pos));bytes.copy(buf,offset,pos,pos+n);return{bytesRead:n}},close:async()=>{}};}};
 return{files,calls};
}
for(const comm of ['systemd','(sd-pam)'])test('trusted root systemd image excludes '+comm+' before forbidden environ read',async()=>{
 const f=nativeFixture({comm});const {readOfflineLinuxProcess}=require('../out/offline-process-census');const row=await readOfflineLinuxProcess(42,1000,false,f.files);assert.equal(row.unrelated,true);assert.ok(!f.calls.includes('environ'));
});
for(const overrides of [{exe:'/tmp/systemd'},{exeDenied:true},{writable:true},{comm:'node',args:['node','--type=extensionHost']},{comm:'agy'},{args:['/usr/lib/systemd/systemd','--type=extensionHost']}])test('unproven or relevant process cannot bypass unreadable environment '+JSON.stringify(overrides),async()=>{const f=nativeFixture(overrides);await assert.rejects(require('../out/offline-process-census').readOfflineLinuxProcess(42,1000,false,f.files));assert.ok(f.calls.includes('environ'));});
for(const overrides of [{reused:true},{exeChanged:true}])test('trusted system image proof detects process identity change '+JSON.stringify(overrides),async()=>{const f=nativeFixture(overrides);await assert.rejects(require('../out/offline-process-census').readOfflineLinuxProcess(42,1000,false,f.files));});
test('known host cannot be excluded by a systemd-looking image',async()=>{const f=nativeFixture();await assert.rejects(require('../out/offline-process-census').readOfflineLinuxProcess(42,1000,true,f.files));assert.ok(f.calls.includes('environ'));});

test('field-shaped 13 hosts and 3 hubs remain counted while two proven system images avoid EACCES',async()=>{const rows={};for(let i=1;i<=13;i++)rows[i]={args:['node','--type=extensionHost']};for(let i=20;i<=22;i++)rows[i]={comm:'agy'};const f=fixture(rows),baseRead=f.io.read,readNative=require('../out/offline-process-census').readOfflineLinuxProcess;f.io.pids=async()=>[...Object.keys(rows).map(Number),65640,65642];const calls=[];f.io.read=async pid=>{if(pid<100)return baseRead(pid);const n=nativeFixture({comm:pid===65640?'systemd':'(sd-pam)'});const row=await readNative(42,1000,false,n.files);calls.push(...n.calls);return row;};const result=await inspectOfflineLinuxProcesses(f);assert.equal(result.complete,true);assert.equal(result.unknown,false);assert.equal(result.hosts.length,13);assert.equal(result.hubs.length,3);assert.ok(!calls.includes('environ'));});
test('true host or Hub environment denial keeps the whole census incomplete',async()=>{for(const comm of ['node','agy']){const f=fixture({42:{}}),n=nativeFixture({comm,args:comm==='node'?['node','--type=extensionHost']:['agy']});f.io.read=pid=>require('../out/offline-process-census').readOfflineLinuxProcess(pid,1000,false,n.files);const result=await inspectOfflineLinuxProcesses(f);assert.equal(result.complete,false);assert.equal(result.unknown,true);}});
test('process exiting during metadata acquisition is absent, not an unreadable live process',async()=>{const f=fixture({42:{}}),n=nativeFixture({comm:'node',gone:true});f.io.read=pid=>require('../out/offline-process-census').readOfflineLinuxProcess(pid,1000,false,n.files);const result=await inspectOfflineLinuxProcesses(f);assert.equal(result.complete,true);assert.equal(result.unknown,false);});
test('root image with writable ancestor or mismatched kernel inode cannot be excluded',async()=>{for(const fault of ['ancestor','inode']){const f=nativeFixture(),old=f.files.lstat;f.files.lstat=async p=>({...await old(p),...(fault==='ancestor'&&p==='/usr/lib/systemd'?{mode:0o40777}:{}),...(fault==='inode'&&p.endsWith('/systemd')?{ino:123}:{})});await assert.rejects(require('../out/offline-process-census').readOfflineLinuxProcess(42,1000,false,f.files));assert.ok(f.calls.includes('environ'));}});
function roleFixture(fault){
 const n=nativeFixture({exeDenied:true});const oldRead=n.files.readFile,oldStat=n.files.stat;
 const rows={1:{uid:0,comm:'systemd',args:['/sbin/init'],ppid:0,group:'/'},42:{uid:1000,comm:'systemd',args:['/usr/lib/systemd/systemd','--user'],ppid:1,group:'/user.slice/user-1000.slice/user@1000.service/init.scope'},43:{uid:1000,comm:'(sd-pam)',args:['(sd-pam)'],ppid:42,group:'/user.slice/user-1000.slice/user@1000.service/init.scope'}};
 if(fault==='host')rows[42].args=['node','--type=extensionHost'];
 if(fault==='name-only')rows[42].args=['node'];
 if(fault==='group')rows[42].group='/user.slice/user-1001.slice/user@1001.service/init.scope';
 if(fault==='parent')rows[42].ppid=99;
 if(fault==='pam-args')rows[43].args=['node'];
 if(fault==='pam-group')rows[43].group='/other';
 if(fault==='uid')rows[42].uid=1001;
 let parentReads=0;
 n.files.stat=async p=>{const row=rows[Number(p.split('/')[2])];return /^\/proc\/\d+$/.test(p)&&row?{...await oldStat(p),uid:row.uid}:oldStat(p);};
 n.files.readFile=async p=>{const id=Number(p.split('/')[2]),r=rows[id];if(!r)throw Object.assign(Error(),{code:'ENOENT'});
 if(id===42&&p.endsWith('/stat')){parentReads++;if(fault==='parent-gone')throw Object.assign(Error(),{code:'ENOENT'});}
 if(p.endsWith('/stat')){const a=Array(25).fill('0');a[1]=String(r.ppid);a[19]=fault==='parent-reused'&&id===42&&parentReads>1?'88':'77';return `${id} (${r.comm}) ${a.join(' ')}`;}
 if(p.endsWith('/comm'))return r.comm+'\n';if(p.endsWith('/cmdline'))return r.args.join('\0')+'\0';if(p.endsWith('/cgroup'))return '0::'+r.group+'\n';return oldRead(p);};
 n.files.open=async p=>{n.calls.push(p.split('/').at(-1));if(p.endsWith('/environ'))throw Object.assign(Error(),{code:'EACCES'});const bytes=Buffer.from(await n.files.readFile(p));return{read:async(b,o,l,pos)=>{const count=Math.min(l,Math.max(0,bytes.length-pos));bytes.copy(b,o,pos,pos+count);return{bytesRead:count}},close:async()=>{}};};
 if(fault==='writable'){const old=n.files.lstat;n.files.lstat=async p=>({...await old(p),...(p==='/usr/lib'?{mode:0o40777}:{})});}
 if(fault==='install-gone')n.files.realpath=async()=>{throw Object.assign(Error(),{code:'ENOENT'});};
 return n;
}
for(const pid of [42,43])test('cross-checked service role excludes system process despite both exe and environ EACCES '+pid,async()=>{const f=roleFixture();const r=await require('../out/offline-process-census').readOfflineLinuxProcess(pid,1000,false,f.files);assert.equal(r.unrelated,true);assert.ok(!f.calls.includes('environ'));});
for(const fault of ['host','name-only','group','parent','pam-args','pam-group','uid','parent-gone','parent-reused','writable','install-gone'])test('service role ambiguity stays blocked: '+fault,async()=>{const f=roleFixture(fault);await assert.rejects(require('../out/offline-process-census').readOfflineLinuxProcess(43,1000,false,f.files),error=>error.code!=='ENOENT');});
test('known host role cannot skip environment',async()=>{const f=roleFixture();await assert.rejects(require('../out/offline-process-census').readOfflineLinuxProcess(42,1000,true,f.files));assert.ok(f.calls.includes('environ'));});
test('field-shaped census includes 13 hosts/3 hubs without ptrace access to system services',async()=>{const rows={};for(let i=100;i<113;i++)rows[i]={args:['node','--type=extensionHost']};for(let i=120;i<123;i++)rows[i]={comm:'agy'};const f=fixture(rows),old=f.io.read;f.io.pids=async()=>[...Object.keys(rows).map(Number),42,43];f.io.read=pid=>pid<100?require('../out/offline-process-census').readOfflineLinuxProcess(pid,1000,false,roleFixture().files):old(pid);const r=await inspectOfflineLinuxProcesses(f);assert.equal(r.complete,true);assert.equal(r.unknown,false);assert.equal(r.hosts.length,13);assert.equal(r.hubs.length,3);});
