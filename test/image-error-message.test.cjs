const {test}=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {summarizeImageErrorMessage:summarize,sanitizeImageMessageSummary,formatImageMessageSummary:format,MAX_ERROR_MESSAGE_BYTES}=require('../out/image-error-message');
const {imageHttpFailure,formatImageFailure}=require('../out/direct-image-http-error');
const {captureRecentImageFailure,readRecentImageFailure,formatRecentImageFailure}=require('../out/recent-image-failure');
const {debugErrorData}=require('../out/debug-events');
const {sendDirectImage}=require('../out/direct-image-transport');
const id='12345678-1234-4123-8123-123456789abc';

test('retains readable capacity, rate, eligibility and client reasons plus bounded wait semantics',()=>{
 const samples=[
  ['The model has insufficient capacity. Try again in 120 seconds.','capacity',/容量/,120],
  ['Quota exceeded: requests per minute. Retry after 2 minutes.','request-rate',/请求次数/,120],
  ['Tokens per minute exceeded.','token-rate',/令牌用量/],
  ['Your account is not eligible for image generation.','eligibility',/资格/],
  ['This client is not allowed to access image generation.','client-restricted',/客户端/],
  ['Service is disabled for this project.','api-disabled',/未启用/],
  ['This country is not supported.','region-restricted',/地区/],
  ['A paid subscription is required.','billing-required',/付费/],
  ['Project access denied.','project-access',/项目/],
  ['The token has expired.','authentication',/认证/],
  ['The model does not exist.','model-unavailable',/模型/],
  ['Input blocked by safety policy.','content-restricted',/安全规则/],
  ['Daily quota exceeded.','daily-limit',/每日/],
  ['Project allowance is zero.','quota-zero',/为零/],
 ];
 for(const [message,code,readable,seconds]of samples){const s=summarize(message);assert.equal(s.state,'summarized',message);assert.ok(s.semantics.includes(code),message);assert.match(format(s),readable);assert.equal(s.waitSeconds,seconds);assert.match(format(s),/非原文/);}
});

test('missing, invalid, empty, overlong and safely unreadable messages are distinguishable',()=>{
 assert.equal(summarize(undefined).state,'absent');assert.equal(summarize(null).state,'invalid');assert.equal(summarize(' ').state,'empty');
 const unknown=summarize('A new provider-specific explanation with private facts.');
 assert.equal(unknown.state,'suppressed');assert.ok(unknown.omissions.includes('unrecognized-text'));assert.match(format(unknown),/已屏蔽/);
 const huge=summarize('Model capacity exhausted. '+'x'.repeat(MAX_ERROR_MESSAGE_BYTES));
 assert.deepEqual(huge,{state:'suppressed',omissions:['length-limit']});
 assert.equal(summarize('The model is not overloaded. There is no rate limit.').state,'suppressed');
 assert.equal(summarize('Model capacity is available. Requests per minute are healthy.').state,'suppressed');
 assert.equal(summarize('Retry in 9999999 hours.').waitSeconds,undefined);
});

test('credentials, query strings, mailboxes and private paths never enter any diagnostic sink',()=>{
 const samples=[
  ['Bearer ya29.SENTINEL_TOKEN','credentials'],
  ['access_token="SENTINEL_ACCESS"','credentials'],
  ['https://example.test/error?access_token=SENTINEL_URL&email=private@example.test','url'],
  ['SENTINEL_MAIL@example.test','email'],
  ['/home/private/SENTINEL_PATH.txt','private-path'],
  ['C:\\Users\\private\\SENTINEL_WINDOWS.txt','private-path'],
  ['\\\\host\\private\\SENTINEL_NETWORK.txt','private-path'],
 ];
 for(const [sensitive,kind]of samples){
  const message='The model capacity is exhausted. '+sensitive;
  const e=imageHttpFailure(429,{error:{message,status:'RESOURCE_EXHAUSTED'},message:'OUTER_SENTINEL'},undefined,id,'structured',0);
  assert.ok(e.evidence.messageSummary.omissions.includes(kind),kind);
  assert.ok(e.evidence.messageSummary.semantics.includes('capacity'));
  const recent=captureRecentImageFailure(e,'gemini-3.1-flash-image','generating',id,0);
  const sinks=JSON.stringify([e,recent,readRecentImageFailure(recent),debugErrorData(e)])+formatImageFailure(e)+formatRecentImageFailure(recent);
  assert.doesNotMatch(sinks,/SENTINEL|example\.test|access_token|C:\\|\/home\/private/);
  assert.match(sinks,/容量/);assert.equal(e.message,'IMAGE_DIRECT_RESOURCE_EXHAUSTED','message semantics do not override structured classification');
 }
 const onlyOuter=imageHttpFailure(429,{message:'Client is not allowed. SENTINEL',error:{status:'RESOURCE_EXHAUSTED'}},undefined);
 assert.equal(onlyOuter.evidence.messageSummary.state,'absent');
});

