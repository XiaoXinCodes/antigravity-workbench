const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const { deflateSync } = require('node:zlib');
const { png } = require('./fixtures/png-fixture.cjs');
const { jpeg } = require('./fixtures/jpeg-fixture.cjs');
const { decodeDirectImageResponse, generateDirectImageBatch } = require('../out/direct-image-core');
const { sendDirectImage } = require('../out/direct-image-transport');
const { inspectJpeg, readDirectRaster } = require('../out/direct-image-raster');
const { captureImageResponseEvidence, sanitizeImageResponseEvidence } = require('../out/image-response-evidence');
const { DebugRecorder, debugErrorData } = require('../out/debug-events');
const { captureRecentImageFailure, readRecentImageFailure, formatRecentImageFailure } = require('../out/recent-image-failure');

const inline = (bytes, mimeType = 'image/png') => ({ inlineData: { data: bytes.toString('base64'), ...(mimeType === null ? {} : { mimeType }) } });
const candidate = parts => ({ content: { role: 'model', parts }, finishReason: 'STOP' });
const response = parts => ({ response: { candidates: [candidate(parts)] } });
const signal = () => new AbortController().signal;
const operationId = '12345678-1234-4123-8123-123456789abc';
const modelId = 'gemini-3.1-flash-image';
const privateSentinel = 'PRIVATE_PROMPT_TOKEN_ACCOUNT_SENTINEL';
function failure(value, expected, expectedCode = 'IMAGE_DIRECT_RESPONSE_INVALID') {
  let captured; try { decodeDirectImageResponse(value); } catch (error) { captured = error; }
  assert.ok(captured, expected); assert.equal(captured.message, expectedCode);
  assert.equal(captured.responseEvidence.failure, expected); return captured;
}
function fakeHttps(payload, calls, { type = 'application/json; charset=utf-8', raw, status = 200 } = {}) {
  return (options, receive) => {
    const req = new EventEmitter(); req.destroy = () => {};
    req.end = body => queueMicrotask(() => {
      calls.push({ options, body: JSON.parse(body) });
      const res = new EventEmitter(); res.statusCode = status; res.headers = { 'content-type': type }; res.destroy = () => {};
      receive(res);
      const bytes = Buffer.from(raw ?? JSON.stringify(payload));
      // Deliberately fragment UTF-8 and base64 across HTTP chunks (not SSE frames).
      for (let i = 0; i < bytes.length; i += 17) res.emit('data', bytes.subarray(i, i + 17));
      res.emit('end');
    });
    return req;
  };
}
async function offlineRun(payload, count = 1) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ag-response-'))), calls = [], events = [];
  const request = { prompt: privateSentinel, accountId: operationId, modelId, aspectRatio: '1:1', count,
    references: [], outputDirectory: root, endpoint: 'daily' };
  const deps = { bind: async () => ({ token: 'synthetic-access', projectId: 'synthetic-project', modelId, endpoint: 'daily', verify: async () => events.push('verify') }),
    send: (token, body, abort, endpoint) => { events.push('send'); return sendDirectImage(token, body, abort, fakeHttps(payload, calls), endpoint); },
    onProgress: value => events.push(value.phase) };
  try { return { root, calls, events, result: await generateDirectImageBatch(request, signal(), deps) }; }
  catch (error) { return { root, calls, events, error }; }
}

