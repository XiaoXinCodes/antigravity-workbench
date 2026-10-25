import * as path from 'node:path';
import { LiveLocks, probeProcessIdentity } from './live-lock';
import { AutomaticOfflineControl } from './offline-automatic';
import { WindowRuntimeChannel } from './window-runtime-channel';
import { WindowGroupReopen } from './window-group-reopen';
import { WslWindowLauncher } from './wsl-window-launcher';

/** Recovery of editor lifecycle only. Never reads or writes token slots. A
 * surviving/reopened participant can resume after helper death or late close. */
export async function recoverWindowRuntime(home: string, scope: string, workspaceUri: string): Promise<void> {
  const channel = new WindowRuntimeChannel(home), group = await channel.readGroup();
  if (!group || group.scope !== scope || !group.members.some(m => m.plan.workspace.uri === workspaceUri)) return;
  if (group.executor) {
    const p = await probeProcessIdentity(group.executor.pid);
    if (p.state === 'unknown' || p.state === 'alive' && p.startIdentity === group.executor.startIdentity) return;
  } else if (!group.cancelled) {
    const initiator = await probeProcessIdentity(group.initiator.pid);
    if (initiator.state === 'unknown' || initiator.state === 'alive' && initiator.startIdentity === group.initiator.startIdentity) return;
  }
  const directory = path.join(home, '.gemini'), marker = await new LiveLocks(directory, scope).inspectRecovery();
  if (marker.owner?.schema !== 4 || marker.owner.id !== group.transactionId) return;
  const locks = new LiveLocks(directory, marker.owner.owner);
  await locks.withOperation(async () => {
    await locks.assertOfflineRecovery(group.transactionId);
    const control = new AutomaticOfflineControl(home, group.transactionId), state = await control.read();
    if (state.attempt !== group.attempt) return;
    const live = await channel.readGroup(group.attempt);
    if (!live) return;
    const owner = live.executor ?? live.initiator, p = await probeProcessIdentity(owner.pid);
    if (p.state === 'unknown' || p.state === 'alive' && p.startIdentity === owner.startIdentity) return;
    await channel.cancel(group.attempt); // Lock held, no live writer/handoff can race cancellation.
    {
      await new WindowGroupReopen(home).prepare(group.attempt, live.members);
      const result = await new WindowGroupReopen(home).recover(group.attempt, new WslWindowLauncher());
      if (result.failed.length || result.pending.length) await control.status('OFFLINE_REOPEN_REQUIRED', group.attempt);
    }
  });
}
