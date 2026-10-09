const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const vm = require('node:vm');
const { png } = require('./fixtures/png-fixture.cjs');
const { bindSavedImageAccount, currentImageModels } = require('../out/direct-image-binding');
const { buildDirectImageBody, decodeDirectImageResponse, generateDirectImage, generateDirectImageBatch } = require('../out/direct-image-core');
const { sendDirectImage } = require('../out/direct-image-transport');
const { imageHttpFailure, formatImageFailure, retryAfterSeconds } = require('../out/direct-image-http-error');
const { debugErrorData } = require('../out/debug-events');
const { resolveImageProject } = require('../out/direct-image-project-transport');
const { validQuotaProject } = require('../out/account-quota-transport');
const { recoverExistingImage } = require('../out/direct-image-output');

const accountId = '12345678-1234-4123-8123-123456789abc';
const email = 'offline@example.test';
const model = currentImageModels({authResult:{hasValidAuth:true}}, {userStatus:{email}}, {response:{imageGenerationModelIds:['gemini-3.1-flash-image'], models:{'gemini-3.1-flash-image':{}}}}, email)[0];
const selected = { id: accountId, label: 'Offline account', expectedEmail: email, active: true, hostCurrent: true };
const hostId = 'offline-host';
const token = 'offline.synthetic.access';
const request = outputDirectory => ({ prompt: 'Draw a calm blue sky', executable: 'agy', aspectRatio: '1:1', references: [], outputDirectory,
  count: 1, size: 'auto', quality: 'auto', accountId, modelId: model.id });
const response = bytes => ({ response: { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: bytes.toString('base64') } }] } }] } });
function vault(options = {}) {
  const storedToken = project => JSON.stringify({ ...(project === undefined ? {} : { project_id: project }),
    token: { access_token: token, refresh_token: 'offline.synthetic.refresh', expiry: new Date(Date.now() + (options.expired ? -3600_000 : 3600_000)).toISOString() } });
  const raw = JSON.stringify({ id: accountId, expectedEmail: email, hostId,
    slots: { keyring: storedToken(options.noProject ? undefined : options.projectOverride ?? 'offline-project'),
      file: options.conflict ? storedToken('different-project') : null } });
  const reads = [];
  return { reads, get: async key => { reads.push(key); if (options.readError) throw Error('offline.synthetic.private');
    return key === `live-switch.account.v1.${accountId}` ? options.noRecord ? undefined : options.invalidRecord ? '{"bad":true}' : raw
      : options.pending && key.includes('quota-pending') ? 'pending' : undefined; } };
}
const binding = (store, options = {}) => bindSavedImageAccount({ vault: store, selected: options.selected || selected,
  hostId: options.hostId || hostId, model: options.model ?? model, signal: new AbortController().signal,
  assertCurrent: async () => { if (options.changed) throw Error('IMAGE_DIRECT_ACCOUNT_CHANGED'); },
  ...(options.currentToken ? { resolveCurrentToken: async () => {
    options.events?.push('current-token');
    return { token: options.currentToken, verify: async () => { options.events?.push('current-token-verify'); } };
  } } : {}),
  ...(options.resolveProject ? { resolveProject: async () => { options.events?.push('project'); return options.resolveProject; } } : {}),
  verifyIdentity: async () => { if (options.identityReadError) throw Error('offline.synthetic.private');
    options.events?.push('identity');
    return { email: options.wrongIdentity ? 'other@example.test' : email }; } });

test('read-only hub model list requires current verified identity and explicit image model ID', () => {
  const auth = { authResult: { hasValidAuth: true } };
  const state = { userStatus: { email, cascadeModelConfigData: { clientModelConfigs: [{ modelId: 'text-only', label: 'Text' }] } } };
  const available = { response: { imageGenerationModelIds: [model.id], models: { [model.id]: {} } } };
  assert.deepEqual(currentImageModels(auth, state, available, email), [model]);
  for (const [id, name] of [['gemini-3.1-flash-lite-image', 'Nano Banana 2 Lite'],
    ['gemini-3-pro-image', 'Nano Banana Pro'], ['gemini-2.5-flash-image', 'Nano Banana']]) {
    assert.deepEqual(currentImageModels(auth, state,
      { response: { imageGenerationModelIds: [id], models: { [id]: {} } } }, email),
      [{ id, label: `${name}（${id}）` }]);
  }
  assert.throws(() => currentImageModels(auth, { userStatus: { ...state.userStatus, email: 'other@example.test' } }, available, email), { message: 'IMAGE_DIRECT_ACCOUNT_CHANGED' });
  assert.throws(() => currentImageModels({}, state, available, email), { message: 'IMAGE_DIRECT_AUTH_REQUIRED' });
  assert.throws(() => currentImageModels(auth, state, { response: { imageGenerationModelIds: [model.id], models: {} } }, email), { message: 'IMAGE_DIRECT_MODEL_UNVERIFIED' });
});