test('Manager image route equivalents: optional response wrapper, first candidate, text and PNG/JPEG parts', () => {
  for (const bytes of [jpeg(), jpeg({ progressive: true })]) {
    assert.equal(inspectJpeg(bytes).width, 2);
    const parts = [{ text: privateSentinel }, inline(png()), inline(bytes, 'image/jpeg')];
    for (const value of [response(parts), { candidates: [candidate(parts), candidate([inline(png())])] }]) {
      const images = decodeDirectImageResponse(value);
      assert.equal(images.length, 2); assert.deepEqual(images.map(x => x.mime), ['image/png', 'image/jpeg']);
      assert.deepEqual(images[1].data, bytes); assert.equal(images[1].extension, 'jpg');
    }
  }
});
test('protobuf aliases, inferred MIME, standard/url-safe base64, omitted padding and bounded whitespace', () => {
  const bytes = jpeg();
  for (const data of [bytes.toString('base64'), bytes.toString('base64url'), '\r\n '+bytes.toString('base64').replace(/.{30}/g,'$&\n')+' ']) {
    for (const part of [{ inline_data: { mime_type: 'image/jpeg', data } }, { inlineData: { mimeType: ' image/jpg ', data } }, { inlineData: { data } }]) {
      assert.deepEqual(decodeDirectImageResponse(response([part]))[0].data, bytes);
    }
  }
  assert.equal(decodeDirectImageResponse(response([inline(png(), null)]))[0].mime, 'image/png');
});
test('count=1 sends one request and saves every image part with original bytes and correct extension', async () => {
  const payload = response([{ text: privateSentinel }, inline(jpeg(), 'image/jpeg'), inline(png()), { text: 'no follow-up request' }]);
  const x = await offlineRun(payload);
  try {
    assert.ifError(x.error); assert.equal(x.calls.length, 1);
    assert.equal(x.calls[0].options.path, '/v1internal:generateContent');
    assert.equal(x.calls[0].options.hostname, 'daily-cloudcode-pa.googleapis.com');
    assert.equal(x.calls[0].body.request.generationConfig.candidateCount, 1);
    assert.equal(Object.hasOwn(x.calls[0].body, 'userAgent'), false);
    assert.equal(x.result.batch.requested, 1); assert.equal(x.result.batch.completed, 1); assert.equal(x.result.batch.artifactCount, 2);
    assert.deepEqual(x.result.images.map(x => path.extname(x.file)), ['.jpg', '.png']);
    assert.deepEqual(await fs.readFile(x.result.images[0].file), jpeg());
    assert.deepEqual(await fs.readFile(x.result.images[1].file), png());
    for (const image of x.result.images) { assert.equal((await readDirectRaster(image.file, x.root)).mime, image.mime); if (process.platform !== 'win32') assert.equal((await fs.stat(image.file)).mode & 0o777, 0o600); }
    assert.deepEqual(x.events, ['verify', 'generating', 'send', 'verify', 'validating']);
  } finally { await fs.rm(x.root, { recursive: true, force: true }); }
});
test('successful artifact counts never replace authorized request counts in a multi-request batch', async () => {
  const x = await offlineRun(response([inline(png()), inline(jpeg(), 'image/jpeg')]), 2);
  try { assert.ifError(x.error); assert.equal(x.calls.length, 2); assert.equal(x.result.images.length, 4); assert.equal(x.result.batch.completed, 2); }
  finally { await fs.rm(x.root, { recursive: true, force: true }); }
});
test('precise fixed reasons distinguish wrapper, candidate, parts, text-only, MIME, base64 and raster failures', () => {
  failure([], 'root'); failure({ response: null, candidates: [candidate([inline(png())])] }, 'wrapper');
  failure({ response: {} }, 'candidates', 'IMAGE_DIRECT_NO_CANDIDATE'); failure({ candidates: [] }, 'candidates', 'IMAGE_DIRECT_NO_CANDIDATE');
  failure({ candidates: [{ content: {} }] }, 'parts', 'IMAGE_DIRECT_NO_IMAGE_RETURNED');
  const text = failure(response([{ text: privateSentinel }]), 'no-images', 'IMAGE_DIRECT_NO_IMAGE_RETURNED');
  assert.equal(text.responseEvidence.finishReason, 'STOP'); assert.equal(text.responseEvidence.textPartCount, 1);
  const nullInline = failure(response([{ inlineData: null }]), 'inline-data');
  assert.equal(nullInline.responseEvidence.partSamples[0].inlineType, 'null');
  assert.equal(nullInline.responseEvidence.partSamples[0].dataType, 'unknown');
  assert.match(formatRecentImageFailure(captureRecentImageFailure(nullInline, modelId, 'validating', operationId)), /unknown\/unknown\/unknown 字符/);
  failure(response([{ ...inline(png()), inline_data: inline(png()).inlineData }]), 'inline-data');
  failure(response([inline(png(), 'image/jpeg')]), 'mime');
  failure(response([inline(jpeg(), 'image/webp')]), 'mime');
  for (const data of ['AA=A', 'AB==', 'data:image/png;base64,AAAA', 'AAA*', 'A', '++++____']) failure(response([{ inlineData: { mimeType: 'image/png', data } }]), 'base64');
  failure(response([inline(png().subarray(0, 50))]), 'png');
  failure(response([inline(jpeg().subarray(0, -2), 'image/jpeg')]), 'jpeg');
  failure(response([inline(Buffer.concat([jpeg(),Buffer.from('tail')]), 'image/jpeg')]), 'jpeg');
  failure(response([inline(jpeg({ width: 8193 }), 'image/jpeg')]), 'jpeg');
  failure(response(Array.from({ length: 9 }, () => inline(png()))), 'image-limit');
  failure(response(Array.from({ length: 65 }, () => ({ text: privateSentinel }))), 'parts');
  failure(response([{ inlineData: { data: 'A'.repeat(32 * 1024 * 1024 + 1) } }]), 'base64');
});
test('a malformed later image cannot silently save an earlier image or issue another request', async () => {
  const x = await offlineRun(response([inline(png()), inline(jpeg().subarray(0, -2), 'image/jpeg')]));
  try { assert.equal(x.error.responseEvidence.failure, 'jpeg'); assert.equal(x.error.responseEvidence.failedPart, 1); assert.equal(x.calls.length, 1); assert.deepEqual(await fs.readdir(x.root), []); }
  finally { await fs.rm(x.root, { recursive: true, force: true }); }
});
test('existing JSON generateContent route does not reinterpret SSE, NDJSON or streaming array wrappers', async () => {
  for (const [options, expected] of [[{ type: 'text/event-stream', raw: 'data: '+JSON.stringify(response([inline(png())]))+'\n\n' }, 'content-type'],
    [{ raw: '{}\n{}' }, 'json'], [{ raw: 'data: {}\n\n' }, 'json'], [{ raw: 'null' }, 'root']]) {
    const calls = [];
    const error = await sendDirectImage('synthetic-token', {}, signal(), fakeHttps({}, calls, options)).then(() => null, e => e);
    assert.equal(error.httpStatus, 200); assert.equal(error.responseEvidence.failure, expected); assert.equal(calls.length, 1);
    assert.equal(error.responseEvidence.transport.contentType, options.type ?? 'application/json');
    const evidence = error.responseEvidence;
    if (expected !== 'root') {
      assert.equal(evidence.structure, 'unavailable'); assert.equal(evidence.rootType, 'unknown');
      assert.equal(evidence.candidatesType, 'unknown'); assert.equal(evidence.partsType, 'unknown');
      assert.equal(evidence.inlinePartCount, undefined); assert.equal(evidence.textPartCount, undefined);
      const restored = readRecentImageFailure(captureRecentImageFailure(error, modelId, 'generating', operationId));
      assert.equal(restored.responseEvidence.structure, 'unavailable');
      assert.match(formatRecentImageFailure(restored), /inline unknown.*文本 parts unknown/);
    }
  }
  const x = await offlineRun([response([inline(png())])]);
  try { assert.equal(x.error.responseEvidence.failure, 'root'); assert.equal(x.error.httpStatus, 200); assert.equal(x.calls.length, 1); }
  finally { await fs.rm(x.root, { recursive: true, force: true }); }
});

