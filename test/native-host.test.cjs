const test = require('node:test');
const assert = require('node:assert/strict');
const { credentialHostId, resolveCredentialHostId } = require('../out/native-host');
const { LiveError } = require('../out/live-storage');
const context = kind => ({ extension: { extensionKind: kind }, extensionUri: {scheme:'file',authority:''}, globalStorageUri:{scheme:'file',authority:''} });
const machineA = '1'.repeat(32), machineB = '2'.repeat(32);
const identity = { platform:'linux', hostname:()=> 'same-Windows-host', homedir:()=> '/home/same-user' };
const unavailable = async () => { throw Error('synthetic machine-id unavailable'); };

test('WSL distro names isolate equal hostname and HOME even with cloned machine IDs', async () => {
  const options = { ...identity, readMachineId:async()=>machineA };
  const ubuntu = await resolveCredentialHostId(context(2),'wsl','wsl-file',{...options,env:{WSL_DISTRO_NAME:'Ubuntu'}});
  const debian = await resolveCredentialHostId(context(2),'wsl','wsl-file',{...options,env:{WSL_DISTRO_NAME:'Debian'}});
  assert.match(ubuntu,/^[a-f0-9]{64}$/);assert.notEqual(ubuntu,debian);
  assert.equal(await resolveCredentialHostId(context(2),'wsl','wsl-file',{...options,env:{WSL_DISTRO_NAME:'Ubuntu'}}),ubuntu);
  assert.ok(!ubuntu.includes('same-user'));
});

test('kernel-detected WSL without distro environment requires stable current machine identity', async () => {
  const first=await resolveCredentialHostId(context(2),'wsl','wsl-file',{...identity,env:{},readMachineId:async()=>machineA});
  const second=await resolveCredentialHostId(context(2),'wsl','wsl-file',{...identity,env:{},readMachineId:async()=>machineB});
  assert.notEqual(first,second);
  assert.equal(await resolveCredentialHostId(context(2),'wsl','wsl-file',{...identity,env:{},readMachineId:async()=>machineA.toUpperCase()+'\n'}),first);
});

test('missing or malformed WSL distro and machine identity fails closed', async () => {
  for(const readMachineId of [unavailable,async()=>'',async()=> 'uninitialized',async()=> '0'.repeat(32),async()=> 'not-a-machine-id']){
    for(const env of [{},{WSL_INTEROP:'synthetic-interoperability'},{WSL_DISTRO_NAME:'   '},{WSL_DISTRO_NAME:'bad\nname'}]){
      await assert.rejects(resolveCredentialHostId(context(2),'wsl','wsl-file',{...identity,env,readMachineId}),error=>error instanceof LiveError&&error.code==='HOST_IDENTITY_UNAVAILABLE');
    }
  }
});

test('named WSL distros remain separate when machine identity is unavailable', async () => {
  const first=await resolveCredentialHostId(context(2),'wsl','wsl-file',{...identity,env:{WSL_DISTRO_NAME:'Ubuntu'},readMachineId:unavailable});
  const second=await resolveCredentialHostId(context(2),'wsl','wsl-file',{...identity,env:{WSL_DISTRO_NAME:'Debian'},readMachineId:unavailable});
  assert.notEqual(first,second);
  assert.equal(await resolveCredentialHostId(context(2),'wsl','wsl-file',{...identity,env:{WSL_DISTRO_NAME:'Ubuntu'},readMachineId:unavailable}),first);
});

test('local UI in a WSL workspace preserves native Windows identity and never reads Linux machine files', async () => {
  let reads=0;const data={...identity,platform:'win32',env:{WSL_DISTRO_NAME:'forwarded-Ubuntu'},readMachineId:async()=>{reads++;throw Error('must not read')}};
  const local=await resolveCredentialHostId(context(1),undefined,'native-keyring',data);
  const wslWindow=await resolveCredentialHostId(context(1),'wsl','native-keyring',data);
  assert.equal(local,wslWindow);assert.equal(reads,0);
});

test('native Linux identity resolution and explicit fingerprints stay pure without WSL indicators', async () => {
  let reads=0;const data={...identity,env:{},readMachineId:async()=>{reads++;throw Error('must not read')}};
  const actual=await resolveCredentialHostId(context(1),'ssh-remote','native-keyring',data);
  assert.equal(actual,credentialHostId(context(1),undefined,'native-keyring',{platform:'linux',hostname:'same-Windows-host',home:'/home/same-user'}));assert.equal(reads,0);
});

test('WSL provenance identifies the distro even when storage mode falls back to a keyring', async () => {
  const options={...identity,readMachineId:async()=>machineA};
  const a=await resolveCredentialHostId(context(2),'wsl','native-keyring',{...options,env:{WSL_DISTRO_NAME:'Ubuntu'}});
  const b=await resolveCredentialHostId(context(2),'wsl','native-keyring',{...options,env:{WSL_DISTRO_NAME:'Debian'}});
  assert.notEqual(a,b);
  assert.notEqual(a,await resolveCredentialHostId(context(2),'wsl','wsl-file',{...options,env:{WSL_DISTRO_NAME:'Ubuntu'}}));
});
