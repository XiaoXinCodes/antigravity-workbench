const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { LiveError, OfficialTokenSlots, SystemKeyring, validateSlots, validateStoredToken, runPrivate, WINDOWS_KEYRING_SCRIPT } = require('../out/live-storage');
const { LiveSwitchService, JOURNAL_KEY, ACCOUNT_PREFIX, parseJournal } = require('../out/live-switch');
const { parseHubProof, queryHub, generation, hubRpc } = require('../out/live-hub');
const fixture = name => JSON.stringify({ token: { access_token: 'synthetic-access-' + name, refresh_token: 'synthetic-refresh-' + name, token_type: 'Bearer' }, auth_method: 'oauth' });
const A = { keyring: fixture('A'), file: null }, B = { keyring: fixture('B'), file: fixture('B') };
function setup(initial = A, hostId, data = new Map()) {
  const vault = { get: async k => data.get(k), store: async (k,v) => { data.set(k,v); }, delete: async k => { data.delete(k); } };
  let current = structuredClone(initial); let writes = 0, reads = 0;
  const slots = { read: async () => { reads++; return structuredClone(current); }, write: async (next,expected) => { assert.deepEqual(current, expected); current = structuredClone(next); writes++; } };
  const service = new LiveSwitchService(vault, slots, hostId);
  const phases = []; let proof;
  const backend = { generation:'old', stop:async () => { phases.push('stop'); }, reload:async () => { phases.push('reload');backend.generation='new-'+phases.filter(p=>p==='reload').length; }, proof:async () => proof||({email:(current.keyring||current.file)===fixture('A')?'a@example.test':'b@example.test',generation:backend.generation,authValid:true,quotaSource:'server',observedAt:new Date().toISOString(),buckets:[]}),signedOutProof:async()=>({generation:backend.generation,authValid:false}) };
  const journalKey = hostId === undefined ? JOURNAL_KEY : `${JOURNAL_KEY}.host.${require('node:crypto').createHash('sha256').update(hostId).digest('hex')}`;
  return { service, vault, data, slots, backend, phases, journalKey, set: x => { current=structuredClone(x); }, current:() => current, writes:() => writes, reads:() => reads, proof:x => { proof=x; } };
}
async function saveB(x) { x.set(B); const a=await x.service.capture({label:'B',expectedEmail:'b@example.test',identitySource:'user'}); x.set(A); return a; }
test('verified capture is idempotent across concurrent calls and keeps the saved fingerprint',async()=>{
 const x=setup(A,'host'),rows=[]; const index={read:()=>rows,write:async next=>{rows.splice(0,rows.length,...next)}};
 const metadata={label:'A',expectedEmail:'a@example.test',identitySource:'hub'};
 let guards=0; const verify=async()=>{guards++};
 const [first,second]=await Promise.all([x.service.captureCurrent(metadata,index,verify),x.service.captureCurrent(metadata,index,verify)]);
 assert.equal(first.saved,false);assert.equal(second.saved,true);assert.equal(rows.length,1);assert.deepEqual(first.account,second.account);assert.equal(x.reads(),2);assert.equal(x.writes(),0);assert.ok(guards>=5);
 const raw=x.data.get(ACCOUNT_PREFIX+first.account.id);await x.service.captureCurrent(metadata,index,verify);assert.equal(x.data.get(ACCOUNT_PREFIX+first.account.id),raw);
});
test('passive saved check requires matching host, identity and complete credential record without official reads',async()=>{
 const x=setup(A,'host');const a=await x.service.capture({label:'A',expectedEmail:'a@example.test',identitySource:'hub'});const reads=x.reads();
 assert.equal(await x.service.savedLoginUsable(a),true);assert.equal(await x.service.savedLoginUsable({...a,hostId:'other'}),false);
 assert.equal(await x.service.savedLoginUsable({...a,expectedEmail:'b@example.test'}),false);assert.equal(await x.service.savedLoginUsable({...a,migrationState:'pending'}),false);
 x.data.delete(ACCOUNT_PREFIX+a.id);assert.equal(await x.service.savedLoginUsable(a),false);assert.equal(x.reads(),reads);
});
test('missing or malformed credentials update the same ID; changed identity restores the old copy and index',async()=>{
 const x=setup(A,'host');const a=await x.service.capture({label:'A',expectedEmail:'a@example.test',identitySource:'hub'});let rows=[a];const index={read:()=>rows,write:async next=>{rows=next}};
 const metadata={label:'A',expectedEmail:'a@example.test',identitySource:'hub'};
 x.data.delete(ACCOUNT_PREFIX+a.id);const updated=await x.service.captureCurrent(metadata,index,async()=>{});assert.equal(updated.account.id,a.id);assert.equal(rows.length,1);
 const invalid=JSON.stringify({...rows[0],slots:{file:'bad',keyring:null}});x.data.set(ACCOUNT_PREFIX+a.id,invalid);
 let proofs=0;await assert.rejects(x.service.captureCurrent(metadata,index,async()=>{if(++proofs===3)throw new LiveError('CAPTURE_HUB_CHANGED')}),/CAPTURE_HUB_CHANGED/);
 assert.equal(x.data.get(ACCOUNT_PREFIX+a.id),invalid);assert.equal(rows[0].id,a.id);assert.equal(await x.service.savedLoginUsable(rows[0]),false);
 const repaired=await x.service.captureCurrent(metadata,index,async()=>{});assert.equal(repaired.account.id,a.id);assert.equal(await x.service.savedLoginUsable(rows[0]),true);
});
test('ambiguous identities and interrupted refresh records cannot create or overwrite a duplicate',async()=>{
 const x=setup(A,'host');const a=await x.service.capture({label:'Same label',expectedEmail:'a@example.test',identitySource:'hub'});let rows=[a,{...a,id:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'}];const index={read:()=>rows,write:async next=>{rows=next}};const metadata={label:'Same label',expectedEmail:'a@example.test',identitySource:'hub'};
 await assert.rejects(x.service.captureCurrent(metadata,index,async()=>{}),/CAPTURE_ACCOUNT_AMBIGUOUS/);rows=[a];x.data.set('live-switch.quota-pending.v1.'+a.id,'synthetic-pending');
 const before=x.data.get(ACCOUNT_PREFIX+a.id);await assert.rejects(x.service.captureCurrent(metadata,index,async()=>{}),/CAPTURE_CREDENTIAL_RECOVERY_REQUIRED/);assert.equal(x.data.get(ACCOUNT_PREFIX+a.id),before);
 await assert.rejects(x.service.captureCurrent(metadata,index,async()=>{},false),/CAPTURE_CREDENTIAL_CHANGED/);
});
test('A to B succeeds; failed return reconnect resumes exact installed A without another credential write',async()=>{
 const x=setup(),a=await x.service.capture({label:'A',expectedEmail:'a@example.test',identitySource:'hub'}),b=await saveB(x);
 await x.service.install(b.id,x.backend);await x.service.finishVerified(x.backend);
 const stages=[];x.backend.reload=async()=>{throw new LiveError('OFFICIAL_COMPONENT_RECONNECT_FAILED');};
 await assert.rejects(x.service.install(a.id,x.backend,undefined,s=>stages.push(s)),/OFFICIAL_COMPONENT_RECONNECT_FAILED/);
 assert.equal(stages.at(-1),'reconnect');const journal=await x.service.journal();assert.equal(journal.phase,'installed');assert.deepEqual(x.current(),A);assert.deepEqual(journal.backup,B);
 const writes=x.writes(),stops=x.phases.filter(v=>v==='stop').length;
 x.backend.restartMode='component';x.backend.generation='stopped';x.backend.reload=async()=>{x.phases.push('resume');x.backend.generation='resumed-A';};
 const guard={id:journal.id,phase:journal.phase,assertCurrent(){}};
 await x.service.resumeStoppedVerification(x.backend,guard);
 assert.equal(x.writes(),writes);assert.equal(x.phases.filter(v=>v==='stop').length,stops);assert.equal((await x.service.journal()).phase,'installed');
 assert.equal((await x.service.finishVerified(x.backend,undefined,guard)).email,'a@example.test');assert.equal(await x.service.journal(),null);
});
test('bounded installed-journal confirmation waits through repeated exact predecessor reads without rewriting credentials',async()=>{
 const x=setup(),b=await saveB(x),store=x.vault.store,get=x.vault.get;let stale,count=0,journalWrites=0;
 x.vault.store=async(key,value)=>{const prior=x.data.get(key);await store(key,value);if(key===x.journalKey){journalWrites++;if(JSON.parse(value).phase==='installed'){stale=prior;count=4;}}};
 x.vault.get=async key=>key===x.journalKey&&count-->0?stale:get(key);
 const stages=[];await x.service.install(b.id,x.backend,undefined,s=>stages.push(s));
 assert.equal(stages.at(-1),'reconnect');assert.equal(x.writes(),1);assert.equal(journalWrites,2);
 assert.equal((await x.service.journal()).phase,'installed');assert.equal((await x.service.journal()).revision,2);
 assert.equal((await x.service.finishVerified(x.backend)).email,'b@example.test');assert.equal(await x.service.journal(),null);
});
test('stopped resume refuses external changes, a replacement journal, and a running component without restart',async()=>{
 for(const mode of ['external','second-read-change','journal-change','same-id-backup-change','same-id-generation-change','running']){
  const x=setup(),b=await saveB(x);await x.service.install(b.id,x.backend);const j=await x.service.journal();
  x.backend.restartMode='component';x.backend.generation=mode==='running'?'still-running':'stopped';let restarts=0;x.backend.reload=async()=>{restarts++;};
  if(mode==='external')x.set(A);
  if(mode==='second-read-change'){const read=x.slots.read;let reads=0;x.slots.read=async()=>{if(++reads===2)x.set(A);return read();};}
  if(mode==='journal-change')x.data.set(x.journalKey,JSON.stringify({...j,id:require('node:crypto').randomUUID()}));
  if(mode.startsWith('same-id-')){const read=x.slots.read;let reads=0;x.slots.read=async()=>{if(++reads===2)x.data.set(x.journalKey,JSON.stringify({...j,...(mode==='same-id-backup-change'?{backup:{keyring:fixture('external'),file:null}}:{oldGeneration:'changed'})}));return read();};}
  const writes=x.writes();await assert.rejects(x.service.resumeStoppedVerification(x.backend,{id:j.id,phase:j.phase,assertCurrent(){}}),/EXTERNAL_CHANGE|RECOVERY_VERIFICATION_STALE|OFFICIAL_BACKEND_NOT_STOPPED/);
  assert.equal(restarts,0);assert.equal(x.writes(),writes);assert.ok(await x.service.journal());
 }
});
test('stopped restored phase resumes its exact backup and keeps it until original identity is proved',async()=>{
 const x=setup(),b=await saveB(x);await x.service.install(b.id,x.backend);await x.service.restore(x.backend,{reload:false});
 const j=await x.service.journal(),writes=x.writes();x.backend.restartMode='component';x.backend.generation='stopped';x.backend.reload=async()=>{x.backend.generation='restored-A';};
 await x.service.resumeStoppedVerification(x.backend,{id:j.id,phase:j.phase,assertCurrent(){}});
 assert.equal(x.writes(),writes);assert.ok(await x.service.journal());assert.equal((await x.service.finishVerified(x.backend)).email,'a@example.test');assert.equal(await x.service.journal(),null);
});
test('expired installed metadata acknowledgement may start exact target once but never writes or clears recovery',async()=>{
 const {verificationClock,settle}=require('./fixtures/verification-clock.cjs');
 for(const conflict of ['none','credentials','journal','lock','running','legacy']){
  const x=setup(A,'synthetic-host'),clock=verificationClock();x.service=new LiveSwitchService(x.vault,x.slots,'synthetic-host',{clock,timeoutMs:1000});
  const b=await saveB(x),originalStore=x.vault.store;let delayed;
  x.vault.store=async(key,value)=>{if(key===x.journalKey&&JSON.parse(value).phase==='installed'){delayed=value;return;}await originalStore(key,value)};
  x.backend.restartMode='component';x.backend.stop=async()=>{x.backend.generation='stopped'};
  const install=x.service.install(b.id,x.backend,'synthetic-transaction'),rejected=assert.rejects(install,/RECOVERY_SAVE_NOT_VERIFIED/);
  await settle();await clock.advance(1000);await rejected;
  const record=x.data.get(x.journalKey),writes=x.writes();let starts=0;x.backend.reload=async()=>{starts++;x.backend.generation='resumed'};
  if(conflict==='credentials')x.set(A);
  if(conflict==='journal')x.data.set(x.journalKey,JSON.stringify({...JSON.parse(record),oldGeneration:'external'}));
  if(conflict==='running')x.backend.generation='running';
  if(conflict==='legacy')x.data.set(JOURNAL_KEY,record);
  const action=()=>x.service.resumeUnconfirmedInstall(x.backend,'synthetic-transaction',async()=>{if(conflict==='lock')throw new LiveError('LOCK_OWNERSHIP_CHANGED')});
  if(conflict==='none'){
   assert.equal(await action(),true);assert.equal(await action(),false);assert.equal(starts,1);assert.equal(x.data.get(x.journalKey),record);assert.equal(JSON.parse(record).phase,'prepared');
   x.data.set(x.journalKey,delayed);assert.equal((await x.service.journal()).phase,'installed');
  }else{await assert.rejects(action(),/EXTERNAL_CHANGE|RECOVERY_CHANGED|LOCK_OWNERSHIP_CHANGED|OFFICIAL_BACKEND_NOT_STOPPED|RECOVERY_RECORD_CONFLICT/);assert.equal(starts,0);}
  assert.equal(x.writes(),writes);assert.ok(x.data.has(x.journalKey));
 }
});
test('same transaction late proof cannot overwrite a newer verification revision from another service instance',async()=>{
 const x=setup(),saved=await saveB(x);await x.service.install(saved.id,x.backend);
 let release,entered;const waiting=new Promise(resolve=>{entered=resolve}),proof=x.backend.proof;
 x.backend.proof=()=>{entered();return new Promise(resolve=>{release=resolve})};
 const first=x.service.verify(x.backend),failed=assert.rejects(first,/RECOVERY_CHANGED/);await waiting;
 const other=new LiveSwitchService(x.vault,x.slots);x.backend.proof=proof;await other.verify(x.backend);
 const raw=x.data.get(x.journalKey);release(await proof());await failed;
 assert.equal(x.data.get(x.journalKey),raw);assert.equal(JSON.parse(raw).verification.attempts,2);assert.equal(JSON.parse(raw).verification.state,'verified');
});
test('journal revision metadata is paired, integral and uniquely identifies a write; legacy records still parse',()=>{
 const base={schema:1,id:'synthetic',phase:'prepared',backup:A,target:{id:'synthetic'},oldGeneration:'old'};
 assert.equal(parseJournal(JSON.stringify(base)).revision,undefined);
 for(const revision of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>parseJournal(JSON.stringify({...base,revision,writeId:require('node:crypto').randomUUID()})),/RECOVERY_RECORD_INVALID/);
 assert.throws(()=>parseJournal(JSON.stringify({...base,revision:1})),/RECOVERY_RECORD_INVALID/);
 assert.throws(()=>parseJournal(JSON.stringify({...base,writeId:require('node:crypto').randomUUID()})),/RECOVERY_RECORD_INVALID/);
});
test('automatic rollback refuses externally changed credentials before stopping the backend', async()=>{
 const x=setup(), b=await saveB(x); await x.service.install(b.id,x.backend);
 x.set({keyring:fixture('external'),file:null}); const writes=x.writes(),stops=x.phases.filter(p=>p==='stop').length;
 await assert.rejects(x.service.restore(x.backend,{guardInstalled:true}),/EXTERNAL_CHANGE/);
 assert.equal(x.writes(),writes);assert.equal(x.phases.filter(p=>p==='stop').length,stops);assert.ok(await x.service.journal());
});
test('automatic rollback compares again after stop and retains recovery on drift', async()=>{
 const x=setup(), b=await saveB(x);await x.service.install(b.id,x.backend);const writes=x.writes();
 x.backend.stop=async()=>{x.set({keyring:fixture('external'),file:null});};
 await assert.rejects(x.service.restore(x.backend,{guardInstalled:true}),/EXTERNAL_CHANGE/);
 assert.equal(x.writes(),writes);assert.equal((await x.service.journal()).phase,'prepared');
});
test('late identity proof cannot overwrite or delete a replacement transaction journal',async()=>{
 const x=setup(),saved=await saveB(x);await x.service.install(saved.id,x.backend);const old=await x.service.journal();
 let finish;const ready=new Promise(resolve=>{x.backend.proof=()=>{resolve();return new Promise(done=>{finish=done;});};});
 const verifying=x.service.finishVerified(x.backend);const rejected=assert.rejects(verifying,/RECOVERY_CHANGED/);await ready;
 const replacement={...old,id:require('node:crypto').randomUUID(),verification:{state:'pending',attempts:0}};
 const raw=JSON.stringify(replacement);x.data.set(x.journalKey,raw);const account=x.data.get(ACCOUNT_PREFIX+saved.id);
 finish({email:'b@example.test',generation:x.backend.generation,authValid:true,quotaSource:'server',observedAt:new Date().toISOString(),buckets:[]});await rejected;
 assert.equal(x.data.get(x.journalKey),raw);assert.equal(x.data.get(ACCOUNT_PREFIX+saved.id),account);assert.deepEqual(x.current(),B);
});
test('expired identity read retains encrypted recovery and a late success cannot finalize it',async()=>{
 const {RecoveryVerification}=require('../out/recovery-verification'),{verificationClock,settle}=require('./fixtures/verification-clock.cjs');
 const x=setup(),saved=await saveB(x);await x.service.install(saved.id,x.backend);const journal=await x.service.journal();
 const clock=verificationClock(),windows=new RecoveryVerification(clock),lease=windows.bind(journal.id,'installed');let finish;
 const guarded={...x.backend,proof:()=>windows.proof(lease,()=>new Promise(resolve=>{finish=resolve;}))};
 const pending=x.service.finishVerified(guarded,undefined,{id:journal.id,phase:'installed',assertCurrent:()=>windows.assertScope(lease)});
 const rejected=assert.rejects(pending,/RECOVERY_VERIFICATION_TIMEOUT/);await settle();await clock.advance(90_000);await rejected;
 const retained=x.data.get(x.journalKey);assert.equal((await x.service.journal()).verification.code,'RECOVERY_VERIFICATION_TIMEOUT');assert.deepEqual((await x.service.journal()).backup,A);
 windows.bind(journal.id,'restored');finish({email:'b@example.test',generation:x.backend.generation,authValid:true,quotaSource:'server',observedAt:new Date().toISOString(),buckets:[]});await settle();
 assert.equal(x.data.get(x.journalKey),retained);assert.deepEqual(x.current(),B);windows.dispose();
});
test('capture stores exact full slots only in vault and returns no credentials', async () => {
  const x=setup(B); const a=await x.service.capture({label:'B',expectedEmail:'b@example.test',identitySource:'hub'});
  assert.ok(!JSON.stringify(a).includes('synthetic')); assert.deepEqual((await x.service.account(a.id)).slots,B);
  assert.ok(x.data.has(ACCOUNT_PREFIX+a.id)); assert.equal(x.writes(),0);
});
test('capture refuses changing official storage or empty/non-OAuth fixtures', async () => {
  const x=setup(); let n=0;x.slots.read=async()=>++n===1?A:B;
  await assert.rejects(x.service.capture({label:'x',expectedEmail:'x@example.test',identitySource:'user'}),/OFFICIAL_STORAGE_CHANGED/);
  assert.equal(x.data.size,0);assert.throws(()=>validateSlots({keyring:null,file:null}),/NO_SAVED/);
  assert.throws(()=>validateStoredToken('{}'),/ONLY_PERSONAL/);
  assert.throws(()=>validateStoredToken('{'),/FORMAT/);
  assert.throws(()=>validateStoredToken(JSON.stringify({token:{refresh_token:'fixture'},wif_provider:'corp'})),/ONLY_PERSONAL/);
});
test('compatible added credential fields are preserved exactly, unsupported structures never mutate slots', async () => {
  const raw=JSON.stringify({token:{refresh_token:'synthetic-future-refresh',future_field:{retained:true}},future_metadata:['unchanged']});
  const compatible={keyring:null,file:raw},x=setup(compatible);
  const saved=await x.service.capture({label:'Future',expectedEmail:'future@example.test',identitySource:'user'});
  assert.deepEqual((await x.service.account(saved.id)).slots,compatible);
  for(const raw of ['{"oauth":{"refreshToken":"synthetic"}}','{"token":[]}','{"token":{"refresh_token":123}}','{"token":{"refresh_token":"synthetic"},"wif_provider":"corp"}']){
    const value={keyring:null,file:raw},y=setup(value);
    await assert.rejects(y.service.capture({label:'Unsupported',expectedEmail:'future@example.test',identitySource:'user'}),/ONLY_PERSONAL_OAUTH_SUPPORTED/);
    assert.equal(y.writes(),0);assert.equal(y.data.size,0);assert.deepEqual(y.current(),value);
  }
});
test('actual transaction stops backend, secures backup, installs and reloads without claiming success', async () => {
  const x=setup();const a=await saveB(x);
  const original=x.slots.write;x.slots.write=async(next,expected)=>{assert.deepEqual(x.phases,['stop']);const j=await x.service.journal();assert.deepEqual(j.backup,A);assert.equal(j.phase,'prepared');await original(next,expected);};
  await x.service.install(a.id,x.backend);assert.deepEqual(x.current(),B);assert.deepEqual(x.phases,['stop','reload']);assert.equal((await x.service.journal()).phase,'installed');
  await assert.rejects(x.service.install(a.id,x.backend),/RECOVERY_PENDING/);
  const result=await x.service.verify(x.backend);assert.equal(result.email,'b@example.test');assert.ok(x.data.has(JOURNAL_KEY));
  await x.service.finish();assert.equal(await x.service.journal(),null);
});
test('unsupported current credential schema blocks only switching before stop or mutation', async () => {
  const x=setup();const saved=await saveB(x);
  const future={keyring:null,file:'{"future_oauth":{"refreshToken":"synthetic"}}'};
  x.set(future);const vaultBefore=[...x.data];
  await assert.rejects(x.service.install(saved.id,x.backend),/ONLY_PERSONAL_OAUTH_SUPPORTED/);
  assert.equal(x.writes(),0);assert.deepEqual(x.current(),future);assert.deepEqual(x.phases,[]);
  assert.deepEqual([...x.data],vaultBefore);assert.equal(await x.service.journal(),null);
});
test('valid credential JSON followed by trailing data blocks switching before stop and preserves saved accounts', async () => {
  const x=setup();const saved=await saveB(x);
  const damaged={keyring:null,file:fixture('A')+'b'.repeat(228),keyringState:'unobserved'};
  x.set(damaged);const vaultBefore=[...x.data];
  x.backend.proof=async()=>{throw Error('must not query authentication after invalid storage')};
  await assert.rejects(x.service.install(saved.id,x.backend),/TOKEN_FORMAT_UNSUPPORTED/);
  assert.equal(x.writes(),0);assert.deepEqual(x.phases,[]);assert.deepEqual(x.current(),damaged);
  assert.deepEqual([...x.data],vaultBefore);assert.equal(await x.service.journal(),null);
  assert.deepEqual((await x.service.account(saved.id)).slots,B);
});
test('backup storage failure prevents every credential mutation', async () => {
  const x=setup();const a=await saveB(x);x.vault.store=async()=>{throw new Error('simulated secret details')};
  await assert.rejects(x.service.install(a.id,x.backend));assert.equal(x.writes(),0);assert.deepEqual(x.current(),A);assert.deepEqual(x.phases,['stop']);
});
test('stop failure prevents backup and mutation', async () => {
  const x=setup();const a=await saveB(x);x.backend.stop=async()=>{throw new LiveError('STOP_FAILED')};
  await assert.rejects(x.service.install(a.id,x.backend),/STOP_FAILED/);assert.equal(x.writes(),0);assert.equal(await x.service.journal(),null);
});
test('half-write failure restores original present/absent slots and retains recovery journal', async () => {
  const x=setup();const a=await saveB(x);const original=x.slots.write;let first=true;
  x.slots.write=async(next,expected)=>{if(first){first=false;x.set({keyring:next.keyring,file:expected.file});throw new Error('credential-containing error must not escape');}await original(next,expected);};
  await assert.rejects(x.service.install(a.id,x.backend),/SWITCH_FAILED_STORAGE_RESTORED_RELOAD_REQUIRED/);
  assert.deepEqual(x.current(),A);assert.equal((await x.service.journal()).phase,'restored');assert.deepEqual(x.phases,['stop']);
});
test('unexpected external mutation leaves unknown state and encrypted backup untouched', async () => {
  const x=setup();const a=await saveB(x);x.slots.write=async()=>{x.set({keyring:fixture('external'),file:null});throw new Error('raw error')};
  await assert.rejects(x.service.install(a.id,x.backend),/SWITCH_FAILED_RECOVERY_REQUIRED/);assert.equal((await x.service.journal()).phase,'prepared');assert.equal(x.current().keyring,fixture('external'));
});
test('reload failure retains installed journal for explicit recovery', async () => {
  const x=setup();const a=await saveB(x);x.backend.reload=async()=>{throw new LiveError('RELOAD_FAILED')};
  await assert.rejects(x.service.install(a.id,x.backend),/RELOAD_FAILED/);assert.equal((await x.service.journal()).phase,'installed');assert.deepEqual(x.current(),B);
});
test('verification rejects stale generation, wrong account and invalid auth', async () => {
  const x=setup();const a=await saveB(x);await x.service.install(a.id,x.backend);
  for(const proof of [{email:'a@example.test',generation:'new',authValid:true},{email:'b@example.test',generation:'old',authValid:true},{email:'b@example.test',generation:'new',authValid:false}]){
    x.proof(proof);await assert.rejects(x.service.verify(x.backend),/HUB_IDENTITY_NOT_VERIFIED/);assert.ok(x.data.has(JOURNAL_KEY));
  }
});
test('explicit recovery restores both slots, including absence, and reloads', async () => {
  const x=setup();const a=await saveB(x);await x.service.install(a.id,x.backend);await x.service.restore(x.backend);
  assert.deepEqual(x.current(),A);assert.equal((await x.service.journal()).phase,'restored');assert.deepEqual(x.phases,['stop','reload','stop','reload']);
  await assert.rejects(x.service.verify(x.backend),/NO_SWITCH_TO_VERIFY/);
});
test('corrupt recovery record fails closed',()=>{assert.throws(()=>parseJournal('{}'),/RECOVERY_RECORD_INVALID/);assert.throws(()=>parseJournal('secret'),/RECOVERY_RECORD_INVALID/);});
test('official file adapter roundtrip on private temp HOME, no system credentials',async()=>{
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'agm-slots-'));await fs.mkdir(path.join(home,'.gemini'),{mode:0o700});let key=null;
  const slots=new OfficialTokenSlots(home,{read:async()=>key,write:async v=>{key=v;}});
  try {const empty=await slots.read();assert.deepEqual(empty,{keyring:null,file:null});await slots.write(B,empty);assert.deepEqual(await slots.read(),B);if(process.platform!=='win32')assert.equal((await fs.stat(slots.file)).mode&0o077,0);await slots.write(empty,B);assert.deepEqual(await slots.read(),empty);assert.deepEqual(await fs.readdir(path.join(home,'.gemini')),[]);}
  finally{await fs.rm(home,{recursive:true,force:true});}
});
test('file adapter refuses symlink and stale snapshots without keyring writes', {skip:process.platform==='win32'},async()=>{
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'agm-slots-'));await fs.mkdir(path.join(home,'.gemini'),{mode:0o700});const outside=path.join(home,'outside');await fs.writeFile(outside,fixture('A'),{mode:0o600});let writes=0;
  const slots=new OfficialTokenSlots(home,{read:async()=>null,write:async()=>{writes++;}});
  try{await fs.symlink(outside,slots.file);await assert.rejects(slots.read(),/OFFICIAL_FILE_UNSAFE/);assert.equal(writes,0);await fs.unlink(slots.file);await assert.rejects(slots.write(B,A),/OFFICIAL_STORAGE_CHANGED/);assert.equal(writes,0);}
  finally{await fs.rm(home,{recursive:true,force:true});}
});
test('Windows uses fixed credential target and secrets only over stdin',async()=>{
  const calls=[];const run=async(exe,args,input)=>{calls.push({exe,args,input});return {code:0,stdout:JSON.stringify({value:Buffer.from(fixture('A')).toString('base64')}),stderr:''}};
  const keyring=new SystemKeyring('win32',run);assert.equal(await keyring.read(),fixture('A'));await keyring.write(fixture('B'));
  assert.ok(WINDOWS_KEYRING_SCRIPT.includes("'gemini:antigravity'"));assert.ok(!calls[1].args.join(' ').includes('synthetic'));assert.equal(JSON.parse(calls[1].input).action,'write');assert.match(calls[0].exe,/powershell\.exe$/);
});
test('macOS supported keyring encodings and stdin write, Linux missing != unavailable',async()=>{
  const mac=new SystemKeyring('darwin',async(_exe,args,input)=>{if(args[0]==='find-generic-password')return {code:0,stdout:'go-keyring-base64:'+Buffer.from(fixture('A')).toString('base64')+'\n',stderr:''};assert.deepEqual(args,['-i']);assert.ok(input.startsWith('add-generic-password'));return{code:0,stdout:'',stderr:''};});
  assert.equal(await mac.read(),fixture('A'));await mac.write(fixture('B'));
  assert.equal(await new SystemKeyring('linux',async()=>({code:0,stdout:'(@ao [], @ao [])',stderr:''})).read(),null);
  await assert.rejects(new SystemKeyring('linux',async()=>({code:1,stdout:'',stderr:'dbus unavailable'})).read(),/KEYRING_UNAVAILABLE/);
});
test('private process runner preserves chunked UTF-8 and never returns raw error on missing executable',async()=>{
  const r=await runPrivate(process.execPath,['-e',"const b=Buffer.from('身份');process.stdout.write(b.subarray(0,2));setTimeout(()=>process.stdout.end(b.subarray(2)),5)"]);assert.equal(r.stdout,'身份');
  await assert.rejects(runPrivate(path.join(os.tmpdir(),'nonexistent-agm-executable'),[]),/NATIVE_HELPER_UNAVAILABLE/);
});
const api={port:12345,csrfToken:'synthetic-hub-nonce-not-a-credential'};
const status={userStatus:{email:'B@EXAMPLE.TEST',cascadeModelConfigData:{clientModelConfigs:[{label:'Model',quotaInfo:{remainingFraction:0.4,resetTime:'2030-01-01T00:00:00Z'}}]},accessToken:'must-not-escape'}};
test('proof parser only returns whitelisted identity/quota, rejects absent auth/email',()=>{
  const proof=parseHubProof({authResult:{hasValidAuth:true}},status,api);assert.equal(proof.email,'b@example.test');assert.equal(proof.buckets[0].remaining,0.4);assert.ok(!JSON.stringify(proof).includes('must-not-escape'));assert.equal(proof.generation,generation(api));
  assert.throws(()=>parseHubProof({},status,api),/HUB_AUTH_INVALID/);assert.throws(()=>parseHubProof({authResult:{hasValidAuth:true}},{},api),/HUB_EMAIL_MISSING/);
});
test('actual loopback transport uses fixed RPC and CSRF header, no redirects',async()=>{
  const seen=[];const server=http.createServer((req,res)=>{seen.push({url:req.url,csrf:req.headers['x-codeium-csrf-token']});res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url.endsWith('/GetAuthStatus')?{authResult:{hasValidAuth:true}}:status));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try{const actual={...api,port:server.address().port};const proof=await queryHub(actual);assert.equal(proof.email,'b@example.test');assert.equal(seen.length,2);assert.ok(seen.every(v=>v.url.startsWith('/exa.language_server_pb.LanguageServerService/')&&v.csrf===api.csrfToken));await assert.rejects(hubRpc({...actual,port:0},'GetUserStatus'),/OFFICIAL_HUB_API_UNAVAILABLE/);}
  finally{await new Promise(r=>server.close(r));}
});
const { LiveLocks } = require('../out/live-lock');
const { randomUUID } = require('node:crypto');
test('live operation mutex serializes capture/switch/restore/finish and recovery ownership is bound',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'agm-locks-'));const owner='a'.repeat(64),a=new LiveLocks(dir,owner),b=new LiveLocks(dir,'b'.repeat(64)),id=randomUUID();
  try{
    await a.withOperation(async()=>{
      await assert.rejects(b.withOperation(async()=>{}),/LIVE_OPERATION_OR_RECOVERY_LOCKED/);
      await a.beginRecovery(id);await a.assertRecovery(id);await assert.rejects(b.assertRecovery(id),/OWNER_MISMATCH/);
      await assert.rejects(a.clearRecovery(randomUUID()),/OWNER_MISMATCH/);
    });
    await a.withOperation(async()=>{await a.assertRecovery(id);await a.clearRecovery(id);});assert.equal(await a.hasRecovery(),false);
    assert.deepEqual(await fs.readdir(dir),[]);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('live lock never clears a living owner or silently repairs corrupt metadata',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'agm-locks-'));const a=new LiveLocks(dir,'a'.repeat(64));
  try{
    await a.withOperation(async()=>{await assert.rejects(a.clearAbandonedOperation(),/LOCK_PROCESS_STILL_ALIVE/);});
    await fs.mkdir(path.join(dir,'.agm-operation.lock'));await assert.rejects(a.clearAbandonedOperation(),/LOCK_RECORD_REQUIRES_MANUAL_CHECK/);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('token slot identity rejects contradictory emails and ambiguous keyring/file accounts',()=>{
  const { assertSlotIdentity }=require('../out/live-storage');
  assert.throws(()=>assertSlotIdentity({keyring:fixture('A'),file:fixture('B')},'b@example.test'),/IDENTITY_AMBIGUOUS/);
  const raw=JSON.stringify({token:{refresh_token:'fixture'},id_token:'e30.'+Buffer.from(JSON.stringify({email:'a@example.test',sub:'fixture-a'})).toString('base64url')+'.synthetic'});
  assert.throws(()=>assertSlotIdentity({keyring:raw,file:null},'b@example.test'),/STORED_TOKEN_EMAIL_MISMATCH/);
});
test('finish failing secure deletion retains recovery record',async()=>{
  const x=setup();const a=await saveB(x);await x.service.install(a.id,x.backend);x.vault.delete=async()=>{};
  await assert.rejects(x.service.finish(),/RECOVERY_DELETE_FAILED/);assert.equal((await x.service.journal()).phase,'installed');
});

test('Windows native helper compiles without touching any credential store',{skip:process.platform!=='win32'},async()=>{
 const executable=path.win32.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
 const result=await runPrivate(executable,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(WINDOWS_KEYRING_SCRIPT,'utf16le').toString('base64')],JSON.stringify({action:'validate'}));
 assert.equal(result.code,0);assert.deepEqual(JSON.parse(result.stdout),{ready:true});
});

