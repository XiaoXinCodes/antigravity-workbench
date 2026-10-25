import { isDeepStrictEqual } from 'node:util';
import { sameStorageIdentity } from './live-switch';
import { LiveError, assertSlotIdentity, equalSlots, validateSlots, validateSlotScope, validateStoredToken, type TokenSlots } from './live-storage';

export interface OfflineProcess { pid: number; startIdentity: string }
export interface OfflineCensus { complete: boolean; unknown: boolean; hosts: OfflineProcess[]; hubs: OfflineProcess[] }
export interface OfflineJournal {
  schema: 1; hostId: string; id: string; phase: 'prepared' | 'installed' | 'restored' | 'verified' | 'restored-verified' | 'kept-current';
  backup: TokenSlots; target: TokenSlots; expectedEmail: string;
  originalEmail?: string;
  keptEmail?: string;
  execution?: { owner: string; extensionKind: 1 | 2; remoteName?: string; knownHosts: OfflineProcess[]; initialHosts?: OfflineProcess[]; participants: OfflineProcess[]; windowAutomation?: 'single-window-v1' | 'group-window-v1' };
}
export interface OfflineRuntime {
  hostId: string;
  /** Native adapter checks known host births AND newly discovered hosts/Hubs.
   * A fresh census detects violations of the user's no-new-window constraint;
   * it is not an OS-level prohibition of future starts. */
  census(): Promise<OfflineCensus>;
  /** Must hold the existing credential-scope cross-process exclusion. */
  withLock<T>(operation: () => Promise<T>): Promise<T>;
  /** Recovery must establish previous writers cannot still mutate storage.
   * A killed helper/closed pipe is NOT proof an OS keyring service settled. */
  assertWritersSettled(record: OfflineJournal): Promise<void>;
  slots: {
    read(): Promise<TokenSlots>;
    /** Invoke beforeMutation before EACH native slot mutation, also on rollback.
     * Compare exact slot bytes again after the awaited guard. Await native I/O
     * settlement: a timeout must not abandon a writer then start rollback. */
    write(value: TokenSlots, expected: TokenSlots, beforeMutation: () => Promise<void>): Promise<void>;
  };
  journal: {
    read(): Promise<OfflineJournal | undefined>;
    /** Authenticated encrypted, durable CAS + readback; do not implement using
     * SecretStorage alone, which may be in-memory without an encryption backend. */
    save(value: OfflineJournal, expected: OfflineJournal | undefined): Promise<void>;
  };
  reopen(): Promise<void>;
}
export interface OfflineRequest {
  confirmed: boolean; transactionId: string; backup: TokenSlots; target: TokenSlots; expectedEmail: string; execution?: OfflineJournal['execution']; originalEmail?: string;
}
const error = (code: string): LiveError => new LiveError(code);
export function validateOfflineJournal(record: OfflineJournal, hostId: string): void {
  try {
    if (!record || record.schema !== 1 || record.hostId !== hostId || typeof hostId !== 'string' || !hostId || hostId.length > 1024 ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(record.id) ||
      !['prepared', 'installed', 'restored', 'verified', 'restored-verified', 'kept-current'].includes(record.phase) ||
      typeof record.expectedEmail !== 'string' || !/^[^\s@]{1,128}@[^\s@]{1,128}$/.test(record.expectedEmail) ||
      [...record.expectedEmail].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) throw 0;
    if (record.keptEmail !== undefined && (typeof record.keptEmail !== 'string' || !/^[^\s@]{1,128}@[^\s@]{1,128}$/.test(record.keptEmail))) throw 0;
    if (record.phase === 'kept-current' && !record.keptEmail) throw 0;
    if (record.originalEmail !== undefined && (typeof record.originalEmail !== 'string' || !/^[^\s@]{1,128}@[^\s@]{1,128}$/.test(record.originalEmail))) throw 0;
    if (record.originalEmail) assertSlotIdentity(record.backup, record.originalEmail);
    if (record.execution) {
      const e = record.execution;
      if (e.windowAutomation !== undefined && !['single-window-v1', 'group-window-v1'].includes(e.windowAutomation)) throw 0;
      if (!/^[a-f0-9]{64}$/.test(e.owner) || ![1, 2].includes(e.extensionKind) || e.remoteName !== undefined && e.remoteName !== 'wsl' ||
          !Array.isArray(e.knownHosts) || !e.knownHosts.length || !Array.isArray(e.participants) || e.initialHosts !== undefined && (!Array.isArray(e.initialHosts) || !e.initialHosts.length) ||
          [...e.knownHosts, ...(e.initialHosts ?? []), ...e.participants].some(p => !Number.isSafeInteger(p.pid) || p.pid < 1 || typeof p.startIdentity !== 'string' || !/^linux:[a-f0-9-]{36}:[0-9]+$/.test(p.startIdentity))) throw 0;
    }
    validateSlotScope(record.backup); validateSlots(record.target); assertSlotIdentity(record.target, record.expectedEmail);
    if (record.backup.keyringState !== record.target.keyringState) throw 0;
    for (const value of [record.backup.keyring, record.backup.file]) if (value !== null) validateStoredToken(value);
  } catch { throw error('OFFLINE_RECOVERY_INVALID'); }
}
/** Host-independent transaction core. Not yet wired to UI/native offline
 * adapters: no production capability should be advertised until those adapters
 * and secure standalone recovery have passed platform acceptance. */
