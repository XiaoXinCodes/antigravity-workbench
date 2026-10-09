const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const entry = require.resolve('../out/live-ui');
const { LiveError } = require('../out/live-storage');
const { generation } = require('../out/live-hub');
const { t: tr } = require('../out/i18n');
const tick = () => new Promise(setImmediate);
const localHost = 'a'.repeat(64), foreignHost = 'b'.repeat(64);
const localId = '11111111-1111-4111-8111-111111111111';
const foreignId = '22222222-2222-4222-8222-222222222222';

// Isolated host and API only. No official backend, native credentials or Google.
function fixture(t) {
  const commands = new Map(), state = new Map(), data = new Map(), events = [];
  const account = { id: localId, label: 'Synthetic A', expectedEmail: 'a@example.test', capturedAt: new Date().toISOString(), identitySource: 'hub', hostId: localHost };
  state.set('live-switch.accounts.v1', [account]);
  data.set(`live-switch.account.v1.${account.id}`, 'synthetic-saved-copy');
  const official = { id: 'google.google-antigravity', extensionKind: 1, extensionUri: { scheme: 'file', authority: '' }, extensionPath: path.resolve('/synthetic-official-extension'), packageJSON: { version: '1.6.0', main: './extension.js' }, isActive: true, exports: { port: 34567, csrfToken: 'synthetic-current-csrf' } };
  const proof = (email = account.expectedEmail) => ({ email, generation: generation(official.exports), observedAt: new Date().toISOString(), authValid: true, quotaSource: 'server', buckets: [{ label: 'Synthetic quota', remaining: 0.5, resetAt: null }] });
  const ui = { answer: undefined, identity: async () => proof(), focus: undefined, currentCalls: 0, savedCalls: 0, identityCalls: 0 };
  const vscode = { UIKind: { Desktop: 1 }, env: { uiKind: 1 }, extensions: { getExtension: id => id === official.id ? official : undefined },
    workspace: { isTrusted: true, getConfiguration: () => ({ get: () => undefined }) },
    commands: { registerCommand(name, fn) { commands.set(name, fn); return { dispose() {} }; } },
    window: { onDidChangeWindowState(fn) { ui.focus = fn; return { dispose() {} }; },
      async showWarningMessage(text) { events.push({ type: 'confirmation', text }); return ui.answer; }, async showQuickPick() { return undefined; }, async showInformationMessage() {} } };
  const load = Module._load;
  Module._load = function(id, ...args) { return id === 'vscode' ? vscode : load.call(this, id, ...args); };
  let registerLiveUi;
  try { delete require.cache[entry]; ({ registerLiveUi } = require(entry)); } finally { Module._load = load; }
  const context = { subscriptions: [], secrets: { get: async key => data.get(key), store: async (key, value) => { data.set(key, value); }, delete: async key => { events.push({ type: 'delete', key }); data.delete(key); } },
    globalState: { get: (key, fallback) => state.has(key) ? state.get(key) : fallback, update: async (key, value) => { state.set(key, value); } },
    extension: { extensionKind: 1 }, extensionUri: { scheme: 'file', authority: '' }, globalStorageUri: { scheme: 'file', authority: '', toString: () => 'file:///synthetic-account-interaction-storage' } };
  const service = { journal: async () => null, hostIsCurrent: row => row.hostId === localHost, credentialHostIdentity: () => localHost,
    savedLoginUsable: async () => false, account: async id => ({ ...state.get('live-switch.accounts.v1').find(row => row.id === id), slots: { keyring: null, file: 'synthetic-slot' } }),
    removeImportCandidates: async id => { events.push({ type: 'remove-import-candidates', id }); } };
  const locks = { withOperation: async fn => fn(), hasRecovery: async () => false, beginRecovery: async () => {}, clearRecovery: async () => {} };
  const controller = registerLiveUi(context, { service, locks, lifecycle: async () => { events.push({ type: 'lifecycle' }); throw new LiveError('OFFICIAL_BACKEND_UNAVAILABLE'); },
    currentIdentity: signal => { ui.identityCalls++; return ui.identity(signal); },
    currentQuota: async email => { ui.currentCalls++; return proof(email); }, savedQuota: async saved => { ui.savedCalls++; return proof(saved.expectedEmail); } });
  t.after(() => context.subscriptions.forEach(item => item.dispose()));
  return { account, official, proof, ui, controller, service, state, data, events, call: (name, arg) => commands.get('antigravityAccounts.live.' + name)(arg) };
}

async function rechecking(f) {
  let complete, entered, signal;
  const ready = new Promise(resolve => { entered = resolve; });
  f.ui.identity = value => { signal = value; entered(); return new Promise(resolve => { complete = resolve; }); };
  f.ui.focus({ focused: true }); await ready;
  assert.equal(f.controller.getState().identityChecking, true);
  assert.equal(f.controller.getState().activeEmail, f.account.expectedEmail);
  return { signal, complete: value => complete(value) };
}

