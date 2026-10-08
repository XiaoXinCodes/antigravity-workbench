const test=require('node:test');
const assert=require('node:assert/strict');
const {RecoveryVerification}=require('../out/recovery-verification');
const {verificationClock,settle}=require('./fixtures/verification-clock.cjs');
test('idle controllers and later transactions each get an independent 90-second window',async()=>{
 const clock=verificationClock(),windows=new RecoveryVerification(clock);clock.jump(3_600_000);
 const first=windows.bind('first','installed');assert.equal(first.deadline,3_690_000);
 await clock.advance(89_000);assert.equal(windows.bind('first','installed'),first);windows.assertReady(first);
 await clock.advance(1000);assert.throws(()=>windows.assertReady(first),/RECOVERY_VERIFICATION_TIMEOUT/);
 assert.equal(windows.bind('first','installed'),first,'focus refresh must not extend expired work');
 const second=windows.bind('second','installed');assert.equal(second.deadline,clock.now()+90_000);windows.assertReady(second);
 await clock.advance(80_000);const restored=windows.bind('second','restored');assert.equal(restored.deadline,clock.now()+90_000);
 windows.dispose();
});
test('automatic retries stop at the deadline and cannot be restarted by repeated focus refreshes',async()=>{
 const clock=verificationClock();let attempts=0,expired=0;const windows=new RecoveryVerification(clock,()=>expired++),lease=windows.bind('retry','installed');
 const retry=()=>{attempts++;windows.schedule(lease,retry);};windows.schedule(lease,retry);
 await clock.advance(900_000);assert.equal(expired,1);assert.ok(attempts>0&&attempts<=60);const before=attempts;
 for(let n=0;n<10;n++)assert.equal(windows.schedule(windows.bind('retry','installed'),retry),false);
 await clock.advance(900_000);assert.equal(attempts,before);assert.equal(clock.timers.size,0);windows.dispose();
});
test('an already queued old callback cannot run against a new transaction or erase its timer',async()=>{
 const clock=verificationClock(),windows=new RecoveryVerification(clock),old=windows.bind('old','installed');let stale=0,current=0;
 windows.schedule(old,()=>stale++);const oldCallback=[...clock.timers].find(t=>t.at===1500).callback;
 const next=windows.bind('new','installed');windows.schedule(next,()=>current++);oldCallback();
 await clock.advance(1500);assert.equal(stale,0);assert.equal(current,1);windows.dispose();
});
test('late RPC completion after timeout is discarded and cannot satisfy restored identity',async()=>{
 const clock=verificationClock(),windows=new RecoveryVerification(clock),lease=windows.bind('same','installed');let finish,signal;
 const pending=windows.proof(lease,s=>{signal=s;return new Promise(resolve=>{finish=resolve;});});
 const rejected=assert.rejects(pending,/RECOVERY_VERIFICATION_TIMEOUT/);await settle();await clock.advance(90_000);await rejected;assert.equal(signal.aborted,true);
 const restored=windows.bind('same','restored');finish('wrong late identity');await settle();windows.assertReady(restored);
 assert.equal(await windows.proof(restored,async()=> 'original identity'),'original identity');windows.dispose();
});
test('explicit verification renews only its lease and invalidates pending reads of the old attempt',async()=>{
 const clock=verificationClock(),windows=new RecoveryVerification(clock),old=windows.bind('same','restored');let finish;
 const pending=windows.proof(old,()=>new Promise(resolve=>{finish=resolve;}));const rejected=assert.rejects(pending,/RECOVERY_VERIFICATION_STALE/);await settle();
 clock.jump(50_000);const renewed=windows.bind('same','restored',true);await rejected;
 assert.notEqual(renewed,old);assert.equal(renewed.deadline,140_000);finish('old');await settle();windows.assertReady(renewed);windows.dispose();
});
