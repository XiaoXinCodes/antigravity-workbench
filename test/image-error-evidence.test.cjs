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