test('Linux rejects duplicate/foreign keyring collections before lookup or clear',async()=>{
 const calls=[];const keyring=new SystemKeyring('linux',async(exe,args)=>{calls.push({exe,args});return{code:0,stdout:"([objectpath '/org/freedesktop/secrets/collection/other/1'], @ao [])",stderr:''};});
 await assert.rejects(keyring.read(),/KEYRING_COLLECTION_AMBIGUOUS/);await assert.rejects(keyring.write(null),/KEYRING_COLLECTION_AMBIGUOUS/);assert.ok(calls.every(c=>c.exe==='/usr/bin/gdbus'));
 const writes=[];const allowed=new SystemKeyring('linux',async(exe,args,input)=>{if(exe==='/usr/bin/gdbus')return{code:0,stdout:'(@ao [], @ao [])',stderr:''};writes.push({exe,args,input});return{code:0,stdout:'',stderr:''};});
 await allowed.write(fixture('B'));assert.ok(writes[0].args.includes('--collection=/org/freedesktop/secrets/collection/login'));assert.equal(writes[0].input,fixture('B'));
});

test('native helper timeout keeps unknown recovery state without racing an OS-service write',async()=>{
 const x=setup();const a=await saveB(x);let calls=0;x.slots.write=async()=>{calls++;throw new LiveError('NATIVE_HELPER_TIMEOUT_OR_LIMIT');};
 await assert.rejects(x.service.install(a.id,x.backend),/SWITCH_TIMEOUT_RECOVERY_REQUIRED/);assert.equal(calls,1);assert.equal((await x.service.journal()).phase,'prepared');assert.deepEqual(x.phases,['stop']);
});
test('official file adapter rejects non-UTF8 bytes without normalizing a recovery backup',async()=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'agm-encoding-'));await fs.mkdir(path.join(home,'.gemini'),{mode:0o700});const slots=new OfficialTokenSlots(home,{read:async()=>null,write:async()=>{throw Error('must not write')}});
  try{await fs.writeFile(slots.file,Buffer.from([0xff,0xfe,0x7b]),{mode:0o600});await assert.rejects(slots.read(),/OFFICIAL_FILE_ENCODING_INVALID/);assert.deepEqual(await fs.readFile(slots.file),Buffer.from([0xff,0xfe,0x7b]));}finally{await fs.rm(home,{recursive:true,force:true});}
});

