const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { LiveSwitchService, ACCOUNT_PREFIX, QUOTA_PENDING_PREFIX, QUOTA_UNKNOWN_PREFIX, QUOTA_REFRESH_PREFIX } = require('../out/live-switch');
const { AccountImportTransaction } = require('../out/account-import');
const { IMPORT_CANDIDATE_PREFIX } = require('../out/account-import-candidate');
const { SavedAccountQuotaClient, queryImportedAccountQuota } = require('../out/account-quota');
const { CONSUMER_CLIENT_ID_SHA256 } = require('../out/account-quota-client');
const { LiveError } = require('../out/live-storage');
const NOW = Date.parse('2026-10-08T00:00:00Z');
const tick = () => new Promise(setImmediate);
const token = (name, expired = false, grant = name) => JSON.stringify({ auth_method: 'consumer', project_id: 'project-'+name,
  id_token: 'unsigned.'+Buffer.from(JSON.stringify({ email: name+'@example.test', sub: 'subject-'+name })).toString('base64url')+'.fixture',
  token: { access_token: 'synthetic-access-'+name, refresh_token: 'synthetic-refresh-'+grant, token_type: 'Bearer', expiry: new Date(NOW+(expired?-3600000:3600000)).toISOString() } });
const entry = (name, expired = false, grant = name) => ({ label: 'Imported '+name, expectedEmail: name+'@example.test', capturedAt: new Date(NOW).toISOString(), token: token(name,expired,grant) });
function fixture(options = {}) {
  const data = new Map(), events = []; let rows = [], exchanges = 0, official = 0;
  const vault = { async get(key) { events.push(['get',key]); return data.get(key); }, async store(key,value) { events.push(['store',key]); data.set(key,value); }, async delete(key) { events.push(['delete',key]); data.delete(key); } };
  const index = { read: () => structuredClone(rows), async write(value) { events.push(['index','index']); rows = structuredClone(value); } };
  const slots = { async read() { official++; throw Error('official slots must not be read'); }, async write() { official++; throw Error('official slots must not be changed'); } };
  const service = new LiveSwitchService(vault, slots, 'synthetic-host');
  const client = new SavedAccountQuotaClient(async request => {
    events.push([request.endpoint,request.accessToken]);
    if (options.transport) return options.transport(request, events);
    const name = request.accessToken.replace('synthetic-access-', '').replace('synthetic-new-', '');
    return request.endpoint === 'identity' ? { email: name+'@example.test', id: 'subject-'+name, verified_email: true } : { buckets: [{ displayName: 'Window', remainingFraction: 0.4 }] };
  }, () => NOW, options.deadline ?? 1000);
  const provider = { clientIdSha256: CONSUMER_CLIENT_ID_SHA256, async exchange(refresh,signal) {
    exchanges++; events.push(['exchange',refresh]);
    if (options.exchange) return options.exchange(refresh,signal);
    const name = refresh.replace('synthetic-refresh-',''); return { access_token:'synthetic-new-'+name, refresh_token:'synthetic-rotated-'+name, expires_in:3600, token_type:'Bearer' };
  } };
  const query = (account,signal,settings) => queryImportedAccountQuota(account,signal,settings,client);
  const run = (entries, settings = {}) => service.importAccounts(entries,index,{query,provider,...settings});
  const seed = (name, expired = false, extra = {}) => {
    const account = { id: randomUUID(), label:'Saved '+name, expectedEmail:name+'@example.test', capturedAt:new Date(NOW-1000).toISOString(), identitySource:'hub', hostId:'synthetic-host', verifiedSubject:'subject-'+name, ...extra, slots:{keyring:token(name,expired),file:token(name,expired)} };
    const {slots:_slots,...metadata}=account; void _slots; rows.push(metadata);data.set(ACCOUNT_PREFIX+account.id,JSON.stringify(account));return metadata;
  };
  return {data,vault,index,service,events,run,seed,provider,query,rows:()=>rows,setRows:value=>{rows=value;},exchanges:()=>exchanges,official:()=>official};
}
const accountRecords = f => new Map([...f.data].filter(([key])=>key.startsWith(ACCOUNT_PREFIX)));
const candidateRecords = f => [...f.data].filter(([key])=>key.startsWith(IMPORT_CANDIDATE_PREFIX)).map(([,raw])=>JSON.parse(raw)).filter(record=>record.account);

