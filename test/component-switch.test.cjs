const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { LiveSwitchService, JOURNAL_KEY } = require('../out/live-switch');
const { ComponentCoordination } = require('../out/component-coordination');
const { ComponentSwitch } = require('../out/component-switch');
const token = name => JSON.stringify({ token: { access_token: `synthetic-${name}`, refresh_token: `synthetic-refresh-${name}`, token_type: 'Bearer' }, auth_method: 'oauth' });
const slotsFor = name => ({ file: token(name), keyring: null, keyringState: 'unobserved' });
async function fixture(options = {}) {
  const vault = new Map(); let current = slotsFor('b'), writes = 0, generation = 'initial', marker = null, driver;
  const hosts = [1, 2, 3].map(pid => ({ pid, startIdentity: `host-${pid}` }));
  const hubs = new Map(hosts.map(host => [host.pid, { pid: host.pid + 10, startIdentity: `initial-${host.pid}` }]));
  const events = [];
  const slots = { read: async scope => {
    if (driver) assert.equal(await driver.fileOnlyGuard(scope?.keyringState === 'unobserved'), true);
    return structuredClone(current);
  }, write: async (next, expected) => {
    assert.equal(hubs.size, 0); assert.deepEqual(current, expected);
    assert.equal(await driver.fileOnlyGuard(true), true); writes++; current = structuredClone(next); events.push('write');
  } };
  const service = new LiveSwitchService({ get: async key => vault.get(key), store: async (key, value) => { vault.set(key, value); }, delete: async key => { vault.delete(key); } }, slots);
  const account = await service.capture({ label: 'B', expectedEmail: 'b@example.test', identitySource: 'user' }); current = slotsFor('a');
  const group = new ComponentCoordination({ assertOperation: async () => {},
    census: async () => ({ complete: true, unknown: false, hosts, hubs: [...hubs.values()] }),
    participant: host => ({ host,
      prepare: async () => ({ host, hub: hubs.get(host.pid), contract: '1.8.0' }),
      stop: async () => { events.push(`stop:${host.pid}`); hubs.delete(host.pid); },
      resume: async () => {
        events.push(`resume:${host.pid}`); if (host.pid === 1) generation = `new-${events.length}`;
        hubs.set(host.pid, { pid: host.pid + events.length + 100, startIdentity: generation });
      }, release: async () => {},
    }),
  });
  await group.prepare();
  const finalizer = {
    prepare: async (id, binding) => { const owner = { schema: 3, id, completion: binding }; marker = JSON.stringify({ owner, raw: JSON.stringify(owner) }); return marker; },
    pending: async () => marker, identity: async () => marker, clear: async () => { marker = null; },
  };
  driver = new ComponentSwitch({ service, group, host: hosts[0],
    local: { get generation() { return generation; }, stop: async () => {}, reload: async () => {}, proof: async () => {
      if (!hubs.has(1) || options.rpcFailure) throw Error('synthetic fresh RPC failure');
      return { generation, email: `${current.file === token('a') ? 'a' : current.file === token('b') ? 'b' : 'external'}@example.test`, authValid: true, quotaSource: 'server', observedAt: new Date().toISOString(), buckets: [] };
    } },
    readFileRoute: async () => hubs.has(1), readCurrent: scope => slots.read(scope), assertOperation: async () => {},
    index: { read: () => [account], write: async () => {} }, finalizer,
  });
  return { service, driver, group, account, options, events, vault, hubs,
    writes: () => writes, current: () => current, set: value => { current = value; } };
}
test('automatic install stops all components, writes once, verifies before peer restoration', async () => {
  const f = await fixture(); const proof = await f.driver.install(f.account.id, randomUUID());
  assert.equal(proof.email, 'b@example.test'); assert.equal(f.writes(), 1); assert.equal(f.hubs.size, 1);
  assert.deepEqual(f.events.slice(0, 4), ['stop:1', 'stop:2', 'stop:3', 'write']);
  await f.group.close(); assert.equal(f.hubs.size, 3); assert.equal(await f.service.journal(), null);
});
test('failed fresh identity retains journal and never reports switch success', async () => {
  const f = await fixture(); const proof = f.driver.lifecycle.proof;
  f.driver.lifecycle.proof = async signal => { if (f.writes()) throw Error('synthetic post-start RPC failure'); return proof(signal); };
  await assert.rejects(f.driver.install(f.account.id, randomUUID()));
  assert.equal((await f.service.journal()).phase, 'installed'); assert.equal(f.hubs.size, 1);
  f.driver.lifecycle.proof = proof;
  const restored = await f.driver.restore((await f.service.journal()).id);
  assert.equal(restored.email, 'a@example.test'); await f.group.close(); assert.equal(f.writes(), 2);
});
test('unknown external login cannot be rolled back; explicit retain keeps encrypted original', async () => {
  const f = await fixture(), transaction = randomUUID();
  await f.service.install(f.account.id, f.driver.lifecycle, transaction);
  const original = f.vault.get(JOURNAL_KEY); f.set(slotsFor('external'));
  await assert.rejects(f.driver.restore(transaction), { code: 'EXTERNAL_CHANGE' });
  assert.equal(f.writes(), 1); assert.deepEqual(f.current(), slotsFor('external'));
  const proof = await f.driver.retainCurrent(transaction);
  assert.equal(proof.email, 'external@example.test'); assert.equal(f.writes(), 1);
  assert.equal(f.vault.get(`${JOURNAL_KEY}.retained.${transaction}`), original);
  await f.group.close(); assert.equal(await f.service.journal(), null);
});