// These use only a disposable synthetic HOME and fake keyring/vault. They prove this
// extension's storage boundaries, not whether an official login preserves cloud/local history.
async function historyPreservationFixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agm-preserve-history-'));
  t.after(() => fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  await fs.mkdir(path.join(home, '.gemini'), { mode: 0o700 });
  const conversation = randomUUID();
  const sentinels = new Map([
    [`.gemini/antigravity-cli/brain/${conversation}/generated_image_123.png`, require('./fixtures/png-fixture.cjs').png()],
    [`.gemini/antigravity-cli/brain/${conversation}/task.md`, Buffer.from('Synthetic image task; preserve bytes\n')],
    [`.gemini/antigravity-cli/conversations/${conversation}.pb`, Buffer.from([0x08, 0x01, 0x12, 0x03, 0x61, 0x62, 0x63])],
    ['.gemini/antigravity-cli/cache/last_conversations.json', Buffer.from(JSON.stringify({ conversations: [conversation] }))],
    ['.config/Antigravity/User/workspaceStorage/synthetic/state.vscdb', Buffer.from('Synthetic IDE local-state sentinel, not a real database')],
    ['Pictures/saved-output.png', require('./fixtures/png-fixture.cjs').png()],
  ]);
  for (const [name, data] of sentinels) {
    const file = path.join(home, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, data);
  }
  const roots = ['.gemini/antigravity-cli', '.config/Antigravity', 'Pictures'];
  const manifest = async () => {
    const entries = [];
    const visit = async name => {
      const file = path.join(home, name), stat = await fs.lstat(file);
      const entry = { name, kind: stat.isDirectory() ? 'directory' : 'file', mtimeMs: stat.mtimeMs, mode: stat.mode };
      if (stat.isDirectory()) {
        entries.push(entry);
        for (const child of (await fs.readdir(file)).sort()) await visit(path.join(name, child));
      } else {
        const data = await fs.readFile(file);
        entries.push({ ...entry, bytes: data.length, sha256: require('node:crypto').createHash('sha256').update(data).digest('hex') });
      }
    };
    for (const root of roots) await visit(root);
    return entries;
  };
  const before = await manifest(), data = new Map(); let keyring = null, failNextTargetWrite = false;
  const slots = new OfficialTokenSlots(home, {
    read: async () => keyring,
    write: async value => {
      keyring = value;
      if (failNextTargetWrite && value === B.keyring) { failNextTargetWrite = false; throw new Error('Synthetic failure after keyring write'); }
    },
  });
  const service = new LiveSwitchService({ get: async key => data.get(key), store: async (key, value) => { data.set(key, value); }, delete: async key => { data.delete(key); } }, slots);
  const unchanged = async phase => assert.deepEqual(await manifest(), before, `History/artifact/output manifest changed during ${phase}`);
  await slots.write(A, { keyring: null, file: null });
  const accountA = await service.capture({ label: 'A', expectedEmail: 'a@example.test', identitySource: 'user' });
  await slots.write(B, A);
  const accountB = await service.capture({ label: 'B', expectedEmail: 'b@example.test', identitySource: 'user' });
  await slots.write(A, B); await unchanged('fixture account capture');
  const lifecycle = (oldGeneration, _target, newGeneration) => {
    const life = { generation: oldGeneration, stop: async () => undefined, reload: async () => {life.generation=newGeneration},
      proof: async () => ({ email: (await slots.read()).keyring===A.keyring?'a@example.test':'b@example.test', generation: life.generation, authValid: true, quotaSource:'server',observedAt: new Date().toISOString(), buckets: [] }),
    };return life;
  };
  return { slots, service, accountA, accountB, unchanged, lifecycle, failNextWrite: () => { failNextTargetWrite = true; } };
}

