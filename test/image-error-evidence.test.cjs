const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { imageHttpFailure, retryAfterSeconds, formatImageFailure } = require('../out/direct-image-http-error');
const { diagnosticDelay, sanitizeImageErrorEvidence } = require('../out/image-error-evidence');
const { debugErrorData } = require('../out/debug-events');
const { captureRecentImageFailure, readRecentImageFailure, formatRecentImageFailure } = require('../out/recent-image-failure');
const { sendDirectImage } = require('../out/direct-image-transport');
const secret = 'SENTINEL_PRIVATE_PROMPT Bearer SECRET_TOKEN PRIVATE_PROJECT account@example.test';
const id = '12345678-1234-4123-8123-123456789abc';
const info = fields => ({ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', ...fields });
const error = (details, message = secret, header) => imageHttpFailure(429, { error: { status: 'RESOURCE_EXHAUSTED', message, details } }, header, id, 'structured', 0);

test('retains omitted cause evidence without copying unknown reasons, metadata values or server message', () => {
  const e = error([info({ reason: secret, metadata: { quota_metric: secret, consumer: secret, privateKey: secret } })]);
  assert.equal(e.message, 'IMAGE_DIRECT_RESOURCE_EXHAUSTED');
  assert.equal(e.evidence.body, 'error-object');
  assert.equal(e.evidence.message, 'present');
  assert.equal(e.evidence.reasons, 'unrecognized');
  assert.deepEqual(e.evidence.metadataKeys, ['quota_metric', 'consumer']);
  assert.equal(e.evidence.retryHeader, 'absent');
  assert.equal(e.evidence.retryDetail, 'absent');
  const record = captureRecentImageFailure(e, 'gemini-3.1-flash-image', 'generating', id, 0);
  assert.deepEqual(readRecentImageFailure(JSON.parse(JSON.stringify(record))), record);
  assert.equal(record.requestId, id); assert.equal(record.responseShape, 'structured');
  assert.equal(record.respondedAt, '1970-01-01T00:00:00.000Z');
  const sinks = JSON.stringify([e, record, debugErrorData(e)]) + formatImageFailure(e) + formatRecentImageFailure(record);
  assert.doesNotMatch(sinks, /SENTINEL|SECRET_TOKEN|PRIVATE_PROJECT|account@example|privateKey/);
});

test('recognizes Manager capacity reason and bounded untyped reason without guessing from generic 429', () => {
  for (const detail of [info({ reason: 'MODEL_CAPACITY_EXHAUSTED' }), { reason: 'MODEL_CAPACITY_EXHAUSTED' }]) {
    const e = error([detail]);
    assert.equal(e.message, 'IMAGE_DIRECT_CAPACITY_UNAVAILABLE');
    assert.equal(debugErrorData(e).serviceReason, 'MODEL_CAPACITY_EXHAUSTED');
    assert.equal(captureRecentImageFailure(e, 'gemini-3.1-flash-image', 'generating', id).serviceReason, 'MODEL_CAPACITY_EXHAUSTED');
  }
  const generic = error(undefined, 'Resource has been exhausted (e.g. check quota).');
  assert.equal(generic.message, 'IMAGE_DIRECT_RESOURCE_EXHAUSTED');
  assert.deepEqual(generic.evidence.messageSignals, ['generic-resource']);
  const minute = error([], 'Resource has been exhausted. Tokens per minute exceeded. '+secret);
  assert.equal(minute.message, 'IMAGE_DIRECT_RESOURCE_EXHAUSTED');
  assert.deepEqual(minute.evidence.messageSignals, ['minute-rate']);
  assert.deepEqual(minute.evidence.messageSummary.semantics, ['token-rate']);
});

test('preserves distinct long reset, RetryInfo and Retry-After hints without changing request policy', () => {
  const e = error([
    { reason: 'QUOTA_EXHAUSTED', metadata: { quotaResetDelay: '58h24m53s', quotaResetTime: '2026-10-06T00:00:00Z', consumer: secret } },
    { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '7.123456789s' },
  ], secret, '90000');
  assert.equal(e.message, 'IMAGE_DIRECT_QUOTA_LIMITED');
  assert.equal(e.retryAfterSeconds, 90000);
  assert.equal(e.evidence.headerDelaySeconds, 90000);
  assert.equal(e.evidence.detailDelaySeconds, 8);
  assert.equal(e.evidence.quotaResetDelaySeconds, 210293);
  assert.equal(e.evidence.quotaResetTime, '2026-10-06T00:00:00Z');
  assert.deepEqual(e.evidence.detailTypes, ['untyped', 'retry-info']);
  assert.equal(diagnosticDelay('2592000s'), 2592000);
  for (const invalid of ['', secret, '31d', '1e3s', '-3s', '5hours', '3s1h']) assert.equal(diagnosticDelay(invalid), undefined);
  for (const invalid of ['99999999', '0.5', '2030', secret]) assert.equal(retryAfterSeconds(invalid, Date.now()), invalid === '2030' ? 2030 : undefined);
  const rejected = error([{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: secret }], secret, secret);
  assert.equal(rejected.evidence.retryHeader, 'rejected'); assert.equal(rejected.evidence.retryDetail, 'rejected');
});

test('malformed, over-limit, mixed and conflicting details stay visibly distinct and conservative', () => {
  assert.equal(error({ private: secret }).evidence.details, 'invalid');
  assert.equal(error(Array.from({ length: 25 }, () => info({ reason: 'QUOTA_EXHAUSTED' }))).evidence.details, 'over-limit');
  const mixed = error([info({ reason: 'QUOTA_EXHAUSTED' }), info({ reason: secret })]);
  assert.equal(mixed.evidence.reasons, 'mixed'); assert.equal(mixed.serviceReason, undefined);
  assert.equal(mixed.message, 'IMAGE_DIRECT_RESOURCE_EXHAUSTED');
  const conflict = error([info({ reason: 'RATE_LIMIT_EXCEEDED' }), info({ reason: 'QUOTA_EXHAUSTED' })]);
  assert.equal(conflict.evidence.reasons, 'conflicting'); assert.equal(conflict.serviceReason, undefined);
  const unread = imageHttpFailure(429, undefined, undefined, id, 'oversize');
  assert.equal(unread.evidence.body, 'unavailable');
});

test('rehydration drops forged fields and raw data; old 0.15.3 records remain readable', () => {
  const base = error([]).evidence;
  const rebuilt = sanitizeImageErrorEvidence({ ...base, messageSignals: [secret], metadataKeys: [secret], quotaResetTime: secret,
    rawBody: secret, headerDelaySeconds: Infinity, detailDelaySeconds: -1 });
  assert.doesNotMatch(JSON.stringify(rebuilt), /SENTINEL|SECRET_TOKEN|PRIVATE_PROJECT|rawBody/);
  assert.equal(rebuilt.messageSignals, undefined); assert.equal(rebuilt.quotaResetTime, undefined);
  assert.equal(sanitizeImageErrorEvidence({ ...base, reasons: secret }), undefined);
  const old = { schema: 1, at: '2026-10-03T10:33:56.693Z', operationId: id, modelId: 'gemini-3.1-flash-image',
    stage: 'generating', code: 'IMAGE_DIRECT_RESOURCE_EXHAUSTED', httpStatus: 429, serviceStatus: 'RESOURCE_EXHAUSTED' };
  assert.deepEqual(readRecentImageFailure(old), old);
});

test('fake HTTPS error reaches persisted safe evidence after exactly one send and no retry', async () => {
  let sends = 0;
  const fake = (options, receive) => {
    assert.equal(options.hostname, 'daily-cloudcode-pa.googleapis.com');
    assert.equal(options.path, '/v1internal:generateContent');
    const req = new EventEmitter(); req.destroy = () => {};
    req.end = () => { sends++; queueMicrotask(() => {
      const res = new EventEmitter(); res.statusCode = 429; res.headers = { 'content-type': 'application/json' }; res.destroy = () => {};
      receive(res); res.emit('data', Buffer.from(JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED', message: secret,
        details: [info({ reason: 'MODEL_CAPACITY_EXHAUSTED', metadata: { quotaResetDelay: '180s', consumer: secret } })] } }))); res.emit('end');
    }); }; return req;
  };
  const e = await sendDirectImage('synthetic-token', { requestId: id }, new AbortController().signal, fake).catch(e => e);
  const record = captureRecentImageFailure(e, 'gemini-3.1-flash-image', 'generating', id);
  assert.equal(sends, 1); assert.equal(record.serviceReason, 'MODEL_CAPACITY_EXHAUSTED');
  assert.equal(record.evidence.quotaResetDelaySeconds, 180);
  assert.ok(Buffer.byteLength(JSON.stringify(record)) < 4096);
  assert.doesNotMatch(JSON.stringify(record), /SENTINEL|SECRET_TOKEN|PRIVATE_PROJECT/);
});