test('official Hub identity selects one host-bound account even if sidebar active badge lags', async () => {
  const entry = require.resolve('../out/direct-image-vscode');
  const original = Module._load;
  let requested = 0;
  const extension = { isActive: true, exports: { port: 40001, csrfToken: 'offline-synthetic' } };
  Module._load = function (name, ...args) {
    if (name === 'vscode') return { UIKind: { Desktop: 1 }, env: { uiKind: 1, remoteName: 'wsl' },
      workspace: { isTrusted: true, getConfiguration: () => ({ inspect: () => undefined }) }, extensions: { getExtension: () => extension } };
    if (name === './official-extension-identity') return { pinOfficialExtension: () => ({}), matchesOfficialExtension: () => true };
    if (name === './native-host') return { nativeHostStatus: () => ({ available: true }) };
    if (name === './live-hub') return { generation: require('../out/live-hub').generation, hasOfficialHubApi: () => true, hubRpc: async (_api, method) => {
      requested++;
      if (method === 'GetAuthStatus') return { authResult: { hasValidAuth: true } };
      if (method === 'GetUserStatus') return { userStatus: { email } };
      return { response: { imageGenerationModelIds: [model.id], models: { [model.id]: {} } } };
    } };
    return original.call(this, name, ...args);
  };
  try {
    delete require.cache[entry];
    const { createDirectImageIntegration } = require(entry);
    const direct = createDirectImageIntegration({}, () => [{ ...selected, active: false }]);
    const result = await direct.readChoices(new AbortController().signal);
    assert.equal(result.accounts.length, 1);
    assert.equal(result.accounts[0].id, accountId);
    assert.equal(result.accounts[0].active, true);
    assert.equal(requested, 5);
  } finally { Module._load = original; delete require.cache[entry]; }
});

test('storage and official Hub startup readiness recover without premature RPC or credential reads', async () => {
  const entry = require.resolve('../out/direct-image-vscode');
  const original = Module._load;
  let requested = 0, ready = false, apiReady = false;
  const extension = { isActive: false, exports: { port: 40001, csrfToken: 'offline-synthetic' } };
  Module._load = function (name, ...args) {
    if (name === 'vscode') return { UIKind: { Desktop: 1 }, env: { uiKind: 1, remoteName: 'wsl' },
      workspace: { isTrusted: true, getConfiguration: () => ({ inspect: () => undefined }) }, extensions: { getExtension: () => extension } };
    if (name === './official-extension-identity') return { pinOfficialExtension: () => ({}), matchesOfficialExtension: () => true };
    if (name === './native-host') return { nativeHostStatus: () => ({ available: true }) };
    if (name === './live-hub') return { generation: require('../out/live-hub').generation, hasOfficialHubApi: () => apiReady, hubRpc: async (_api, method) => {
      requested++;
      if (method === 'GetAuthStatus') return { authResult: { hasValidAuth: true } };
      if (method === 'GetUserStatus') return { userStatus: { email } };
      return { response: { imageGenerationModelIds: [model.id], models: { [model.id]: {} } } };
    } };
    return original.call(this, name, ...args);
  };
  try {
    delete require.cache[entry];
    const { createDirectImageIntegration } = require(entry);
    const direct = createDirectImageIntegration({}, () => [{ ...selected, active: false }], { accountsReady: () => ready });
    const signal = new AbortController().signal;
    await assert.rejects(direct.readChoices(signal), { message: 'IMAGE_ACCOUNT_INITIALIZING' });
    assert.throws(() => direct.selectSavedAccount(accountId), { message: 'IMAGE_ACCOUNT_INITIALIZING' });
    assert.equal(requested, 0);
    ready = true;
    await assert.rejects(direct.readChoices(signal), { message: 'IMAGE_ACCOUNT_INITIALIZING' });
    extension.isActive = true;
    await assert.rejects(direct.readChoices(signal), { message: 'IMAGE_ACCOUNT_INITIALIZING' });
    assert.equal(requested, 0); apiReady = true;
    const result = await direct.readChoices(new AbortController().signal);
    assert.equal(result.accounts.length, 1);
    assert.equal(result.accounts[0].id, accountId);
    assert.equal(result.accounts[0].active, true);
    assert.equal(requested, 5);
  } finally { Module._load = original; delete require.cache[entry]; }
});

test('account binding reads a host-bound saved account and checks identity without writes', async () => {
  const store = vault();
  const bound = await binding(store);
  assert.equal(bound.projectId, 'offline-project'); assert.equal(bound.modelId, model.id);
  assert.equal(bound.token, token); assert.ok(store.reads.includes(`live-switch.account.v1.${accountId}`));
  await bound.verify(new AbortController().signal);
});

