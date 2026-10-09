const test=require('node:test'),assert=require('node:assert/strict');
const {QuotaPreferences,pinnedQuota,readQuotaPreferences}=require('../out/quota-preferences'),{quotaEntries}=require('../out/quota-presentation');
const account={id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',expectedEmail:'synthetic@example.test',hostId:'host',hostCurrent:true,capturedAt:'original',quota:{phase:'ready',snapshot:{source:'server',email:'synthetic@example.test',observedAt:'2026-10-09T00:00:00Z',buckets:[{bucketId:'server-id',label:'Gemini',remaining:.5}]}}};
test('favorites and optional pin persist serially; pin follows metadata identity, not current official login',async()=>{
 const storage=new Map(),prefs=new QuotaPreferences({get:k=>storage.get(k),update:async(k,v)=>{await new Promise(setImmediate);storage.set(k,v)}});const key=quotaEntries(account)[0].key;
 assert.equal(prefs.getState().pin,undefined);await Promise.all([prefs.favorite(key),prefs.favoriteImage('actual-image-model-id'),prefs.pin(account,key)]);
 assert.deepEqual(prefs.getState().favorites,[key]);assert.deepEqual(prefs.getState().imageFavorites,['actual-image-model-id']);assert.equal(pinnedQuota([account],prefs.getState().pin).account,account);
 assert.equal(pinnedQuota([{...account,capturedAt:'replacement'}],prefs.getState().pin),undefined);assert.equal(pinnedQuota([{...account,hostCurrent:false}],prefs.getState().pin),undefined);
 await prefs.pin();assert.equal(prefs.getState().pin,undefined);assert.deepEqual(prefs.getState().favorites,[key]);
});
test('storage failure leaves previous preference and queue remains usable; malformed storage is bounded',async()=>{
 let value={favorites:['keep'],imageFavorites:[]},fail=true;const prefs=new QuotaPreferences({get:()=>value,update:async(_k,v)=>{if(fail)throw Error('synthetic save failure');value=v}});
 await assert.rejects(prefs.favorite('new'));assert.deepEqual(prefs.getState().favorites,['keep']);fail=false;await prefs.favorite('new');assert.deepEqual(prefs.getState().favorites,['keep','new']);
 const parsed=readQuotaPreferences({favorites:['ok','ok',4,'x'.repeat(1001),...Array.from({length:400},(_,i)=>String(i))],imageFavorites:null,pin:{accountId:'not-id',key:'k',fingerprint:'f'}});assert.equal(parsed.favorites.length,300);assert.deepEqual(parsed.imageFavorites,[]);assert.equal(parsed.pin,undefined);
});