test('HTTP 200 no-image response preserves observed missing fields, text count and allowlisted safety reason', async () => {
  for (const payload of [{ response: { promptFeedback: { blockReason: 'SAFETY' } } },
    { response: { candidates: [{ finishReason: 'NO_IMAGE', content: { parts: [{ text: privateSentinel }] } }] } }]) {
    const x = await offlineRun(payload);
    try {
      assert.equal(x.calls.length, 1); assert.equal(x.error.httpStatus, 200);
      const e = x.error.responseEvidence;
      assert.equal(e.structure, 'observed');
      if (e.failure === 'candidates') {
        assert.equal(e.candidatesType, 'missing'); assert.equal(e.partsType, 'unknown');
        assert.equal(e.inlinePartCount, undefined); assert.equal(e.blockReason, 'SAFETY');
      } else {
        assert.equal(e.failure, 'no-images'); assert.equal(e.finishReason, 'NO_IMAGE');
        assert.equal(e.inlinePartCount, 0); assert.equal(e.textPartCount, 1);
      }
      assert.doesNotMatch(JSON.stringify(captureRecentImageFailure(x.error, modelId, 'validating', operationId)), /PRIVATE_PROMPT/);
    } finally { await fs.rm(x.root, { recursive: true, force: true }); }
  }
});
test('failure evidence survives HTTP -> decoder -> debug -> memento -> UI without response data or secret keys', async () => {
  const payload = response([{ text: privateSentinel }, { inlineData: { mimeType: 'image/jpeg', data: privateSentinel }, [privateSentinel]: privateSentinel }]);
  payload[privateSentinel] = privateSentinel;
  const x = await offlineRun(payload);
  try {
    assert.equal(x.error.httpStatus, 200); assert.equal(x.error.responseEvidence.failure, 'base64');
    const record = captureRecentImageFailure(x.error, modelId, 'validating', operationId);
    const restored = readRecentImageFailure(JSON.parse(JSON.stringify(record)));
    assert.ok(restored.responseEvidence); assert.equal(restored.responseEvidence.root.otherKeys, 1);
    assert.equal(restored.responseEvidence.partSamples[0].mime, 'image/jpeg');
    assert.equal(restored.responseEvidence.partSamples[0].encodedChars, privateSentinel.length);
    assert.ok(restored.responseEvidence.transport.bodyBytes > 0);
    assert.match(formatRecentImageFailure(restored), /HTTP 200.*base64.*image\/jpeg/);
    const output = JSON.stringify(debugErrorData(x.error)) + JSON.stringify(restored) + formatRecentImageFailure(restored);
    assert.doesNotMatch(output, /PRIVATE_PROMPT|synthetic-access|synthetic-project/);
    const poisoned = { ...restored.responseEvidence, root: { ...restored.responseEvidence.root, keys: [privateSentinel], types: ['string'] } };
    assert.equal(sanitizeImageResponseEvidence(poisoned), undefined);
    let getters = 0; const getter = Object.defineProperty({}, 'schema', { get() { getters++; throw Error(privateSentinel); } });
    assert.equal(sanitizeImageResponseEvidence(getter), undefined); assert.equal(getters, 0);
  } finally { await fs.rm(x.root, { recursive: true, force: true }); }
});
test('fileData and model text never select files or fetch remote images', async () => {
  const x = await offlineRun(response([{ fileData: { fileUri: 'https://example.invalid/private', mimeType: 'image/png' } }, { text: privateSentinel }]));
  try { assert.equal(x.error.responseEvidence.failure, 'no-images'); assert.equal(x.calls.length, 1); assert.deepEqual(await fs.readdir(x.root), []); }
  finally { await fs.rm(x.root, { recursive: true, force: true }); }
});

