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

test('quota UI keeps successful preferences across old whole-state echoes and subsequent view writes',async()=>{
 const {quotaUiStorage}=require('../out/quota-ui-storage');let data={};const writes=[];
 const raw={get:k=>data[k],update:async(k,v)=>{data[k]=structuredClone(v);writes.push(k)}};
 const ui=quotaUiStorage(raw);assert.equal(quotaUiStorage(raw),ui);const prefs=new QuotaPreferences(ui),key=quotaEntries(account)[0].key;
 await prefs.pin(account,key);const oldPin=structuredClone(data);
 await prefs.favorite(key);await prefs.favoriteImage('synthetic-image');const current=structuredClone(data);
 data=oldPin;assert.deepEqual(prefs.getState().favorites,[key]);assert.deepEqual(prefs.getState().imageFavorites,['synthetic-image']);
 await ui.update('antigravityAccounts.quotaViewState',{sort:'low',expanded:{Gemini:true}});
 assert.deepEqual(data['quota.presentation.v1'],current['quota.presentation.v1']);assert.deepEqual(data['antigravityAccounts.quotaViewState'],{sort:'low',expanded:{Gemini:true}});
 for(let n=0;n<80;n++)await ui.update('antigravityAccounts.quotaViewState',{sort:'low',expanded:{Gemini:true},sequence:n});data=oldPin;assert.deepEqual(prefs.getState().favorites,[key]);assert.deepEqual(prefs.getState().imageFavorites,['synthetic-image']);
 data={};assert.deepEqual(prefs.getState().favorites,[key]);data=current;await prefs.favorite('another');assert.deepEqual(prefs.getState().favorites,[key,'another']);
 // Reopening the extension reads the existing keys, with no account/history migration.
 const reopened=quotaUiStorage({get:k=>data[k],update:raw.update});assert.deepEqual(reopened.get('quota.presentation.v1'),prefs.getState());assert.equal(reopened.get('antigravityAccounts.quotaViewState').sort,'low');
 assert.ok(writes.every(k=>['quota.presentation.v1','antigravityAccounts.quotaViewState','quota.ui.revision.v1'].includes(k)));
});

test('quota UI adopts another window revision and keeps failed updates out of its committed snapshot',async()=>{
 const {quotaUiStorage}=require('../out/quota-ui-storage');let data={'quota.presentation.v1':{favorites:['existing'],imageFavorites:[]}},fail=false;
 const raw={get:k=>data[k],update:async(k,v)=>{data[k]=structuredClone(v);if(fail)throw Error('synthetic storage failure')}};
 const ui=quotaUiStorage(raw),prefs=new QuotaPreferences(ui);const baseline=structuredClone(data);
 fail=true;await assert.rejects(prefs.favorite('failed'));assert.deepEqual(prefs.getState().favorites,['existing']);
 data=baseline;fail=false;await prefs.favorite('saved');assert.deepEqual(prefs.getState().favorites,['existing','saved']);
 data={'quota.ui.revision.v1':'another-window-revision','quota.presentation.v1':{favorites:['external'],imageFavorites:['external-image']},'antigravityAccounts.quotaViewState':{sort:'reset'}};
 assert.deepEqual(prefs.getState().favorites,['external']);await prefs.pin(account,'new');assert.deepEqual(prefs.getState().favorites,['external']);assert.equal(data['antigravityAccounts.quotaViewState'].sort,'reset');
});

test('queued preference transform reads an external revision when its shared UI turn actually begins',async()=>{
 const {quotaUiStorage}=require('../out/quota-ui-storage');let data={'quota.presentation.v1':{favorites:['base'],imageFavorites:[]}},release,hold=true;
 const raw={get:k=>data[k],update:async(k,v)=>{data[k]=structuredClone(v);if(hold&&k==='antigravityAccounts.quotaViewState')await new Promise(resolve=>release=resolve)}};
 const ui=quotaUiStorage(raw),prefs=new QuotaPreferences(ui);const view=ui.update('antigravityAccounts.quotaViewState',{sort:'low'});
 while(!release)await new Promise(setImmediate);const favorite=prefs.favorite('local');await new Promise(setImmediate);
 data={'quota.ui.revision.v1':'another-window-new','quota.presentation.v1':{favorites:['external'],imageFavorites:['external-image']},'antigravityAccounts.quotaViewState':{sort:'reset'}};
 hold=false;release();await Promise.all([view,favorite]);assert.deepEqual(prefs.getState().favorites,['external','local']);assert.deepEqual(prefs.getState().imageFavorites,['external-image']);assert.equal(data['antigravityAccounts.quotaViewState'].sort,'reset');
});