test('refresh during focus recheck uses the current official session and keeps current identity', async t => {
  const f = fixture(t); await f.controller.refresh();
  const pending = await rechecking(f);
  await f.call('quota', f.account.id);
  assert.equal(pending.signal.aborted, true);
  assert.equal(f.ui.currentCalls, 1, 'current account must use the official session');
  assert.equal(f.ui.savedCalls, 0, 'must not load a second saved credential client');
  assert.equal(f.controller.getState().activeEmail, f.account.expectedEmail);
  assert.equal(f.controller.getState().identityChecking, false);
  assert.equal(f.controller.getAccounts()[0].active, true);
  assert.equal(f.controller.getAccounts()[0].quota.phase, 'ready');
  pending.complete(f.proof('late-old-proof@example.test')); await tick();
  assert.equal(f.controller.getState().activeEmail, f.account.expectedEmail, 'cancelled late result cannot repaint current identity');
});

test('dismissing Save current while focus recheck is pending preserves identity without credential writes', async t => {
  const f = fixture(t); await f.controller.refresh(); const pending = await rechecking(f);
  await f.call('capture');
  assert.equal(pending.signal.aborted, true);
  assert.equal(f.controller.getState().activeEmail, f.account.expectedEmail);
  assert.equal(f.controller.getState().identityChecking, false);
  assert.ok(!f.events.some(event => event.type === 'lifecycle' || event.type === 'delete'));
  pending.complete(f.proof());
});

test('command cancellation cannot preserve identity from a replaced Hub generation', async t => {
  const f = fixture(t); await f.controller.refresh(); const pending = await rechecking(f);
  f.official.exports = { ...f.official.exports, csrfToken: 'synthetic-new-generation-csrf' };
  await f.call('capture');
  assert.equal(f.controller.getState().activeEmail, undefined);
  pending.complete(f.proof());
});

test('command cancellation cannot preserve identity after the official extension is replaced', async t => {
  const f = fixture(t); await f.controller.refresh(); const pending = await rechecking(f);
  f.official.packageJSON = { ...f.official.packageJSON, version: 'synthetic-new-version' };
  await f.call('capture');
  assert.equal(f.controller.getState().activeEmail, undefined);
  pending.complete(f.proof());
});

test('a real identity failure still invalidates the current account', async t => {
  const f = fixture(t); await f.controller.refresh();
  f.ui.identity = async () => { throw new LiveError('HUB_AUTH_INVALID'); };
  f.ui.focus({ focused: true }); await f.controller.refresh();
  assert.equal(f.controller.getState().activeEmail, undefined);
  assert.equal(f.controller.getState().identityChecking, false);
});

test('explicit confirmed foreign-host deletion does not depend on signed-out official identity', async t => {
  const f = fixture(t);
  const foreign = { ...f.account, id: foreignId, label: 'Synthetic foreign A', hostId: foreignHost };
  f.state.set('live-switch.accounts.v1', [f.account, foreign]);
  f.data.set(`live-switch.account.v1.${foreign.id}`, 'synthetic-foreign-copy');
  f.ui.identity = async () => { throw new LiveError('HUB_AUTH_INVALID'); }; await f.controller.refresh();
  const queries = f.ui.identityCalls;
  f.ui.answer = tr('liveUi.49283708f3'); await f.call('remove', foreign.id);
  assert.equal(f.ui.identityCalls, queries, 'foreign copy cannot be this host current login');
  assert.deepEqual(f.controller.getAccounts().map(row => row.id), [f.account.id]);
  assert.equal(f.data.has(`live-switch.account.v1.${foreign.id}`), false);
  assert.equal(f.data.has(`live-switch.account.v1.${f.account.id}`), true);
  assert.ok(f.events.some(event => event.type === 'remove-import-candidates' && event.id === foreign.id));
  assert.ok(!f.events.some(event => event.type === 'lifecycle'));
  assert.equal(f.state.get('live-switch.removed-current.v1.' + localHost), undefined);
});

test('foreign-host deletion cancellation performs no identity lookup or delete', async t => {
  const f = fixture(t); const foreign = { ...f.account, id: foreignId, hostId: foreignHost };
  f.state.set('live-switch.accounts.v1', [foreign]);
  f.ui.identity = async () => { throw new LiveError('HUB_AUTH_INVALID'); }; await f.controller.refresh();
  const queries = f.ui.identityCalls; await f.call('remove', foreign.id);
  assert.equal(f.ui.identityCalls, queries);
  assert.equal(f.controller.getAccounts().length, 1);
  assert.ok(!f.events.some(event => event.type === 'delete'));
});

for (const binding of [localHost, undefined, 'invalid-host-binding']) test(`failed official identity still protects local or uncertain copy (${binding ?? 'unbound'})`, async t => {
  const f = fixture(t); const guarded = { ...f.account, hostId: binding };
  f.state.set('live-switch.accounts.v1', [guarded]); f.ui.identity = async () => { throw new LiveError('HUB_AUTH_INVALID'); }; await f.controller.refresh();
  const queries = f.ui.identityCalls; f.ui.answer = tr('liveUi.49283708f3'); await f.call('remove', guarded.id);
  assert.equal(f.ui.identityCalls, queries + 1);
  assert.equal(f.controller.getAccounts().length, 1);
  assert.ok(!f.events.some(event => event.type === 'delete'));
});