test('current account changing to another saved account blocks the integration before image send', async () => {
  const entry = require.resolve('../out/direct-image-vscode');
  const original = Module._load;
  const other = { ...selected, id: '22345678-1234-4123-8123-123456789abc', expectedEmail: 'other@example.test' };
  let currentEmail = email, verifyCalls = 0, sends = 0;
  const extension = { isActive: true, exports: { port: 40001, csrfToken: 'offline-synthetic' } };
  Module._load = function (name, ...args) {
    if (name === 'vscode') return { UIKind: { Desktop: 1 }, env: { uiKind: 1, remoteName: 'wsl' },
      workspace: { isTrusted: true, getConfiguration: () => ({ inspect: () => undefined }) }, extensions: { getExtension: () => extension } };
    if (name === './official-extension-identity') return { pinOfficialExtension: () => ({}), matchesOfficialExtension: () => true };
    if (name === './native-host') return { nativeHostStatus: () => ({ available: true }), resolveCredentialHostId: async () => hostId };
    if (name === './live-lock') return { LiveLocks: class { async withOperation(fn) { return fn(); } async hasRecovery() { return false; } } };
    if (name === './live-environment') return { EnvironmentTokenSlots: class { async mode() { return 'wsl-file'; } } };
    if (name === './live-hub') return { generation: require('../out/live-hub').generation, hasOfficialHubApi: () => true, hubRpc: async (_api, method) => {
      if (method === 'GetAuthStatus') return { authResult: { hasValidAuth: true } };
      if (method === 'GetUserStatus') return { userStatus: { email: currentEmail } };
      return { response: { imageGenerationModelIds: [model.id], models: { [model.id]: {} } } };
    } };
    if (name === './direct-image-binding') return { currentImageModels, bindSavedImageAccount: async input => {
      await input.assertCurrent(); verifyCalls++;
      currentEmail = other.expectedEmail;
      await input.assertCurrent(); verifyCalls++;
      return { token, projectId: 'offline-project', modelId: model.id, verify: async () => {} };
    } };
    if (name === './direct-image-core') return { generateDirectImageBatch: async (input, signal, deps) => {
      const bound = await deps.bind(input.accountId, input.modelId, signal);
      await deps.send(bound.token, {}, signal);
      return { batch: { outcome: 'complete', requested: 1, completed: 1 } };
    } };
    if (name === './direct-image-transport') return { sendDirectImage: async () => { sends++; } };
    return original.call(this, name, ...args);
  };
  try {
    delete require.cache[entry];
    const { createDirectImageIntegration } = require(entry);
    const direct = createDirectImageIntegration({ globalStorageUri: {toString:()=> 'synthetic'}, globalState: { get: (_key, fallback) => fallback }, secrets: {} },
      () => [selected, other]);
    await assert.rejects(direct.run(request('/tmp/offline'), new AbortController().signal, () => {}),
      { message: 'IMAGE_DIRECT_ACCOUNT_CHANGED' });
    assert.equal(verifyCalls, 1); assert.equal(sends, 0);
  } finally { Module._load = original; delete require.cache[entry]; }
});
for (const [name, options, code] of [
  ['missing project', { noProject: true }, 'IMAGE_DIRECT_PROJECT_MISSING'],
  ['invalid project', { projectOverride: '\u0000bad' }, 'IMAGE_DIRECT_PROJECT_INVALID'],
  ['conflicting project slots', { conflict: true }, 'IMAGE_DIRECT_PROJECT_CONFLICT'],
  ['pending quota transaction', { pending: true }, 'IMAGE_ACCOUNT_RECOVERY_PENDING'],
  ['wrong host', { hostId: 'different-host' }, 'IMAGE_DIRECT_HOST_MISMATCH'],
  ['wrong identity', { wrongIdentity: true }, 'IMAGE_DIRECT_IDENTITY_MISMATCH'],
  ['failed identity request', { identityReadError: true }, 'IMAGE_DIRECT_IDENTITY_CHECK_FAILED'],
  ['inactive account', { selected: { ...selected, active: false } }, 'IMAGE_DIRECT_SUMMARY_MISMATCH'],
  ['missing secure account', { noRecord: true }, 'IMAGE_DIRECT_SECRET_MISSING'],
  ['invalid secure account', { invalidRecord: true }, 'IMAGE_DIRECT_SECRET_INVALID'],
  ['failed secure read', { readError: true }, 'IMAGE_DIRECT_VAULT_READ_FAILED'],
  ['current account drift', { changed: true }, 'IMAGE_DIRECT_ACCOUNT_CHANGED']
]) test(`${name} blocks before any image send`, async () => {
  await assert.rejects(binding(vault(options), options), error => {
    assert.equal(error.message, code);
    assert.equal(error.message.includes('offline.synthetic.private'), false);
    return true;
  });
});

test('server-owned opaque project is accepted without GCP slug assumptions', async () => {
  const opaque = 'server/项目 segment:1';
  const bound = await binding(vault({ projectOverride: opaque }));
  assert.equal(bound.projectId, opaque);
  assert.equal(buildDirectImageBody(request('/tmp/offline'), bound, []).project, opaque);
  assert.equal(validQuotaProject(opaque), true);
  assert.equal(validQuotaProject('unsafe\u0000project'), false);
});