test('offline 403 fixtures require explicit structured evidence and retain only safe enums', () => {
  const { formatImageUserFailure } = require('../out/direct-image-http-error');
  const { imageQuotaErrorText } = require('../out/image-quota');
  const { setLanguage } = require('../out/i18n');
  try {
    for (const language of ['zh-CN', 'en']) {
      setLanguage(language);
      for (const fixture of require('./fixtures/access-diagnostics.json')) {
        const e = imageHttpFailure(403, fixture.body, undefined, id, 'structured', 0);
        assert.equal(e.message, fixture.code, fixture.name);
        const record = captureRecentImageFailure(e, 'gemini-3.1-flash-image', 'generating', id, 0);
        assert.equal(record.code, fixture.code);
        const text = formatImageUserFailure(e);
        assert.equal(imageQuotaErrorText(e), text);
        assert.doesNotMatch(text, /IMAGE_|HTTP|PERMISSION_DENIED|reason [A-Z_]|requestId|project|SENTINEL|https:|private@/);
        if (language === 'en') assert.doesNotMatch(text, /[\u3400-\u9fff]/u);
        const expected = fixture.code.includes('VALIDATION') ? language === 'en' ? /requires verification/ : /需要完成验证/ : fixture.code.includes('PERMISSION') ? language === 'en' ? /lacks permission/ : /没有本次操作所需的权限/ : language === 'en' ? /reason is unclear/ : /原因尚不明确/;
        assert.match(text, expected, fixture.name);
        assert.doesNotMatch(JSON.stringify([e, record, debugErrorData(e)]), /SENTINEL|https:|private@/);
      }
    }
  } finally { setLanguage('zh-CN'); }
});