test('a second local save failure exposes the first verified artifact and stops further requests', async () => {
  const write = fs.writeFile;
  let writes = 0, x;
  fs.writeFile = async (...args) => {
    if (++writes === 2) throw Object.assign(Error('synthetic disk full'), { code: 'ENOSPC' });
    return write(...args);
  };
  try { x = await offlineRun(response([inline(png()), inline(jpeg(), 'image/jpeg')]), 2); }
  finally { fs.writeFile = write; }
  try {
    assert.ifError(x.error); assert.equal(x.calls.length, 1); assert.equal(x.result.images.length, 1);
    assert.equal(x.result.batch.outcome, 'partial'); assert.equal(x.result.batch.completed, 0);
    assert.equal(x.result.batch.error, 'IMAGE_LOCAL_IO_ERROR'); assert.equal(x.result.batch.artifactCount, 1);
    assert.deepEqual(await fs.readFile(x.result.images[0].file), png());
    assert.equal((await fs.readdir(x.root)).length, 1);
  } finally { await fs.rm(x.root, { recursive: true, force: true }); }
});

test('bounded recent/debug evidence keeps the failure and totals in 4096/2048 byte records', async () => {
  const keys = ['response', 'candidates', 'content', 'parts', 'inlineData', 'inline_data', 'mimeType', 'mime_type', 'data', 'text', 'thought', 'thoughtSignature', 'fileData', 'functionCall', 'finishReason', 'promptFeedback', 'blockReason', 'usageMetadata', 'modelVersion', 'responseId', 'error'];
  const wide = () => Object.fromEntries(keys.map(key => [key, privateSentinel]));
  const value = { ...wide(), response: { ...wide(), candidates: [{ ...wide(), content: { parts: Array.from({ length: 8 }, () => ({ ...wide(), inlineData: { data: privateSentinel, mimeType: 'image/jpeg' } })) } }] } };
  const evidence = captureImageResponseEvidence(value, 'base64', 7);
  const error = Object.assign(Error('IMAGE_DIRECT_RESPONSE_INVALID'), { responseEvidence: evidence });
  const record = captureRecentImageFailure(error, modelId, 'validating', operationId);
  assert.ok(Buffer.byteLength(JSON.stringify(record)) <= 4096);
  assert.equal(record.responseEvidence.failure, 'base64'); assert.equal(record.responseEvidence.partCount, 8);
  assert.equal(record.responseEvidence.inlinePartCount, 8); assert.equal(record.responseEvidence.failedPart, 7);
  assert.ok(record.responseEvidence.partSamples.length < 8);
  assert.ok(readRecentImageFailure(JSON.parse(JSON.stringify(record))));
  assert.doesNotMatch(JSON.stringify(record), /PRIVATE_PROMPT/);
  const lines = [];
  const store = { append: async line => { assert.ok(Buffer.byteLength(line) + 1 <= 2048); lines.push(line); }, readLines: async () => lines, flush: async () => {}, dispose() {} };
  const recorder = new DebugRecorder(store, { version: '0.15.5', platform: 'linux', host: 'wsl' });
  await recorder.setEnabled(true);
  recorder.begin('image.generate', operationId).end('failed', debugErrorData(error));
  const exported = (await recorder.preview()).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(exported.length, 2); assert.equal(recorder.getState().storageUnavailable, false);
  const savedEvidence = exported[1].data.responseEvidence;
  assert.equal(savedEvidence.failure, 'base64'); assert.equal(savedEvidence.inlinePartCount, 8);
  assert.equal(savedEvidence.failedPart, 7); assert.equal(savedEvidence.truncated, true);
  assert.doesNotMatch(JSON.stringify(exported), /PRIVATE_PROMPT/);
  recorder.dispose();
});