test('missing project is resolved only after saved-token identity and never written back', async () => {
  const events = [], store = vault({ noProject: true });
  const bound = await binding(store, { resolveProject: 'opaque/项目 1', events });
  assert.equal(bound.projectId, 'opaque/项目 1');
  assert.deepEqual(events, ['identity', 'project']);
  assert.equal('store' in store, false);
  assert.equal('delete' in store, false);
});

test('expired saved access token uses verified current official token before one project lookup', async () => {
  const events = [], store = vault({ noProject: true, expired: true });
  const bound = await binding(store, { currentToken: 'offline.current.access', resolveProject: 'server/opaque 1', events });
  assert.equal(bound.token, 'offline.current.access');
  assert.equal(bound.projectId, 'server/opaque 1');
  assert.deepEqual(events, ['current-token', 'current-token-verify', 'identity', 'current-token-verify', 'project', 'current-token-verify']);
  assert.equal('store' in store, false);
});

test('request body binds explicit project/model and supported reference bytes without token', () => {
  const bytes = png(); const bound = { token, projectId: 'offline-project', modelId: model.id };
  const body = buildDirectImageBody({ ...request('/tmp/offline'), size: '2K' }, bound, [bytes]);
  assert.equal(body.project, bound.projectId); assert.equal(body.model, model.id);
  assert.equal(Object.hasOwn(body, 'userAgent'), false);
  assert.equal(body.request.generationConfig.imageConfig.imageSize, '2K');
  assert.equal(body.request.contents[0].parts[1].inlineData.data, bytes.toString('base64'));
  assert.equal(JSON.stringify(body).includes(token), false);
  assert.throws(() => buildDirectImageBody({ ...request('/tmp/offline'), modelId: 'other-image' }, bound, []), { message: 'IMAGE_DIRECT_SCOPE_INVALID' });
});

