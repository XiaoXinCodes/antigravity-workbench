const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { imageOperationStart, imageOperationResponse, imageOperationFailure, readImageOperation, ImageOperationJournal, formatImageOperations } = require('../out/image-operation-record');
const { rememberImageTransport } = require('../out/image-response-evidence');
const { imageHttpFailure } = require('../out/direct-image-http-error');
const request = { prompt: 'PRIVATE_PROMPT_MARKER', accountId: '00000000-0000-4000-8000-000000000001', modelId: 'gemini-3.1-flash-image',
 aspectRatio: '1:1', count: 1, size: '1K', quality: 'detail', outputDirectory: '/PRIVATE_PATH', references: ['/PRIVATE_REFERENCE'], endpoint: 'daily' };
test('success and failure share only safe parameter and anonymous account metadata', () => {
 const start = imageOperationStart(request);
 assert.equal(imageOperationStart({ ...request, endpoint: undefined }).endpoint, 'daily');
 assert.equal(imageOperationStart({ ...request, endpoint: 'production' }).endpoint, 'production');
 assert.match(formatImageOperations([start]),/端点 daily · daily-cloudcode-pa\.googleapis\.com/);
 assert.match(formatImageOperations([imageOperationStart({...request,endpoint:'production'})]),/端点 production · cloudcode-pa\.googleapis\.com/);
 const success = { candidates: [{ finishReason: 'STOP', content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'PRIVATE_PICTURE' } }, { text: 'PRIVATE_TEXT' }] } }] };
 rememberImageTransport(success, { httpStatus: 200, contentType: 'application/json', bodyBytes: 300 });
 start.responses = [imageOperationResponse(success)]; start.outcome = 'complete'; start.artifacts = start.png = start.completed = start.attempted = 1;
 const safe = readImageOperation(start);
 assert.equal(safe.responses[0].httpStatus, 200); assert.equal(safe.responses[0].finishReason, 'STOP');
 assert.equal(safe.responses[0].parts, 2); assert.equal(safe.endpoint, 'daily');
 assert.equal(safe.accountRef, imageOperationStart(request).accountRef);
 assert.notEqual(safe.accountRef, imageOperationStart({ ...request, accountId: '00000000-0000-4000-8000-000000000002' }).accountRef);
 const failure = imageOperationFailure(imageHttpFailure(429, { error: { status: 'RESOURCE_EXHAUSTED', message: 'PRIVATE_SERVER_BODY' } }));
 assert.equal(failure.httpStatus, 429); assert.equal(failure.code, 'IMAGE_DIRECT_RESOURCE_EXHAUSTED');
 assert.doesNotMatch(JSON.stringify({ safe, failure }), /PRIVATE_|00000000-0000-4000|example\.test/);
});
test('untrusted persisted fields, injected strings and getters cannot expose private data', () => {
 const value = { ...imageOperationStart(request), prompt: 'PRIVATE_PROMPT', token: 'PRIVATE_TOKEN',
  responses: [{ finishReason: 'PRIVATE_FINISH', blockReason: 'PRIVATE_BLOCK', code: 'PRIVATE_ERROR', requestId: 'PRIVATE_ID', httpStatus: 429 }] };
 Object.defineProperty(value, 'code', { get() { throw Error('GETTER_CALLED'); } });
 const safe = readImageOperation(value);
 assert.equal(safe.responses[0].finishReason, 'unrecognized');
 assert.doesNotMatch(JSON.stringify(safe), /PRIVATE_|GETTER/);
 assert.equal(readImageOperation({ ...value, operationId: 'PRIVATE_ID' }), undefined);
});
test('bounded operation journal retains completed and failed records across readers, without bodies', async t => {
 const dir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'agm-image-journal-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
 const store = new ImageOperationJournal(path.join(dir, 'journal')); t.after(() => store.dispose());
 const first = imageOperationStart(request); assert.equal(await store.write(first), true);
 first.outcome = 'complete'; first.endedAt = new Date().toISOString(); first.artifacts = first.jpeg = 1; assert.equal(await store.write(first), true);
 const second = imageOperationStart(request); second.outcome = 'failed'; second.responses = [{ httpStatus: 429 }]; assert.equal(await store.write(second), true);
 const reopened = new ImageOperationJournal(path.join(dir, 'journal')); t.after(() => reopened.dispose());
 const records = await reopened.read(); assert.equal(records.length, 2); assert.equal(records[0].operationId, first.operationId);
 assert.equal(records[0].outcome, 'complete'); assert.equal(records[1].outcome, 'failed');
 assert.match(formatImageOperations(records), /HTTP 429/); assert.doesNotMatch(formatImageOperations(records), /PRIVATE_/);
 const max = imageOperationStart({ ...request, count: 4 }); max.responses = Array.from({ length: 4 }, () => ({ requestId: 'agent-00000000-0000-4000-8000-000000000001', httpStatus: 200, finishReason: 'MISSING_THOUGHT_SIGNATURE', blockReason: 'BLOCK_REASON_UNSPECIFIED', candidates: 10000, parts: 10000, code: 'IMAGE_DIRECT_RESPONSE_INVALID' }));
 assert.equal(await store.write(max), true); assert.ok(Buffer.byteLength(JSON.stringify(max)) < 2048);
});
