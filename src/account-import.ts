import { createHash } from 'node:crypto';
import { LiveError, validateSlots, assertSlotIdentity } from './live-storage';
import { ACCOUNT_PREFIX, type LiveAccount, type SavedLogin, type SecretVault } from './live-switch';

export interface AccountIndex { read(): SavedLogin[]; write(accounts: SavedLogin[]): Promise<void> }
export const IMPORT_PREFIX = 'live-switch.import.v1';
interface ImportJournal { schema: 1; hostId?: string; accounts: SavedLogin[] }
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const summary = ({ slots: _slots, ...metadata }: LiveAccount): SavedLogin => { void _slots; return metadata; };
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** An additive, recoverable transaction. Never reads or writes official credentials. */
export class AccountImportTransaction {
  private readonly key: string;
  constructor(private readonly vault: SecretVault, private readonly hostId?: string) {
    this.key = hostId === undefined ? IMPORT_PREFIX : `${IMPORT_PREFIX}.host.${createHash('sha256').update(hostId).digest('hex')}`;
  }
  private async journal(): Promise<ImportJournal | null> {
    const raw = await this.vault.get(this.key);
    if (raw === undefined) return null;
    try {
      if (Buffer.byteLength(raw) > 128 * 1024) throw 0;
      const value = JSON.parse(raw) as ImportJournal;
      if (value.schema !== 1 || value.hostId !== this.hostId || Object.keys(value).some(key => !['schema', 'hostId', 'accounts'].includes(key)) || !Array.isArray(value.accounts) || value.accounts.length < 1 || value.accounts.length > 50) throw 0;
      const ids = new Set<string>();
      for (const item of value.accounts) {
        if (!item || !uuid.test(item.id) || ids.has(item.id) || item.hostId !== this.hostId || item.migrationState !== 'pending' || item.identitySource !== 'user' || typeof item.label !== 'string' || item.label.length > 80 || typeof item.expectedEmail !== 'string' || item.expectedEmail.length > 260 || typeof item.capturedAt !== 'string' || item.capturedAt.length > 40 || Object.keys(item).some(key => !['id', 'label', 'expectedEmail', 'capturedAt', 'identitySource', 'hostId', 'migrationState'].includes(key))) throw 0;
        ids.add(item.id);
      }
      return value;
    } catch { throw new LiveError('MIGRATION_RECOVERY_INVALID'); }
  }
  private async clear(): Promise<void> {
    await this.vault.delete(this.key);
    if (await this.vault.get(this.key) !== undefined) throw new LiveError('MIGRATION_ROLLBACK_REQUIRED');
  }
  private async rollback(journal: ImportJournal, index: AccountIndex): Promise<void> {
    const ids = new Set(journal.accounts.map(account => account.id));
    // Remove only this transaction's newly allocated IDs, preserving concurrent unrelated rows.
    const current = index.read();
    if (current.some(account => ids.has(account.id))) {
      await index.write(current.filter(account => !ids.has(account.id)));
      if (index.read().some(account => ids.has(account.id))) throw new LiveError('MIGRATION_ROLLBACK_REQUIRED');
    }
    for (const id of ids) {
      await this.vault.delete(ACCOUNT_PREFIX + id);
      if (await this.vault.get(ACCOUNT_PREFIX + id) !== undefined) throw new LiveError('MIGRATION_ROLLBACK_REQUIRED');
    }
    await this.clear();
  }
  async recover(index: AccountIndex): Promise<void> {
    const journal = await this.journal();
    if (!journal) return;
    let complete = journal.accounts.every(account => index.read().some(item => same(item, account)));
    if (complete) for (const metadata of journal.accounts) {
      const raw = await this.vault.get(ACCOUNT_PREFIX + metadata.id);
      try {
        if (!raw || Buffer.byteLength(raw) > 1024 * 1024) throw 0;
        const account = JSON.parse(raw) as LiveAccount;
        if (!same(summary(account), metadata)) throw 0;
        validateSlots(account.slots); assertSlotIdentity(account.slots, metadata.expectedEmail);
      } catch { complete = false; break; }
    }
    try {
      // A crash after the atomic index write is a complete import. A crash before it
      // removes only staged new copies. No rollback rewrites an existing account.
      if (complete) await this.clear(); else await this.rollback(journal, index);
    } catch { throw new LiveError('MIGRATION_ROLLBACK_REQUIRED'); }
  }
  async commit(accounts: LiveAccount[], index: AccountIndex): Promise<SavedLogin[]> {
    await this.recover(index);
    const before = index.read();
    if (!accounts.length || accounts.length > 50 || before.length + accounts.length > 50) throw new LiveError('SAVED_ACCOUNT_LIMIT');
    for (const account of accounts) {
      if (!uuid.test(account.id) || before.some(item => item.id === account.id) || await this.vault.get(ACCOUNT_PREFIX + account.id) !== undefined) throw new LiveError('MIGRATION_INDEX_CHANGED');
    }
    const metadata = accounts.map(summary);
    const journal: ImportJournal = { schema: 1, ...(this.hostId === undefined ? {} : { hostId: this.hostId }), accounts: metadata };
    const raw = JSON.stringify(journal);
    // Persist the entire set of owned IDs before creating even the first secret.
    await this.vault.store(this.key, raw);
    if (await this.vault.get(this.key) !== raw) throw new LiveError('MIGRATION_ROLLBACK_REQUIRED');
    try {
      for (const account of accounts) {
        const key = ACCOUNT_PREFIX + account.id, value = JSON.stringify(account);
        await this.vault.store(key, value);
        if (await this.vault.get(key) !== value) throw new LiveError('SECURE_SAVE_NOT_VERIFIED');
      }
      if (!same(index.read(), before)) throw new LiveError('MIGRATION_INDEX_CHANGED');
      const after = [...before, ...metadata];
      await index.write(after);
      if (!same(index.read(), after)) throw new LiveError('MIGRATION_INDEX_CHANGED');
    } catch {
      try { await this.rollback(journal, index); }
      catch { throw new LiveError('MIGRATION_ROLLBACK_REQUIRED'); }
      throw new LiveError('MIGRATION_IMPORT_FAILED');
    }
    // If cleanup fails, all imports are committed and the next explicit command
    // can recognize and finalize this journal. Never report an unverified success.
    try { await this.clear(); } catch { throw new LiveError('MIGRATION_ROLLBACK_REQUIRED'); }
    return metadata;
  }
}