test('fresh candidates run identity → quota → identity, persist verified subjects and never touch official slots',async()=>{
  const f=fixture();const rows=await f.run([entry('a'),entry('b')]);
  assert.deepEqual(f.events.filter(([event])=>['identity','quota'].includes(event)).map(([event])=>event),['identity','quota','identity','identity','quota','identity']);
  assert.deepEqual(rows.map(row=>row.verifiedSubject),['subject-a','subject-b']);assert.ok(rows.every(row=>row.migrationState==='verified'));assert.equal(f.official(),0);assert.equal(f.exchanges(),0);assert.equal(candidateRecords(f).length,0);
});
test('replace matches email AND host; duplicate legacy rows require an explicit exact target',async()=>{
  const f=fixture(), a=f.seed('a'), duplicate=f.seed('a'), other=f.seed('b',false,{hostId:'another-host'});
  await assert.rejects(f.run([entry('a')]),/MIGRATION_TARGET_REQUIRED/);
  await assert.rejects(f.run([entry('a')],{replace:{'a@example.test':other.id}}),/MIGRATION_TARGET_REQUIRED/);
  await f.run([entry('a')],{replace:{'a@example.test':duplicate.id}});
  assert.deepEqual(f.rows().map(row=>row.id),[a.id,duplicate.id,other.id]);assert.equal(f.rows()[0].label,a.label);assert.equal(f.rows()[1].label,'Imported a');
});
test('50 saved accounts allow replacement, while only additions count against capacity',async()=>{
  const f=fixture(), a=f.seed('a');for(let n=0;n<49;n++)f.seed('x'+n);
  await f.run([entry('a')],{replace:{'a@example.test':a.id}});assert.equal(f.rows().length,50);
  const before=accountRecords(f);await assert.rejects(f.run([entry('new')]),/SAVED_ACCOUNT_LIMIT/);assert.deepEqual(accountRecords(f),before);
});
test('same-email different server subject or identity change cannot replace the original',async()=>{
  for(const late of [false,true]) {
    let identities=0;
    const f=fixture({transport:async request=>request.endpoint==='quota'?{buckets:[{displayName:'Window',remainingFraction:0.4}]}:{email:'a@example.test',id:++identities===1&&late?'subject-a':'different-subject',verified_email:true}}),a=f.seed('a'),before=accountRecords(f);
    await assert.rejects(f.run([entry('a')],{replace:{'a@example.test':a.id}}),/ACCOUNT_QUOTA_IDENTITY_MISMATCH/);assert.deepEqual(accountRecords(f),before);assert.deepEqual(f.rows(),[a]);
  }
});
test('no quota, 403 eligibility, 429 and quota network timeout preserve a valid identity with distinct quota errors',async()=>{
  for(const code of ['ACCOUNT_QUOTA_EMPTY','ACCOUNT_QUOTA_FORBIDDEN','ACCOUNT_QUOTA_RATE_LIMITED','ACCOUNT_QUOTA_TIMEOUT','ACCOUNT_QUOTA_REQUEST_FAILED']) {
    let result;const f=fixture({transport:async request=>{if(request.endpoint==='quota')throw new LiveError(code);return {email:'a@example.test',id:'subject-a',verified_email:true};}});
    const [row]=await f.run([entry('a')],{quota:(_row,value)=>{result=value;}});assert.equal(row.migrationState,'verified');assert.equal(result.quotaError,code);assert.equal(result.proof.authValid,true);assert.deepEqual(result.proof.buckets,[]);
  }
});
test('identity 401 rejection and network timeout fail safely with separate errors and retain originals',async()=>{
  for(const code of ['ACCOUNT_QUOTA_REAUTH_REQUIRED','ACCOUNT_QUOTA_TIMEOUT','ACCOUNT_QUOTA_REQUEST_FAILED']) {
    const f=fixture({transport:async()=>{throw new LiveError(code);},exchange:async()=>{throw new LiveError('ACCOUNT_QUOTA_REAUTH_REQUIRED');}}),a=f.seed('a'),before=accountRecords(f);
    await assert.rejects(f.run([entry('a')],{replace:{'a@example.test':a.id}}),new RegExp(code));assert.deepEqual(accountRecords(f),before);assert.deepEqual(f.rows(),[a]);
  }
});
test('cancel during refresh persists returned rotation; retry never exchanges the old refresh token again',async()=>{
  let finish;const abort=new AbortController();const f=fixture({exchange:async()=>new Promise(resolve=>{finish=resolve;})});
  const work=f.run([entry('a',true)],{signal:abort.signal});while(!finish)await tick();abort.abort();finish({access_token:'synthetic-new-a',refresh_token:'synthetic-rotated-a',expires_in:3600});
  await assert.rejects(work,/QUOTA_QUERY_CANCELLED/);assert.equal(f.rows().length,0);assert.match(JSON.stringify(candidateRecords(f)),/synthetic-rotated-a/);
  const [row]=await f.run([entry('a',true)]);assert.equal(f.exchanges(),1);assert.match(f.data.get(ACCOUNT_PREFIX+row.id),/synthetic-rotated-a/);assert.equal(f.official(),0);
});
test('mixed add/replace index failure restores metadata but keeps shared-grant rotation in original credentials',async()=>{
  const f=fixture(),a=f.seed('a',true),b=f.seed('b');let fail=true;const write=f.index.write;
  f.index.write=async value=>{await write(value);if(fail){fail=false;throw Error('synthetic index failure');}};
  await assert.rejects(f.run([entry('a',true),entry('c')],{replace:{'a@example.test':a.id}}),/MIGRATION_IMPORT_FAILED/);
  assert.deepEqual(f.rows(),[a,b]);assert.match(f.data.get(ACCOUNT_PREFIX+a.id),/synthetic-rotated-a/);assert.equal(accountRecords(f).size,2);assert.match(JSON.stringify(candidateRecords(f)),/synthetic-rotated-a/);
  await f.run([entry('a',true),entry('c')],{replace:{'a@example.test':a.id}});assert.equal(f.exchanges(),1);assert.equal(f.rows().length,3);assert.equal(f.rows()[0].id,a.id);
});
test('refresh identity network failure leaves candidate and same-grant original quarantine intact; restart resumes rotation',async()=>{
  let failing=true;const f=fixture({transport:async request=>{if(failing)throw new LiveError('ACCOUNT_QUOTA_REQUEST_FAILED');return request.endpoint==='identity'?{email:'a@example.test',id:'subject-a',verified_email:true}:{buckets:[{displayName:'Window',remainingFraction:0.4}]};}}),a=f.seed('a',true);
  await assert.rejects(f.run([entry('a',true)],{replace:{'a@example.test':a.id}}),/ACCOUNT_QUOTA_REFRESH_PENDING/);
  assert.ok(f.data.has(QUOTA_PENDING_PREFIX+a.id));assert.match(JSON.stringify(candidateRecords(f)),/synthetic-rotated-a/);assert.match(f.data.get(ACCOUNT_PREFIX+a.id),/synthetic-refresh-a/);
  // Fresh SecretVault identity simulates a process restart; no in-memory rotation is available.
  const vault={get:async key=>f.data.get(key),store:async(key,raw)=>{f.data.set(key,raw);},delete:async key=>{f.data.delete(key);}};
  failing=false;const service=new LiveSwitchService(vault,{read:async()=>{throw Error('official');},write:async()=>{throw Error('official');}},'synthetic-host');
  await service.importAccounts([entry('a',true)],f.index,{replace:{'a@example.test':a.id},query:f.query,provider:f.provider});assert.equal(f.exchanges(),1);assert.match(f.data.get(ACCOUNT_PREFIX+a.id),/synthetic-rotated-a/);assert.ok(!f.data.has(QUOTA_PENDING_PREFIX+a.id));
});
test('uncertain refresh after restart cannot re-exchange old grant or install original stale slots',async()=>{
  const f=fixture({exchange:async()=>{throw new LiveError('ACCOUNT_QUOTA_REFRESH_OUTCOME_UNKNOWN');}}),a=f.seed('a',true);
  await assert.rejects(f.run([entry('a',true)],{replace:{'a@example.test':a.id}}),/ACCOUNT_QUOTA_REFRESH_OUTCOME_UNKNOWN/);assert.ok(f.data.has(QUOTA_UNKNOWN_PREFIX+a.id));
  await assert.rejects(f.run([entry('a',true)],{replace:{'a@example.test':a.id}}),/ACCOUNT_QUOTA_REFRESH_OUTCOME_UNKNOWN/);assert.equal(f.exchanges(),1);assert.equal(await f.service.savedLoginUsable(a),false);
  await assert.rejects(f.service.install(a.id,{}),/ACCOUNT_QUOTA_REFRESH_OUTCOME_UNKNOWN/);assert.equal(f.official(),0);
});
test('every SecretStorage get/store/delete and index step failing before or after operation remains recoverable',async()=>{
  const baseline=fixture(),a=baseline.seed('a'),b=baseline.seed('b');baseline.events.length=0;await baseline.run([entry('a'),entry('c')],{replace:{'a@example.test':a.id}});
  const steps=baseline.events.filter(([event])=>['get','store','delete','index'].includes(event)).length;
  for(const after of [false,true])for(let fault=1;fault<=steps;fault++) {
    const f=fixture(),oldA=f.seed('a'),oldB=f.seed('b');let count=0,failed=false;
    for(const method of ['get','store','delete']){const original=f.vault[method];f.vault[method]=async(...args)=>{const hit=++count===fault;if(hit&&!after){failed=true;throw Error('synthetic-storage-fault');}const value=await original(...args);if(hit){failed=true;throw Error('synthetic-storage-fault');}return value;};}
    const write=f.index.write;f.index.write=async value=>{const hit=++count===fault;if(hit&&!after){failed=true;throw Error('synthetic-index-fault');}await write(value);if(hit){failed=true;throw Error('synthetic-index-fault');}};
    try {await f.run([entry('a'),entry('c')],{replace:{'a@example.test':oldA.id}});}catch(error){assert.ok(error instanceof Error);}
    if(!failed)continue;
    await f.service.recoverImport(f.index);
    const rows=f.rows();assert.equal(rows[0].id,oldA.id);assert.deepEqual(rows[1],oldB);assert.ok(rows.length===2||rows.length===3,`fault ${fault}/${after}`);
    assert.equal(rows[0].label,rows.length===2?oldA.label:'Imported a');assert.equal(accountRecords(f).size,rows.length);
    for(const row of rows){const account=JSON.parse(f.data.get(ACCOUNT_PREFIX+row.id));const {slots:_slots,...metadata}=account;void _slots; assert.deepEqual(metadata,row);}
    assert.equal(f.official(),0);
  }
  assert.ok(steps>40);void b;
});
test('crash at each mixed-batch mutation recovers all original or all committed rows while preserving unrelated rows',async()=>{
  const baseline=fixture(),a=baseline.seed('a');baseline.seed('b');baseline.events.length=0;await baseline.run([entry('a'),entry('c')],{replace:{'a@example.test':a.id}});
  const mutations=baseline.events.filter(([event])=>['store','delete','index'].includes(event)).length;
  for(let crash=1;crash<=mutations;crash++){
    const f=fixture(),old=f.seed('a');f.seed('b');let count=0,dead=false;
    for(const method of ['get','store','delete']){const original=f.vault[method];f.vault[method]=async(...args)=>{if(dead)throw Error('process stopped');const value=await original(...args);if(method!=='get'&&++count===crash){dead=true;throw Error('process stopped');}return value;};}
    const write=f.index.write;f.index.write=async value=>{if(dead)throw Error('process stopped');await write(value);if(++count===crash){dead=true;throw Error('process stopped');}};
    try{await f.run([entry('a'),entry('c')],{replace:{'a@example.test':old.id}});}catch{ /* Abrupt stop prohibits rollback in this instance. */ }
    const unrelated=f.seed('unrelated');
    const vault={get:async key=>f.data.get(key),store:async(key,raw)=>{f.data.set(key,raw);},delete:async key=>{f.data.delete(key);}};
    await new AccountImportTransaction(vault,'synthetic-host').recover({read:f.index.read,write});
    assert.ok(f.rows().length===3||f.rows().length===4);assert.ok(f.rows().some(row=>row.id===unrelated.id));assert.equal(f.rows()[0].label,f.rows().length===3?'Saved a':'Imported a');assert.equal(accountRecords(f).size,f.rows().length);
  }
});
test('duplicate in-flight imports reject, cancellation discards late identity response and later import can proceed',async()=>{
  let release;const abort=new AbortController();const f=fixture({transport:async request=>{if(request.endpoint==='identity'&&!release)return new Promise(resolve=>{release=()=>resolve({email:'a@example.test',id:'subject-a',verified_email:true});});return request.endpoint==='identity'?{email:'a@example.test',id:'subject-a',verified_email:true}:{buckets:[{displayName:'Window',remainingFraction:0.4}]};}});
  const work=f.run([entry('a')],{signal:abort.signal});while(!release)await tick();await assert.rejects(f.run([entry('a')]),/ACCOUNT_QUOTA_ALREADY_RUNNING/);abort.abort();await assert.rejects(work,/QUOTA_QUERY_CANCELLED/);release();await tick();assert.equal(f.rows().length,0);await f.run([entry('a')]);assert.equal(f.rows().length,1);
});
test('concurrent unrelated index/target secret change is detected without overwriting independent credentials',async()=>{
  const f=fixture(),a=f.seed('a');let changed=false;const query=f.query;
  await assert.rejects(f.run([entry('a')],{replace:{'a@example.test':a.id},query:async(...args)=>{const result=await query(...args);if(!changed){changed=true;f.seed('unrelated');}return result;}}),/MIGRATION_INDEX_CHANGED/);assert.equal(f.rows()[0].label,'Saved a');assert.equal(f.rows().length,2);
});
test('export of unfinished refresh is read-only and never repairs SecretStorage or index',async()=>{
  const f=fixture(),a=f.seed('a');const before=f.data.get(ACCOUNT_PREFIX+a.id);
  f.data.set(QUOTA_REFRESH_PREFIX+a.id,JSON.stringify({schema:1,accountId:a.id,before,after:before}));const data=new Map(f.data),rows=f.rows();
  await assert.rejects(f.service.exportAccounts([a.id]),/CAPTURE_CREDENTIAL_RECOVERY_REQUIRED/);assert.deepEqual(f.data,data);assert.deepEqual(f.rows(),rows);assert.equal(f.official(),0);
});

