const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const source = require('./fixtures/official-provider-renderer-1.9.cjs');
const desktop = require('./fixtures/official-desktop-setup-1.9.cjs');
const { restartOfficialComponent, OFFICIAL_RECONNECT, OFFICIAL_FOCUS } = require('../out/official-restart');

// Execute only the two unmodified class expressions against synthetic delegates.
// No official activation, binary, network, account, file store or VS Code window.
function fixture({ resolved = true, focusResolves = true, setupFails = false, startupDeferred = false } = {}) {
  let api, processCount = 0, starts = 0, ticks = 0, releaseStart;
  const events = [], tasks = [], retryListeners = new Set();
  let failing = setupFails;
  const start = async () => {
    events.push('desktop-setup'); starts++;
    if (failing) { events.push('setup-waits-for-user-retry'); throw Error('synthetic-start-failure'); }
    if (startupDeferred) await new Promise(resolve => { releaseStart = resolve; });
    api = { port: 30001, csrfToken: 'synthetic-capability-never-real' }; processCount = 1;
    return 'http://synthetic.invalid';
  };
  const sandbox = {
    f: { asyncContextStart: () => () => value => value },
    n: { commands: { executeCommand: () => {} } },
    Fn: () => 'fixed error',
    pc: { AntigravityServerManager: { getInstance: () => ({ start, setLastStartupError: () => {} }) } },
    XP: () => undefined, ZP: effectiveUrl => ({ effectiveUrl }),
    aO: { MessageNotifierImpl: class {
      onRetry(callback) { retryListeners.add(callback); return { dispose: () => retryListeners.delete(callback) }; }
      notifyMessage() {} resolveWebviewView() {} dispose() {} notifyError() { events.push('view-error'); }
    } },
  };
  const setup = vm.runInNewContext('(function(){' + desktop.retry + desktop.helper + '; return aQ;})()', sandbox);
  const Provider = vm.runInNewContext('(' + source.provider + ')', sandbox);
  const Renderer = vm.runInNewContext('(' + source.renderer + ')', sandbox);
  const context = { subscriptions: [], extensionUri: {}, workspaceState: { get: () => undefined, update: () => {} } };
  const renderer = new Renderer({ context, setupFn: setup, apiImpl: { registerWebview: async () => {} }, delegate: {
    renderLoading: () => {}, validateServerUrl: value => value, renderIframe: async () => {},
    updateTitle: async (_view, info) => { await info; },
  } });
  const provider = new Provider(context, renderer, 'antigravity.panel', {});
  const view = { webview: {} };
  if (resolved) provider.view = view;
  // Observe otherwise unawaited provider tasks without changing their behavior.
  const render = provider.renderWebview.bind(provider), title = renderer.updateTitle.bind(renderer);
  provider.renderWebview = (...args) => { const p = render(...args); tasks.push(p); return p; };
  renderer.updateTitle = (...args) => { const p = title(...args); tasks.push(p); return p; };
  const runtime = {
    api: () => api, processCount: async () => processCount, assertCurrent: () => {},
    now: () => ticks, timeoutMs: 5,
    wait: async ms => { ticks += ms; await Promise.resolve(); },
    execute: async command => {
      events.push(command);
      if (command === OFFICIAL_RECONNECT) provider.refresh(); // actual callback is () => m.refresh()
      if (command === OFFICIAL_FOCUS && !provider.view && focusResolves) await provider.resolveWebviewView(view);
    },
  };
  return { retryListeners, provider, setFailing: value => { failing = value; }, fireRetry: () => { for (const fn of [...retryListeners]) fn(); }, runtime, events, starts: () => starts, release: () => releaseStart?.(), tasks };
}

test('resolved official provider refresh actually invokes desktop setup, without a direct start command', async () => {
  const f = fixture(); await restartOfficialComponent('stopped', f.runtime);
  await Promise.all(f.tasks); assert.equal(f.starts(), 1);
  assert.ok(f.events.includes('desktop-setup')); assert.deepEqual(f.events.filter(v => v.startsWith('antigravity.')), [OFFICIAL_RECONNECT, OFFICIAL_FOCUS]);
});
test('unresolved view starts only when focus resolves provider', async () => {
  const f = fixture({ resolved: false }); await restartOfficialComponent('stopped', f.runtime);
  assert.equal(f.starts(), 1);
  const absent = fixture({ resolved: false, focusResolves: false });
  await assert.rejects(restartOfficialComponent('stopped', absent.runtime), { code: 'OFFICIAL_COMPONENT_RESTART_TIMEOUT' });
  assert.equal(absent.starts(), 0); // repeated command presence cannot create a missing view
});
test('reconnect callback returns before the real asynchronous setup completes', async () => {
  const f = fixture({ startupDeferred: true });
  await f.runtime.execute(OFFICIAL_RECONNECT);
  assert.equal(f.starts(), 1); assert.equal(f.runtime.api(), undefined);
  f.release(); await Promise.all(f.tasks); assert.ok(f.runtime.api());
});
test('desktop setup may wait for official retry UI although reconnect and focus returned', async () => {
  const f = fixture({ setupFails: true });
  await assert.rejects(restartOfficialComponent('stopped', f.runtime), { code: 'OFFICIAL_COMPONENT_RESTART_TIMEOUT' });
  assert.equal(f.starts(), 1); assert.ok(f.events.includes('setup-waits-for-user-retry'));
  assert.equal(f.runtime.api(), undefined);
});

test('actual YP keeps failed setup pending; repeated refresh retains earlier retry subscriptions',async()=>{
 const f=fixture({setupFails:true});
 await f.runtime.execute(OFFICIAL_RECONNECT);await new Promise(setImmediate);
 assert.equal(f.starts(),1);assert.equal(f.retryListeners.size,1);
 await f.runtime.execute(OFFICIAL_RECONNECT);await new Promise(setImmediate);
 assert.equal(f.starts(),2);assert.equal(f.retryListeners.size,2);
 f.setFailing(false);f.fireRetry();await Promise.all(f.tasks);
 assert.equal(f.starts(),4);assert.equal(f.retryListeners.size,0);
 // Four calls are not a claim of four processes: actual manager.start coalesces
 // its in-flight promise. This test proves retained setup/retry continuations.
});