export class OfflineSwitchCoordinator {
  private busy = false;
  constructor(private readonly runtime: OfflineRuntime) {}
  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.busy) throw error('OFFLINE_OPERATION_BUSY');
    this.busy = true;
    try { return await this.runtime.withLock(operation); }
    finally { this.busy = false; }
  }
  private async closed(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw error('CANCELLED');
    const census = await this.runtime.census();
    if (signal?.aborted) throw error('CANCELLED');
    if (!census || census.complete !== true || census.unknown !== false || !Array.isArray(census.hosts) || !Array.isArray(census.hubs)) throw error('OFFLINE_CENSUS_UNVERIFIED');
    if (census.hosts.length || census.hubs.length) throw error('OFFLINE_INSTANCE_PRESENT');
  }
  private async saved(next: OfflineJournal, previous: OfflineJournal | undefined): Promise<void> {
    await this.runtime.journal.save(next, previous);
    if (!isDeepStrictEqual(await this.runtime.journal.read(), next)) throw error('OFFLINE_JOURNAL_UNVERIFIED');
  }
  private async restoreRecord(record: OfflineJournal): Promise<void> {
    validateOfflineJournal(record, this.runtime.hostId);
    if (record.phase === 'kept-current') throw error('OFFLINE_TRANSACTION_SETTLED');
    await this.runtime.assertWritersSettled(record);
    await this.closed();
    const current = await this.runtime.slots.read();
    // After a two-slot partial failure, old/target mixtures are ours to restore.
    // Any third-party value or scope change is preserved for manual recovery.
    if (current.keyringState !== record.backup.keyringState ||
      (['keyring', 'file'] as const).some(slot => ![record.backup, record.target].some(source => sameStorageIdentity({ keyring: null, file: source[slot] }, { keyring: null, file: current[slot] })))) throw error('OFFLINE_STORAGE_CHANGED');
    if (!equalSlots(current, record.backup)) await this.runtime.slots.write(record.backup, current, () => this.closed());
    if (!equalSlots(await this.runtime.slots.read(), record.backup)) throw error('OFFLINE_READBACK_FAILED');
    await this.closed();
    await this.saved({ ...record, phase: 'restored' }, record);
  }
  async install(request: OfflineRequest, signal?: AbortSignal): Promise<'installed-awaiting-verification'> {
    // Snapshot before the first await: caller cannot change the selected account.
    const input = structuredClone(request);
    return this.exclusive(async () => {
      if (input.confirmed !== true) throw error('OFFLINE_CONFIRMATION_REQUIRED');
      const record: OfflineJournal = { schema: 1, hostId: this.runtime.hostId, id: input.transactionId, phase: 'prepared', backup: input.backup, target: input.target, expectedEmail: input.expectedEmail, ...(input.execution ? { execution: input.execution } : {}), ...(input.originalEmail ? { originalEmail: input.originalEmail } : {}) };
      validateOfflineJournal(record, this.runtime.hostId);
      const prepared = await this.runtime.journal.read();
      if (prepared) {
        // The standalone helper may persist and ACK this exact preparation
        // before asking the user to close clients. No other pending transaction
        // or installed result can be reused as a fresh switch request.
        if (!isDeepStrictEqual(prepared, record)) throw error('OFFLINE_RECOVERY_REQUIRED');
        await this.runtime.assertWritersSettled(prepared);
      }
      await this.closed(signal);
      if (!equalSlots(await this.runtime.slots.read(), record.backup)) throw error('OFFLINE_STORAGE_CHANGED');
      if (!prepared) await this.saved(record, undefined);
      let attempted = false, writeSettled = false;
      try {
        await this.closed(signal);
        attempted = true;
        await this.runtime.slots.write(record.target, record.backup, () => this.closed(signal));
        writeSettled = true;
        if (!equalSlots(await this.runtime.slots.read(), record.target)) throw error('OFFLINE_READBACK_FAILED');
        await this.closed(signal);
        await this.saved({ ...record, phase: 'installed' }, record);
      } catch (failure) {
        if (attempted) {
          // Rejection does not establish service-side completion. Preserve the
          // encrypted backup and require an explicit recovery settlement proof.
          if (!writeSettled) throw error('OFFLINE_RECOVERY_REQUIRED');
          try {
            const persisted = await this.runtime.journal.read();
            if (!persisted || persisted.id !== record.id || persisted.hostId !== record.hostId ||
                !equalSlots(persisted.backup, record.backup) || !equalSlots(persisted.target, record.target)) throw error('OFFLINE_RECOVERY_INVALID');
            await this.restoreRecord(persisted);
          } catch { throw error('OFFLINE_RECOVERY_REQUIRED'); }
        }
        throw failure instanceof LiveError ? failure : error('OFFLINE_SWITCH_FAILED');
      }
      // A launch can succeed before returning an error: never roll back here.
      try { await this.runtime.reopen(); }
      catch { throw error('OFFLINE_REOPEN_REQUIRED'); }
      return 'installed-awaiting-verification' as const;
    });
  }
  async restore(confirmed: boolean): Promise<void> {
    return this.exclusive(async () => {
      if (confirmed !== true) throw error('OFFLINE_CONFIRMATION_REQUIRED');
      const record = await this.runtime.journal.read();
      if (!record) throw error('OFFLINE_RECOVERY_REQUIRED');
      await this.restoreRecord(record);
    });
  }
}
