const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ComponentCoordination } = require('../out/component-coordination');

function fixture(options = {}) {
  const hosts = [1, 2, 3].map(pid => ({ pid, startIdentity: `host-${pid}` }));
  const hubs = new Map(hosts.map(host => [host.pid, { pid: host.pid + 10, startIdentity: `hub-${host.pid}` }]));
  const events = [];
  const runtime = {
    assertOperation: async () => { if (options.lostLock) throw Error('lost lock'); },
    census: async () => ({ complete: !options.incomplete, unknown: false, hosts: [...hosts], hubs: [...hubs.values()] }),
    participant: host => ({ host,
      prepare: async () => {
        events.push(`prepare:${host.pid}`);
        if (options.unsupported === host.pid) throw Error('unsupported');
        return { host, hub: hubs.get(host.pid), contract: '1.8.0' };
      },
      stop: async () => {
        events.push(`stop:${host.pid}`);
        if (options.earlyAck !== host.pid) hubs.delete(host.pid);
        if (options.stopFailure === host.pid) throw Error('stop failed after exit');
      },
      resume: async () => {
        events.push(`resume:${host.pid}`);
        if (options.restoreFailure === host.pid) throw Error('restore failed');
        hubs.set(host.pid, { pid: host.pid + 20, startIdentity: `new-${host.pid}` });
      },
      release: async () => { events.push(`release:${host.pid}`); },
    }),
  };
  return { group: new ComponentCoordination(runtime), hosts, hubs, events, options };
}
test('all hosts stop before storage admission; restore verifier then peers', async () => {
  const f = fixture(); await f.group.prepare(); await f.group.stop(); await f.group.assertStopped();
  assert.equal(f.hubs.size, 0);
  await f.group.resume(f.hosts[0]);
  await assert.rejects(f.group.assertStopped(), { code: 'COMPONENTS_NOT_STOPPED' });
  await f.group.close(); assert.equal(f.hubs.size, 3);
  assert.equal(f.events.filter(v => v === 'resume:1').length, 1);
});
test('unsupported participant releases preparation without stopping anyone', async () => {
  const f = fixture({ unsupported: 2 }); await assert.rejects(f.group.prepare());
  assert.equal(f.hubs.size, 3); assert.deepEqual(f.events, ['prepare:1', 'prepare:2', 'release:1', 'release:2']);
});
test('partial stop failure restores earlier and ambiguous failing participant', async () => {
  const f = fixture({ stopFailure: 2 }); await f.group.prepare(); await assert.rejects(f.group.stop());
  await assert.rejects(f.group.assertStopped()); await f.group.close();
  assert.equal(f.hubs.size, 3); assert.ok(f.events.includes('resume:2')); assert.ok(!f.events.includes('stop:3'));
});
test('early stop acknowledgement cannot authorize credential write', async () => {
  const f = fixture({ earlyAck: 2 }); await f.group.prepare();
  await assert.rejects(f.group.stop(), { code: 'COMPONENT_RESTART_DURING_WRITE' }); await f.group.close();
});
test('hubless new host and new Hub both invalidate stopped admission', async () => {
  const f = fixture(); await f.group.prepare(); await f.group.stop();
  f.hosts.push({ pid: 4, startIdentity: 'new-host' });
  await assert.rejects(f.group.assertStopped(), { code: 'COMPONENT_PARTICIPANTS_CHANGED' });
  f.hosts.pop(); f.hubs.set(4, { pid: 44, startIdentity: 'new-hub' });
  await assert.rejects(f.group.assertStopped(), { code: 'COMPONENT_RESTART_DURING_WRITE' }); await f.group.close();
});
test('restore failure is reported while still attempting every other participant', async () => {
  const f = fixture({ restoreFailure: 1 }); await f.group.prepare(); await f.group.stop();
  await assert.rejects(f.group.close(), { code: 'COMPONENT_RESTORE_FAILED' });
  assert.ok(f.events.includes('resume:3')); assert.equal(f.hubs.size, 2);
  f.options.restoreFailure = undefined; await f.group.close();
  assert.equal(f.hubs.size, 3); // failed close retains a recovery path
});
test('close cannot race an actual pending stop', async () => {
  const f = fixture(); await f.group.prepare();
  const stopping = f.group.stop();
  await assert.rejects(f.group.close(), { code: 'COMPONENT_ACTION_PENDING' });
  await stopping; await f.group.close(); assert.equal(f.hubs.size, 3);
});
test('cancel after preparation releases participants without interruption', async () => {
  const f = fixture(); await f.group.prepare(); await f.group.close();
  assert.equal(f.hubs.size, 3); assert.ok(!f.events.some(v => v.startsWith('stop:')));
});
test('concurrent or repeated stop cannot enter a second transaction', async () => {
  const f = fixture(); await f.group.prepare(); await f.group.stop();
  await assert.rejects(f.group.stop(), { code: 'COMPONENT_TRANSACTION_STATE' }); await f.group.close();
});
test('rollback can stop the restored verifier while peers remain stopped', async () => {
  const f = fixture(); await f.group.prepare(); await f.group.stop(); await f.group.resume(f.hosts[0]);
  await f.group.stop(); await f.group.assertStopped(); await f.group.close();
  assert.equal(f.events.filter(v => v === 'stop:1').length, 2);
  assert.equal(f.events.filter(v => v === 'stop:2').length, 1);
});
test('failed resume revokes stopped admission even when census is temporarily empty', async () => {
  const f = fixture({ restoreFailure: 1 }); await f.group.prepare(); await f.group.stop();
  await assert.rejects(f.group.resume(f.hosts[0]), { code: 'COMPONENT_RESTORE_FAILED' });
  assert.equal(f.hubs.size, 0);
  await assert.rejects(f.group.stop());
  await assert.rejects(f.group.assertStopped(), { code: 'COMPONENTS_NOT_STOPPED' });
  f.options.restoreFailure = undefined;
  await f.group.resume(f.hosts[0]); await f.group.stop(); await f.group.assertStopped(); await f.group.close();
});