test('verification URLs are never retained or offered, including official-looking and malicious targets', () => {
  const { formatImageUserFailure } = require('../out/direct-image-http-error');
  for (const url of ['https://accounts.google.com/verify?token=SENTINEL', 'https://accounts.google.com.attacker.test/', 'https://google.com@attacker.test/', 'javascript:alert(1)', 'http://accounts.google.com/', 'https://accounts.google.com:444/', '//attacker.test/', 'https://accounts.google.com/%0d%0aSENTINEL']) {
    const e = imageHttpFailure(403, { error: { message: url, details: [info({reason:'VALIDATION_REQUIRED', metadata:{validationUrl:url}})] } });
    assert.equal(e.message, 'IMAGE_DIRECT_VALIDATION_REQUIRED');
    const record = captureRecentImageFailure(e, 'gemini-3.1-flash-image', 'generating', id);
    assert.doesNotMatch(JSON.stringify([e, record, debugErrorData(e)]) + formatImageUserFailure(e), /SENTINEL|https?:|javascript:|attacker|validationUrl/);
  }
});

test('ordinary wait text preserves conflicting server hints, reset evidence and missing values in both languages', () => {
  const { formatImageUserFailure, localizeImageFailure } = require('../out/direct-image-http-error');
  const { setLanguage } = require('../out/i18n');
  const e = error([info({reason:'QUOTA_EXHAUSTED',metadata:{quotaResetDelay:'58h24m53s'}}), {'@type':'type.googleapis.com/google.rpc.RetryInfo',retryDelay:'90s'}], '', '3');
  const before = JSON.stringify(e);
  try {
    setLanguage('en');const english = formatImageUserFailure(e);
    assert.match(english,/3 and 90 seconds/);assert.match(english,/Quota recovery wait.*210293 seconds/);
    assert.doesNotMatch(english,/Retry-After|RetryInfo|IMAGE_|1970|project/);
    setLanguage('zh-CN');const chinese = formatImageUserFailure(e);
    assert.match(chinese,/3 秒和 90 秒/);assert.match(chinese,/额度恢复等待.*210293 秒/);
    assert.equal(localizeImageFailure(english),chinese);
    setLanguage('en');assert.equal(localizeImageFailure(chinese),english);
    for (const header of [undefined,'0','invalid']) {
      const missing = formatImageUserFailure(imageHttpFailure(429,undefined,header));
      assert.match(missing,/Quota recovery time: unknown/);assert.doesNotMatch(missing,/Invalid Date|NaN|undefined|1970/);
      if (header==='0') assert.match(missing,/at least 0 seconds/);
    }
    const agrees = formatImageUserFailure(error([{'@type':'type.googleapis.com/google.rpc.RetryInfo',retryDelay:'3s'}], '', '3'));
    assert.equal((agrees.match(/at least 3 seconds/g)||[]).length,1);assert.doesNotMatch(agrees,/different wait suggestions/);
    const timestamp = formatImageUserFailure(error([info({reason:'QUOTA_EXHAUSTED',metadata:{quotaResetTime:'2026-10-20T08:00:00Z'}})]));
    assert.match(timestamp,/reported by the server: 2026-10-20T08:00:00Z/);
    assert.equal(JSON.stringify(e),before);
  } finally {setLanguage('zh-CN');}
});

