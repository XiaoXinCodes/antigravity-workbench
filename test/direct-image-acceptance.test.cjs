const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { png } = require('./fixtures/png-fixture.cjs');
const { currentImageModels, bindSavedImageAccount } = require('../out/direct-image-binding');
const { resolveImageProject } = require('../out/direct-image-project-transport');
const { sendDirectImage } = require('../out/direct-image-transport');
const { generateDirectImage } = require('../out/direct-image-core');

function fakeHttps(endpoint, payload, calls, events) {
  return (options, receive) => {
    assert.equal(options.protocol, 'https:');
    assert.equal(options.hostname, 'daily-cloudcode-pa.googleapis.com');
    assert.equal(options.path, endpoint);
    assert.equal(options.agent, false);
    assert.equal(options.rejectUnauthorized, true);
    const request = new EventEmitter();
    request.destroy = () => {};
    request.end = body => queueMicrotask(() => {
      events.push(options.path);calls.push({ endpoint: options.path, body: JSON.parse(body) });
      const response = new EventEmitter();
      response.statusCode = 200;
      response.headers = { 'content-type': 'application/json' };
      response.destroy = () => {};
      receive(response);
      response.emit('data', Buffer.from(JSON.stringify(payload)));
      response.emit('end');
    });
    return request;
  };
}

test('one complete offline route: expired saved token, current token, model, project, image and PNG', async () => {
  const email = 'synthetic@example.test';
  const accountId = '12345678-1234-4123-8123-123456789abc';
  const modelId = 'gemini-3.1-flash-image';
  const token = 'synthetic.current.access';
  const stored = JSON.stringify({ token: { access_token: 'synthetic.expired.access', refresh_token: 'synthetic.refresh',
    expiry: '2025-01-01T00:00:00Z' } }); // Official StoredToken has optional top-level project_id.
  const raw = JSON.stringify({ id: accountId, expectedEmail: email, hostId: 'synthetic-host',
    slots: { keyring: stored, file: null } });
  const vault = { reads: 0, async get(key) { this.reads++; return key === `live-switch.account.v1.${accountId}` ? raw : undefined; } };
  const models = currentImageModels({ authResult: { hasValidAuth: true } }, { userStatus: { email } },
    { response: { imageGenerationModelIds: [modelId], models: { [modelId]: { disabled: false } } } }, email);
  assert.equal(models.length, 1);
  const calls = [], events = [];
  const project = 'opaque/项目 1';
  const bind = () => bindSavedImageAccount({ vault, selected: { id: accountId, label: 'Synthetic', expectedEmail: email,
    active: true, hostCurrent: true }, model: models[0], hostId: 'synthetic-host', signal: new AbortController().signal,
    assertCurrent: async () => { events.push('current-account'); },
    resolveCurrentToken: async () => { events.push('current-official-token'); return { token, verify: async () => { events.push('current-token-stable'); } }; },
    verifyIdentity: async actual => { assert.equal(actual, token); events.push('userinfo-identity'); return { email }; },
    resolveProject: (actual, signal) => resolveImageProject(actual, signal,
      fakeHttps('/v1internal:loadCodeAssist', { cloudaicompanionProject: project }, calls, events)) });
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'ag-rebuild-acceptance-'));
  try {
    const result = await generateDirectImage({ prompt: 'A synthetic square', accountId, modelId, aspectRatio: '1:1',
      outputDirectory: output, references: [], count: 1 }, new AbortController().signal, {
      bind, send: (actual, body, signal) => sendDirectImage(actual, body, signal,
        fakeHttps('/v1internal:generateContent', { response: { candidates: [{ content: { parts: [
          { inlineData: { mimeType: 'image/png', data: png().toString('base64') } } ] } }] } }, calls, events))
    });
    assert.equal(result.images.length, 1);
    assert.equal(result.images[0].width, 2);
    assert.deepEqual(await fs.readFile(result.images[0].file), png());
    assert.deepEqual(calls.map(x => x.endpoint), ['/v1internal:loadCodeAssist', '/v1internal:generateContent']);
    assert.equal(calls[1].body.project, project);
    assert.equal(calls[1].body.model, modelId);
    assert.equal(Object.hasOwn(calls[1].body, 'userAgent'), false);
    assert.ok(events.indexOf('userinfo-identity') < events.indexOf('/v1internal:loadCodeAssist'));
    assert.ok(events.indexOf('/v1internal:loadCodeAssist') < events.indexOf('/v1internal:generateContent'));
    assert.equal('store' in vault, false);
    assert.equal('delete' in vault, false);
  } finally { await fs.rm(output, { recursive: true, force: true }); }
});
