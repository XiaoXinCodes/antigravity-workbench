const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {spawnSync}=require('node:child_process');
const {queryQuota,QUOTA_ARGS}=require('../out/legacy/quota-query');
async function fixture(t,mode='ok') {
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'ag-quota-test-'));
 t.after(()=>fs.rm(directory,{recursive:true,force:true,maxRetries:20,retryDelay:100}));
 const executable=path.join(directory,process.platform==='win32'?'agy.exe':'agy');
 if(process.platform==='win32') {
  const source=path.join(directory,'fixture.cs');
  const body=mode==='hang'?'System.Threading.Thread.Sleep(120000);':mode==='fail'?'Console.Error.WriteLine("authentication required");Environment.ExitCode=1;':mode==='large'?'Console.Write(new string(\'x\',300000));':mode==='redact'?'Console.WriteLine("quota Authorization: Bearer sensitive-value");':mode==='empty'?'':`Console.WriteLine("quota-report "+string.Join("|",a));`;
  await fs.writeFile(source,`using System; class Fixture {static void Main(string[] a){${body}}}`);
  const compiler=path.join(process.env.SystemRoot||'C:\\Windows','Microsoft.NET','Framework64','v4.0.30319','csc.exe');
  const r=spawnSync(compiler,['/nologo','/platform:x64','/out:'+executable,source],{encoding:'utf8',timeout:30000});if(r.status!==0)throw Error(r.stdout+r.stderr);
 } else {
  const body=mode==='hang'?'setTimeout(()=>{},120000)':mode==='fail'?'console.error("authentication required");process.exitCode=1':mode==='large'?'process.stdout.write("x".repeat(300000))':mode==='redact'?'console.log("quota Authorization: Bearer sensitive-value")':mode==='empty'?'':'console.log("quota-report "+process.argv.slice(2).join("|"))';
  await fs.writeFile(executable,`#!/usr/bin/env node\n${body}\n`,{mode:0o700});
 }
 return executable;
}
test('server query invokes fixed official built-in with no cache fallback or account guessing',async t=>{
 const exe=await fixture(t);assert.deepEqual(QUOTA_ARGS,['--print','/usage']);const r=await queryQuota(exe);
 assert.equal(r.source,'official-cli-server-query');assert.equal(r.report,'quota-report --print|/usage');assert.equal(r.identity,null);assert.equal(r.serverUpdatedAt,null);assert.ok(Date.parse(r.completedAt)>=Date.parse(r.requestedAt));
});
test('query surfaces authentication failure instead of stale data',async t=>{await assert.rejects(queryQuota(await fixture(t,'fail')),/QUOTA_AUTH_REQUIRED/);});
test('query rejects empty output',async t=>{await assert.rejects(queryQuota(await fixture(t,'empty')),/QUOTA_REPORT_EMPTY/);});
test('query bounds output',async t=>{await assert.rejects(queryQuota(await fixture(t,'large')),/QUOTA_REPORT_TOO_LARGE/);});
test('query timeout terminates child and is retryable',async t=>{await assert.rejects(queryQuota(await fixture(t,'hang'),undefined,300),/QUOTA_QUERY_TIMEOUT/);assert.match((await queryQuota(await fixture(t))).report,/quota-report/);});
test('query cancellation terminates child; cancelled-before-start never spawns',async t=>{const exe=await fixture(t,'hang');const c=new AbortController();const p=queryQuota(exe,c.signal);setTimeout(()=>c.abort(),300);await assert.rejects(p,/QUOTA_QUERY_CANCELLED/);await assert.rejects(queryQuota('does-not-exist',c.signal),/QUOTA_QUERY_CANCELLED/);});

test('raw CLI report redacts common credential strings before display',async t=>{const r=await queryQuota(await fixture(t,'redact'));assert.ok(!r.report.includes('sensitive-value'));assert.match(r.report,/REDACTED/);});
