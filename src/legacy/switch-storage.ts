import { randomUUID } from 'node:crypto';
import { SYNTHETIC_RUNTIME, type OperationContext, type StorageReceipt, type StorageSnapshot, type VersionedCredentialStorage } from './switch-contract';

type Slot = { schema: 'fixture-keyring-v1' | 'fixture-fallback-v1'; subject: string } | null;
export interface SyntheticSlots { keyring: Slot; fallback: Slot }
interface Backup { slots: SyntheticSlots; lastOwnedRevision: number; transactionId: string }
export function isSyntheticSubject(subject: string): boolean { return /^fixture:[a-z0-9-]{1,40}$/u.test(subject); }
function validate(slots: SyntheticSlots): void {
  for (const [name, slot] of Object.entries(slots)) {
    if (slot !== null && (slot.schema !== `fixture-${name}-v1` || !isSyntheticSubject(slot.subject) || Object.keys(slot).length !== 2)) throw new Error('INVALID_SYNTHETIC_SLOT');
  }
  if (Object.keys(slots).length !== 2 || !('keyring' in slots) || !('fallback' in slots)) throw new Error('INVALID_SYNTHETIC_SLOT');
}
/** Composite *fixture* store. Has no filesystem, OS keyring, network or token access. */
export class SyntheticCredentialStorageV1 implements VersionedCredentialStorage {
  readonly mode = 'synthetic' as const;
  readonly runtime = SYNTHETIC_RUNTIME;
  private slots: SyntheticSlots;
  private revision = 0;
  private readonly backups = new Map<string, Backup>();
  constructor(slots: SyntheticSlots, private readonly injectFault: (point: 'after-keyring-write' | 'before-restore-fallback') => void = () => undefined) { validate(slots); this.slots = structuredClone(slots); }
  inspectFixture(): SyntheticSlots { return structuredClone(this.slots); }
  async snapshot(context: OperationContext): Promise<StorageSnapshot> {
    this.check(context);
    const reference = randomUUID();
    this.backups.set(reference, { slots: structuredClone(this.slots), lastOwnedRevision: this.revision, transactionId: context.transactionId });
    return { reference, revision: String(this.revision) };
  }
  async install(target: string, baseline: StorageSnapshot, context: OperationContext): Promise<StorageReceipt> {
    this.check(context);
    const backup = this.backup(baseline, context);
    if (!isSyntheticSubject(target)) throw new Error('INVALID_SYNTHETIC_SUBJECT');
    if (baseline.revision !== String(this.revision) || backup.lastOwnedRevision !== this.revision) throw new Error('STORAGE_CONFLICT');
    // Intentionally separate writes allow a synthetic partial-composite-write test.
    this.slots.keyring = { schema: 'fixture-keyring-v1', subject: target };
    backup.lastOwnedRevision = ++this.revision;
    this.injectFault('after-keyring-write');
    this.slots.fallback = { schema: 'fixture-fallback-v1', subject: target };
    return { revision: String(this.revision) };
  }
  async verifyInstalled(target: string, receipt: StorageReceipt, context: OperationContext): Promise<boolean> {
    this.check(context);
    return receipt.revision === String(this.revision) && this.slots.keyring?.subject === target && this.slots.fallback?.subject === target;
  }
  async restore(baseline: StorageSnapshot, context: OperationContext): Promise<void> {
    this.check(context);
    const backup = this.backup(baseline, context);
    if (backup.lastOwnedRevision !== this.revision) throw new Error('STORAGE_CONFLICT');
    this.slots.keyring = structuredClone(backup.slots.keyring);
    backup.lastOwnedRevision = ++this.revision;
    this.injectFault('before-restore-fallback');
    this.slots.fallback = structuredClone(backup.slots.fallback);
  }
  async verifyRestored(baseline: StorageSnapshot, context: OperationContext): Promise<boolean> {
    this.check(context);
    const backup = this.backup(baseline, context);
    return backup.lastOwnedRevision === this.revision && JSON.stringify(this.slots) === JSON.stringify(backup.slots);
  }
  private backup(snapshot: StorageSnapshot, context: OperationContext): Backup {
    const backup = this.backups.get(snapshot.reference);
    if (!backup || backup.transactionId !== context.transactionId) throw new Error('INVALID_SNAPSHOT');
    return backup;
  }
  private check(context: OperationContext): void { if (context.signal.aborted) throw new Error('CANCELLED'); }
}
