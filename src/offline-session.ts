import { isDeepStrictEqual } from 'node:util';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { LiveError, OfficialTokenSlots, equalSlots, type TokenSlots } from './live-storage';
import { LiveLocks } from './live-lock';
import { OfflineRecoveryStore } from './offline-recovery-store';
import { OfflineSwitchCoordinator, validateOfflineJournal, type OfflineCensus, type OfflineJournal, type OfflineProcess } from './offline-switch';

export interface OfflineSessionInput {
  record: OfflineJournal;
  /** Read proof captured by the initiating extension, bound to the exact backup.
   * Transport only through an authenticated recovery envelope or child stdin;
   * never accept untrusted workspace metadata as a route proof. */
  fileRoute: { hostId: string; backup: TokenSlots };
  password: string;
  knownHosts: OfflineProcess[];
}
export interface OfflineSessionDependencies {
  home: string; hostId: string; owner: string;
  census(known: readonly OfflineProcess[]): Promise<OfflineCensus>;
  ready(): Promise<void>;
  wait(signal?: AbortSignal): Promise<void>;
  now(): number;
  deadlineMs: number;
  prepared?: boolean;
  restore?: boolean;
}
/** POSIX file-only executor. Native keyrings intentionally require a different
 * adapter: process exit alone cannot establish service-side write settlement.
 * It retains a schema-4 recovery marker across every post-prepare outcome. */
export async function runOfflineFileSession(input: OfflineSessionInput, dependencies: OfflineSessionDependencies, signal?: AbortSignal): Promise<'installed-awaiting-verification' | 'restored-awaiting-verification'> {
  const request = structuredClone(input), { record } = request;
  validateOfflineJournal(record, dependencies.hostId);
  if (!dependencies.restore && record.phase !== 'prepared' || request.fileRoute.hostId !== record.hostId ||
      !equalSlots(request.fileRoute.backup, record.backup) || record.backup.keyringState !== 'unobserved' ||
      record.target.keyringState !== 'unobserved' || !request.knownHosts.length ||
      request.knownHosts.some(p => !Number.isSafeInteger(p.pid) || p.pid < 1 || typeof p.startIdentity !== 'string' || !p.startIdentity) ||
      !Number.isFinite(dependencies.deadlineMs) || dependencies.deadlineMs < 1 || dependencies.deadlineMs > 600_000)
    throw new LiveError('OFFLINE_SCOPE_UNVERIFIED');
  const root = path.join(dependencies.home, '.gemini');
  const locks = new LiveLocks(root, dependencies.owner);
  const journal = new OfflineRecoveryStore(path.join(root, 'antigravity-workbench-offline', record.id), request.password, record.hostId, record.id);
  const native = new OfficialTokenSlots(dependencies.home, { read: async () => null, write: async () => { throw new LiveError('OFFLINE_SCOPE_UNVERIFIED'); } });
  const read = async (): Promise<TokenSlots> => ({ ...await native.read(), keyringState: 'unobserved' });
  const census = (): Promise<OfflineCensus> => dependencies.census(request.knownHosts);
  return locks.withOperation(async () => {
    if (signal?.aborted) throw new LiveError('CANCELLED');
    // An existing marker, including another profile's, is never replaced.
    if (dependencies.prepared) {
      await locks.assertOfflineRecovery(record.id);
      if (!isDeepStrictEqual(await journal.read(), record)) throw new LiveError('OFFLINE_JOURNAL_CHANGED');
    } else if (await locks.hasRecovery()) throw new LiveError('OFFLINE_RECOVERY_REQUIRED');
    if (!dependencies.restore && !equalSlots(await read(), record.backup)) throw new LiveError('OFFLINE_STORAGE_CHANGED');
    const initial = await census();
    if (!initial.complete || initial.unknown) throw new LiveError('OFFLINE_CENSUS_UNVERIFIED');
    const births = new Set((dependencies.restore ? [...initial.hosts, ...initial.hubs] : record.execution?.participants ?? [...initial.hosts, ...initial.hubs]).map(p => `${p.pid}:${p.startIdentity}`));
    if ([...initial.hosts, ...initial.hubs].some(p => !births.has(`${p.pid}:${p.startIdentity}`))) throw new LiveError('OFFLINE_NEW_INSTANCE');
    // Persist before publication. A crash here leaves an inert encrypted record,
    // never a credential mutation. Marker publication fences old clients too.
    if (!dependencies.prepared) {
      await journal.save(record, undefined);
      await locks.beginOfflineRecovery(record.id);
    }
    await dependencies.ready();
    const deadline = dependencies.now() + dependencies.deadlineMs;
    for (;;) {
      if (signal?.aborted) throw new LiveError('CANCELLED');
      const current = await census();
      if (!current.complete || current.unknown) throw new LiveError('OFFLINE_CENSUS_UNVERIFIED');
      if ([...current.hosts, ...current.hubs].some(p => !births.has(`${p.pid}:${p.startIdentity}`))) throw new LiveError('OFFLINE_NEW_INSTANCE');
      if (!current.hosts.length && !current.hubs.length) break;
      if (dependencies.now() >= deadline) throw new LiveError('OFFLINE_CLOSE_TIMEOUT');
      await dependencies.wait(signal);
    }
    const coordinator = new OfflineSwitchCoordinator({
      hostId: record.hostId, journal, census,
      withLock: async work => { await locks.assertOperationHeld(); await locks.assertOfflineRecovery(record.id); return work(); },
      // This invocation has not handed any write to a service or old helper.
      // All local file mutations are awaited while this operation is held.
      assertWritersSettled: async () => { await locks.assertOperationHeld(); },
      slots: { read, write: async (value, expected, guard) => {
        await native.write({ keyring: null, file: value.file }, { keyring: null, file: expected.file }, async () => {
          await locks.assertOperationHeld(); await locks.assertOfflineRecovery(record.id); await guard();
        });
        const directory = await fs.open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try { await directory.sync(); } finally { await directory.close(); }
      } },
      // Manual reopen is the supported initial route. Do not guess an old WSL
      // IPC socket or claim that a launch returned successfully.
      reopen: async () => undefined,
    });
    if (dependencies.restore) {
      await coordinator.restore(true);
      return 'restored-awaiting-verification';
    }
    return coordinator.install({ confirmed: true, transactionId: record.id, backup: record.backup, target: record.target, expectedEmail: record.expectedEmail, ...(record.execution ? { execution: record.execution } : {}), ...(record.originalEmail ? { originalEmail: record.originalEmail } : {}) }, signal);
  });
}
