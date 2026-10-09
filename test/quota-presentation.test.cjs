const test=require('node:test'),assert=require('node:assert/strict');
const q=require('../out/quota-presentation'),{imageQuotaPercent}=require('../out/image-quota');
const account=(id,buckets,extra={})=>({id,expectedEmail:id+'@example.test',capturedAt:'2026-10-01T00:00:00Z',hostId:'synthetic',hostCurrent:true,quota:{phase:'ready',snapshot:{source:'server',email:id+'@example.test',observedAt:'2026-10-09T10:00:00Z',buckets}},...extra});
test('shared quota rules distinguish unknown, zero, subfull and disabled',()=>{
 for(const invalid of [undefined,null,'0',NaN,Infinity,-.1,1.1])assert.equal(q.quotaFraction(invalid),null);
 assert.equal(q.quotaValue({remaining:null}),'未知');assert.equal(q.quotaValue({remaining:0}),'0.00%');
 assert.equal(q.quotaPercent(.996),'99.60%');assert.equal(q.quotaPercent(.999999),'接近 100%（未满）');assert.equal(q.quotaPercent(1),'100.00%');
 assert.equal(imageQuotaPercent,q.quotaPercent);assert.equal(q.quotaValue({remaining:1,disabled:true}),'不可用');assert.equal(q.quotaValue({remaining:null,remainingAmount:'0'}),'0');
});
test('invalid, future, aged and failed readings are old without changing observed time',()=>{
 const now=Date.parse('2026-10-09T10:01:00Z');for(const time of ['bad','2026-10-09T10:02:00Z','2026-10-09T10:00:00Z'])assert.equal(q.quotaIsStale(time,now),true);
 assert.equal(q.quotaIsStale('2026-10-09T10:00:01Z',now),false);
 const a=account('a',[]);a.quota.phase='error';assert.equal(q.accountQuotaStale(a,now-59999),true);assert.equal(a.quota.snapshot.observedAt,'2026-10-09T10:00:00Z');
 a.quota.snapshot.email='different@example.test';assert.equal(q.accountQuotaSnapshot(a),undefined);assert.deepEqual(q.quotaEntries(a),[]);
});
test('cross-account comparison uses actual server IDs and windows, never display names or equal fractions',()=>{
 const b={label:'Gemini',bucketId:'actual-server-id',window:'5h',remaining:.5,resetAt:null};
 const a=account('a',[b,{label:'FutureModel',remaining:.5,resetAt:null}]),other=account('b',[{...b,label:'Renamed display'},{...b,window:'7d'}]);
 const key=q.quotaEntries(a)[0].key;assert.equal(q.comparedQuota(other,key).label,'Renamed display');assert.equal(q.quotaChoices([a,other]).length,2);
 assert.equal(q.quotaEntries(a)[1].comparable,false);assert.notEqual(q.quotaBucketKey({label:'same'},'a',0),q.quotaBucketKey({label:'same'},'b',0));
 const duplicates=q.quotaEntries(account('c',[b,b]));assert.ok(duplicates.every(row=>!row.comparable));assert.notEqual(duplicates[0].key,duplicates[1].key);assert.equal(q.quotaFamily('Unmapped future model'),'other');
 assert.notEqual(q.accountDisplayFingerprint(a),q.accountDisplayFingerprint({...a,capturedAt:'2026-10-09T10:00:00Z'}));
});