test('malformed getters and oversized details cannot create a verification requirement', () => {
  const root = {}; Object.defineProperty(root,'error',{get(){throw Error('PRIVATE_GETTER');}});
  assert.equal(imageHttpFailure(403,root,undefined).message,'IMAGE_DIRECT_FORBIDDEN');
  const e=imageHttpFailure(403,{error:{details:Array.from({length:25},()=>({reason:'VALIDATION_REQUIRED'}))}},undefined);
  assert.equal(e.message,'IMAGE_DIRECT_FORBIDDEN');
});

test('bounded error wire rejects invalid UTF8 and oversize, ignores duplicate and late events without retry', async () => {
  for (const raw of [Buffer.alloc(16*1024+1, 'x'), Buffer.from('{"error":{"details":[{"reason":"VALIDATION_REQUIRED"}],"message":"\xff"}}','latin1'), Buffer.from('{broken')]) {
    let sends=0;
    const fake=(_options,receive)=>{
      const req=new EventEmitter(); req.destroy=()=>{};
      req.end=()=>{sends++;queueMicrotask(()=>{
        const res=new EventEmitter();res.statusCode=403;res.headers={'content-type':'application/json'};res.destroy=()=>{};
        receive(res);res.emit('data',raw);res.emit('end');
        res.emit('data',Buffer.from(JSON.stringify({error:{details:[{reason:'VALIDATION_REQUIRED'}]}})));res.emit('end');res.emit('aborted');
      });};return req;
    };
    const e=await sendDirectImage('synthetic-token',{},new AbortController().signal,fake).catch(e=>e);
    assert.equal(e.message,'IMAGE_DIRECT_FORBIDDEN');assert.equal(sends,1);
    assert.doesNotMatch(JSON.stringify(e),/VALIDATION_REQUIRED/);
  }
});

test('missing project resources never become a claim that the account lacks permission',()=>{
 const {formatImageUserFailure}=require('../out/direct-image-http-error');
 const e=imageHttpFailure(403,{error:{details:[{reason:'PROJECT_NOT_FOUND'}]}},undefined);
 assert.doesNotMatch(formatImageUserFailure(e),/没有本次操作所需的权限|需要完成验证/);
 assert.match(formatImageUserFailure(e),/资源暂不可用或访问受限/);
});

test('invalid calendar reset times remain unknown, while reported timestamps are preserved without a computed deadline',()=>{
 const {formatImageUserFailure}=require('../out/direct-image-http-error');
 for(const reset of ['2026-02-31T08:00:00Z','2026-13-01T00:00:00Z','2026-10-20T25:00:00Z','https://evil.test/?token=SENTINEL']) {
  const e=error([info({reason:'QUOTA_EXHAUSTED',metadata:{quotaResetTime:reset}})]);
  assert.equal(e.evidence.quotaResetTime,undefined);assert.doesNotMatch(formatImageUserFailure(e),/2026-|SENTINEL/);assert.match(formatImageUserFailure(e),/额度恢复时间：未知/);
 }
 const e=error([info({reason:'QUOTA_EXHAUSTED',metadata:{quotaResetTime:'2026-10-20T08:00:00.123456789Z'}})]);
 assert.equal(e.evidence.quotaResetTime,'2026-10-20T08:00:00.123456789Z');
});

test('old generated history renders friendly guidance without changing its stored string or interpreting debug prose as evidence',()=>{
 const {localizeImageUserStatus}=require('../out/direct-image-http-error'),{setLanguage}=require('../out/i18n');
 const e=imageHttpFailure(403,{error:{details:[{reason:'PERMISSION_DENIED'}]}},'3',id,'structured',0);
 const legacy=formatImageFailure(e),before=legacy;
 assert.match(legacy,/HTTP 403/);const presented=localizeImageUserStatus(legacy);
 assert.match(presented,/没有本次操作所需的权限/);assert.doesNotMatch(presented,/IMAGE_|HTTP|reason |1970|12345678/);assert.equal(legacy,before);
 // Old flattened suffixes are diagnostic text, not evidence for a new classification.
 const unknown='IMAGE_DIRECT_FORBIDDEN · reason VALIDATION_REQUIRED · HTTP 403';
 assert.match(localizeImageUserStatus(unknown),/原因尚不明确/);assert.doesNotMatch(localizeImageUserStatus(unknown),/需要完成验证/);
 try{setLanguage('en');assert.match(localizeImageUserStatus(legacy),/lacks permission/);}finally{setLanguage('zh-CN');}
});
