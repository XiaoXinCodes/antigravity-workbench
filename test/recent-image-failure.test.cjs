const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { imageHttpFailure } = require('../out/direct-image-http-error');
const { RECENT_IMAGE_FAILURE_KEY, captureRecentImageFailure, readRecentImageFailure,
  RecentImageFailureStore, formatRecentImageFailure } = require('../out/recent-image-failure');

const modelId = 'gemini-3.1-flash-image';
const operationId = '12345678-1234-4123-8123-123456789abc';
const accountId = '87654321-1234-4123-8123-123456789abc';
const privateText = 'SENTINEL_PRIVATE_PROMPT Bearer SECRET_TOKEN secret-project@example.test';
function failure() {
  const error = imageHttpFailure(429, { error: { status: 'RESOURCE_EXHAUSTED', message: privateText,
    details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'RATE_LIMIT_EXCEEDED',
      metadata: { account: privateText } }] } }, '17', undefined, 'structured');
  error.rawBody = privateText;
  error.projectId = privateText;
  return error;
}
function memento() {
  const values = new Map(), writes = [];
  return { values, writes, get: key => values.get(key), async update(key, value) {
    writes.push({ key, value });
    if (value === undefined) values.delete(key); else values.set(key, structuredClone(value));
  } };
}

test('recent failure keeps only bounded allowlisted metadata, never prompt, token, project or raw reply', () => {
  const record = captureRecentImageFailure(failure(), modelId, 'generating', operationId, Date.UTC(2026, 9, 3));
  assert.deepEqual(Object.keys(record).sort(), ['at', 'code', 'httpStatus', 'modelId', 'operationId',
    'retryAfterSeconds', 'schema', 'serviceReason', 'serviceStatus', 'stage', 'responseShape', 'respondedAt', 'evidence'].sort());
  assert.equal(record.code, 'IMAGE_DIRECT_RATE_LIMITED');
  assert.equal(record.httpStatus, 429); assert.equal(record.retryAfterSeconds, 17);
  assert.equal(record.serviceReason, 'RATE_LIMIT_EXCEEDED');
  assert.ok(Buffer.byteLength(JSON.stringify(record)) <= 1024);
  assert.doesNotMatch(JSON.stringify(record) + formatRecentImageFailure(record), /SENTINEL_PRIVATE_PROMPT|SECRET_TOKEN|secret-project/);
  assert.equal(readRecentImageFailure({ ...record, extra: privateText }).extra, undefined);
  assert.equal(readRecentImageFailure({ ...record, modelId: privateText }), undefined);
  assert.equal(readRecentImageFailure({ ...record, stage: privateText }), undefined);
  assert.equal(readRecentImageFailure({ ...record, operationId: privateText }), undefined);
  const oversized = { ...record, extra: privateText.repeat(10000) };
  assert.ok(Buffer.byteLength(JSON.stringify(readRecentImageFailure(oversized))) <= 1024);
});

test('local memento survives a new controller and only explicit success clears it', async () => {
  const state = memento();
  const first = new RecentImageFailureStore(state);
  const record = captureRecentImageFailure(failure(), modelId, 'generating', operationId);
  await first.save(record);
  assert.equal(state.writes.length, 1); assert.equal(state.writes[0].key, RECENT_IMAGE_FAILURE_KEY);
  const afterReload = new RecentImageFailureStore(state);
  assert.deepEqual(afterReload.get(), record);
  assert.equal(afterReload.get().httpStatus, 429);
  await afterReload.clear();
  assert.equal(new RecentImageFailureStore(state).get(), undefined);
  assert.equal(state.values.has(RECENT_IMAGE_FAILURE_KEY), false);
  state.values.set(RECENT_IMAGE_FAILURE_KEY, { ...record, modelId: privateText });
  assert.equal(new RecentImageFailureStore(state).get(), undefined);
});

test('failed state write retains the last confirmed failure', async () => {
  const state = memento();
  const stored = captureRecentImageFailure(failure(), modelId, 'generating', operationId);
  await new RecentImageFailureStore(state).save(stored);
  state.update = async () => { throw Error(privateText); };
  const afterReload = new RecentImageFailureStore(state);
  await assert.rejects(afterReload.clear());
  assert.deepEqual(afterReload.get(), stored);
  assert.deepEqual(new RecentImageFailureStore(state).get(), stored);
});

