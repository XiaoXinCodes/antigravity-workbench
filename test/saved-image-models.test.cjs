const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {readSavedImageModels}=require('../out/saved-image-models');
const token='synthetic-bearer-B',project='project-B',data={imageGenerationModelIds:['gemini-3-pro-image'],models:{'gemini-3-pro-image':{}}};
function transport({status=200,mime='application/json',body=JSON.stringify(data),late=false}={}){
 const calls=[];let finish;
 const request=(options,receive)=>{const req=new EventEmitter();req.destroy=()=>{};req.end=payload=>{calls.push({options,payload});finish=()=>{const res=new EventEmitter();res.destroy=()=>{};res.statusCode=status;res.headers={'content-type':mime};receive(res);res.emit('data',Buffer.isBuffer(body)?body:Buffer.from(body));res.emit('end')};if(!late)queueMicrotask(finish)};return req};
 return{request,calls,finish:()=>finish()};
}
test('saved catalog sends only its verified project/bearer to fixed matching endpoint, once',async()=>{
 for(const endpoint of ['daily','production']){const f=transport();assert.deepEqual(await readSavedImageModels(token,project,new AbortController().signal,endpoint,f.request),data);
  assert.equal(f.calls.length,1);const c=f.calls[0];assert.equal(c.options.path,'/v1internal:fetchAvailableModels');assert.equal(c.options.hostname,endpoint==='daily'?'daily-cloudcode-pa.googleapis.com':'cloudcode-pa.googleapis.com');assert.equal(c.options.headers.Authorization,'Bearer '+token);assert.deepEqual(JSON.parse(c.payload),{project});assert.equal(c.options.rejectUnauthorized,true);
 }
});
test('redirects, MIME mismatch, oversized/invalid JSON and denied calls never fall back or expose body',async()=>{
 for(const options of [{status:302},{status:401},{status:403},{status:429},{mime:'text/html',body:token},{body:'broken '+token},{body:' '.repeat(2*1024*1024+1)},{body:Buffer.from([0xff])}]){
  const f=transport(options);await assert.rejects(readSavedImageModels(token,project,new AbortController().signal,'daily',f.request),e=>!String(e).includes(token));assert.equal(f.calls.length,1);
 }
});
test('cancelled or invalid metadata calls do not emit network requests or return late results',async()=>{
 const abort=new AbortController();abort.abort();const f=transport();await assert.rejects(readSavedImageModels(token,project,abort.signal,'daily',f.request));assert.equal(f.calls.length,0);
 const g=transport({late:true}),c=new AbortController(),p=readSavedImageModels(token,project,c.signal,'daily',g.request);c.abort();await assert.rejects(p);g.finish();assert.equal(g.calls.length,1);
});


test('only retryable server statuses are classified as transient without echoing body',async()=>{
 for(const status of [500,502,503,504]){const f=transport({status,body:token});await assert.rejects(readSavedImageModels(token,project,new AbortController().signal,'daily',f.request),{message:'IMAGE_SAVED_MODELS_TRANSIENT'});assert.equal(f.calls.length,1)}
 for(const status of [302,400,404,501]){const f=transport({status});await assert.rejects(readSavedImageModels(token,project,new AbortController().signal,'daily',f.request),{message:'IMAGE_SAVED_MODELS_FAILED'})}
});
test('network retry classification excludes TLS or unrecognized failures',async()=>{
 for(const code of ['ECONNRESET','ECONNREFUSED','ETIMEDOUT','EAI_AGAIN','ENOTFOUND','ERR_TLS_CERT_ALTNAME_INVALID','SYNTHETIC_PRIVATE']){
  const request=()=>{const req=new EventEmitter();req.destroy=()=>{};req.end=()=>queueMicrotask(()=>req.emit('error',Object.assign(Error(token),{code})));return req};
  await assert.rejects(readSavedImageModels(token,project,new AbortController().signal,'daily',request),{message:code.startsWith('ERR_')||code==='SYNTHETIC_PRIVATE'?'IMAGE_SAVED_MODELS_FAILED':'IMAGE_SAVED_MODELS_TRANSIENT'});
 }
});
test('transport timeout and cancellation have distinct bounded outcomes',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=transport({late:true});const timed=readSavedImageModels(token,project,new AbortController().signal,'daily',f.request);
 const timedCheck=assert.rejects(timed,{message:'IMAGE_SAVED_MODELS_TRANSIENT'});t.mock.timers.tick(15000);await timedCheck;
 const abort=new AbortController(),g=transport({late:true}),cancelled=readSavedImageModels(token,project,abort.signal,'daily',g.request);const cancelledCheck=assert.rejects(cancelled,{message:'IMAGE_CANCELLED'});abort.abort();await cancelledCheck;g.finish();
});