test('real token-slot adapter preserves all synthetic history and artwork through A to B to A switches', async t => {
  const f = await historyPreservationFixture(t);
  const toB = f.lifecycle('hub-a-0', 'b@example.test', 'hub-b-1');
  await f.service.install(f.accountB.id, toB); assert.deepEqual(await f.slots.read(), B); await f.unchanged('install B');
  await f.service.verify(toB); await f.unchanged('verify B');
  await f.service.finish(); await f.unchanged('finish B');
  const toA = f.lifecycle('hub-b-1', 'a@example.test', 'hub-a-2');
  await f.service.install(f.accountA.id, toA); assert.deepEqual(await f.slots.read(), A); await f.unchanged('install A');
  await f.service.verify(toA); await f.unchanged('verify A');
  await f.service.finish(); await f.unchanged('finish A');
  assert.equal(await f.service.journal(), null);
});

test('real token-slot adapter preserves synthetic histories during explicit restore and partial-write rollback', async t => {
  const f = await historyPreservationFixture(t), backend = f.lifecycle('hub-a-0', 'b@example.test', 'hub-b-1');
  await f.service.install(f.accountB.id, backend); await f.unchanged('install before restore');
  await f.service.restore(backend); assert.deepEqual(await f.slots.read(), A); await f.unchanged('explicit restore');
  await f.service.finish(); await f.unchanged('finish restored transaction');
  f.failNextWrite();
  await assert.rejects(f.service.install(f.accountB.id, backend), /SWITCH_FAILED_STORAGE_RESTORED_RELOAD_REQUIRED/);
  assert.deepEqual(await f.slots.read(), A); assert.equal((await f.service.journal()).phase, 'restored');
  await f.unchanged('automatic rollback after partial write');
  await f.service.restore(backend); await f.unchanged('explicit recovery after rollback');
  await f.service.finish(); await f.unchanged('finish rollback recovery');
});

