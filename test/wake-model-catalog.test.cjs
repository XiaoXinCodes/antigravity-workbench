const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {wakeModelsFromCatalog:parse,wakeCatalogPayload}=require('../out/wake-model-catalog');
const {imageModelsFromCatalog}=require('../out/direct-image-binding');
const {readAccountModelCatalog}=require('../out/account-model-catalog');
const {readSavedImageModels}=require('../out/saved-image-models');
const {sendWake}=require('../out/wake-transport');
const {catalog}=require('./fixtures/conversation-catalog.cjs');
test('server agent choices use exact map keys, preserving multimodal input support and excluding image generation',()=>{
 const raw=catalog();assert.deepEqual(parse(raw).map(x=>x.id),['synthetic-text-alpha','synthetic-unlisted-model']);assert.equal(parse(raw)[1].classification,'unclassified');
 assert.match(parse(raw)[0].label,/synthetic-text-alpha/);assert.deepEqual(imageModelsFromCatalog(raw).map(x=>x.id),['synthetic-image-model']);
 assert.ok(raw.models['synthetic-text-alpha'].supportsImages);assert.equal(raw.models['synthetic-text-alpha'].model,'MODEL_SYNTHETIC_AGENT');
});
test('names, constants and quota pool IDs do not classify models or replace callable IDs',()=>{
 const id='future-image-named-conversation',raw=catalog(id);raw.models[id].displayName='Image capable ordinary conversation';raw.models[id].quotaInfo.bucketId='quota-pool-not-a-model';
 raw.models['synthetic-image-model'].displayName='Ordinary sounding name';raw.agentModelSorts[0].groups[0].modelIds.push('MODEL_SYNTHETIC_AGENT','quota-pool-not-a-model');
 assert.deepEqual(parse(raw).map(x=>x.id),[id,'synthetic-unlisted-model']);
});
test('server grouping preserves order and deduplicates while ignoring missing or disabled members',()=>{
 const raw=catalog('text-first');raw.models['text-second']={};raw.models['text-disabled']={disabled:true};raw.models['text-invalid']={disabled:'false'};
 raw.agentModelSorts=[{groups:[{modelIds:['text-second','text-first','text-second','text-missing','text-disabled','text-invalid']},{}, {modelIds:[]}]},{}];
 assert.deepEqual(parse(raw).map(x=>x.id),['text-second','text-first','synthetic-unlisted-model']);
});
test('legacy map with explicit image list preserves unfamiliar conversation members',()=>{
 const raw=catalog('text-future');delete raw.agentModelSorts;delete raw.models['synthetic-unlisted-model'];assert.deepEqual(parse(raw).map(x=>x.id),['text-future']);
 assert.deepEqual(parse({models:{'future-model':{}},imageGenerationModelIds:[]}).map(x=>x.id),['future-model']);
});
test('models-only legacy response keeps exact server members as unclassified without guessing from input MIME types',()=>{
 const raw=catalog();delete raw.agentModelSorts;delete raw.imageGenerationModelIds;assert.deepEqual(parse(raw).map(x=>x.id),Object.keys(raw.models));assert.ok(parse(raw).every(x=>x.classification==='unclassified'));
 assert.deepEqual(parse({models:{'text-model':{}},agentModelSorts:[]}),[{id:'text-model',label:'text-model',classification:'unclassified'}]);
});
test('root and wrapped catalog shapes normalize identically without accepting ambiguous roots',()=>{
 const raw=catalog();assert.deepEqual(parse({response:raw}),parse(raw));assert.strictEqual(wakeCatalogPayload({response:raw}),raw);
 assert.throws(()=>parse({...raw,response:raw}),/CATALOG_INVALID/);
 for(const bad of [null,[],{response:[]},{models:[]},{response:{models:[]}}])assert.throws(()=>parse(bad),/CATALOG_INVALID/);
});
test('malformed and oversized classification lists never become a permissive fallback',()=>{
 for(const value of [null,{},['unsafe model'],Array(501).fill('text-model')])assert.throws(()=>parse({...catalog(),imageGenerationModelIds:value}),/CATALOG_INVALID/);
 for(const value of [null,{},[null],[{groups:{}}],[{groups:[null]}],[{groups:[{modelIds:['unsafe model']}]}],Array(101).fill({})])assert.throws(()=>parse({...catalog(),agentModelSorts:value}),/CATALOG_INVALID/);
 const models=Object.fromEntries(Array.from({length:501},(_,i)=>['model-'+i,{}]));assert.throws(()=>parse({models,imageGenerationModelIds:[]}),/CATALOG_INVALID/);
});
function http(raw){const calls=[];return{calls,request:(options,receive)=>{const req=new EventEmitter();req.destroy=()=>{};req.end=body=>{calls.push({options,body:JSON.parse(body)});queueMicrotask(()=>{const res=new EventEmitter();res.destroy=()=>{};res.statusCode=200;res.headers={'content-type':'application/json'};receive(res);res.emit('data',Buffer.from(JSON.stringify(raw)));res.emit('end')})};return req}}}
test('neutral metadata transport and image compatibility alias use the same fixed account/project endpoint contract',async()=>{
 assert.strictEqual(readSavedImageModels,readAccountModelCatalog);
 for(const endpoint of ['daily','production']){const raw={response:catalog()},f=http(raw);const value=await readAccountModelCatalog('synthetic-account-B','project-B-'+endpoint,new AbortController().signal,endpoint,f.request);
  assert.deepEqual(value,raw);assert.deepEqual(parse(value).map(x=>x.id),['synthetic-text-alpha','synthetic-unlisted-model']);assert.equal(f.calls.length,1);const {options,body}=f.calls[0];
  assert.equal(options.hostname,endpoint==='daily'?'daily-cloudcode-pa.googleapis.com':'cloudcode-pa.googleapis.com');assert.equal(options.path,'/v1internal:fetchAvailableModels');assert.equal(options.headers.Authorization,'Bearer synthetic-account-B');assert.deepEqual(body,{project:'project-B-'+endpoint});
 }
});
test('invalid endpoint is rejected before metadata or conversation send and before send authorization',async()=>{
 const f=http(catalog()),signal=new AbortController().signal;await assert.rejects(readAccountModelCatalog('synthetic','synthetic-project',signal,'https://example.test',f.request),/ENDPOINT_INVALID/);
 let verified=false,sent=false;await assert.rejects(sendWake({token:'synthetic',projectId:'synthetic-project',modelId:'synthetic-text-alpha',endpoint:'other',verify:async()=>verified=true},8,signal,async()=>sent=true,f.request),/ENDPOINT_INVALID/);
 assert.equal(f.calls.length,0);assert.equal(verified,false);assert.equal(sent,false);
});
