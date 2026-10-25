import { debugErrorCode } from './debug-events';
import * as os from 'node:os';
import * as path from 'node:path';
import { LiveError } from './live-storage';
import { resolveCredentialHostId } from './native-host';
import { resolveOfficialStorageMode } from './live-environment';
import { AutomaticOfflineControl, AutomaticOfflineKey } from './offline-automatic';
import { OfflineRecoveryStore } from './offline-recovery-store';
import { inspectOfflineLinuxProcesses } from './offline-process-census';
import { runOfflineFileSession } from './offline-session';
import { WindowReopen } from './window-reopen';
import { WslWindowLauncher } from './wsl-window-launcher';
import { WindowRuntimeChannel } from './window-runtime-channel';
import { WindowRuntimeDriver } from './window-runtime-driver';
import { WindowGroupReopen } from './window-group-reopen';
import { probeProcessIdentity } from './live-lock';
import { LiveLocks } from './live-lock';

export async function automaticOfflineHelper(args: string[]): Promise<void> {
  const [id, host, kind, remote, action, attempt] = args;
  if (args.length !== 6 || !id || !host || !attempt || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(attempt) || !['1', '2'].includes(kind ?? '') || !['local', 'wsl'].includes(remote ?? '') || !['install', 'restore'].includes(action ?? '')) throw new LiveError('OFFLINE_ARGUMENT_INVALID');
  if (process.platform !== 'linux' || !process.getuid || await resolveOfficialStorageMode() !== 'wsl-file') throw new LiveError('OFFLINE_PLATFORM_UNSUPPORTED');
  if (host !== await resolveCredentialHostId({ extension: { extensionKind: Number(kind) } }, remote === 'local' ? undefined : remote, 'wsl-file')) throw new LiveError('OFFLINE_SCOPE_UNVERIFIED');
  const home = os.homedir(), key = await new AutomaticOfflineKey(home, host, id).read();
  if (!key) throw new LiveError('OFFLINE_AUTOMATIC_KEY_MISSING');
  const record = await new OfflineRecoveryStore(path.join(home, '.gemini', 'antigravity-workbench-offline', id), key, host, id).read();
  if (!record?.execution || record.execution.extensionKind !== Number(kind) || (record.execution.remoteName ?? 'local') !== remote) throw new LiveError('OFFLINE_RECOVERY_INVALID');
  const control = new AutomaticOfflineControl(home, id), abort = new AbortController();
  const channel = new WindowRuntimeChannel(home), group = await channel.readGroup(attempt), driver = new WindowRuntimeDriver(channel);
  const checkCancel = async (): Promise<void> => {
    const state = await control.read();
    if (state.attempt !== attempt) throw new LiveError('OFFLINE_ATTEMPT_CHANGED');
    if (state.cancelled) { abort.abort(); throw new LiveError('CANCELLED'); }
    if (group) {
      const active = await channel.readGroup(attempt);
      if (!active || active.transactionId !== id || active.scope !== host) throw new LiveError('OFFLINE_ATTEMPT_CHANGED');
      if (active.cancelled || active.requests.some(r => r.result === 'cancelled' || r.result === 'failed')) { abort.abort(); throw new LiveError('CANCELLED'); }
      if (Date.now() >= active.deadline) throw new LiveError('OFFLINE_CLOSE_TIMEOUT');
    }
  };
  try {
    if (record.execution.windowAutomation === 'group-window-v1' && !group) throw new LiveError('OFFLINE_ATTEMPT_CHANGED');
    await checkCancel();
    const result = await runOfflineFileSession({ record, password: key, knownHosts: record.execution.knownHosts, fileRoute: { hostId: host, backup: record.backup } }, {
      home, hostId: host, owner: record.execution.owner, prepared: true, restore: action === 'restore', deadlineMs: 300_000, now: Date.now,
      ready: async () => {
        await control.status('WAITING_FOR_CLOSE', attempt);
        if (group) {
          const self = await probeProcessIdentity(process.pid);
          if (self.state !== 'alive') throw new LiveError('OFFLINE_CENSUS_UNVERIFIED');
          await driver.start(attempt, { pid: process.pid, startIdentity: self.startIdentity });
        }
        process.stdout.end('READY\n');
      },
      wait: async () => { await new Promise(resolve => setTimeout(resolve, 250)); await checkCancel(); if (group) await driver.advance(attempt); },
      census: async knownHosts => { await checkCancel(); return inspectOfflineLinuxProcesses({ uid: process.getuid!(), home, knownHosts, scope: 'file-only' }); },
    }, abort.signal);
    await control.status(result === 'restored-awaiting-verification' ? 'RESTORED' : 'INSTALLED', attempt);
  } catch (error) {
    const code = error instanceof LiveError ? error.code : 'OFFLINE_OPERATION_FAILED';
    await control.status(code, attempt).catch(() => undefined);
    throw error;
  } finally {
    // The reopen path is opt-in by a durable, attempt-bound window request.
    // It never treats CLI success as account verification. Legacy attempts
    // have no request and retain their existing behavior.
    if (group) {
      await channel.cancel(attempt);
      const reopenLocks = new LiveLocks(path.join(home, '.gemini'), record.execution.owner);
      await reopenLocks.withOperation(async () => {
        if ((await control.read()).attempt !== attempt) throw new LiveError('OFFLINE_ATTEMPT_CHANGED');
        await reopenLocks.assertOfflineRecovery(id);
        const result = await new WindowGroupReopen(home).recover(attempt, new WslWindowLauncher());
        if (result.pending.length || result.failed.length) await control.status('OFFLINE_REOPEN_REQUIRED', attempt);
      });
    }
    const reopen = new WindowReopen(home);
    if (await reopen.hasAttempt(attempt)) {
      // Join the real credential lock after BOTH successful and failed sessions.
      // Another live writer, stale attempt or missing marker prevents reopening.
      const reopenLocks = new LiveLocks(path.join(home, '.gemini'), record.execution.owner);
      await reopenLocks.withOperation(async () => {
        if ((await control.read()).attempt !== attempt) throw new LiveError('OFFLINE_ATTEMPT_CHANGED');
        await reopenLocks.assertOfflineRecovery(id);
        await reopen.reopen(attempt, new WslWindowLauncher());
      }).catch(async error => { await control.status('OFFLINE_REOPEN_REQUIRED', attempt).catch(() => undefined); throw error; });
    }
  }
}
if (require.main === module) {
  // An initiating host may disappear before ACK. Broken stdout is never an
  // excuse to clear the durable transaction or terminate an in-flight write.
  process.stdout.on('error', () => undefined);
  void automaticOfflineHelper(process.argv.slice(2)).catch(error => {
    // Fixed-code protocol only: never send stderr, paths or credential values.
    if (!process.stdout.writableEnded) process.stdout.end(`ERROR ${debugErrorCode(error)}\n`);
    process.exitCode = 1;
  });
}
