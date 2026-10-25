const { test } = require('node:test');
const assert = require('node:assert/strict');
const { OwnComponentLifecycle } = require('../out/component-own-lifecycle');
function fixture() {
  let hub = { pid: 2, startIdentity: 'birth-2' }, gen = 'initial', running = true;
  const runtime = {
    host: { pid: 1, startIdentity: 'birth-1' },
    contract: async () => '1.8.0', assertOwner: async () => {},
    ready: async () => { if (!running) throw Error('not ready'); return { hub, generation: gen }; },
    proof: async () => ({ email: 'synthetic@example.test', generation: gen, authValid: true, quotaSource: 'server', observedAt: new Date().toISOString(), buckets: [] }),
    stop: async () => { running = false; }, stopped: async () => !running,
    restart: async () => { hub = { pid: 3, startIdentity: 'birth-3' }; gen = 'next'; running = true; },
  };
  return { actor: new OwnComponentLifecycle(runtime), runtime };
}
test('ready receipt, stop, fresh restore and verification', async () => {
  const f = fixture(); const receipt = await f.actor.prepare(); assert.equal(receipt.hub.pid, 2);
  await f.actor.stop(); await assert.rejects(f.actor.proof()); await f.actor.reload();
  assert.equal((await f.actor.proof()).generation, 'next');
});
test('unsupported exact contract fails before stop', async () => {
  const f = fixture(); f.runtime.contract = async () => '1.9.0';
  await assert.rejects(f.actor.prepare(), { code: 'COMPONENT_CONTRACT_UNSUPPORTED' });
});
test('cached or invalid identity never prepares', async () => {
  const f = fixture(); f.runtime.proof = async () => ({ generation: 'initial', authValid: true, quotaSource: 'cache' });
  await assert.rejects(f.actor.prepare(), { code: 'HUB_CHANGED_DURING_OPERATION' });
});
test('pending actual stop rejects reconnect and double click until settlement', async () => {
  const f = fixture(); await f.actor.prepare();
  let release; const original = f.runtime.stop;
  f.runtime.stop = () => new Promise(resolve => { release = async () => { await original(); resolve(); }; });
  const stop = f.actor.stop(); while (!release) await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(f.actor.stop(), { code: 'COMPONENT_ACTION_PENDING' });
  await assert.rejects(f.actor.reload(), { code: 'COMPONENT_ACTION_PENDING' });
  await release(); await stop; await f.actor.reload();
});
test('stop returning before process exit cannot acknowledge stopped', async () => {
  const f = fixture(); await f.actor.prepare(); f.runtime.stop = async () => {};
  await assert.rejects(f.actor.stop(), { code: 'OFFICIAL_BACKEND_NOT_STOPPED' });
  let restarted = false; f.runtime.restart = async () => { restarted = true; };
  await f.actor.reload(); assert.equal(restarted, false); // original ready instance survived
});
test('changed birth before stop never invokes hook', async () => {
  const f = fixture(); await f.actor.prepare(); let stopped = false;
  f.runtime.stop = async () => { stopped = true; };
  f.runtime.ready = async () => ({ hub: { pid: 2, startIdentity: 'reused' }, generation: 'initial' });
  await assert.rejects(f.actor.stop(), { code: 'HUB_CHANGED_DURING_OPERATION' }); assert.equal(stopped, false);
});
test('fresh identity failure after restore remains a failure', async () => {
  const f = fixture(); await f.actor.prepare(); await f.actor.stop(); await f.actor.reload();
  f.runtime.proof = async () => { throw Error('RPC failed'); };
  await assert.rejects(f.actor.proof(), /RPC failed/);
});
test('concurrent prepare is rejected before any awaited proof completes', async () => {
  const f = fixture(); const first = f.actor.prepare();
  await assert.rejects(f.actor.prepare(), { code: 'COMPONENT_TRANSACTION_STATE' }); await first;
});
test('late completion of our start is joined without a second reconnect', async () => {
  const f = fixture(); await f.actor.prepare(); await f.actor.stop();
  const start = f.runtime.restart; let calls = 0;
  f.runtime.restart = async () => { calls++; throw Error('observation timeout'); };
  await assert.rejects(f.actor.reload(), /observation timeout/);
  await start(); await f.actor.reload();
  assert.equal(calls, 1); assert.equal((await f.actor.proof()).generation, 'next');
});
test('recovery can prove route and stop an unauthenticated component but cannot claim fresh identity', async () => {
  const f = fixture(); f.runtime.proof = async () => { throw Error('invalid target login'); };
  const receipt = await f.actor.prepare(false); assert.equal(receipt.hub.pid, 2);
  await f.actor.describe(); await f.actor.stop(); await f.actor.reload();
  await assert.rejects(f.actor.proof(), /invalid target login/);
});
test('replacement coordinator describes a late start without dispatching it twice', async () => {
  const f = fixture(); await f.actor.prepare(); await f.actor.stop();
  const start = f.runtime.restart; let calls = 0;
  f.runtime.restart = async () => { calls++; throw Error('observation timeout'); };
  await assert.rejects(f.actor.reload()); await start();
  assert.equal((await f.actor.describe()).hub.pid, 3); assert.equal(calls, 1);
});
test('fresh identity receipt carries only nonce-bound digest and process births', async () => {
  const { componentIdentityDigest } = require('../out/component-coordination');
  const f = fixture(), challenge = require('node:crypto').randomUUID();
  assert.equal((await f.actor.prepare()).verification, 'identity-v1');
  await f.actor.stop(); await f.actor.reload();
  const receipt = await f.actor.verify(challenge);
  assert.deepEqual(Object.keys(receipt).sort(), ['digest', 'host', 'hub']);
  assert.equal(receipt.hub.pid, 3);
  assert.equal(receipt.digest, componentIdentityDigest('SYNTHETIC@example.test', challenge));
  assert.notEqual(receipt.digest, componentIdentityDigest('synthetic@example.test', require('node:crypto').randomUUID()));
  const proof = f.runtime.proof;
  f.runtime.proof = async () => ({ ...await proof(), generation: 'stale' });
  await assert.rejects(f.actor.verify(challenge), { code: 'HUB_CHANGED_DURING_QUERY' });
});
test('failed observation rejoins original attempt and fresh-verifies a late ready result', async () => {
  const { LiveError } = require('../out/live-storage');
  const f = fixture(); await f.actor.prepare(); await f.actor.stop();
  const start = f.runtime.restart, ready = f.runtime.ready;
  f.runtime.ready = async () => { try { return await ready(); } catch { throw new LiveError('OFFICIAL_HUB_NOT_READY'); } };
  f.runtime.restart = async () => { throw new LiveError('OFFICIAL_COMPONENT_RESTART_TIMEOUT'); };
  let retries = 0; f.runtime.awaitRestart = async () => { retries++; await start(); };
  await assert.rejects(f.actor.reload(), { code: 'OFFICIAL_COMPONENT_RESTART_TIMEOUT' });
  await f.actor.reload(); assert.equal(retries, 1); assert.equal((await f.actor.proof()).generation, 'next');
});
test('observation retry joins startup but cannot bypass command or route failure', async () => {
  const { LiveError } = require('../out/live-storage');
  for (const reason of ['pending', 'alive', 'route']) {
    const f = fixture(); await f.actor.prepare(); await f.actor.stop();
    f.runtime.restart = async () => { throw new LiveError('OFFICIAL_COMPONENT_RESTART_TIMEOUT'); };
    await assert.rejects(f.actor.reload());
    let calls = 0;
    f.runtime.ready = async () => { throw new LiveError(reason === 'route' ? 'WSL_FILE_ROUTE_UNVERIFIED' : 'OFFICIAL_HUB_NOT_READY'); };
    f.runtime.stopped = async () => reason !== 'alive';
    f.runtime.awaitRestart = async () => { calls++; throw new LiveError('COMPONENT_ACTION_PENDING'); };
    await assert.rejects(f.actor.reload()); assert.equal(calls, reason === 'route' ? 0 : 1);
  }
});
