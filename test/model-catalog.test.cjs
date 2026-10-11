const test = require('node:test'), assert = require('node:assert/strict'), { randomUUID } = require('node:crypto'), path = require('node:path');
const { parseModelCatalog, catalogChoices, assertModelUse } = require('../out/model-catalog');
const { imageQuotaFromCatalog } = require('../out/image-quota');
const { buildDirectImageBody } = require('../out/direct-image-core');
const { wakeRequestBody } = require('../out/wake-transport');
const { ModelCatalogDisplay, catalogDisplayKey } = require('../out/model-catalog-display');
const { parseWakeTask } = require('../out/wake-state');
const { inspect, check } = require('../scripts/check-model-hardcoding.cjs');
test('production AST architecture gate and negative probes catch several hardcoding mechanisms', () => {
  assert.deepEqual(check(path.resolve(__dirname, '..')), []);
  for (const source of ["const x = modelId === 'unfamiliar-zeta';", "const x = modelId.startsWith('future-');", "const x = {modelId:'unfamiliar-zeta'};", "const x = {id:'unfamiliar-zeta'};", "const x = /sonnet/.test(label);", "function validModel(value){return /image/.test(value)}", "const x = {'claude-opus-4':'Renamed'};"]) assert.ok(inspect('direct-image-binding.ts', source).length, source);
  assert.ok(inspect('another-parser.ts', 'const roles = response.imageGenerationModelIds;').length);
  for (const source of ["const x = modelEnum ?? 'MODEL_FUTURE';", "const x = {model_enum:'MODEL_FUTURE'};", "const modelNames = {'unknown-a':'Marketing A'};", "const imageModelIds = ['unknown-a'];"]) assert.ok(inspect('new-feature.ts', source).length, source);
  assert.deepEqual(inspect('direct-image-protocol.ts', "const role = 'image_gen'; const id = model.id;"), []);
});
test('randomized unknown IDs and misleading names preserve exact identity, role, quota and final wire', () => {
  for (let i = 0; i < 60; i++) {
    const visual = randomUUID(), chat = randomUUID(), unknown = randomUUID(), accountId = randomUUID();
    const raw = { models: { [chat]: { displayName: 'Image Pro Thinking', supportsImages: true }, [unknown]: { displayName: 'Ordinary text' }, [visual]: { displayName: '对话 Text', model: 'MODEL_RANDOM_ENUM', quotaInfo: { remainingFraction: .413 } } }, imageGenerationModelIds: [visual], agentModelSorts: [{ groups: [{ modelIds: [chat, visual, chat] }] }] };
    const catalog = parseModelCatalog(i % 2 ? { response: raw } : raw);
    assert.strictEqual(parseModelCatalog(catalog), catalog);
    const image = catalogChoices(catalog, 'image'), conversation = catalogChoices(catalog, 'conversation');
    assert.deepEqual(image.map(m => m.id), [visual, unknown]); assert.deepEqual(conversation.map(m => m.id), [chat, unknown]);
    assert.equal(image[1].classification, 'unclassified'); assert.equal(conversation[1].classification, 'unclassified');
    assert.throws(() => assertModelUse(conversation[1], false, 'USAGE_REQUIRED'), /USAGE_REQUIRED/);
    assertModelUse(conversation[1], true, 'USAGE_REQUIRED');
    assert.equal(imageQuotaFromCatalog(catalog, image)[0].remainingFraction, .413); assert.equal(imageQuotaFromCatalog(catalog, image)[1].remainingFraction, null);
    const request = { prompt: 'fixture', accountId, modelId: visual, aspectRatio: '1:1', size: '4K', quality: 'detail' };
    const bound = { accountId, token: 'synthetic', projectId: 'synthetic-project', modelId: visual, modelEnum: image[0].modelEnum, verify: async () => {} };
    const body = buildDirectImageBody(request, bound, []);
    assert.equal(body.model, visual); assert.equal(body.requestType, 'image_gen'); assert.equal(body.request.labels.model_enum, 'MODEL_RANDOM_ENUM');
    assert.equal(body.request.generationConfig.imageConfig.imageSize, '4K'); assert.equal(body.request.generationConfig.thinkingConfig, undefined);
    const text = wakeRequestBody({ ...bound, modelId: chat, endpoint: 'daily' }, 8);
    assert.equal(text.model, chat); assert.equal(text.requestType, 'agent'); assert.deepEqual(text.request.generationConfig, { maxOutputTokens: 8, temperature: 0 });
    assert.throws(() => buildDirectImageBody({ ...request, size: 'invented-size' }, bound, []), /SCOPE_INVALID/);
    assert.throws(() => buildDirectImageBody(request, { ...bound, imageInput: false }, [Buffer.from('fixture')]), /SCOPE_INVALID/);
  }
});
test('catalog addition/removal/rename/disabled updates never synthesize permissions or quotas', () => {
  const raw = { models: { 'future-a': { displayName: '服务端原名' }, 'future-b': { disabled: true }, 'future-c': { disabled: 'false' } }, imageGenerationModelIds: ['future-a', 'future-b'] };
  assert.deepEqual(catalogChoices(raw, 'image').map(m => m.id), ['future-a']);
  raw.models['future-a'].displayName = 'Server renamed'; raw.models['future-d'] = {};
  assert.equal(catalogChoices(raw, 'image')[0].label, 'Server renamed (future-a)');
  assert.equal(catalogChoices(raw, 'conversation')[0].id, 'future-d'); assert.equal(catalogChoices(raw, 'conversation')[0].classification, 'unclassified');
  raw.imageGenerationModelIds = []; delete raw.models['future-a'];
  assert.deepEqual(catalogChoices(raw, 'image').map(m => m.id), ['future-d']);
  assert.equal(imageQuotaFromCatalog(raw, [{ id: 'future-d' }])[0].remainingFraction, null);
  for (const bad of [{ ...raw, imageGenerationModelIds: null }, { ...raw, response: raw }, { ...raw, agentModelSorts: [{ groups: null }] }]) assert.throws(() => parseModelCatalog(bad), /CATALOG_INVALID/);
});
test('display persistence isolates accounts/endpoints/roles, retains last selection and is never a membership proof', async () => {
  const state = new Map(), storage = { get: key => state.get(key), update: async (key, value) => state.set(key, value) };
  const cache = new ModelCatalogDisplay(storage), a = catalogDisplayKey('account-A-revision', 'daily', 'image');
  const entry = { models: [{ id: 'future-a', label: '服务端名称 (future-a)', classification: 'unclassified', token: 'must-not-persist' }], selectedId: 'future-a', queriedAt: '2026-10-11T00:00:00Z', source: 'fetchAvailableModels' };
  await cache.save(a, entry); await cache.confirm(a, 'future-a', true);
  await Promise.all([cache.select(a, 'future-a'), cache.save(a, { ...entry, queriedAt: '2026-10-11T01:00:00Z' })]);
  assert.deepEqual(cache.get(a).confirmedIds, ['future-a']);
  assert.equal(cache.get(catalogDisplayKey('account-A-revision', 'daily', 'image', {quotaDisplayId: 'replacement'})), undefined);
  const restored = new ModelCatalogDisplay(storage); assert.equal(restored.get(a).selectedId, 'future-a'); assert.doesNotMatch(JSON.stringify([...state]), /token|must-not-persist/);
  for (const scope of [['account-B-revision','daily','image'],['account-A-revision','production','image'],['account-A-revision','daily','conversation'],['account-A-replaced','daily','image']]) assert.equal(restored.get(catalogDisplayKey(...scope)), undefined);
  await cache.save(a, { ...entry, models: [] }); assert.equal(restored.get(a).selectedId, 'future-a'); assert.deepEqual(restored.get(a).models, []);
});
test('legacy task migration keeps model and schedule without inventing an unknown-role confirmation', () => {
  const old = { id: randomUUID(), revision: randomUUID(), accountId: randomUUID(), fingerprint: 'fixture', modelId: 'old-user-choice', endpoint: 'daily', schedule: { timezone: 'Etc/UTC', times: ['08:00'], weekdays: [1] }, enabled: true, outputBudget: 8, nextDue: 0 };
  assert.equal(parseWakeTask(old).modelId, old.modelId); assert.equal(parseWakeTask(old).enabled, true); assert.equal(parseWakeTask(old).confirmedModelUse, undefined);
  assert.equal(parseWakeTask({ ...old, confirmedModelUse: true }).confirmedModelUse, true);
});