test('exact, partial, quoted, escaped and labelled prompt echoes cannot become server diagnoses',()=>{
 const privatePrompt='Tell my private story about the model capacity exhausted. Retry in 123 seconds.';
 for(const message of [privatePrompt,'Server echoed: '+privatePrompt,'the model capacity exhausted','Retry in 123 seconds.', 'Prompt: the model capacity exhausted. Retry in 123 seconds.', '"the model capacity exhausted"', '“the model capacity exhausted”']){
  const s=summarize(message,[privatePrompt]);assert.equal(s.state,'suppressed',message);assert.equal(s.waitSeconds,undefined);assert.doesNotMatch(JSON.stringify(s)+format(s),/private story|123|capacity/);
 }
 const escaped='User input: \\u0054ell my private story about the model capacity exhausted';
 assert.equal(summarize(escaped,[privatePrompt]).state,'suppressed');
 const mixed=summarize('This client is not allowed. Prompt: '+privatePrompt,[privatePrompt]);
 assert.deepEqual(mixed.semantics,['client-restricted']);assert.equal(mixed.waitSeconds,undefined);
});

test('rehydration rebuilds canonical meanings and ignores forged human-readable prose',()=>{
 const raw={state:'summarized',semantics:['capacity','SENTINEL'],waitSeconds:120,omissions:['email'],text:'PRIVATE_SENTINEL'};
 const safe=sanitizeImageMessageSummary(raw);assert.deepEqual(safe,{state:'summarized',semantics:['capacity'],waitSeconds:120,omissions:['email']});
 assert.doesNotMatch(JSON.stringify(safe)+format(raw),/SENTINEL/);
 assert.equal(sanitizeImageMessageSummary({state:'summarized',semantics:['SECRET']}).state,'suppressed');
 const getter={state:'summarized'};Object.defineProperty(getter,'semantics',{get(){throw Error('must not invoke getter')}});assert.equal(sanitizeImageMessageSummary(getter).state,'suppressed');
});

test('one fake HTTPS send excludes the actual in-memory request prompt, token and project',async()=>{
 let sends=0,wire;
 const prompt='The model capacity is exhausted. Retry in 123 seconds.';
 const body={requestId:id,project:'PRIVATE_PROJECT_SENTINEL',request:{contents:[{role:'user',parts:[{text:prompt}]}]}};
 const fake=(_options,receive)=>{
  const req=new EventEmitter();req.destroy=()=>{};req.end=input=>{wire=input;sends++;queueMicrotask(()=>{
   const res=new EventEmitter();res.statusCode=429;res.headers={'content-type':'application/json'};res.destroy=()=>{};receive(res);
   res.emit('data',Buffer.from(JSON.stringify({error:{status:'RESOURCE_EXHAUSTED',message:'This client is not allowed. '+prompt+' PRIVATE_TOKEN_SENTINEL PRIVATE_PROJECT_SENTINEL'}})));res.emit('end');
  })};return req;
 };
 const e=await sendDirectImage('PRIVATE_TOKEN_SENTINEL',body,new AbortController().signal,fake).catch(x=>x);
 assert.equal(sends,1);assert.equal(wire,JSON.stringify(body));assert.deepEqual(e.evidence.messageSummary.semantics,['client-restricted']);assert.equal(e.evidence.messageSummary.waitSeconds,undefined);
 const record=captureRecentImageFailure(e,'gemini-3.1-flash-image','generating',id);
 assert.doesNotMatch(JSON.stringify([record,debugErrorData(e)])+formatRecentImageFailure(record),/PRIVATE_|SENTINEL|123 seconds/);
 assert.match(formatRecentImageFailure(record),/客户端/);assert.ok(Buffer.byteLength(JSON.stringify(record))<4096);
});
