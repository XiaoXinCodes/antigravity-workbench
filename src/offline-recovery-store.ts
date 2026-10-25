import { isDeepStrictEqual } from 'node:util';
import { PrivateState } from './private-state';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { constants } from 'node:fs';
import { LiveError } from './live-storage';
import { decryptOfflineRecovery, encryptOfflineRecovery } from './offline-recovery-envelope';
import { validateOfflineJournal, type OfflineJournal } from './offline-switch';

interface EncryptedState { schema: 1; revision: number; envelope: string | null }
function parse(value: unknown): EncryptedState {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'envelope,revision,schema') throw new LiveError('OFFLINE_JOURNAL_INVALID');
  const state = value as EncryptedState;
  if (state.schema !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0 ||
      state.envelope !== null && (typeof state.envelope !== 'string' || Buffer.byteLength(state.envelope) > 2 * 1024 * 1024)) throw new LiveError('OFFLINE_JOURNAL_INVALID');
  return state;
}
/** Password-encrypted standalone recovery storage. Uses PrivateState's private
 * path validation, cross-process CAS, atomic rename and POSIX directory fsync.
 * Never stores the password/key. UI must confirm the user can recover the
 * password before closing clients. Windows durability/ACL acceptance is separate.
 * No automatic journal deletion: online verification owns final cleanup. */
export class OfflineRecoveryStore {
  private readonly state: PrivateState<EncryptedState>;
  constructor(private readonly directory: string, private readonly password: string, private readonly hostId: string, private readonly transactionId: string) {
    this.state = new PrivateState(directory, parse, () => ({ schema: 1, revision: 0, envelope: null }));
  }
  private async decode(state: EncryptedState): Promise<OfflineJournal | undefined> {
    return state.envelope === null ? undefined : decryptOfflineRecovery(Buffer.from(state.envelope), this.password, this.hostId, this.transactionId);
  }
  async read(): Promise<OfflineJournal | undefined> { return this.decode(await this.state.read()); }
  private async syncDirectoryChain(): Promise<void> {
    // PrivateState has already validated/created the private path. Sync every
    // parent as well as the leaf: a newly created leaf's directory entry lives
    // in its parent, and leaf fsync alone cannot make that entry durable.
    if (process.platform === 'win32') throw new LiveError('OFFLINE_DURABILITY_UNSUPPORTED');
    let current = this.directory;
    for (;;) {
      const handle = await fs.open(current, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_DIRECTORY || 0));
      try { if (!(await handle.stat()).isDirectory()) throw new LiveError('OFFLINE_JOURNAL_INVALID'); await handle.sync(); }
      finally { await handle.close(); }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  async save(value: OfflineJournal, expected: OfflineJournal | undefined): Promise<void> {
    // Caller-owned objects cannot change during KDF/IO awaits.
    const next = structuredClone(value), before = structuredClone(expected);
    validateOfflineJournal(next, this.hostId);
    if (next.id !== this.transactionId) throw new LiveError('OFFLINE_RECOVERY_INVALID');
    const observed = await this.state.read();
    if (!isDeepStrictEqual(await this.decode(observed), before)) throw new LiveError('OFFLINE_JOURNAL_CHANGED');
    const envelope = (await encryptOfflineRecovery(next, this.password)).toString('utf8');
    await this.state.transaction(state => {
      if (state.revision !== observed.revision || state.envelope !== observed.envelope || state.revision >= Number.MAX_SAFE_INTEGER) throw new LiveError('OFFLINE_JOURNAL_CHANGED');
      state.revision++; state.envelope = envelope;
    });
    await this.syncDirectoryChain();
    if (!isDeepStrictEqual(await this.read(), next)) throw new LiveError('OFFLINE_JOURNAL_UNVERIFIED');
  }
}
