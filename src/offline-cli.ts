import { t as tr } from './i18n';
import * as os from 'node:os';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { LiveError } from './live-storage';
import { resolveCredentialHostId } from './native-host';
import { resolveOfficialStorageMode } from './live-environment';
import { OfflineRecoveryStore } from './offline-recovery-store';
import { inspectOfflineLinuxProcesses } from './offline-process-census';
import { runOfflineFileSession } from './offline-session';

/** Interactive external terminal only: passwords are never accepted through
 * arguments, environment or redirected files. No official extension is loaded. */
export async function readOfflinePassword(input = process.stdin, output = process.stdout): Promise<string> {
  if (!input.isTTY || !output.isTTY) throw new LiveError('OFFLINE_EXTERNAL_TERMINAL_REQUIRED');
  output.write(tr('offline.cliPassword'));
  readline.emitKeypressEvents(input); input.setRawMode(true); input.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const cleanup = (): void => { input.removeListener('keypress', key); input.setRawMode(false); input.pause(); output.write('\n'); };
    const key = (text: string | undefined, info: { name?: string; ctrl?: boolean }): void => {
      if (info.ctrl && ['c', 'd'].includes(info.name ?? '')) { cleanup(); value = ''; reject(new LiveError('CANCELLED')); }
      else if (info.name === 'return') { cleanup(); resolve(value); value = ''; }
      else if (info.name === 'backspace') value = value.slice(0, -1);
      else if (text && [...text].every(c => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127) && Buffer.byteLength(value + text) <= 1024) value += text;
    };
    input.on('keypress', key);
  });
}
export async function offlineCli(args: string[]): Promise<void> {
  const [transactionId, hostId, kind, remote, action] = args;
  if (args.length !== 5 || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(transactionId ?? '') ||
      !/^[a-f0-9]{64}$/.test(hostId ?? '') || !['1', '2'].includes(kind ?? '') || !['local', 'wsl'].includes(remote ?? '') || !['install', 'restore'].includes(action ?? ''))
    throw new LiveError('OFFLINE_ARGUMENT_INVALID');
  if (process.platform !== 'linux' || !process.getuid || await resolveOfficialStorageMode() !== 'wsl-file') throw new LiveError('OFFLINE_PLATFORM_UNSUPPORTED');
  const actualHost = await resolveCredentialHostId({ extension: { extensionKind: Number(kind) } }, remote === 'local' ? undefined : remote, 'wsl-file');
  if (actualHost !== hostId) throw new LiveError('OFFLINE_SCOPE_UNVERIFIED');
  const secret = await readOfflinePassword();
  const store = new OfflineRecoveryStore(path.join(os.homedir(), '.gemini', 'antigravity-workbench-offline', transactionId!), secret, actualHost, transactionId!);
  const record = await store.read();
  if (!record?.execution || record.execution.extensionKind !== Number(kind) || (record.execution.remoteName ?? 'local') !== remote) throw new LiveError('OFFLINE_RECOVERY_INVALID');
  process.stdout.write(tr('offline.cliWait'));
  const controller = new AbortController(), cancel = (): void => controller.abort();
  process.on('SIGINT', cancel);
  try {
    const result = await runOfflineFileSession({ record, password: secret, knownHosts: record.execution.knownHosts, fileRoute: { hostId: actualHost, backup: record.backup } }, {
      home: os.homedir(), hostId: actualHost, owner: record.execution.owner, prepared: true, restore: action === 'restore', deadlineMs: 300_000,
      now: Date.now, wait: () => new Promise(resolve => setTimeout(resolve, 250)), ready: async () => undefined,
      census: knownHosts => inspectOfflineLinuxProcesses({ uid: process.getuid!(), home: os.homedir(), knownHosts, scope: 'file-only' }),
    }, controller.signal);
    process.stdout.write(result === 'restored-awaiting-verification' ? tr('offline.cliRestored') : tr('offline.cliInstalled'));
  } finally { process.removeListener('SIGINT', cancel); }
}
if (require.main === module) void offlineCli(process.argv.slice(2)).catch(error => {
  // No arbitrary error text: errors may originate in credential/native I/O.
  const code = error instanceof LiveError ? error.code : 'OFFLINE_OPERATION_FAILED';
  process.stderr.write(`${code}\n${tr('offline.restoreInstructions')}\n`); process.exitCode = 1;
});