test('concurrent target-secret replacement is preserved even when its metadata stays unchanged',async()=>{
  const f=fixture(),a=f.seed('a');const original=f.data.get(ACCOUNT_PREFIX+a.id);let external;const query=f.query;
  await assert.rejects(f.run([entry('a')],{replace:{'a@example.test':a.id},query:async(...args)=>{const result=await query(...args);const value=JSON.parse(original);value.slots.file=value.slots.keyring=token('a',false,'independent');external=JSON.stringify(value);f.data.set(ACCOUNT_PREFIX+a.id,external);return result;}}),/MIGRATION_INDEX_CHANGED/);
  assert.equal(f.data.get(ACCOUNT_PREFIX+a.id),external);assert.deepEqual(f.rows(),[a]);
});
test('every refresh persistence step failing before/after mutation can retry without reusing a rotated grant',async()=>{
  const baseline=fixture(),a=baseline.seed('a',true);baseline.events.length=0;await baseline.run([entry('a',true)],{replace:{'a@example.test':a.id}});
  const steps=baseline.events.filter(([event])=>['get','store','delete','index'].includes(event)).length;
  for(const after of [false,true])for(let fault=1;fault<=steps;fault++){
    const f=fixture(),old=f.seed('a',true);let count=0;
    for(const method of ['get','store','delete']){const original=f.vault[method];f.vault[method]=async(...args)=>{const hit=++count===fault;if(hit&&!after)throw Error('synthetic-fault');const result=await original(...args);if(hit)throw Error('synthetic-fault');return result;};}
    const write=f.index.write;f.index.write=async value=>{const hit=++count===fault;if(hit&&!after)throw Error('synthetic-fault');await write(value);if(hit)throw Error('synthetic-fault');};
    let firstError; try{await f.run([entry('a',true)],{replace:{'a@example.test':old.id}});}catch(error){ firstError=error.code; }
    const trace=f.events.slice(-9).map(([method,key])=>[method,key.slice(0,36)]);
    await f.service.recoverImport(f.index);
    try { await f.run([entry('a',true)],{replace:{'a@example.test':old.id}}); } catch(error) { throw new Error(`refresh step ${fault}/${after}: ${error.code}; exchanges=${f.exchanges()}; first=${firstError}; trace=${JSON.stringify(trace)}; candidate=${JSON.stringify(candidateRecords(f).map(c=>({next:!!c.next,response:!!c.response,exchanging:c.exchanging})))}; pending=${f.data.has(QUOTA_PENDING_PREFIX+old.id)}; unknown=${f.data.has(QUOTA_UNKNOWN_PREFIX+old.id)}`); }
    // If no exchange preceded the injected failure, the retry exchanges once.
    // If it did, all retries must validate and save the retained rotated response.
    assert.equal(f.exchanges(),1,`refresh step ${fault}/${after}`);
    assert.match(f.data.get(ACCOUNT_PREFIX+old.id),/synthetic-rotated-a/);assert.equal(f.official(),0);
  }
});