test('image UI keeps failure across panel recreation, retains it for unrelated actions, clears after saved success', async () => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'ag-recent-image-'));
  const state = memento();
  let runs = 0;
  const operationIds = [];
  const direct = { getEndpoint: () => 'production', readChoices: async () => ({ accounts: [{ id: accountId, label: 'Synthetic', active: true }],
    models: [{ id: modelId, label: 'Nano Banana 2' }] }),
    run: async (_request, _signal, progress, id) => {
      runs++; operationIds.push(id);
      progress({ phase: 'generating', message: 'working' });
      if (runs === 1) throw failure();
      if (runs === 2) return { images: [{ file: path.join(output, 'partial.png'), width: 2, height: 2 }],
        batch: { outcome: 'partial', requested: 2, completed: 1, error: 'IMAGE_DIRECT_RESOURCE_EXHAUSTED',
          failure: { httpStatus: 429, serviceStatus: 'RESOURCE_EXHAUSTED', retryAfterSeconds: 13 } } };
      return { images: [{ file: path.join(output, 'synthetic.png'), width: 2, height: 2 }],
        batch: { outcome: 'complete', requested: 1, completed: 1 } };
    } };
  const original = Module._load;
  function start() {
    const commands = new Map(), messages = [];
    let receive, close;
    const uri = file => ({ scheme: 'file', authority: '', fsPath: file, path: file });
    const vscode = { ViewColumn: { Active: 1 }, Uri: { file: uri }, env: { remoteName: undefined },
      workspace: { workspaceFolders: [{ uri: uri(output) }] },
      commands: { registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() {} }; } },
      window: { createWebviewPanel: () => ({ webview: { html: '', postMessage: async value => { messages.push(value); },
        onDidReceiveMessage: fn => { receive = fn; return { dispose() {} }; } },
        onDidDispose: fn => { close = fn; return { dispose() {} }; }, reveal() {} }),
      showWarningMessage: async () => '确认生成', showOpenDialog: async () => undefined } };
    Module._load = function (name, ...args) { return name === 'vscode' ? vscode : original.call(this, name, ...args); };
    const entry = require.resolve('../out/direct-image-ui'); delete require.cache[entry];
    const ui = require(entry);
    Module._load = original;
    ui.registerDirectImageUi({ subscriptions: [], globalState: state }, direct, undefined, require('./helpers/image-session.cjs').memorySession());
    const send = async value => { receive(value); for (let i = 0; i < 8; i++) await new Promise(setImmediate); };
    return { open: () => commands.get('antigravityAccounts.images.open')(), send, close: () => close(), messages };
  }
  try {
    const first = start(); await first.open();
    await first.send({ type: 'generate', prompt: privateText, accountId, modelId, ratio: '1:1', count: 1, size: 'auto', quality: 'auto' });
    assert.equal(runs, 1);
    assert.equal(state.values.get(RECENT_IMAGE_FAILURE_KEY).httpStatus, 429);
    assert.equal(state.values.get(RECENT_IMAGE_FAILURE_KEY).operationId, operationIds[0]);
    assert.doesNotMatch(JSON.stringify(state.writes), /SENTINEL_PRIVATE_PROMPT|SECRET_TOKEN|secret-project/);
    first.close();
    const afterReload = start(); await afterReload.open();
    assert.match(afterReload.messages.at(-1).recentDiagnostic, /HTTP 429/);
    await afterReload.send({ type: 'output' });
    assert.equal(state.values.has(RECENT_IMAGE_FAILURE_KEY), true);
    await afterReload.send({ type: 'generate', prompt: 'safe synthetic prompt', accountId, modelId, ratio: '1:1', count: 1, size: 'auto', quality: 'auto' });
    assert.equal(runs, 2);
    assert.equal(state.values.get(RECENT_IMAGE_FAILURE_KEY).code, 'IMAGE_DIRECT_RESOURCE_EXHAUSTED');
    assert.equal(state.values.get(RECENT_IMAGE_FAILURE_KEY).httpStatus, 429);
    assert.equal(state.values.get(RECENT_IMAGE_FAILURE_KEY).operationId, operationIds[1]);
    await afterReload.send({ type: 'generate', prompt: 'safe synthetic prompt', accountId, modelId, ratio: '1:1', count: 1, size: 'auto', quality: 'auto' });
    assert.equal(runs, 3);
    assert.equal(state.values.has(RECENT_IMAGE_FAILURE_KEY), false);
    assert.match(afterReload.messages.at(-1).recentDiagnostic, /暂无最近一次图片失败记录/);
  } finally { Module._load = original; await fs.rm(output, { recursive: true, force: true }); }
});