test('one fake response is saved as one fully decoded PNG; no official history is fabricated', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ag-direct-test-'));
  try {
    let sends = 0, verifies = 0;
    const result = await generateDirectImage(request(root), new AbortController().signal, {
      bind: async () => ({ token, projectId: 'offline-project', modelId: model.id, verify: async () => { verifies++; } }),
      send: async (actualToken, body) => { sends++; assert.equal(actualToken, token); assert.equal(body.model, model.id); return response(png()); }
    });
    assert.equal(sends, 1); assert.equal(verifies, 2); assert.equal(result.images.length, 1);
    assert.equal(result.images[0].width, 2); assert.equal(result.conversationId, null);
    assert.deepEqual(await fs.readFile(result.images[0].file), png());
    assert.equal((await fs.readdir(root)).length, 1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('partial batch carries only safe HTTP fields from its failed later request', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ag-direct-partial-'));
  try {
    let sends = 0;
    const result = await generateDirectImageBatch({ ...request(root), count: 2 }, new AbortController().signal, {
      bind: async () => ({ token, projectId: 'offline-project', modelId: model.id, verify: async () => {} }),
      send: async () => {
        sends++;
        if (sends === 1) return response(png());
        return Promise.reject(imageHttpFailure(429, { error: { status: 'RESOURCE_EXHAUSTED',
          message: 'SENTINEL_PRIVATE_PROMPT SECRET_TOKEN', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
            reason: 'RATE_LIMIT_EXCEEDED', metadata: { project: 'SECRET_PROJECT' } }] } }, '11'));
      }
    });
    assert.equal(sends, 2); assert.equal(result.images.length, 1);
    assert.equal(result.batch.failure.httpStatus, 429);
    assert.equal(result.batch.failure.serviceStatus, 'RESOURCE_EXHAUSTED');
    assert.equal(result.batch.failure.serviceReason, 'RATE_LIMIT_EXCEEDED');
    assert.equal(result.batch.failure.retryAfterSeconds, 11);
    assert.equal(result.batch.failure.evidence.reasons, 'recognized');
    assert.equal(result.batch.failure.modelSource, 'official-hub');
    assert.match(result.batch.failure.respondedAt, /^\d{4}-/);
    assert.doesNotMatch(JSON.stringify(result.batch), /SENTINEL_PRIVATE_PROMPT|SECRET_TOKEN|SECRET_PROJECT/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('explicit existing official PNG is recovered without any image request or source mutation',async()=>{
 // macOS may expose /var as an alias; this fixture represents the pinned native home.
 const home=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'ag-direct-recover-')));
 try{
  const output=path.join(home,'output');const brain=path.join(home,'.gemini','antigravity-cli','brain','12345678-1234-4123-8123-123456789abc');
  await fs.mkdir(brain,{recursive:true});await fs.mkdir(output);
  const source=path.join(brain,'generated_image_0.png');await fs.writeFile(source,png());
  const recovered=await recoverExistingImage(source,output,home);
  assert.notEqual(recovered.file,source);assert.deepEqual(await fs.readFile(recovered.file),png());assert.deepEqual(await fs.readFile(source),png());
  await assert.rejects(recoverExistingImage(path.join(output,path.basename(source)),output,home),/IMAGE_ARTIFACT_PATH_REJECTED/);
 }finally{await fs.rm(home,{recursive:true,force:true});}
});

test('invalid or ambiguous inline data never saves an image', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ag-direct-invalid-'));
  try {
    const good = response(png());
    for (const bad of [null, {}, { candidates: [] },
      { response: { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/jpeg', data: png().toString('base64') } }] } }] } },
      response(Buffer.from('bad png'))]) {
      await assert.rejects(generateDirectImage(request(root), new AbortController().signal, {
        bind: async () => ({ token, projectId: 'offline-project', modelId: model.id, verify: async () => {} }), send: async () => bad
      }));
      assert.deepEqual(await fs.readdir(root), []);
    }
    assert.equal(decodeDirectImageResponse(good)[0].info.width, 2);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('abort after submission is outcome-unknown and never retries', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ag-direct-abort-'));
  try {
    const controller = new AbortController(); let sends = 0;
    await assert.rejects(generateDirectImage(request(root), controller.signal, {
      bind: async () => ({ token, projectId: 'offline-project', modelId: model.id, verify: async () => { if (controller.signal.aborted) throw Error('IMAGE_CANCELLED'); } }),
      send: async () => { sends++; controller.abort(); return response(png()); }
    }), { message: 'IMAGE_DIRECT_OUTCOME_UNKNOWN' });
    assert.equal(sends, 1); assert.deepEqual(await fs.readdir(root), []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('fake HTTPS transport pins Google destination, no redirect, no raw error and no retry', async () => {
  const seen = [];
  const fake = (options, receive) => {
    seen.push(options);
    const req = new EventEmitter(); req.destroy = () => {};
    req.end = body => { assert.equal(JSON.parse(body).project, 'offline-project');
      queueMicrotask(() => { const res = new EventEmitter(); res.statusCode = 403; res.headers = { 'content-type': 'text/plain' }; res.destroy = () => {}; receive(res); }); };
    return req;
  };
  await assert.rejects(sendDirectImage(token, { project: 'offline-project' }, new AbortController().signal, fake), { message: 'IMAGE_DIRECT_FORBIDDEN' });
  assert.equal(seen.length, 1); assert.equal(seen[0].hostname, 'daily-cloudcode-pa.googleapis.com');
  assert.equal(seen[0].path, '/v1internal:generateContent'); assert.equal(seen[0].rejectUnauthorized, true);
  assert.equal(seen[0].headers['User-Agent'], 'Antigravity-Workbench/0.1.5');
});

test('429 without a specific reason remains ambiguous, preserving safe HTTP evidence without raw server text', async () => {
  const requestId = '12345678-1234-4123-8123-123456789abc';
  let calls = 0;
  const fake = (_options, receive) => {
    calls++;
    const req = new EventEmitter(); req.destroy = () => {};
    req.end = () => queueMicrotask(() => {
      const res = new EventEmitter(); res.statusCode = 429;
      res.headers = { 'content-type': 'application/json', 'retry-after': '17' }; res.destroy = () => {};
      receive(res);
      res.emit('data', Buffer.from(JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED',
        message: 'SENTINEL_PRIVATE_PROMPT Bearer SECRET_TOKEN' } })));
      res.emit('end');
    });
    return req;
  };
  const error = await sendDirectImage(token, { requestId, project: 'offline-project' }, new AbortController().signal, fake)
    .then(() => { throw Error('expected rejection'); }, value => value);
  assert.equal(calls, 1);
  assert.equal(error.message, 'IMAGE_DIRECT_RESOURCE_EXHAUSTED');
  assert.equal(error.httpStatus, 429);
  assert.equal(error.serviceStatus, 'RESOURCE_EXHAUSTED');
  assert.equal(error.serviceReason, undefined);
  assert.equal(error.retryAfterSeconds, 17);
  assert.equal(error.requestId, requestId);
  assert.equal(error.responseShape, 'structured');
  assert.match(error.respondedAt, /^\d{4}-\d\d-\d\dT/);
  const exposed = JSON.stringify(error) + String(error) + formatImageFailure(error) + JSON.stringify(debugErrorData(error));
  assert.doesNotMatch(exposed, /SENTINEL_PRIVATE_PROMPT|SECRET_TOKEN|offline-project/);
  assert.match(formatImageFailure(error), /具体原因未确认/);
});

test('structured Google reasons distinguish rate, concurrency, quota, capacity and project failures', () => {
  const detail = reason => ({ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason,
    metadata: { account: 'SENTINEL_PRIVATE_ACCOUNT', project: 'SENTINEL_PRIVATE_PROJECT' } });
  const error = (status, reason, extra = []) => imageHttpFailure(status, { error: { status: 'RESOURCE_EXHAUSTED',
    message: 'SENTINEL_PRIVATE_PROMPT', details: [...(reason ? [detail(reason)] : []), ...extra] } }, undefined, undefined, 'structured', 0);
  assert.equal(error(429, 'RATE_LIMIT_EXCEEDED').message, 'IMAGE_DIRECT_RATE_LIMITED');
  assert.equal(error(429, 'CONCURRENCY_LIMIT_EXCEEDED').message, 'IMAGE_DIRECT_CONCURRENCY_LIMITED');
  assert.equal(error(429, 'QUOTA_EXHAUSTED').message, 'IMAGE_DIRECT_QUOTA_LIMITED');
  assert.equal(error(429, 'INSUFFICIENT_QUOTA').message, 'IMAGE_DIRECT_QUOTA_EXHAUSTED');
  assert.equal(error(429, 'CAPACITY_EXCEEDED').message, 'IMAGE_DIRECT_CAPACITY_UNAVAILABLE');
  assert.equal(error(403, 'PROJECT_NOT_ALLOWED').message, 'IMAGE_DIRECT_PROJECT_ACCESS_DENIED');
  assert.equal(error(429, undefined, [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
    violations: [{ subject: 'SENTINEL_PRIVATE_PROJECT' }] }]).message, 'IMAGE_DIRECT_QUOTA_LIMITED');
  assert.equal(error(429, 'UNKNOWN_NEW_REASON').message, 'IMAGE_DIRECT_RESOURCE_EXHAUSTED');
  assert.equal(error(429, 'RATE_LIMIT_EXCEEDED', [detail('QUOTA_EXHAUSTED')]).message, 'IMAGE_DIRECT_RESOURCE_EXHAUSTED');
  assert.doesNotMatch(JSON.stringify(error(429, undefined, [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
    violations: [{ subject: 'SENTINEL_PRIVATE_PROJECT' }] }])), /SENTINEL/);
});

test('Retry-After and RetryInfo are bounded hints only; oversized errors stay generic and never retry', async () => {
  assert.equal(retryAfterSeconds('25', 0), 25);
  assert.equal(retryAfterSeconds('90000', 0), 90000);
  assert.equal(retryAfterSeconds('2592001', 0), undefined);
  assert.equal(retryAfterSeconds('Thu, 01 Jan 1970 00:00:12 GMT', 0), 12);
  assert.equal(retryAfterSeconds('Bearer SECRET_TOKEN', 0), undefined);
  const retry = imageHttpFailure(429, { error: { status: 'RESOURCE_EXHAUSTED', details: [
    { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '7.2s' } ] } }, undefined, undefined, 'structured', 0);
  assert.equal(retry.retryAfterSeconds, 8);
  let calls = 0;
  const fake = (_options, receive) => {
    calls++; const req = new EventEmitter(); req.destroy = () => {};
    req.end = () => queueMicrotask(() => {
      const res = new EventEmitter(); res.statusCode = 429; res.headers = { 'content-type': 'application/json' }; res.destroy = () => {};
      receive(res); res.emit('data', Buffer.alloc(16 * 1024 + 1, 65));
    });
    return req;
  };
  const failure = await sendDirectImage(token, { project: 'offline-project' }, new AbortController().signal, fake)
    .then(() => { throw Error('expected rejection'); }, value => value);
  assert.equal(calls, 1);
  assert.equal(failure.message, 'IMAGE_DIRECT_RESOURCE_EXHAUSTED');
  assert.equal(failure.responseShape, 'oversize');
});

test('the image operation preserves only source provenance and bounded HTTP failure metadata', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ag-direct-error-'));
  try {
    let sends = 0;
    const failure = await generateDirectImage(request(root), new AbortController().signal, {
      bind: async () => ({ token, projectId: 'offline-project', modelId: model.id,
        projectSource: 'loadCodeAssist', verify: async () => {} }),
      send: async () => { sends++; throw imageHttpFailure(429, { error: { status: 'RESOURCE_EXHAUSTED',
        message: 'SENTINEL_PRIVATE_PROMPT' } }, '12', accountId, 'structured', 1_700_000_000_000); }
    }).then(() => { throw Error('expected rejection'); }, value => value);
    assert.equal(sends, 1);
    assert.equal(failure.message, 'IMAGE_DIRECT_RESOURCE_EXHAUSTED');
    assert.equal(failure.modelSource, 'official-hub');
    assert.equal(failure.projectSource, 'loadCodeAssist');
    assert.deepEqual(await fs.readdir(root), []);
    assert.match(formatImageFailure(failure), /project 来源：本次服务端元数据/);
    assert.equal(debugErrorData(failure).httpStatus, 429);
    assert.equal(debugErrorData(failure).projectSource, 'loadCodeAssist');
    assert.doesNotMatch(formatImageFailure(failure) + JSON.stringify(debugErrorData(failure)), /SENTINEL_PRIVATE_PROMPT|offline-project/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('fixed authenticated project discovery accepts one opaque response without retry or storage write', async () => {
  const seen = [];
  const fake = (options, receive) => {
    seen.push(options);
    const req = new EventEmitter(); req.destroy = () => {};
    req.end = body => {
      assert.deepEqual(JSON.parse(body), { metadata: { ideType: 'ANTIGRAVITY' } });
      queueMicrotask(() => { const res = new EventEmitter(); res.statusCode = 200;
        res.headers = { 'content-type': 'application/json' }; res.destroy = () => {}; receive(res);
        res.emit('data', Buffer.from(JSON.stringify({ cloudaicompanionProject: 'opaque/项目 1' })));
        res.emit('end'); });
    };
    return req;
  };
  assert.equal(await resolveImageProject(token, new AbortController().signal, fake), 'opaque/项目 1');
  assert.equal(seen.length, 1); assert.equal(seen[0].hostname, 'daily-cloudcode-pa.googleapis.com');
  assert.equal(seen[0].path, '/v1internal:loadCodeAssist');
  assert.equal(seen[0].rejectUnauthorized, true);
  assert.equal(seen[0].headers.Authorization, `Bearer ${token}`);
});

test('project discovery rejects redirect and missing project without exposing response content', async () => {
  for (const [status, payload, code] of [[302, {}, 'IMAGE_DIRECT_PROJECT_LOOKUP_FAILED'],
    [200, { unexpected: 'offline.synthetic.private' }, 'IMAGE_DIRECT_PROJECT_LOOKUP_INVALID']]) {
    let calls = 0;
    const fake = (_options, receive) => { calls++;
      const req = new EventEmitter(); req.destroy = () => {};
      req.end = () => queueMicrotask(() => { const res = new EventEmitter(); res.statusCode = status;
        res.headers = { 'content-type': 'application/json' }; res.destroy = () => {}; receive(res);
        if (status === 200) { res.emit('data', Buffer.from(JSON.stringify(payload))); res.emit('end'); } });
      return req;
    };
    await assert.rejects(resolveImageProject(token, new AbortController().signal, fake), error => {
      assert.equal(error.message, code); assert.equal(error.message.includes('offline.synthetic.private'), false); return true;
    });
    assert.equal(calls, 1);
  }
});

test('thin webview keeps one confirmation, cancels before send, coalesces clicks and closes', async () => {
  const commands = new Map(), states = [];
  let message, close, panel, answer, runCount = 0, requestSignal;
  const uri = file => ({ scheme: 'file', authority: '', fsPath: file, path: file });
  const vscode = { ViewColumn: { Active: 1 }, Uri: { file: uri }, env: { remoteName: undefined },
    workspace: { workspaceFolders: [{ name: 'offline', uri: uri(os.tmpdir()) }] },
    commands: { registerCommand: (id, callback) => { commands.set(id, callback); return { dispose() {} }; } },
    window: { createWebviewPanel: () => {
      panel = { webview: { html: '', postMessage: async value => { states.push(value); },
        onDidReceiveMessage: callback => { message = callback; return { dispose() {} }; } },
        onDidDispose: callback => { close = callback; return { dispose() {} }; }, reveal() {}, dispose() { close(); } };
      return panel;
    }, showWarningMessage: text => { assert.match(text, /向 Google 提交/); assert.doesNotMatch(text, /Daily|Production|googleapis\.com/); assert.ok(text.includes(model.id)); assert.match(text, /可能消耗额度/); return answer(); } }
  };
  const entry = require.resolve('../out/direct-image-ui'); const original = Module._load;
  Module._load = function (name, ...args) { return name === 'vscode' ? vscode : original.call(this, name, ...args); };
  delete require.cache[entry]; const ui = require(entry);
  const direct = { getEndpoint: () => 'production', readChoices: async () => ({ accounts: [selected], models: [model] }),
    run: (approvedRequest, signal) => { assert.equal(approvedRequest.endpoint, 'production'); runCount++; requestSignal = signal;
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Error('IMAGE_DIRECT_OUTCOME_UNKNOWN')), { once: true })); } };
  try { ui.registerDirectImageUi({ subscriptions: [], globalState: { get: () => undefined, update: async () => {} } }, direct, undefined, require('./helpers/image-session.cjs').memorySession()); }
  finally { Module._load = original; }
  await commands.get('antigravityAccounts.images.open')();
  await message({ type: 'ready' });
  new vm.Script(panel.webview.html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1]);
  assert.match(panel.webview.html, /id="account"/); assert.match(panel.webview.html, /id="model"/);
  assert.doesNotMatch(panel.webview.html, /for="executable"/);
  assert.equal(states.at(-1).choices.models[0].id, model.id);
  const generate = { type: 'generate', prompt: 'Offline UI fixture', ratio: '1:1', count: 1,
    size: 'auto', quality: 'auto', accountId, modelId: model.id, endpoint: 'daily' };
  let decide; answer = () => new Promise(resolve => { decide = resolve; });
  const first = message(generate); await new Promise(setImmediate); await message(generate);
  assert.equal(typeof decide, 'function'); assert.equal(runCount, 0);
  await message({ type: 'cancel' }); decide('确认生成'); await first;
  assert.equal(runCount, 0);
  answer = () => Promise.resolve('确认生成');
  const second = message(generate); await new Promise(setImmediate);
  assert.equal(runCount, 1); await message(generate); assert.equal(runCount, 1);
  panel.dispose(); assert.equal(requestSignal.aborted, true);
  await second;
});

test('one frozen binding owns every request and artifact, even when the external selection changes',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'ag-frozen-batch-'));let binds=0,sends=0;const tokens=[];
 try{const result=await generateDirectImageBatch({...request(root),count:3},new AbortController().signal,{
  bind:async id=>{binds++;return{accountId:id,token:'synthetic-A',projectId:'project-A',modelId:model.id,verify:async()=>{}}},
  send:async actual=>{sends++;tokens.push(actual);return response(png())},
 });assert.equal(binds,1);assert.equal(sends,3);assert.deepEqual(tokens,['synthetic-A','synthetic-A','synthetic-A']);assert.ok(result.images.every(x=>x.accountId===accountId));}
 finally{await fs.rm(root,{recursive:true,force:true})}
});
test('current-account binding freezes its verified bearer after preflight and ignores later official login changes',async()=>{
 let changed=false;const signal=new AbortController().signal;
 const bound=await bindSavedImageAccount({vault:vault(),selected,hostId,model,signal,freezeAfterBinding:true,
 assertCurrent:async()=>{if(changed)throw Error('IMAGE_DIRECT_ACCOUNT_CHANGED')},verifyIdentity:async()=>({email})});
 changed=true;await bound.verify(signal);assert.equal(bound.accountId,accountId);assert.equal(bound.token,token);
});