// Shared SecretStorage fixtures model native Windows and WSL extension hosts.
// No test below opens a system credential store, runs an authentication flow or
// infers a host ID from actual machine/user data.
const HOST_WINDOWS = 'a'.repeat(64), HOST_WSL = 'b'.repeat(64);
const hostMetadata = { label: 'B', expectedEmail: 'b@example.test', identitySource: 'user' };
const rejectsHost = (operation, code) => assert.rejects(operation, error => error instanceof LiveError && error.code === code && error.message === code);
test('saved host metadata is constructor-owned and passive host filtering never touches credentials', async () => {
  const x = setup(B, HOST_WSL);
  const account = await x.service.capture({ ...hostMetadata, hostId: HOST_WINDOWS });
  assert.equal(account.hostId, HOST_WSL);
  assert.equal((await x.service.account(account.id)).hostId, HOST_WSL);
  assert.equal(JSON.parse(x.data.get(ACCOUNT_PREFIX + account.id)).hostId, HOST_WSL);
  assert.equal(Object.hasOwn(account, 'slots'), false);
  assert.ok(!JSON.stringify(account).includes('synthetic'));
  const reads = x.reads(), records = [...x.data];
  assert.equal(x.service.hostIsCurrent(account), true);
  assert.equal(x.service.hostIsCurrent({ hostId: HOST_WINDOWS }), false);
  assert.equal(x.service.hostIsCurrent({}), false);
  assert.equal(x.reads(), reads); assert.equal(x.writes(), 0); assert.deepEqual([...x.data], records);
  for (const host of ['', ' ', ' host ']) assert.throws(() => new LiveSwitchService(x.vault, x.slots, host), /HOST_ID_INVALID/);
});
test('shared vault account reads and installs reject another host or legacy records without native access', async () => {
  for (const [ownerHost, code] of [[HOST_WINDOWS, 'HOST_ACCOUNT_MISMATCH'], [undefined, 'HOST_ACCOUNT_UNBOUND']]) {
    const owner = setup(B, ownerHost), account = await owner.service.capture(hostMetadata);
    const other = setup(A, HOST_WSL, owner.data), records = [...owner.data];
    await rejectsHost(other.service.account(account.id), code);
    await rejectsHost(other.service.install(account.id, other.backend), code);
    assert.equal(other.reads(), 0); assert.equal(other.writes(), 0);
    assert.deepEqual(other.phases, []); assert.deepEqual(other.current(), A);
    assert.deepEqual([...other.data], records);
  }
});
test('host binding survives restart, switch verification, restore and explicit recovery completion', async () => {
  const x = setup(B, HOST_WSL), account = await x.service.capture(hostMetadata);
  x.set(A);
  const restarted = new LiveSwitchService(x.vault, x.slots, HOST_WSL);
  await restarted.install(account.id, x.backend);
  const journal = await restarted.journal();
  assert.equal(journal.hostId, HOST_WSL); assert.equal(journal.target.hostId, HOST_WSL);
  assert.deepEqual(journal.backup, A); assert.deepEqual(x.current(), B);
  const afterReload = new LiveSwitchService(x.vault, x.slots, HOST_WSL);
  assert.equal((await afterReload.verify(x.backend)).email, 'b@example.test');
  await afterReload.restore(x.backend);
  assert.equal((await afterReload.journal()).hostId, HOST_WSL);
  assert.deepEqual(x.current(), A);
  await afterReload.finish(); assert.equal(await afterReload.journal(), null);
  assert.equal((await afterReload.account(account.id)).hostId, HOST_WSL);
});
test('foreign and legacy journals block every read, capture, cancellation, install and deletion path', async () => {
  for (const [ownerHost, code] of [[HOST_WINDOWS, 'HOST_RECOVERY_MISMATCH'], [undefined, 'HOST_RECOVERY_UNBOUND']]) {
    for (const phase of ['authorizing', 'prepared', 'installed', 'restored']) {
      const owner = setup(A, ownerHost); await owner.service.prepareLogin(owner.backend);
      const journal = JSON.parse(owner.data.get(owner.journalKey)); journal.phase = phase;
      owner.data.set(JOURNAL_KEY, JSON.stringify(journal));
      const other = setup(B, HOST_WSL, owner.data), records = [...owner.data];
      let proofCalls = 0; other.backend.proof = async () => { proofCalls++; throw Error('must not request proof'); };
      for (const operation of [
        () => other.service.journal(),
        () => other.service.capture(hostMetadata),
        () => other.service.prepareLogin(other.backend),
        () => other.service.captureLogin(hostMetadata),
        () => other.service.installLogin(journal.target.id, other.backend),
        () => other.service.install(journal.target.id, other.backend),
        () => other.service.verify(other.backend),
        () => other.service.restore(other.backend),
        () => other.service.finish(),
      ]) await rejectsHost(operation(), code);
      assert.equal(other.reads(), 0); assert.equal(other.writes(), 0); assert.equal(proofCalls, 0);
      assert.deepEqual(other.phases, []); assert.deepEqual(other.current(), B);
      assert.deepEqual([...other.data], records);
    }
  }
});
test('a journal cannot relabel a foreign or legacy target as the current host', async () => {
  for (const [targetHost, code] of [[HOST_WINDOWS, 'HOST_RECOVERY_MISMATCH'], [undefined, 'HOST_RECOVERY_UNBOUND']]) {
    const x = setup(A, HOST_WSL); await x.service.prepareLogin(x.backend);
    const journal = JSON.parse(x.data.get(x.journalKey));
    if (targetHost === undefined) delete journal.target.hostId; else journal.target.hostId = targetHost;
    const raw = JSON.stringify(journal); x.data.set(x.journalKey, raw);
    const reads = x.reads();
    await rejectsHost(x.service.journal(), code); await rejectsHost(x.service.restore(x.backend), code);
    await rejectsHost(x.service.finish(), code);
    assert.equal(x.reads(), reads); assert.equal(x.writes(), 0); assert.deepEqual(x.phases, []);
    assert.equal(x.data.get(x.journalKey), raw);
  }
});
test('native direct-login cancellation on restart cannot restore or delete the other host backup', async () => {
  const owner = setup(A, HOST_WINDOWS); await owner.service.prepareLogin(owner.backend);
  owner.set(B); // The synthetic official login changed only the owner's slots.
  const raw = owner.data.get(owner.journalKey), other = setup(B, HOST_WSL, owner.data);
  const reopenedOnOtherHost = new LiveSwitchService(other.vault, other.slots, HOST_WSL);
  assert.equal(await reopenedOnOtherHost.journal(), null);
  await assert.rejects(reopenedOnOtherHost.restore(other.backend), /NO_RECOVERY_BACKUP/);
  await reopenedOnOtherHost.finish();
  assert.equal(other.reads(), 0); assert.equal(other.writes(), 0); assert.deepEqual(other.phases, []);
  assert.deepEqual(other.current(), B); assert.equal(owner.data.get(owner.journalKey), raw);
  const reopenedOnOwner = new LiveSwitchService(owner.vault, owner.slots, HOST_WINDOWS);
  await reopenedOnOwner.restore(owner.backend);
  assert.deepEqual(owner.current(), A); assert.equal((await reopenedOnOwner.journal()).phase, 'restored');
  assert.equal((await reopenedOnOwner.journal()).hostId, HOST_WINDOWS);
  await reopenedOnOwner.finish(); assert.equal(owner.data.has(owner.journalKey), false);
});
test('direct-login install checks saved-account ownership before stopping a current-host authorization', async () => {
  for (const [ownerHost, code] of [[HOST_WINDOWS, 'HOST_ACCOUNT_MISMATCH'], [undefined, 'HOST_ACCOUNT_UNBOUND']]) {
    const owner = setup(B, ownerHost), account = await owner.service.capture(hostMetadata);
    const current = setup(A, HOST_WSL, owner.data); await current.service.prepareLogin(current.backend);
    const records = [...current.data], reads = current.reads();
    await rejectsHost(current.service.installLogin(account.id, current.backend), code);
    assert.equal(current.reads(), reads); assert.equal(current.writes(), 0); assert.deepEqual(current.phases, []);
    assert.deepEqual([...current.data], records); assert.deepEqual(current.current(), A);
  }
});
test('new native login capture and journal target are bound to their credential host', async () => {
  const x = setup(A, HOST_WSL); await x.service.prepareLogin(x.backend);
  assert.equal((await x.service.journal()).hostId, HOST_WSL);
  assert.equal((await x.service.journal()).target.hostId, HOST_WSL);
  x.set(B); const account = await x.service.captureLogin({ ...hostMetadata, hostId: HOST_WINDOWS });
  assert.equal(account.hostId, HOST_WSL);
  await x.service.installLogin(account.id, x.backend);
  assert.equal((await x.service.journal()).target.hostId, HOST_WSL);
  assert.deepEqual(x.current(), A);
});
test('a foreign journal arriving during capture or backup reads is preserved rather than overwritten', async () => {
  for (const operation of ['capture', 'prepareLogin']) {
    const owner = setup(A, HOST_WINDOWS); await owner.service.prepareLogin(owner.backend);
    const raw = owner.data.get(owner.journalKey), x = setup(B, HOST_WSL);
    x.slots.read = async () => { x.data.set(JOURNAL_KEY, raw); return structuredClone(B); };
    await rejectsHost(operation === 'capture' ? x.service.capture(hostMetadata) : x.service.prepareLogin(x.backend), 'HOST_RECOVERY_MISMATCH');
    assert.deepEqual([...x.data], [[JOURNAL_KEY, raw]]); assert.equal(x.writes(), 0); assert.deepEqual(x.phases, []);
  }
});
test('capture refuses even a current-host pending journal before reading native slots', async () => {
  const x = setup(A, HOST_WSL); await x.service.prepareLogin(x.backend);
  const records = [...x.data], reads = x.reads();
  await assert.rejects(x.service.capture(hostMetadata), /RECOVERY_PENDING/);
  assert.equal(x.reads(), reads); assert.deepEqual([...x.data], records);
});
test('malformed journal host metadata fails closed without modifying legacy identifiers', async () => {
  const x = setup(A, HOST_WSL); await x.service.prepareLogin(x.backend);
  assert.equal(JOURNAL_KEY, 'live-switch.recovery.v1'); assert.equal(ACCOUNT_PREFIX, 'live-switch.account.v1.');
  const original = JSON.parse(x.data.get(x.journalKey));
  for (const bad of ['', ' ', null, 42, {}]) {
    assert.throws(() => parseJournal(JSON.stringify({ ...original, hostId: bad })), /RECOVERY_RECORD_INVALID/);
    assert.throws(() => parseJournal(JSON.stringify({ ...original, target: { ...original.target, hostId: bad } })), /RECOVERY_RECORD_INVALID/);
  }
});


