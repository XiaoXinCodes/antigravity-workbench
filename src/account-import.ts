import { createHash } from 'node:crypto';
import { LiveError, validateSlots, assertSlotIdentity } from './live-storage';
import { ACCOUNT_PREFIX, QUOTA_PENDING_PREFIX, QUOTA_UNKNOWN_PREFIX, type LiveAccount, type SavedLogin, type SecretVault } from './live-switch';

export interface AccountIndex { read(): SavedLogin[]; write(accounts: SavedLogin[]): Promise<void> }
export const IMPORT_PREFIX = 'live-switch.import.v1';
interface ImportJournal { schema: 1; hostId?: string; accounts: SavedLogin[] }
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const summary = ({ slots: _slots, ...metadata }: LiveAccount): SavedLogin => { void _slots; return metadata; };
const hash = (value: string | undefined): string => value === undefined ? 'absent' : createHash('sha256').update(value).digest('hex');
interface Change { id: string; before: SavedLogin | null; after: SavedLogin; beforeHash: string; afterHash: string; cleanup?: { key: string; hash: string }[] }
interface ReplacementJournal { schema: 2; hostId?: string; phase: 'prepared' | 'rollback' | 'committed'; changes: Change[] }
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Recoverable add/replace transaction with legacy schema 1 recovery.
 * Never reads or writes official credentials. */
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
  private async recoverLegacy(index: AccountIndex): Promise<void> {
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
  private get replacementKey(): string { return this.key + '.v2'; }
  private changeKey(id: string): string { return this.replacementKey + '.' + id; }
  private validateMetadata(item: SavedLogin): void {
    if (!item || !uuid.test(item.id) || item.hostId !== this.hostId || !['user', 'hub'].includes(item.identitySource) || typeof item.label !== 'string' || item.label.length > 260 || typeof item.expectedEmail !== 'string' || item.expectedEmail.length > 260 || typeof item.capturedAt !== 'string' || !Number.isFinite(Date.parse(item.capturedAt)) || item.migrationState !== undefined && !['pending', 'verified'].includes(item.migrationState) || item.verifiedSubject !== undefined && !/^[a-zA-Z0-9_-]{1,255}$/.test(item.verifiedSubject) || Object.keys(item).some(key => !['id', 'label', 'expectedEmail', 'capturedAt', 'identitySource', 'hostId', 'migrationState', 'verifiedSubject'].includes(key))) throw 0;
  }
  private async replacementJournal(): Promise<ReplacementJournal | undefined> {
    const raw = await this.vault.get(this.replacementKey);
    if (raw === undefined) return;
    try {
      if (Buffer.byteLength(raw) > 256 * 1024) throw 0;
      const value = JSON.parse(raw) as ReplacementJournal;
      if (value.schema !== 2 || value.hostId !== this.hostId || !['prepared', 'rollback', 'committed'].includes(value.phase) || !Array.isArray(value.changes) || !value.changes.length || value.changes.length > 50 || Object.keys(value).some(key => !['schema', 'hostId', 'phase', 'changes'].includes(key))) throw 0;
      const ids = new Set<string>();
      for (const row of value.changes) {
        this.validateMetadata(row.after); if (row.before) this.validateMetadata(row.before);
        if (row.after.id !== row.id || row.before && (row.before.id !== row.id || row.before.expectedEmail.trim().toLowerCase() !== row.after.expectedEmail) || row.after.migrationState !== 'verified' || !row.after.verifiedSubject || ids.has(row.id) || !/^(absent|[a-f0-9]{64})$/.test(row.beforeHash) || !/^[a-f0-9]{64}$/.test(row.afterHash) || !row.before && row.beforeHash !== 'absent' || Object.keys(row).some(key => !['id', 'before', 'after', 'beforeHash', 'afterHash', 'cleanup'].includes(key))) throw 0;
        if (row.cleanup !== undefined && (!Array.isArray(row.cleanup) || row.cleanup.length > 2 || new Set(row.cleanup.map(item => item.key)).size !== row.cleanup.length || row.cleanup.some(item => ![QUOTA_PENDING_PREFIX + row.id, QUOTA_UNKNOWN_PREFIX + row.id].includes(item.key) || !/^[a-f0-9]{64}$/.test(item.hash) || Object.keys(item).some(key => !['key', 'hash'].includes(key))))) throw 0;
        ids.add(row.id);
      }
      return value;
    } catch { throw new LiveError('MIGRATION_RECOVERY_INVALID'); }
  }
  private async writeReplacement(value: ReplacementJournal): Promise<void> {
    const raw = JSON.stringify(value); await this.vault.store(this.replacementKey, raw);
    if (await this.vault.get(this.replacementKey) !== raw) throw new LiveError('MIGRATION_ROLLBACK_REQUIRED');
  }
  private async clearReplacement(value: ReplacementJournal): Promise<void> {
    if (value.phase === 'committed') for (const row of value.changes) for (const item of row.cleanup ?? []) {
      const raw = await this.vault.get(item.key);
      if (raw === undefined) continue;
      if (hash(raw) !== item.hash) throw new LiveError('MIGRATION_INDEX_CHANGED');
      await this.vault.delete(item.key); if (await this.vault.get(item.key) !== undefined) throw new LiveError('MIGRATION_ROLLBACK_REQUIRED');
    }
    for (const row of value.changes) { const key = this.changeKey(row.id); await this.vault.delete(key); if (await this.vault.get(key) !== undefined) throw new LiveError('MIGRATION_ROLLBACK_REQUIRED'); }
    await this.vault.delete(this.replacementKey);
    if (await this.vault.get(this.replacementKey) !== undefined) throw new LiveError('MIGRATION_ROLLBACK_REQUIRED');
  }
  private async rollbackReplacement(value: ReplacementJournal, index: AccountIndex): Promise<void> {
    for (const row of value.changes) {
      const rows = index.read(), matches = rows.filter(item => item.id === row.id);
      if (matches.length > 1 || matches.some(item => !same(item, row.before) && !same(item, row.after))) throw new LiveError('MIGRATION_INDEX_CHANGED');
      if (matches.some(item => same(item, row.after))) {
        await index.write(rows.flatMap(item => item.id !== row.id ? [item] : row.before ? [row.before] : []));
        if (index.read().some(item => item.id === row.id && !same(item, row.before))) throw new LiveError('MIGRATION_ROLLBACK_REQUIRED');
      } else if (row.before && !matches.length) throw new LiveError('MIGRATION_INDEX_CHANGED');
      const key = ACCOUNT_PREFIX + row.id, current = await this.vault.get(key);
      if (hash(current) === row.beforeHash) continue;
      if (hash(current) !== row.afterHash) throw new LiveError('MIGRATION_INDEX_CHANGED');
      if (row.before) {
        const raw = await this.vault.get(this.changeKey(row.id));
        let before: string;
        try { const record = JSON.parse(raw!) as { before: string; after: string }; before = record.before; if (hash(before) !== row.beforeHash || hash(record.after) !== row.afterHash || !same(summary(JSON.parse(before) as LiveAccount), row.before)) throw 0; }
        catch { throw new LiveError('MIGRATION_RECOVERY_INVALID'); }
        await this.vault.store(key, before);
      } else await this.vault.delete(key);
      if (hash(await this.vault.get(key)) !== row.beforeHash) throw new LiveError('MIGRATION_ROLLBACK_REQUIRED');
    }
    await this.clearReplacement(value);
  }
  async recover(index: AccountIndex): Promise<void> {
    await this.recoverLegacy(index);
    const value = await this.replacementJournal(); if (!value) return;
    try {
      let complete = value.phase !== 'rollback' && value.changes.every(row => index.read().filter(item => item.id === row.id).length === 1 && index.read().some(item => same(item, row.after)));
      if (complete) for (const row of value.changes) if (hash(await this.vault.get(ACCOUNT_PREFIX + row.id)) !== row.afterHash) { complete = false; break; }
      if (complete) { value.phase = 'committed'; await this.writeReplacement(value); await this.clearReplacement(value); }
      else { value.phase = 'rollback'; await this.writeReplacement(value); await this.rollbackReplacement(value, index); }
    } catch { throw new LiveError('MIGRATION_ROLLBACK_REQUIRED'); }
  }
  /** Recoverable add/replace batch. Backups contain the latest durable OAuth
   * rotation, so rollback can never reinstall a pre-refresh credential. */
  async commitChanges(accounts: LiveAccount[], index: AccountIndex, assertCurrent: () => Promise<void> = async () => {}, expectedSecrets?: Map<string, string>): Promise<SavedLogin[]> {
    await this.recover(index);
    const beforeIndex = index.read(), changes: Change[] = [], records = new Map<string, string>();
    if (!accounts.length || accounts.length > 50 || new Set(accounts.map(account => account.id)).size !== accounts.length || beforeIndex.length + accounts.filter(account => !beforeIndex.some(item => item.id === account.id)).length > 50) throw new LiveError('SAVED_ACCOUNT_LIMIT');
    for (const account of accounts) {
      const after = summary(account); this.validateMetadata(after); validateSlots(account.slots); assertSlotIdentity(account.slots, account.expectedEmail);
      if (after.migrationState !== 'verified' || !after.verifiedSubject) throw new LiveError('ACCOUNT_QUOTA_IDENTITY_MISMATCH');
      const matches = beforeIndex.filter(item => item.id === account.id); if (matches.length > 1) throw new LiveError('MIGRATION_INDEX_CHANGED');
      const before = matches[0] ?? null, raw = await this.vault.get(ACCOUNT_PREFIX + account.id);
      if (expectedSecrets?.has(account.id) && raw !== expectedSecrets.get(account.id)) throw new LiveError('MIGRATION_INDEX_CHANGED');
      if (before) { this.validateMetadata(before); if (!raw || !same(summary(JSON.parse(raw) as LiveAccount), before) || before.expectedEmail.trim().toLowerCase() !== after.expectedEmail) throw new LiveError('MIGRATION_INDEX_CHANGED'); }
      else if (raw !== undefined) throw new LiveError('MIGRATION_INDEX_CHANGED');
      const cleanup: { key: string; hash: string }[] = [];
      if (before) for (const prefix of [QUOTA_PENDING_PREFIX, QUOTA_UNKNOWN_PREFIX]) { const key = prefix + account.id, value = await this.vault.get(key); if (value !== undefined) cleanup.push({ key, hash: hash(value) }); }
      const value = JSON.stringify(account); changes.push({ id: account.id, before, after, beforeHash: hash(raw), afterHash: hash(value), ...(cleanup.length ? { cleanup } : {}) });
      records.set(account.id, JSON.stringify({ before: raw ?? null, after: value }));
    }
    const journal: ReplacementJournal = { schema: 2, ...(this.hostId === undefined ? {} : { hostId: this.hostId }), phase: 'prepared', changes };
    await assertCurrent();
    // Own every staging key before creating any backup or replacing any secret.
    await this.writeReplacement(journal);
    try {
      for (const row of changes) { const key = this.changeKey(row.id), raw = records.get(row.id)!; if (await this.vault.get(key) !== undefined) throw new LiveError('MIGRATION_INDEX_CHANGED'); await this.vault.store(key, raw); if (await this.vault.get(key) !== raw) throw new LiveError('SECURE_SAVE_NOT_VERIFIED'); }
      for (const row of changes) {
        await assertCurrent();
        const key = ACCOUNT_PREFIX + row.id; if (hash(await this.vault.get(key)) !== row.beforeHash) throw new LiveError('MIGRATION_INDEX_CHANGED');
        const raw = (JSON.parse(records.get(row.id)!) as { after: string }).after;
        await this.vault.store(key, raw); if (await this.vault.get(key) !== raw) throw new LiveError('SECURE_SAVE_NOT_VERIFIED');
      }
      for (const row of changes) if (hash(await this.vault.get(ACCOUNT_PREFIX + row.id)) !== row.afterHash) throw new LiveError('MIGRATION_INDEX_CHANGED');
      await assertCurrent(); if (!same(index.read(), beforeIndex)) throw new LiveError('MIGRATION_INDEX_CHANGED');
      const afterIndex = beforeIndex.map(item => changes.find(row => row.id === item.id)?.after ?? item).concat(changes.filter(row => !row.before).map(row => row.after));
      await index.write(afterIndex); if (!same(index.read(), afterIndex)) throw new LiveError('MIGRATION_INDEX_CHANGED');
    } catch (error) {
      try { journal.phase = 'rollback'; await this.writeReplacement(journal); await this.rollbackReplacement(journal, index); }
      catch { throw new LiveError('MIGRATION_ROLLBACK_REQUIRED'); }
      throw new LiveError(error instanceof LiveError && error.code === 'QUOTA_QUERY_CANCELLED' ? error.code : 'MIGRATION_IMPORT_FAILED');
    }
    // Index readback is the commit boundary. Cleanup crashes finalize forward.
    journal.phase = 'committed';
    try { await this.writeReplacement(journal); await this.clearReplacement(journal); }
    catch { throw new LiveError('MIGRATION_ROLLBACK_REQUIRED'); }
    return changes.map(row => row.after);
  }
}