test('catalog membership accepts new and unknown image IDs and rejects invented, text, cloned or wrong-account proofs',async()=>{
 const auth={authResult:{hasValidAuth:true}},state={userStatus:{email}};
 for(const id of ['gemini-nano-banana-2.1','future-visual-v4']){
  const choice=currentImageModels(auth,state,{response:{imageGenerationModelIds:[id],models:{[id]:{},'text-model':{}}}},email)[0];
  assert.equal(Object.isFrozen(choice),true);const bound=await binding(vault(),{model:choice});assert.equal(bound.modelId,id);
  if(id==='gemini-nano-banana-2.1')assert.match(choice.label,/Nano Banana 2.1/);
  await assert.rejects(binding(vault(),{model:{...choice}}),/MODEL_UNVERIFIED/);
 }
 const other=currentImageModels(auth,{userStatus:{email:'other@example.test'}},{response:{imageGenerationModelIds:[model.id],models:{[model.id]:{}}}},'other@example.test')[0];
 for(const candidate of [other,{id:'invented-image',label:'Fake'},{id:'text-model',label:'Text'}])await assert.rejects(binding(vault(),{model:candidate}),/MODEL_UNVERIFIED/);
 for(const disabled of [true,'false',1,null])assert.throws(()=>currentImageModels(auth,state,{response:{imageGenerationModelIds:[model.id],models:{[model.id]:{disabled}}}},email),/MODEL_UNVERIFIED/);
});
for(const change of ['identity','auth','endpoint'])test(`current catalog rejects ${change} changes during GetAvailableModels before publishing choices`,async()=>{
 const entry=require.resolve('../out/direct-image-vscode'),old=Module._load;let changed=false,catalogs=0,endpoint='daily';const extension={isActive:true,exports:{port:40001,csrfToken:'synthetic-local-session'}};
 Module._load=function(name,...args){
  if(name==='vscode')return{UIKind:{Desktop:1},env:{uiKind:1,remoteName:'wsl'},workspace:{isTrusted:true,getConfiguration:()=>({inspect:()=>({globalValue:endpoint})})},extensions:{getExtension:()=>extension}};
  if(name==='./official-extension-identity')return{pinOfficialExtension:()=>({}),matchesOfficialExtension:()=>true};
  if(name==='./native-host')return{nativeHostStatus:()=>({available:true})};
  if(name==='./live-hub')return{generation:require('../out/live-hub').generation,hasOfficialHubApi:()=>true,hubRpc:async(_api,method)=>{
   if(method==='GetAuthStatus')return{authResult:{hasValidAuth:!changed||change!=='auth'}};
   if(method==='GetUserStatus')return{userStatus:{email:changed&&change==='identity'?'other@example.test':email}};
   catalogs++;changed=true;if(change==='endpoint')endpoint='production';return{response:{imageGenerationModelIds:[model.id],models:{[model.id]:{}}}};
  }};
  return old.call(this,name,...args);
 };
 try{delete require.cache[entry];const direct=require(entry).createDirectImageIntegration({subscriptions:[]},()=>[selected],{journal:{dispose(){},read:async()=>[],write:async()=>true}});await assert.rejects(direct.readChoices(new AbortController().signal),new RegExp(change==='endpoint'?'ENDPOINT_CHANGED':'ACCOUNT_CHANGED'));assert.equal(catalogs,1);}finally{Module._load=old;delete require.cache[entry]}
});