test('concurrent host login preparation retains both backups even when secret writes finish out of order', async () => {
  const data=new Map(),a=setup(A,HOST_WINDOWS,data),b=setup(B,HOST_WSL,data);let releaseB,startedB;
  const waitingB=new Promise(resolve=>{releaseB=resolve}),reachedB=new Promise(resolve=>{startedB=resolve});
  const storeB=b.vault.store;b.vault.store=async(key,value)=>{if(key===b.journalKey){startedB();await waitingB;}await storeB(key,value);};
  const prepareA=a.service.prepareLogin(a.backend),prepareB=b.service.prepareLogin(b.backend);
  await reachedB;await prepareA;
  assert.equal((await a.service.journal()).hostId,HOST_WINDOWS);assert.deepEqual((await a.service.journal()).backup,A);
  releaseB();await prepareB;
  assert.notEqual(a.journalKey,b.journalKey);assert.equal(data.has(JOURNAL_KEY),false);
  assert.deepEqual((await a.service.journal()).backup,A);assert.deepEqual((await b.service.journal()).backup,B);
  const bRaw=data.get(b.journalKey);await a.service.finish();assert.equal(data.get(b.journalKey),bRaw);assert.equal(data.has(a.journalKey),false);
});

test('concurrent host installs and independent restart recovery never overwrite or delete the other backup', async () => {
  const data=new Map(),a=setup(B,HOST_WINDOWS,data),b=setup(A,HOST_WSL,data);
  const aTarget=await a.service.capture(hostMetadata),bTarget=await b.service.capture({label:'A',expectedEmail:'a@example.test',identitySource:'user'});
  a.set(A);b.set(B);let releaseB,startedB;
  const waitingB=new Promise(resolve=>{releaseB=resolve}),reachedB=new Promise(resolve=>{startedB=resolve});
  const storeB=b.vault.store;let gated=false;b.vault.store=async(key,value)=>{if(key===b.journalKey&&!gated){gated=true;startedB();await waitingB;}await storeB(key,value);};
  const installA=a.service.install(aTarget.id,a.backend),installB=b.service.install(bTarget.id,b.backend);
  await reachedB;await installA;releaseB();await installB;
  assert.deepEqual(a.current(),B);assert.deepEqual(b.current(),A);assert.equal(data.has(JOURNAL_KEY),false);
  assert.deepEqual((await a.service.journal()).backup,A);assert.deepEqual((await b.service.journal()).backup,B);
  const bRaw=data.get(b.journalKey),restartedA=new LiveSwitchService(a.vault,a.slots,HOST_WINDOWS);
  await restartedA.restore(a.backend);await restartedA.finish();assert.deepEqual(a.current(),A);assert.equal(data.get(b.journalKey),bRaw);
  const restartedB=new LiveSwitchService(b.vault,b.slots,HOST_WSL);await restartedB.restore(b.backend);await restartedB.finish();assert.deepEqual(b.current(),B);
  assert.equal(data.has(a.journalKey),false);assert.equal(data.has(b.journalKey),false);
});