test('offline image UI accepts a saved JPEG for native preview and rejects a changed file', async () => {
  const x = await offlineRun(response([inline(jpeg({ progressive: true }), 'image/jpeg'), inline(png())]));
  assert.ifError(x.error);
  const commands = new Map(), states = [], opened = [];
  let receive;
  const uri = file => ({ scheme: 'file', authority: '', fsPath: file, path: file });
  const vscode = { ViewColumn: { Active: 1 }, Uri: { file: uri }, env: {},
    workspace: { workspaceFolders: [{ uri: uri(x.root) }] },
    commands: { registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() {} }; },
      executeCommand: async (...args) => { opened.push(args); } },
    window: { showWarningMessage: async () => '确认生成', createWebviewPanel: () => ({
      webview: { html: '', postMessage: async state => { states.push(state); },
        onDidReceiveMessage: fn => { receive = fn; return { dispose() {} }; } },
      onDidDispose: () => ({ dispose() {} }), reveal() {} }) } };
  const entry = require.resolve('../out/direct-image-ui'), original = Module._load;
  try {
    Module._load = function (name, ...args) { return name === 'vscode' ? vscode : original.call(this, name, ...args); };
    delete require.cache[entry];
    const { registerDirectImageUi } = require(entry);
    Module._load = original;
    registerDirectImageUi({ subscriptions: [], globalState: { get: () => undefined, update: async () => {} } }, {
      getEndpoint: () => 'daily', readChoices: async () => ({ accounts: [{ id: operationId, label: 'Synthetic', active: true }], models: [{ id: modelId, label: 'Synthetic' }] }),
      run: async () => x.result }, undefined, require('./helpers/image-session.cjs').memorySession());
    const send = async msg => {
      const prior = states.length; receive(msg);
      for (let i = 0; i < 200 && (states.length === prior || states.at(-1).busy); i++) await new Promise(resolve => setTimeout(resolve, 5));
      assert.ok(states.length > prior); assert.equal(states.at(-1).busy, false);
    };
    await commands.get('antigravityAccounts.images.open')();
    await send({ type: 'generate', prompt: 'Synthetic', accountId: operationId, modelId, ratio: '1:1', count: 1, size: 'auto', quality: 'auto' });
    assert.equal(states.at(-1).images.length, 2);
    await send({ type: 'preview', index: 0 });
    assert.equal(opened.length, 1); assert.equal(opened[0][0], 'vscode.open');
    assert.equal(opened[0][1].fsPath, x.result.images[0].file);
    await fs.writeFile(x.result.images[0].file, png());
    await send({ type: 'preview', index: 0 });
    assert.equal(opened.length, 1);
    assert.equal(x.calls.length, 1);
  } finally { Module._load = original; delete require.cache[entry]; await fs.rm(x.root, { recursive: true, force: true }); }
});

test('compressed PNG output cannot exceed its declared bounded raster', () => {
  const bomb = png({ compressed: deflateSync(Buffer.alloc(256 * 1024)) });
  assert.ok(bomb.length < 1024);
  failure(response([inline(bomb)]), 'png');
});

test('JPEG local reads reject wrong format, traversal, symlinks and hardlinks', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ag-jpeg-path-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'safe.jpg'); await fs.writeFile(file, jpeg());
  assert.equal((await readDirectRaster(file, root)).info.width, 2);
  await assert.rejects(readDirectRaster(file, path.join(root, 'elsewhere')), /IMAGE_PATH_OUTSIDE_OUTPUT/);
  const hard = path.join(root, 'hard.jpg'); await fs.link(file, hard);
  await assert.rejects(readDirectRaster(hard, root), /IMAGE_UNSAFE_FILE/); await fs.unlink(hard);
  const alias = path.join(root, 'alias.jpg');
  try { await fs.symlink(file, alias); await assert.rejects(readDirectRaster(alias, root), /IMAGE_UNSAFE_FILE|IMAGE_LINK_REJECTED/); }
  catch (error) { if (process.platform !== 'win32' || error.code !== 'EPERM') throw error; }
  await fs.writeFile(file, png());
  await assert.rejects(readDirectRaster(file, root), /IMAGE_DIRECT_MIME_INVALID/);
});