test('removing a saved copy removes its retained rotated import credentials as well',async()=>{
  const f=fixture(),a=f.seed('a',true);await f.run([entry('a',true)],{replace:{'a@example.test':a.id}});assert.ok(candidateRecords(f).length);
  await f.service.removeImportCandidates(a.id);assert.equal(candidateRecords(f).length,0);assert.ok([...f.data.keys()].every(key=>!key.startsWith(IMPORT_CANDIDATE_PREFIX)));assert.equal(f.official(),0);
});

test('archive binding follows later verified saved-quota rotations without reinstalling its older refresh token',async()=>{
  const f=fixture(),a=f.seed('a',true);await f.run([entry('a',true)],{replace:{'a@example.test':a.id}});const saved=await f.service.account(a.id),next=structuredClone(saved.slots);
  for(const key of ['keyring','file']){const envelope=JSON.parse(next[key]);envelope.token.access_token='synthetic-access-a';envelope.token.refresh_token='synthetic-later-grant';next[key]=JSON.stringify(envelope);}
  await f.service.commitQuotaRefresh(a.id,saved.slots,next);await f.run([entry('a',true)],{replace:{'a@example.test':a.id}});assert.equal(f.exchanges(),1);assert.match(f.data.get(ACCOUNT_PREFIX+a.id),/synthetic-later-grant/);
});