test('same-host bound legacy recovery stays at its old key until explicit completion', async () => {
  const x=setup(A,HOST_WSL);await x.service.prepareLogin(x.backend);
  const raw=x.data.get(x.journalKey);x.data.set(JOURNAL_KEY,raw);x.data.delete(x.journalKey);x.set(B);
  const restarted=new LiveSwitchService({...x.vault},x.slots,HOST_WSL);await restarted.restore(x.backend);
  assert.equal(x.data.has(x.journalKey),false);assert.equal(JSON.parse(x.data.get(JOURNAL_KEY)).phase,'restored');assert.deepEqual(x.current(),A);
  await restarted.finish();assert.equal(x.data.has(JOURNAL_KEY),false);
});

test('conflicting current-host legacy and scoped recovery records fail closed without choosing or deleting either', async () => {
  const x=setup(A,HOST_WSL);await x.service.prepareLogin(x.backend);x.data.set(JOURNAL_KEY,x.data.get(x.journalKey));
  const before=[...x.data],reads=x.reads();await assert.rejects(x.service.journal(),/RECOVERY_RECORD_CONFLICT/);await assert.rejects(x.service.restore(x.backend),/RECOVERY_RECORD_CONFLICT/);await assert.rejects(x.service.finish(),/RECOVERY_RECORD_CONFLICT/);
  assert.deepEqual([...x.data],before);assert.equal(x.reads(),reads);assert.equal(x.writes(),0);
});