test('oversize HTTP 200 stops before JSON inspection and keeps structure unknown', async () => {
  let calls = 0;
  const fake = (_options, receive) => {
    calls++;
    const req = new EventEmitter(); req.destroy = () => req.emit('error', Error(privateSentinel));
    req.end = () => queueMicrotask(() => {
      const res = new EventEmitter(); res.statusCode = 200; res.headers = { 'content-type': 'application/json' };
      receive(res); res.emit('data', Buffer.alloc(36 * 1024 * 1024 + 1)); res.emit('end');
    });
    return req;
  };
  const error = await sendDirectImage('synthetic-token', {}, signal(), fake).then(() => null, e => e);
  assert.equal(calls, 1); assert.equal(error.responseEvidence.failure, 'body-limit');
  assert.equal(error.responseEvidence.structure, 'unavailable'); assert.equal(error.responseEvidence.candidateCount, undefined);
  assert.equal(error.httpStatus, 200); assert.equal(error.responseEvidence.transport.bodyBytes, 36 * 1024 * 1024 + 1);
  assert.doesNotMatch(JSON.stringify(captureRecentImageFailure(error, modelId, 'generating', operationId)), /PRIVATE_PROMPT/);
});

test('synthetic no-parts reply matching observed 13:57 structure reports no image, without guessing a cause', async () => {
  // This is synthetic: the real 624-byte body was not retained; its role/unknown key cannot be recovered.
  const x = await offlineRun({ response: { candidates: [{ content: { role: 'model' }, index: 0 }] } }, 3);
  try {
    assert.equal(x.error.message, 'IMAGE_DIRECT_NO_IMAGE_RETURNED'); assert.equal(x.calls.length, 1);
    assert.deepEqual(await fs.readdir(x.root), []);
    const record = captureRecentImageFailure(x.error, modelId, 'validating', operationId);
    const c = record.responseEvidence.completion;
    assert.equal(c.contentType, 'object'); assert.equal(c.role, 'model');
    assert.equal(record.responseEvidence.partsType, 'missing'); assert.equal(record.responseEvidence.finishReason, 'missing');
    assert.equal(c.finishMessage.type, 'missing'); assert.equal(c.feedback.type, 'missing'); assert.deepEqual(c.errors, []);
    assert.match(formatRecentImageFailure(record), /content object.*role model.*finishReason missing/);
    const { formatImageFailure } = require('../out/direct-image-http-error');
    assert.match(formatImageFailure(x.error), /具体原因未确认/);
    assert.doesNotMatch(formatImageFailure(x.error), /容量不足|安全拦截|配额限制/);
  } finally { await fs.rm(x.root, { recursive: true, force: true }); }
});

test('candidate completion variants use exact structured markers and preserve unknown versus absent', () => {
  const variants = {
    SAFETY: 'CONTENT_BLOCKED', IMAGE_SAFETY: 'CONTENT_BLOCKED',
    RECITATION: 'RESPONSE_RESTRICTED', IMAGE_RECITATION: 'RESPONSE_RESTRICTED', LANGUAGE: 'RESPONSE_RESTRICTED',
    BLOCKLIST: 'RESPONSE_RESTRICTED', PROHIBITED_CONTENT: 'RESPONSE_RESTRICTED', SPII: 'RESPONSE_RESTRICTED', IMAGE_PROHIBITED_CONTENT: 'RESPONSE_RESTRICTED',
    MAX_TOKENS: 'OUTPUT_LIMIT', MALFORMED_FUNCTION_CALL: 'MODEL_STOPPED', UNEXPECTED_TOOL_CALL: 'MODEL_STOPPED', TOO_MANY_TOOL_CALLS: 'MODEL_STOPPED', MISSING_THOUGHT_SIGNATURE: 'MODEL_STOPPED',
    STOP: 'NO_IMAGE_RETURNED', NO_IMAGE: 'NO_IMAGE_RETURNED', IMAGE_OTHER: 'NO_IMAGE_RETURNED', OTHER: 'NO_IMAGE_RETURNED', FINISH_REASON_UNSPECIFIED: 'NO_IMAGE_RETURNED',
    FUTURE_PRIVATE_FINISH_REASON: 'NO_IMAGE_RETURNED',
  };
  for (const [finishReason, suffix] of Object.entries(variants)) {
    for (const content of [undefined, null, {}, { parts: [] }, { parts: [{ text: privateSentinel }] }]) {
      const raw = { candidates: [{ finishReason, finishMessage: privateSentinel, ...(content === undefined ? {} : { content }) }] };
      let err; try { decodeDirectImageResponse(raw); } catch (e) { err = e; }
      assert.equal(err.message, `IMAGE_DIRECT_${suffix}`, `${finishReason}/${JSON.stringify(content)}`);
      const e = captureRecentImageFailure(err, modelId, 'validating', operationId).responseEvidence;
      assert.equal(e.finishReason, finishReason.startsWith('FUTURE_') ? 'unrecognized' : finishReason);
      assert.deepEqual(e.completion.finishMessage, { type: 'string', chars: privateSentinel.length });
      assert.doesNotMatch(JSON.stringify(e), /PRIVATE_PROMPT|FUTURE_PRIVATE/);
    }
  }
  failure({ candidates: [{ content: { parts: privateSentinel } }] }, 'parts');
  failure({ candidates: [null] }, 'parts'); failure({ candidates: privateSentinel }, 'candidates');
  failure({ candidates: null, promptFeedback: { blockReason: 'SAFETY' } }, 'candidates', 'IMAGE_DIRECT_CONTENT_BLOCKED');
});

