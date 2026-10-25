const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { ComponentMailbox } = require('../../out/component-mailbox');
const { ComponentCoordination, componentIdentityDigest } = require('../../out/component-coordination');
const { LiveLocks, probeProcessIdentity } = require('../../out/live-lock');
let child, mailbox, locks;
async function launch() {
  child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await once(child, 'spawn');
}
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exit = once(child, 'exit'); child.kill('SIGTERM'); await exit;
}
process.on('message', async message => {
  try {
    if (message.action === 'init') {
      await launch();
      const identity = await probeProcessIdentity(process.pid), host = { pid: process.pid, startIdentity: identity.startIdentity };
      locks = new LiveLocks(message.root, message.owner);
      mailbox = new ComponentMailbox(message.directory, host, locks, async assertOwner => {
        let receipt;
        return {
        prepare: async () => {
          await assertOwner(); const hub = await probeProcessIdentity(child.pid);
          receipt = { host, hub: { pid: child.pid, startIdentity: hub.startIdentity }, contract: '1.8.0', verification: 'identity-v1' };
          return receipt;
        },
        verify: async challenge => { await assertOwner(); const current = await probeProcessIdentity(child.pid); if(current.state !== 'alive')throw Error('child missing'); return {host,hub:{pid:child.pid,startIdentity:current.startIdentity},digest:componentIdentityDigest('synthetic@example.test',challenge)}; },
        stop: async () => { await assertOwner(); await stop(); },
        resume: async () => { await assertOwner(); if (child.exitCode !== null || child.signalCode !== null) await launch(); },
        describe: async () => {
          await assertOwner(); const current = await probeProcessIdentity(child.pid);
          return current.state === 'alive' ? { host, hub: { pid: child.pid, startIdentity: current.startIdentity }, contract: '1.8.0' } : { ...receipt, stopped: true };
        },
      }; });
      await mailbox.start(); process.send({ id: message.id, host });
    } else if (message.action === 'coordinate-stop') {
      await locks.withOperation(async () => {
        await locks.beginRecovery(message.recovery);
        const operation = await locks.inspectOperation();
        const group = new ComponentCoordination({ assertOperation: () => locks.assertOperationHeld(),
          participant: host => mailbox.participant(host, operation, message.recovery, 10000),
          census: async () => ({ complete: true, unknown: false, hosts: message.hosts,
            hubs: (await Promise.all(message.hubs.map(async hub => {
              const status = await probeProcessIdentity(hub.pid);
              return status.state === 'alive' && status.startIdentity === hub.startIdentity ? hub : null;
            }))).filter(Boolean) }),
        });
        await group.prepare(); await group.stop(); await group.assertStopped();
        process.send({ id: message.id });
        // Parent kills this isolated synthetic coordinator after receiving ACK.
        await new Promise(() => {});
      });
    } else if (message.action === 'status') {
      const identity = child ? await probeProcessIdentity(child.pid) : { state: 'dead' };
      process.send({ id: message.id, hub: identity.state === 'alive' ? { pid: child.pid, startIdentity: identity.startIdentity } : null });
    } else if (message.action === 'quit') {
      mailbox?.dispose(); await stop(); process.send({ id: message.id }); process.disconnect();
    }
  } catch { process.send({ id: message.id, error: 'SYNTHETIC_WORKER_FAILED' }); }
});
process.on('disconnect', () => { mailbox?.dispose(); void stop().finally(() => process.exit()); });