test('automatic switch verification binds fresh identity, restarted lifecycle and current official storage',async()=>{
 const x=setup();const saved=await saveB(x);await x.service.install(saved.id,x.backend);const proof=await x.service.finishVerified(x.backend);
 assert.equal(proof.email,'b@example.test');assert.equal(await x.service.journal(),null);assert.deepEqual(x.current(),B);
});
test('cached status cannot complete a switch even when its mailbox and generation match',async()=>{
 const x=setup();const saved=await saveB(x);await x.service.install(saved.id,x.backend);x.proof({email:'b@example.test',generation:x.backend.generation,authValid:true});
 await assert.rejects(x.service.finishVerified(x.backend),/HUB_IDENTITY_NOT_VERIFIED/);assert.equal((await x.service.journal()).verification.state,'retry');assert.equal((await x.service.journal()).verification.attempts,1);
});
test('official storage mismatch blocks auto completion and preserves backup even with matching live mailbox',async()=>{
 const x=setup();const saved=await saveB(x);await x.service.install(saved.id,x.backend);x.set({keyring:fixture('C'),file:fixture('C')});x.proof({email:'b@example.test',generation:x.backend.generation,authValid:true,quotaSource:'server'});
 await assert.rejects(x.service.finishVerified(x.backend),/VERIFICATION_STORAGE_MISMATCH/);assert.deepEqual((await x.service.journal()).backup,A);assert.equal((await x.service.journal()).verification.state,'retry');
});
test('ordinary access-token refresh is accepted but different refresh credentials never inherit verification',async()=>{
 const x=setup();const saved=await saveB(x);await x.service.install(saved.id,x.backend);const refreshed=JSON.parse(fixture('B'));refreshed.token.access_token='synthetic-rotated-access';const value=JSON.stringify(refreshed);x.set({keyring:value,file:value});
 assert.equal((await x.service.finishVerified(x.backend)).email,'b@example.test');assert.equal(await x.service.journal(),null);
});
test('storage mutation during live proof becomes a durable retry and never clears encrypted recovery',async()=>{
 const x=setup();const saved=await saveB(x);await x.service.install(saved.id,x.backend);x.backend.proof=async()=>{x.set(A);return{email:'b@example.test',generation:x.backend.generation,authValid:true,quotaSource:'server'}};
 await assert.rejects(x.service.finishVerified(x.backend),/VERIFICATION_STORAGE_MISMATCH/);assert.equal((await x.service.journal()).verification.state,'retry');
});
test('server timeout survives restart, then one fresh retry can finish without a user-success flag',async()=>{
 const x=setup();const saved=await saveB(x);await x.service.install(saved.id,x.backend);const original=x.backend.proof;x.backend.proof=async()=>{throw new LiveError('HUB_RPC_TIMEOUT')};
 await assert.rejects(x.service.finishVerified(x.backend),/HUB_RPC_TIMEOUT/);const reopened=new LiveSwitchService(x.vault,x.slots);assert.equal((await reopened.journal()).verification.code,'HUB_RPC_TIMEOUT');
 x.backend.proof=original;assert.equal((await reopened.finishVerified(x.backend)).email,'b@example.test');assert.equal(await reopened.journal(),null);
});
test('verification persists only safe error codes and never raw adapter detail or credentials',async()=>{
 const x=setup();const saved=await saveB(x);await x.service.install(saved.id,x.backend);x.backend.proof=async()=>{throw new LiveError('synthetic-private-response-with-bearer')};
 await assert.rejects(x.service.finishVerified(x.backend),e=>e.code==='VERIFICATION_RETRY_REQUIRED');const journal=await x.service.journal();assert.equal(journal.verification.code,'VERIFICATION_RETRY_REQUIRED');assert.ok(!JSON.stringify(journal).includes('synthetic-private-response-with-bearer'));assert.equal(journal.phase,'installed');
});
test('successful switch saves only the verified target renewed access token before clearing recovery',async()=>{
 const x=setup();const original=await x.service.capture({label:'A',expectedEmail:'a@example.test',identitySource:'hub'}),originalRaw=x.data.get(ACCOUNT_PREFIX+original.id);
 const saved=await saveB(x);await x.service.install(saved.id,x.backend);const renewed=JSON.parse(fixture('B'));renewed.token.access_token='synthetic-renewed-access-B';renewed.token.expiry='2099-01-01T00:00:00Z';const value=JSON.stringify(renewed);x.set({keyring:value,file:value});
 await x.service.finishVerified(x.backend);assert.deepEqual((await x.service.account(saved.id)).slots,{keyring:value,file:value});assert.equal(x.data.get(ACCOUNT_PREFIX+original.id),originalRaw);assert.equal(await x.service.journal(),null);
});
test('restoration verification never overwrites newly saved B with the restored A credentials',async()=>{
 const x=setup();await x.service.prepareLogin(x.backend);x.set(B);const saved=await x.service.captureLogin({label:'B',expectedEmail:'b@example.test',identitySource:'hub'});const savedRaw=x.data.get(ACCOUNT_PREFIX+saved.id);
 await x.service.completeLogin(saved.id,x.backend);await x.service.finishVerified(x.backend);assert.equal(x.data.get(ACCOUNT_PREFIX+saved.id),savedRaw);assert.deepEqual(x.current(),A);
});
test('verified target update failure retains encrypted backup and never claims transaction complete',async()=>{
 const x=setup();const saved=await saveB(x);await x.service.install(saved.id,x.backend);const store=x.vault.store;x.vault.store=async(key,value)=>{if(key===ACCOUNT_PREFIX+saved.id)return;await store(key,value)};
 const renewed=JSON.parse(fixture('B'));renewed.token.access_token='synthetic-renewed-access-B';const value=JSON.stringify(renewed);x.set({keyring:value,file:value});
 await assert.rejects(x.service.finishVerified(x.backend),/SECURE_SAVE_NOT_VERIFIED/);assert.ok(await x.service.journal());assert.deepEqual((await x.service.journal()).backup,A);assert.equal((await x.service.journal()).verification.state,'retry');assert.equal((await x.service.journal()).verification.code,'SECURE_SAVE_NOT_VERIFIED');
});

test('saved local usability rejects expired nonrefreshable or inconsistent credentials and accepts an audited renewable grant',async()=>{
 const x=setup(A,'host'),a=await x.service.capture({label:'A',expectedEmail:'a@example.test',identitySource:'hub'}),key=ACCOUNT_PREFIX+a.id;
 const record=JSON.parse(x.data.get(key));const expired=JSON.stringify({auth_method:'oauth',token:{access_token:'synthetic-valid-access',refresh_token:'synthetic-valid-refresh',token_type:'Bearer',expiry:'2020-01-01T00:00:00Z'}});
 record.slots={keyring:null,file:expired};x.data.set(key,JSON.stringify(record));assert.equal(await x.service.savedLoginUsable(a),false);
 record.slots.file=JSON.stringify({...JSON.parse(expired),auth_method:'consumer'});x.data.set(key,JSON.stringify(record));assert.equal(await x.service.savedLoginUsable(a),true);
 record.slots.file=JSON.stringify({...JSON.parse(expired),token:{...JSON.parse(expired).token,token_type:'Basic'}});x.data.set(key,JSON.stringify(record));assert.equal(await x.service.savedLoginUsable(a),false);
});