test('fresh independently verified credentials can explicitly replace an uncertain old grant without losing rollback quarantine',async()=>{
  for(const fail of [false,true]){
    const f=fixture({exchange:async()=>{throw new LiveError('ACCOUNT_QUOTA_REFRESH_OUTCOME_UNKNOWN');}}),a=f.seed('a',true);
    await assert.rejects(f.run([entry('a',true)],{replace:{'a@example.test':a.id}}),/ACCOUNT_QUOTA_REFRESH_OUTCOME_UNKNOWN/);const before=f.data.get(ACCOUNT_PREFIX+a.id);
    if(fail){let failed=false;const write=f.index.write;f.index.write=async value=>{await write(value);if(!failed){failed=true;throw Error('synthetic index failure');}};}
    const work=f.run([entry('a',false,'independent')],{replace:{'a@example.test':a.id}});
    if(fail){await assert.rejects(work,/MIGRATION_IMPORT_FAILED/);assert.equal(f.data.get(ACCOUNT_PREFIX+a.id),before);assert.ok(f.data.has(QUOTA_UNKNOWN_PREFIX+a.id));}
    else{await work;assert.equal(f.rows()[0].id,a.id);assert.match(f.data.get(ACCOUNT_PREFIX+a.id),/synthetic-refresh-independent/);assert.ok(!f.data.has(QUOTA_UNKNOWN_PREFIX+a.id));assert.equal(await f.service.savedLoginUsable(f.rows()[0]),true);}
    assert.equal(f.official(),0);
  }
});

