const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const entry = require.resolve('../out/live-ui');
function load() {
  const original = Module._load;
  Module._load = function (name, ...args) { return name === 'vscode' ? {} : original.call(this, name, ...args); };
  try { delete require.cache[entry]; return require(entry).loadedDeactivator; }
  finally { Module._load = original; }
}
const settle = () => new Promise(setImmediate);
const timeout = error => error.code === 'OFFICIAL_BACKEND_STOP_TIMEOUT';
function fixture(deactivate) {
  const file = '/synthetic-bounded-official/extension.js';
  const exports = { deactivate };
  return { file, exports, cache: { [file]: { loaded: true, exports } } };
}
test('a hung loaded hook reaches its deadline without retrying or allowing lifecycle resolution', { timeout: 500 }, async () => {
  const loaded = load(); let resolve, calls = 0; const events = [];
  const f = fixture(function () { assert.equal(this, f.exports); calls++; events.push('official-stop'); return new Promise(r => { resolve = r; }); });
  const stop = loaded(f.file, f.cache, { timeoutMs: 5 });
  const oldWrapper = loaded(f.file, f.cache, { timeoutMs: 5 });
  await assert.rejects(stop(), timeout);
  assert.equal(calls, 1); assert.throws(() => loaded(f.file, f.cache), timeout);
  await assert.rejects(oldWrapper(), timeout); assert.equal(calls, 1);
  // No synthetic reconnect, focus, install or background callback is attached.
  resolve(); await settle(); assert.deepEqual(events, ['official-stop']);
  assert.equal(typeof loaded(f.file, f.cache), 'function');
});
test('pending real function cannot be called twice even through a second cache path', { timeout: 500 }, async () => {
  const loaded = load(); let resolve, calls = 0;
  const deactivate = () => { calls++; return new Promise(r => { resolve = r; }); };
  const f = fixture(deactivate), alias = '/synthetic-other-official/extension.js';
  const stop = loaded(f.file, f.cache, { timeoutMs: 5 });
  await assert.rejects(stop(), timeout);
  assert.throws(() => loaded(alias, { [alias]: { loaded: true, exports: { deactivate } } }), timeout);
  assert.equal(calls, 1); resolve(); await settle();
});
test('replacing cached exports cannot bypass the old hook still pending for the same module path', { timeout: 500 }, async () => {
  const loaded = load(); let reject, calls = 0, replacementCalls = 0;
  const f = fixture(() => { calls++; return new Promise((_resolve, r) => { reject = r; }); });
  await assert.rejects(loaded(f.file, f.cache, { timeoutMs: 5 })(), timeout);
  const replacement = { [f.file]: { loaded: true, exports: { deactivate: () => { replacementCalls++; } } } };
  assert.throws(() => loaded(f.file, replacement), timeout);
  reject(Error('synthetic late rejection')); await settle();
  assert.equal(calls, 1); assert.equal(replacementCalls, 0);
  await loaded(f.file, replacement)(); assert.equal(replacementCalls, 1);
});
test('successful, rejected and synchronously throwing hooks settle normally and clear the guard', { timeout: 500 }, async () => {
  const loaded = load(); let calls = 0;
  const success = fixture(() => { calls++; });
  await loaded(success.file, success.cache, { timeoutMs: 5 })();
  await loaded(success.file, success.cache, { timeoutMs: 5 })(); assert.equal(calls, 2);
  for (const deactivate of [() => Promise.reject(Error('synthetic rejection')), () => { throw Error('synthetic throw'); }]) {
    const f = fixture(deactivate);
    await assert.rejects(loaded(f.file, f.cache, { timeoutMs: 5 })(), /synthetic/);
    assert.equal(typeof loaded(f.file, f.cache), 'function');
  }
});
test('concurrent invocation refuses a duplicate before the first deadline and has no queued retry', { timeout: 500 }, async () => {
  const loaded = load(); let resolve, calls = 0;
  const f = fixture(() => { calls++; return new Promise(r => { resolve = r; }); });
  const stop = loaded(f.file, f.cache, { timeoutMs: 100 }); const pending = stop();
  await assert.rejects(stop(), timeout); await settle(); assert.equal(calls, 1);
  resolve(); await pending; assert.equal(calls, 1);
});