test('promptFeedback uses its own block enum and safe message and safety fields at either wrapper scope', () => {
  for (const [blockReason, code] of [['SAFETY', 'CONTENT_BLOCKED'], ['IMAGE_SAFETY', 'CONTENT_BLOCKED'],
    ['BLOCKLIST', 'RESPONSE_RESTRICTED'], ['PROHIBITED_CONTENT', 'RESPONSE_RESTRICTED'], ['JAILBREAK', 'RESPONSE_RESTRICTED'],
    ['BLOCK_REASON_UNSPECIFIED', 'NO_CANDIDATE'], ['OTHER', 'NO_CANDIDATE'], ['FUTURE_PRIVATE_BLOCK', 'NO_CANDIDATE']]) {
    const feedback = { blockReason, blockReasonMessage: privateSentinel, safetyRatings: [{ category: 'HARM_CATEGORY_DANGEROUS_CONTENT', probability: 'NEGLIGIBLE', blocked: false }] };
    for (const raw of [{ response: { promptFeedback: feedback } }, { response: {}, promptFeedback: feedback }]) {
      const err = failure(raw, 'candidates', `IMAGE_DIRECT_${code}`);
      const e = captureRecentImageFailure(err, modelId, 'validating', operationId).responseEvidence;
      const f = e.completion.outerFeedback ?? e.completion.feedback;
      assert.equal(f.type, 'object'); assert.equal(f.blockReason, blockReason.startsWith('FUTURE_') ? 'unrecognized' : blockReason);
      assert.equal(f.blockReasonMessage.chars, privateSentinel.length); assert.equal(f.safety.blockedCount, 0);
      assert.equal(f.safety.samples[0].category, 'HARM_CATEGORY_DANGEROUS_CONTENT');
      assert.doesNotMatch(JSON.stringify(e), /PRIVATE_PROMPT|FUTURE_PRIVATE/);
    }
  }
  const blocked = failure({ candidates: [{ content: {}, safetyRatings: [{ category: privateSentinel, probability: 'HIGH', blocked: true }] }] }, 'parts', 'IMAGE_DIRECT_CONTENT_BLOCKED');
  assert.equal(blocked.responseEvidence.completion.safety.samples[0].category, 'unrecognized');
  // High probability alone and finishMessage wording are never a diagnosis.
  failure({ candidates: [{ content: {}, safetyRatings: [{ probability: 'HIGH' }], finishMessage: 'service overloaded, quota exhausted, safety blocked' }] }, 'parts', 'IMAGE_DIRECT_NO_IMAGE_RETURNED');
});

test('HTTP 200 error wrappers retain safe service status, without confusing it with the HTTP status', async () => {
  for (const payload of [{ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: privateSentinel, details: [{ secret: privateSentinel }] } },
    { response: { error: { code: 503, status: 'UNAVAILABLE', message: privateSentinel } } }]) {
    const x = await offlineRun(payload, 3);
    try {
      assert.equal(x.error.message, 'IMAGE_DIRECT_SERVICE_ERROR'); assert.equal(x.error.httpStatus, 200); assert.equal(x.calls.length, 1);
      assert.deepEqual(await fs.readdir(x.root), []);
      const record = captureRecentImageFailure(x.error, modelId, 'validating', operationId), e = record.responseEvidence.completion.errors[0];
      assert.equal(e.type, 'object'); assert.ok(['RESOURCE_EXHAUSTED', 'UNAVAILABLE'].includes(e.status));
      assert.equal(e.message.chars, privateSentinel.length); assert.doesNotMatch(JSON.stringify(record), /PRIVATE_PROMPT/);
      assert.match(formatRecentImageFailure(record), /HTTP 200.*服务错误 .*status (RESOURCE_EXHAUSTED|UNAVAILABLE)/);
    } finally { await fs.rm(x.root, { recursive: true, force: true }); }
  }
});

