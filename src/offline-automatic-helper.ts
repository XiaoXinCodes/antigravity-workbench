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
  const checkCancel = async (): Promise<void> => { const state = await control.read(); if (state.attempt !== attempt) throw new LiveError('OFFLINE_ATTEMPT_CHANGED'); if (state.cancelled) { abort.abort(); throw new LiveError('CANCELLED'); } };
  try {
    await checkCancel();
    const result = await runOfflineFileSession({ record, password: key, knownHosts: record.execution.knownHosts, fileRoute: { hostId: host, backup: record.backup } }, {
      home, hostId: host, owner: record.execution.owner, prepared: true, restore: action === 'restore', deadlineMs: 300_000, now: Date.now,
      ready: async () => { await control.status('WAITING_FOR_CLOSE', attempt); process.stdout.end('READY\n'); },
      wait: async () => { await new Promise(resolve => setTimeout(resolve, 250)); await checkCancel(); },
      census: async knownHosts => { await checkCancel(); return inspectOfflineLinuxProcesses({ uid: process.getuid!(), home, knownHosts, scope: 'file-only' }); },
    }, abort.signal);
    await control.status(result === 'restored-awaiting-verification' ? 'RESTORED' : 'INSTALLED', attempt);
  } catch (error) {
    const code = error instanceof LiveError ? error.code : 'OFFLINE_OPERATION_FAILED';
    await control.status(code, attempt).catch(() => undefined);
    throw error;
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