test('cleanup crash after replacing an uncertain grant finalizes the verified account and owned old markers',async()=>{
  const f=fixture({exchange:async()=>{throw new LiveError('ACCOUNT_QUOTA_REFRESH_OUTCOME_UNKNOWN');}}),a=f.seed('a',true);
  await assert.rejects(f.run([entry('a',true)],{replace:{'a@example.test':a.id}}),/ACCOUNT_QUOTA_REFRESH_OUTCOME_UNKNOWN/);
  const remove=f.vault.delete;let failed=false;f.vault.delete=async key=>{if(key===QUOTA_UNKNOWN_PREFIX+a.id&&!failed){failed=true;throw Error('synthetic cleanup crash');}return remove(key);};
  await assert.rejects(f.run([entry('a',false,'independent')],{replace:{'a@example.test':a.id}}),/MIGRATION_ROLLBACK_REQUIRED/);assert.match(f.data.get(ACCOUNT_PREFIX+a.id),/synthetic-refresh-independent/);
  await f.service.recoverImport(f.index);assert.equal(f.rows()[0].id,a.id);assert.ok(!f.data.has(QUOTA_UNKNOWN_PREFIX+a.id));assert.match(f.data.get(ACCOUNT_PREFIX+a.id),/synthetic-refresh-independent/);assert.equal(f.official(),0);
});