test('completion evidence resists injected fields and getters and fits recent/debug limits', async () => {
  const { sanitizeImageCompletion } = require('../out/image-completion-evidence');
  let getters = 0;
  const candidate = { content: { role: privateSentinel }, [privateSentinel]: privateSentinel };
  for (const key of ['finishMessage', 'safetyRatings']) Object.defineProperty(candidate, key, { enumerable: true, get() { getters++; throw Error(privateSentinel); } });
  const error = failure({ candidates: [candidate] }, 'parts', 'IMAGE_DIRECT_NO_IMAGE_RETURNED');
  assert.equal(getters, 0); assert.equal(error.responseEvidence.completion.role, 'unrecognized');
  assert.equal(error.responseEvidence.candidate.otherKeys, 1);
  const unsafe = { ...error.responseEvidence.completion, extra: privateSentinel, role: privateSentinel };
  assert.equal(sanitizeImageCompletion(unsafe), undefined);
  const rating = { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', probability: 'HIGH', severity: 'HARM_SEVERITY_HIGH', blocked: true };
  const f = { blockReason: 'PROHIBITED_CONTENT', blockReasonMessage: privateSentinel, safetyRatings: Array(64).fill(rating) };
  const service = { code: 503, status: 'UNAVAILABLE', message: privateSentinel, details: Array(64).fill({ secret: privateSentinel }) };
  const rich = { error: service, promptFeedback: f, response: { error: service, promptFeedback: f,
    candidates: [{ finishReason: 'SAFETY', finishMessage: privateSentinel, safetyRatings: Array(64).fill(rating), content: { role: 'model' } }] } };
  const err = failure(rich, 'service-error', 'IMAGE_DIRECT_SERVICE_ERROR');
  const record = captureRecentImageFailure(err, modelId, 'validating', operationId);
  assert.ok(Buffer.byteLength(JSON.stringify(record)) <= 4096); assert.ok(readRecentImageFailure(record));
  const lines = [], store = { append: async line => { assert.ok(Buffer.byteLength(line) + 1 <= 2048); lines.push(line); }, readLines: async () => lines, flush: async () => {}, dispose() {} };
  const recorder = new DebugRecorder(store, { version: '0.15.6', platform: 'linux', host: 'wsl' });
  await recorder.setEnabled(true); recorder.begin('image.generate', operationId).end('failed', debugErrorData(err));
  const saved = (await recorder.preview()).trim().split('\n').map(JSON.parse);
  assert.equal(saved.length, 2); assert.equal(recorder.getState().storageUnavailable, false);
  assert.equal(saved[1].data.responseEvidence.finishReason, 'SAFETY');
  assert.equal(saved[1].data.responseEvidence.completion.feedback.blockReason, 'PROHIBITED_CONTENT');
  assert.equal(saved[1].data.responseEvidence.completion.safety.blockedCount, 64);
  assert.doesNotMatch(JSON.stringify(saved), /PRIVATE_PROMPT/); recorder.dispose();
});

test('legacy evidence remains readable without inventing unrecorded completion fields', () => {
  const e = captureImageResponseEvidence({ candidates: [{ content: {} }] }, 'parts');
  delete e.completion; delete e.content; delete e.feedback;
  const raw = { schema: 1, at: '2026-10-03T13:57:00.270Z', operationId, modelId, stage: 'validating', code: 'IMAGE_DIRECT_RESPONSE_INVALID', httpStatus: 200, responseEvidence: e };
  const restored = readRecentImageFailure(raw);
  assert.equal(restored.code, 'IMAGE_DIRECT_RESPONSE_INVALID'); assert.equal(restored.responseEvidence.completion, undefined);
  assert.doesNotMatch(formatRecentImageFailure(restored), /role model|安全拦截/);
});

test('existing successful PNG/JPEG response behavior survives added completion diagnostics', async () => {
  const value = response([inline(png()), inline(jpeg(), 'image/jpeg')]);
  Object.assign(value.response.candidates[0], { finishReason: 'FUTURE_FINISH', finishMessage: privateSentinel,
    safetyRatings: [{ category: 'HARM_CATEGORY_DANGEROUS_CONTENT', probability: 'HIGH', blocked: false }] });
  value.response.promptFeedback = { safetyRatings: [] };
  const x = await offlineRun(value);
  try {
    assert.ifError(x.error); assert.equal(x.calls.length, 1); assert.equal(x.result.images.length, 2);
    assert.deepEqual(await fs.readFile(x.result.images[0].file), png()); assert.deepEqual(await fs.readFile(x.result.images[1].file), jpeg());
  } finally { await fs.rm(x.root, { recursive: true, force: true }); }
});
