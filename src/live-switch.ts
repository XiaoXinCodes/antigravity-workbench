import { ComponentRestoreFailure } from './component-coordination';
/* eslint-disable no-control-regex -- Reject control characters in recovered identity metadata. */
import { t as tr } from './i18n';
import { validQuotaDisplayId } from './quota-observation';
import { createHash, randomUUID } from 'node:crypto';
import { LiveError, equalSlots, validateSlots, validateStoredToken, assertSlotIdentity, validateSlotScope, tokenAccountHint, type Slots, type TokenSlots } from './live-storage';
import { portableToken, validateMigrationAccounts, type MigrationAccount } from './account-migration';
import { AccountImportTransaction, type AccountIndex } from './account-import';
import { RecoveryStore, type RecoveryStoreOptions } from './recovery-store';
import { savedLoginLocallyUsable, queryImportedAccountQuota, rebaseRefreshedSlots, type ImportedAccountQuota, type SavedAccountQuotaOptions } from './account-quota';
import { ImportCandidateStore } from './account-import-candidate';
import { createConsumerRefreshProvider, type ConsumerRefreshProvider } from './account-quota-client';
import * as path from 'node:path';
import * as os from 'node:os';

export interface SecretVault { get(key: string): Thenable<string | undefined> | Promise<string | undefined>; store(key: string, value: string): Thenable<void> | Promise<void>; delete(key: string): Thenable<void> | Promise<void>; onDidChange?(listener: (event: { key: string }) => void): { dispose(): void } }
export interface SavedLogin { id: string; label: string; expectedEmail: string; capturedAt: string; identitySource: 'hub' | 'user'; hostId?: string; migrationState?: 'pending' | 'verified'; verifiedSubject?: string; quotaDisplayId?: string }
export interface LiveAccount extends SavedLogin { slots: TokenSlots }
export interface VerificationState { state: 'pending' | 'retry' | 'verified'; attempts: number; checkedAt?: string; code?: string }
export interface Journal { schema: 1; id: string; revision?: number; writeId?: string; phase: 'authorizing' | 'prepared' | 'installed' | 'restored'; operation?: 'login'; backup: TokenSlots; loginCurrent?: TokenSlots; target: SavedLogin; oldGeneration: string; hostId?: string; loginMode?: 'save-only'; original?: { email: string | null }; restoreGeneration?: string; verification?: VerificationState }
export interface HubProof { email: string; generation: string; observedAt: string; authValid: boolean; quotaSource?: 'server'; buckets: { bucketId?: string; groupId?: string; window?: string; label: string; remaining: number | null; resetAt: string | null; remainingAmount?: string; disabled?: boolean }[] }
export interface SignedOutProof { generation: string; authValid: false }
export interface Lifecycle { credentialAdmissionNeedsDrain?: boolean; assertCredentialWriteSafe?(signal?: AbortSignal): Promise<void>; stop(): Promise<void>; reload(): Promise<void>; proof(signal?: AbortSignal): Promise<HubProof>; signedOutProof?(signal?: AbortSignal): Promise<SignedOutProof>; generation: string; restartMode?: 'component' | 'unavailable' }
export interface VerificationGuard { id: string; phase: Journal['phase']; assertCurrent(): void }
export interface RecoveryFinalizer {
  prepare(id: string, binding: string): Promise<string>;
  pending(): Promise<string | null>;
  identity(id: string): Promise<string | null>;
  clear(id: string, identity: string): Promise<void>;
}
export interface AccountResult { schema: 1; id: string; targetId: string; hostId?: string; verifiedAt: string; committedAt?: string; account: 'verified' | 'committed'; components: 'pending' | 'complete' }
interface AccountResultRecord { summary: AccountResult; journalRaw: string; expected: TokenSlots; expectedEmail: string }
interface Completion { accountResult?: true; schema: 1; id: string; hostId?: string; key: string; hash: string; marker: string; deleted: boolean }
export const JOURNAL_KEY = 'live-switch.recovery.v1';
export const ACCOUNT_PREFIX = 'live-switch.account.v1.';
export const QUOTA_REFRESH_PREFIX = 'live-switch.quota-refresh.v1.';
export const QUOTA_PENDING_PREFIX = 'live-switch.quota-pending.v1.';
export const QUOTA_UNKNOWN_PREFIX = 'live-switch.quota-unknown.v1.';
/** A stopped process is not a startup barrier. Production adapters must reject
 * unless they can exclude future starts throughout the entire write transaction.
 * Missing adapters fail closed; isolated test adapters may model that guarantee. */
export async function assertCredentialWriteSafe(lifecycle: Lifecycle, signal?: AbortSignal): Promise<void> {
  if (typeof lifecycle.assertCredentialWriteSafe !== 'function') throw new LiveError('OFFICIAL_CREDENTIAL_WRITE_BARRIER_UNAVAILABLE');
  await lifecycle.assertCredentialWriteSafe(signal);
}
export type LiveInstallStage = 'preflight' | 'stop' | 'backup' | 'credential-write' | 'credential-readback' | 'journal-installed' | 'reconnect';
// Verification errors cross the UI/persistence boundary. Never store an adapter's
// arbitrary message/code, even if it happens to be wrapped in our Error class.
const VERIFICATION_ERRORS = new Set([
  'COMPONENT_RESTORE_FAILED',
  'RECOVERY_VERIFICATION_TIMEOUT', 'RECOVERY_VERIFICATION_STALE',
  'HUB_IDENTITY_NOT_VERIFIED', 'HUB_SIGNED_OUT_NOT_VERIFIED', 'VERIFICATION_STORAGE_MISMATCH',
  'HUB_AUTH_INVALID', 'HUB_EMAIL_MISSING', 'HUB_CHANGED_DURING_QUERY', 'HUB_RPC_FAILED', 'HUB_RPC_TIMEOUT',
  'HUB_RESPONSE_INVALID', 'HUB_RESPONSE_TOO_LARGE', 'HUB_QUOTA_EMPTY', 'HUB_QUOTA_RESPONSE_INVALID',
  'OFFICIAL_HUB_API_UNAVAILABLE', 'OFFICIAL_HUB_NOT_READY', 'OFFICIAL_STORAGE_CHANGED',
  'OFFICIAL_STORAGE_SCOPE_MISMATCH', 'OFFICIAL_STORAGE_MODE_CHANGED', 'OFFICIAL_FILE_UNSAFE',
  'OFFICIAL_FILE_ENCODING_INVALID', 'KEYRING_UNAVAILABLE', 'KEYRING_COLLECTION_AMBIGUOUS',
  'KEYRING_RESPONSE_INVALID', 'KEYRING_ENCODING_INVALID', 'WSL_FILE_ROUTE_UNVERIFIED',
  'NATIVE_HELPER_TIMEOUT_OR_LIMIT', 'NATIVE_HELPER_UNAVAILABLE', 'NO_SAVED_OFFICIAL_LOGIN',
  'TOKEN_SIZE_INVALID', 'TOKEN_FORMAT_UNSUPPORTED', 'ONLY_PERSONAL_OAUTH_SUPPORTED',
  'STORED_TOKEN_EMAIL_MISMATCH', 'KEYRING_FILE_IDENTITY_AMBIGUOUS',
  'SECURE_SAVE_NOT_VERIFIED', 'MIGRATION_INDEX_CHANGED', 'RECOVERY_DELETE_FAILED', 'RECOVERY_CHANGED',
]);

type CaptureMetadata = Omit<SavedLogin, 'id' | 'capturedAt' | 'hostId' | 'migrationState' | 'quotaDisplayId'>;
/** Both slots use the target host's existing native adapters, never source keyring encodings. */
export function migrationTargetSlots(token: string, platform: NodeJS.Platform = process.platform): TokenSlots {
  const bytes = Buffer.byteLength(token);
  if (platform === 'win32' && bytes > 2560 || platform === 'darwin' && Buffer.from(token).toString('base64').length > 3900 || platform === 'linux' && bytes >= 8192) throw new LiveError('MIGRATION_TARGET_SIZE_LIMIT');
  if (!['win32', 'darwin', 'linux'].includes(platform)) throw new LiveError('PLATFORM_UNSUPPORTED');
  // Native target only; observed WSL file scope is chosen separately at transaction preflight.
  return { keyring: token, file: token };
}
function targetForScope(target: TokenSlots, backup: TokenSlots): TokenSlots {
  if (backup.keyringState === 'unobserved') {
    if (target.file === null) throw new LiveError('OFFICIAL_STORAGE_SCOPE_MISMATCH');
    return { keyring: null, file: target.file, keyringState: 'unobserved' };
  }
  if (target.keyringState === 'unobserved') {
    if (target.file === null) throw new LiveError('OFFICIAL_STORAGE_SCOPE_MISMATCH');
    return migrationTargetSlots(target.file);
  }
  return target;
}
function validHostId(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.trim() === value; }
function validEmail(value: unknown): value is string { return typeof value === 'string' && !/[\u202a-\u202e\u2066-\u2069]/u.test(value) && /^[^\s@\x00-\x1f\x7f<>]{1,128}@[^\s@\x00-\x1f\x7f<>]{1,128}$/.test(value); }
export function sameStorageIdentity(expected: TokenSlots, current: TokenSlots): boolean {
  if (expected.keyringState !== current.keyringState) return false;
  return (['keyring', 'file'] as const).every(slot => {
    const before = expected[slot], after = current[slot];
    if (before === null || after === null) return before === after;
    // Access-token refresh is expected. Different refresh credentials cannot be vouched
    // for by an email/JWT hint, so retain recovery rather than accept a different login.
    try { return tokenAccountHint(before).refresh === tokenAccountHint(after).refresh; } catch { return before === after; }
  });
}
export function parseJournal(raw: string): Journal {
  try { const j = JSON.parse(raw) as Journal;
    if (j.schema !== 1 || !['authorizing', 'prepared', 'installed', 'restored'].includes(j.phase) || !j.id || !j.target?.id || typeof j.oldGeneration !== 'string') throw 0;
    if ((j.revision === undefined) !== (j.writeId === undefined) || j.revision !== undefined && (!Number.isSafeInteger(j.revision) || j.revision < 1 || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(j.writeId!))) throw 0;
    if (j.operation !== undefined && j.operation !== 'login' || j.phase === 'authorizing' && j.operation !== 'login') throw 0;
    if (j.hostId !== undefined && !validHostId(j.hostId) || j.target.hostId !== undefined && !validHostId(j.target.hostId)) throw 0;
    if (j.loginMode !== undefined && (j.loginMode !== 'save-only' || j.operation !== 'login')) throw 0;
    if (j.original !== undefined && (!j.original || (j.original.email !== null && !validEmail(j.original.email)))) throw 0;
    if (j.restoreGeneration !== undefined && !validHostId(j.restoreGeneration)) throw 0;
    if (j.verification !== undefined && (!j.verification || !['pending', 'retry', 'verified'].includes(j.verification.state) || !Number.isSafeInteger(j.verification.attempts) || j.verification.attempts < 0 || j.verification.checkedAt !== undefined && !Number.isFinite(Date.parse(j.verification.checkedAt)) || j.verification.code !== undefined && !/^[A-Z0-9_]{1,100}$/.test(j.verification.code))) throw 0;
    validateSlotScope(j.backup);
    if (j.loginCurrent !== undefined) { if (j.operation !== 'login') throw 0; validateSlotScope(j.loginCurrent); for (const token of [j.loginCurrent.keyring, j.loginCurrent.file]) if (token !== null) validateStoredToken(token); }
    for (const value of [j.backup.keyring, j.backup.file]) if (value !== null && typeof value !== 'string') throw 0;
    return j;
  } catch { throw new LiveError('RECOVERY_RECORD_INVALID'); }
}
export class LiveSwitchService {
  private importing = false;
  private captureQueue: Promise<unknown> = Promise.resolve();
  // SecretStorage may be shared by local and remote extension hosts. The optional
  // constructor argument exists for isolated fixtures; production supplies its
  // exact credential-host fingerprint, never a caller's claimed account host.
  private readonly recoveryKey: string;
  private readonly recoveryStore: RecoveryStore;
  private readonly snapshots = new WeakMap<Journal, { key: string; raw: string }>();
  private unconfirmedInstall?: { id: string; key: string; before: string; after: string; expected: TokenSlots; scope: TokenSlots; attempted: boolean } | undefined;
  constructor(private readonly vault: SecretVault, private readonly slots: Slots, private readonly hostId?: string, recoveryOptions?: RecoveryStoreOptions) {
    if (hostId !== undefined && !validHostId(hostId)) throw new LiveError('HOST_ID_INVALID');
    // SecretStorage is shared across hosts, but their HOME filesystem locks are not.
    // Distinct keys prevent concurrent native/WSL transactions replacing each other's backup.
    this.recoveryKey = hostId === undefined ? JOURNAL_KEY : `${JOURNAL_KEY}.host.${createHash('sha256').update(hostId).digest('hex')}`;
    this.recoveryStore = new RecoveryStore(vault, recoveryOptions);
  }
  hostIsCurrent(record: { hostId?: string }): boolean { return this.hostId === undefined || record.hostId === this.hostId; }
  credentialHostIdentity(): string | undefined { return this.hostId; }
  private assertHost(record: { hostId?: string }, kind: 'ACCOUNT' | 'RECOVERY'): void {
    if (this.hostId === undefined) return;
    if (record.hostId === undefined) throw new LiveError(`HOST_${kind}_UNBOUND`);
    if (!this.hostIsCurrent(record)) throw new LiveError(`HOST_${kind}_MISMATCH`);
  }
  private hostBinding(): { hostId?: string } { return this.hostId === undefined ? {} : { hostId: this.hostId }; }
  private importTransaction(): AccountImportTransaction { return new AccountImportTransaction(this.vault, this.hostId); }
  async removeImportCandidates(id: string): Promise<void> { await ImportCandidateStore.removeOwner(this.vault, this.hostId, id); }
  async recoverImport(index: AccountIndex): Promise<void> { await this.importTransaction().recover(index); }
  async exportAccounts(ids: string[]): Promise<MigrationAccount[]> {
    if (await this.journal()) throw new LiveError('RECOVERY_PENDING');
    if (!Array.isArray(ids) || !ids.length || ids.length > 50 || new Set(ids).size !== ids.length) throw new LiveError('MIGRATION_ACCOUNT_SELECTION_INVALID');
    const result: MigrationAccount[] = [];
    for (const id of ids) {
      if (await this.vault.get(QUOTA_REFRESH_PREFIX + id) || await this.vault.get(QUOTA_PENDING_PREFIX + id) || await this.vault.get(QUOTA_UNKNOWN_PREFIX + id)) throw new LiveError('CAPTURE_CREDENTIAL_RECOVERY_REQUIRED');
      const account = await this.readAccount(id);
      // Browser login historically used the full email as its display label, which
      // can exceed the normal 80-code-unit label limit. Preserve the full identity
      // but bound only this portable display label without splitting a surrogate.
      let label = '';
      for (const char of account.label) { if (label.length + char.length > 80) break; label += char; }
      result.push({ label: label.trim(), expectedEmail: account.expectedEmail, capturedAt: account.capturedAt, token: portableToken(account.slots, account.expectedEmail) });
    }
    return validateMigrationAccounts(result);
  }
  /** Caller holds the host operation lock. No official credential or lifecycle access. */
  async importAccounts(entries: MigrationAccount[], index: AccountIndex, options: AccountImportOptions = {}): Promise<SavedLogin[]> {
    if (this.importing) throw new LiveError('ACCOUNT_QUOTA_ALREADY_RUNNING');
    this.importing = true;
    try {
      if (await this.journal()) throw new LiveError('RECOVERY_PENDING');
      await this.recoverImport(index);
      const source = validateMigrationAccounts(entries), before = index.read();
      const plans = source.map(entry => {
        const matches = before.filter(item => item.hostId === this.hostId && item.expectedEmail.trim().toLowerCase() === entry.expectedEmail);
        const target = options.replace?.[entry.expectedEmail];
        if (matches.length && !target || target && !matches.some(item => item.id === target) || target && before.filter(item => item.id === target).length !== 1) throw new LiveError('MIGRATION_TARGET_REQUIRED');
        return { entry, target };
      });
      if (before.length + plans.filter(plan => !plan.target).length > 50) throw new LiveError('SAVED_ACCOUNT_LIMIT');
      const targetSnapshots = new Map<string, string>();
      for (const plan of plans) if (plan.target) {
        const selected = await this.account(plan.target), raw = await this.vault.get(ACCOUNT_PREFIX + plan.target);
        if (!raw || !equalSlots((JSON.parse(raw) as LiveAccount).slots, selected.slots)) throw new LiveError('MIGRATION_INDEX_CHANGED');
        targetSnapshots.set(plan.target, raw);
      }
      const assertHostCurrent = async (): Promise<void> => {
        if (options.signal?.aborted) throw new LiveError('QUOTA_QUERY_CANCELLED');
        await options.assertCurrent?.();
        if (JSON.stringify(index.read()) !== JSON.stringify(before)) throw new LiveError('MIGRATION_INDEX_CHANGED');
      };
      const assertCurrent = async (): Promise<void> => {
        await assertHostCurrent();
        for (const [id, raw] of targetSnapshots) if (await this.vault.get(ACCOUNT_PREFIX + id) !== raw) throw new LiveError('MIGRATION_INDEX_CHANGED');
      };
      await assertCurrent();
      const results: { account: LiveAccount; quota: ImportedAccountQuota; store: ImportCandidateStore }[] = [];
      for (const { entry, target } of plans) {
        await assertCurrent();
        const previous = target ? await this.account(target) : undefined;
        const candidate = new ImportCandidateStore(this.vault, { id: randomUUID(), label: entry.label, expectedEmail: entry.expectedEmail, capturedAt: entry.capturedAt, identitySource: 'user', ...this.hostBinding(), slots: { keyring: entry.token, file: entry.token } }, entry.token, target);
        const saved = await candidate.account();
        // Pin the server subject previously verified for this copy (or constrain a
        // legacy copy's subject hint); the new subject is always established online.
        const expectedSubject = previous?.verifiedSubject ?? (previous ? tokenAccountHint(previous.slots.keyring ?? previous.slots.file!).subject : undefined);
        const pinned = { ...saved, ...(expectedSubject ? { verifiedSubject: expectedSubject } : {}) };
        const grant = tokenAccountHint(entry.token).refresh;
        const linked: LiveAccount[] = [];
        for (const row of before.filter(item => item.hostId === this.hostId && item.expectedEmail.trim().toLowerCase() === entry.expectedEmail)) {
          const old = await this.account(row.id);
          if (tokenAccountHint(old.slots.keyring ?? old.slots.file!).refresh === grant) linked.push(old);
        }
        const stageLinked = async (next: TokenSlots): Promise<void> => {
          for (const old of linked) {
            const prior = await this.vault.get(QUOTA_PENDING_PREFIX + old.id) === undefined ? undefined : await this.pendingQuotaRefresh(old.id, old.slots);
            await this.stageQuotaRefresh(old.id, old.slots, rebaseRefreshedSlots(old.slots, next), prior);
          }
        };
        const provider = options.provider ?? createConsumerRefreshProvider(path.join(os.homedir(), '.gemini', 'bin', process.platform === 'win32' ? 'agy.exe' : 'agy'));
        const queryOptions: SavedAccountQuotaOptions = { refresh: {
          provider: { clientIdSha256: provider.clientIdSha256, exchange: async (token, signal) => {
            for (const old of linked) {
              const key = QUOTA_UNKNOWN_PREFIX + old.id, raw = JSON.stringify({ schema: 1, expected: old.slots, hostId: old.hostId });
              await this.vault.store(key, raw);
              if (await this.vault.get(key) !== raw) throw new LiveError('ACCOUNT_QUOTA_SECURE_SAVE_FAILED');
            }
            return candidate.exchange(saved.slots, async () => {
              try { return await provider.exchange(token, signal); }
              catch (error) {
                if (error instanceof LiveError && ['ACCOUNT_QUOTA_REAUTH_REQUIRED', 'ACCOUNT_QUOTA_CLIENT_UNVERIFIED', 'ACCOUNT_QUOTA_FORBIDDEN', 'ACCOUNT_QUOTA_RATE_LIMITED'].includes(error.code)) {
                  for (const old of linked) {
                    await this.vault.delete(QUOTA_UNKNOWN_PREFIX + old.id);
                    if (await this.vault.get(QUOTA_UNKNOWN_PREFIX + old.id) !== undefined) throw new LiveError('ACCOUNT_QUOTA_SECURE_SAVE_FAILED');
                  }
                }
                throw error;
              }
            });
          } },
          loadPending: async expected => { const next = await candidate.pending(expected); if (next) await stageLinked(next); return next; },
          stage: async (expected, next) => { await candidate.stage(expected, next); await stageLinked(next); },
          commit: async (expected, next) => {
            for (const old of linked) {
              const committed = await this.commitQuotaRefresh(old.id, old.slots, rebaseRefreshedSlots(old.slots, next));
              if (targetSnapshots.has(old.id)) targetSnapshots.set(old.id, JSON.stringify(committed));
            }
            await candidate.commit(expected, next);
          },
        }, ...(options.phase ? { phase: options.phase } : {}) };
        const quota = await (options.query ?? queryImportedAccountQuota)(pinned, options.signal, queryOptions);
        await assertCurrent();
        if (!quota.proof.authValid || quota.proof.quotaSource !== 'server' || quota.proof.email.toLowerCase() !== entry.expectedEmail || !/^[a-zA-Z0-9_-]{1,255}$/.test(quota.subject) || expectedSubject && quota.subject !== expectedSubject) throw new LiveError('ACCOUNT_QUOTA_IDENTITY_MISMATCH');
        const current = await candidate.account();
        const account: LiveAccount = { ...current, id: target ?? current.id, label: entry.label, capturedAt: entry.capturedAt, identitySource: 'user', migrationState: 'verified', verifiedSubject: quota.subject, quotaDisplayId: randomUUID() };
        results.push({ account, quota, store: candidate });
      }
      await assertCurrent();
      const accounts = await this.importTransaction().commitChanges(results.map(result => result.account), index, assertHostCurrent, targetSnapshots);
      for (let n = 0; n < results.length; n++) {
        const result = results[n]!;
        options.quota?.(accounts[n]!, result.quota);
        // Cleanup failure must not report rollback: verified accounts are already committed.
        try { await result.store.clear(); } catch { /* Retry uses the securely retained latest candidate. */ }
      }
      return accounts;
    } finally { this.importing = false; }
  }
  async capture(metadata: CaptureMetadata): Promise<SavedLogin> {
    if (await this.journal()) throw new LiveError('RECOVERY_PENDING');
    const value = await this.slots.read(); validateSlots(value); assertSlotIdentity(value, metadata.expectedEmail);
    // Recheck to avoid saving a half-updated login while the official backend refreshes.
    if (!equalSlots(value, await this.slots.read())) throw new LiveError('OFFICIAL_STORAGE_CHANGED');
    return this.saveAccount(metadata, value);
  }
  /** Passive local check. Never reads official storage, refreshes OAuth, or repairs records. */
  async savedLoginUsable(summary: SavedLogin): Promise<boolean> {
    if (!this.hostIsCurrent(summary) || summary.migrationState === 'pending') return false;
    if (await this.vault.get(QUOTA_REFRESH_PREFIX + summary.id) || await this.vault.get(QUOTA_PENDING_PREFIX + summary.id) || await this.vault.get(QUOTA_UNKNOWN_PREFIX + summary.id)) return false;
    const raw = await this.vault.get(ACCOUNT_PREFIX + summary.id);
    if (!raw) return false;
    try {
      const account = JSON.parse(raw) as LiveAccount;
      if (account.id !== summary.id || account.expectedEmail?.toLowerCase() !== summary.expectedEmail.toLowerCase() || account.hostId !== summary.hostId || account.capturedAt !== summary.capturedAt || account.migrationState === 'pending') return false;
      this.assertHost(account, 'ACCOUNT'); validateSlots(account.slots); assertSlotIdentity(account.slots, summary.expectedEmail);
      return savedLoginLocallyUsable(account);
    } catch { return false; }
  }
  /** Caller holds the shared host operation lock. Serialize same-instance calls too.
   * A fresh Hub guard surrounds all awaits; updates retain the original ID and roll
   * back only this write on failed identity/index verification. No OAuth is started. */
  captureCurrent(metadata: CaptureMetadata, index: AccountIndex, verify: () => Promise<void>, allowWrite = true, expectedLogin?: Journal, refreshExisting = false): Promise<{ account: SavedLogin; saved: boolean }> {
    const operation = this.captureQueue.then(async () => {
      if (metadata.identitySource !== 'hub') throw new LiveError('HUB_FRESH_IDENTITY_REQUIRED');
      const expected = expectedLogin && JSON.stringify(expectedLogin);
      const assertCapture = async (): Promise<void> => {
        const journal = await this.journal();
        if (expectedLogin) {
          if (expectedLogin.operation !== 'login' || expectedLogin.loginMode !== 'save-only' || JSON.stringify(journal) !== expected) throw new LiveError('RECOVERY_CHANGED');
        } else if (journal) throw new LiveError('RECOVERY_PENDING');
        await verify();
      };
      await assertCapture();
      const beforeIndex = JSON.stringify(index.read());
      const matches = index.read().filter(account => this.hostIsCurrent(account) && account.expectedEmail.toLowerCase() === metadata.expectedEmail.toLowerCase());
      if (matches.length > 1 || matches.length === 1 && index.read().filter(account => account.id === matches[0]!.id).length !== 1) throw new LiveError('CAPTURE_ACCOUNT_AMBIGUOUS');
      const previous = matches[0];
      if (previous && !refreshExisting && await this.savedLoginUsable(previous)) {
        await assertCapture();
        if (JSON.stringify(index.read()) !== beforeIndex) throw new LiveError('MIGRATION_INDEX_CHANGED');
        return { account: previous, saved: true };
      }
      if (!allowWrite) throw new LiveError('CAPTURE_CREDENTIAL_CHANGED');
      if (!previous && index.read().length >= 50) throw new LiveError('SAVED_ACCOUNT_LIMIT');
      const id = previous?.id ?? randomUUID(), key = ACCOUNT_PREFIX + id;
      if (await this.vault.get(QUOTA_REFRESH_PREFIX + id) || await this.vault.get(QUOTA_PENDING_PREFIX + id) || await this.vault.get(QUOTA_UNKNOWN_PREFIX + id)) throw new LiveError('CAPTURE_CREDENTIAL_RECOVERY_REQUIRED');
      const before = await this.vault.get(key);
      // Never replace a credential bound to another host or identity, even if its index is corrupt.
      if (before !== undefined) {
        try { const old = JSON.parse(before) as LiveAccount; this.assertHost(old, 'ACCOUNT'); if (old.id !== id || old.expectedEmail?.toLowerCase() !== metadata.expectedEmail.toLowerCase()) throw 0; }
        catch { throw new LiveError('CAPTURE_RECORD_CONFLICT'); }
      }
      const value = await this.slots.read(); validateSlots(value); assertSlotIdentity(value, metadata.expectedEmail);
      if (!equalSlots(value, await this.slots.read())) throw new LiveError('OFFICIAL_STORAGE_CHANGED');
      await assertCapture();
      if (JSON.stringify(index.read()) !== beforeIndex || await this.vault.get(key) !== before) throw new LiveError('MIGRATION_INDEX_CHANGED');
      if (previous && before !== undefined && equalSlots((JSON.parse(before) as LiveAccount).slots, value)) return { account: previous, saved: true };
      // An explicitly replaced record gets a new display identity; ordinary
      // same-identity capture keeps its observation origin, never its request revision.
      const subjects = [value.keyring, value.file].filter((raw): raw is string => raw !== null).map(raw => tokenAccountHint(raw).subject);
      let priorSubject = previous?.verifiedSubject, priorReadable = false;
      try {
        if (before) { const old = JSON.parse(before) as LiveAccount; validateSlots(old.slots); priorSubject ??= tokenAccountHint(old.slots.keyring ?? old.slots.file!).subject; priorReadable = true; }
      } catch { /* A repaired/missing credential record gets a new display identity. */ }
      const sameIdentity = !!previous && priorReadable && (!priorSubject || subjects.every(subject => subject === priorSubject));
      const account: LiveAccount = { ...metadata, label: previous?.label ?? metadata.label, ...this.hostBinding(), id, capturedAt: new Date().toISOString(), slots: value,
        quotaDisplayId: previous && sameIdentity ? (validQuotaDisplayId(previous.quotaDisplayId) ? previous.quotaDisplayId : validQuotaDisplayId(previous.capturedAt) ? previous.capturedAt : randomUUID()) : randomUUID(),
        ...(sameIdentity && previous?.verifiedSubject ? { verifiedSubject: previous.verifiedSubject } : {}),
        ...(sameIdentity && previous?.migrationState ? { migrationState: previous.migrationState } : {}) };
      const { slots: _slots, ...summary } = account; void _slots;
      const after = JSON.stringify(account);
      try {
        await assertCapture();
        await this.vault.store(key, after);
        if (await this.vault.get(key) !== after) throw new LiveError('SECURE_SAVE_NOT_VERIFIED');
        await assertCapture();
        if (JSON.stringify(index.read()) !== beforeIndex) throw new LiveError('MIGRATION_INDEX_CHANGED');
        await index.write(previous ? index.read().map(item => item.id === id ? summary : item) : [...index.read(), summary]);
        if (!index.read().some(item => JSON.stringify(item) === JSON.stringify(summary))) throw new LiveError('SECURE_SAVE_NOT_VERIFIED');
        await assertCapture();
        return { account: summary, saved: false };
      } catch (error) {
        // Restore the index only if it still contains our exact summary; preserve concurrent rows.
        if (index.read().some(item => JSON.stringify(item) === JSON.stringify(summary))) await index.write(previous ? index.read().map(item => item.id === id ? previous : item) : index.read().filter(item => item.id !== id));
        if (await this.vault.get(key) === after) { if (before === undefined) await this.vault.delete(key); else await this.vault.store(key, before); }
        throw error;
      }
    });
    this.captureQueue = operation.catch(() => undefined);
    return operation;
  }
  private async saveAccount(metadata: CaptureMetadata, value: TokenSlots, id: string = randomUUID(), assertCurrent?: () => Promise<void>): Promise<SavedLogin> {
    // Recheck shared recovery ownership after reading native storage. Preserve an
    // incompatible journal verbatim rather than importing or replacing it.
    await this.journal();
    const { label, expectedEmail, identitySource } = metadata;
    const account: LiveAccount = { label, expectedEmail, identitySource, ...this.hostBinding(), id, capturedAt: new Date().toISOString(), quotaDisplayId: randomUUID(), slots: value };
    const key = ACCOUNT_PREFIX + account.id, raw = JSON.stringify(account);
    await assertCurrent?.();
    await this.vault.store(key, raw);
    if (await this.vault.get(key) !== raw) throw new LiveError('SECURE_SAVE_NOT_VERIFIED');
    await assertCurrent?.();
    const { slots: _slots, ...summary } = account; void _slots;
    return summary;
  }
  private async originalSession(lifecycle: Lifecycle, backup: TokenSlots): Promise<{ email: string | null }> {
    validateSlotScope(backup);
    if (backup.keyring === null && backup.file === null) {
      const proof = await lifecycle.signedOutProof?.();
      if (!proof || proof.authValid !== false || proof.generation !== lifecycle.generation) throw new LiveError('ORIGINAL_SESSION_UNVERIFIED');
      return { email: null };
    }
    // A live Hub identity does not establish the credential serialization contract.
    // Validate actual storage before login, stopping the Hub or creating a transaction.
    validateSlots(backup);
    const proof = await lifecycle.proof();
    if (!proof.authValid || !validEmail(proof.email) || proof.generation !== lifecycle.generation || proof.quotaSource !== 'server') throw new LiveError('ORIGINAL_SESSION_UNVERIFIED');
    return { email: proof.email.toLowerCase() };
  }
  async prepareLogin(lifecycle: Lifecycle, transactionId = randomUUID()): Promise<void> {
    await assertCredentialWriteSafe(lifecycle);
    if (await this.hasCompletion()) throw new LiveError('RECOVERY_CLEANUP_PENDING');
    if (await this.journal()) throw new LiveError('RECOVERY_PENDING');
    if (await this.vault.get(ACCOUNT_PREFIX + transactionId)) throw new LiveError('ACCOUNT_ID_COLLISION');
    const backup = await this.slots.read();
    const original = await this.originalSession(lifecycle, backup);
    if (!equalSlots(backup, await this.slots.read(backup))) throw new LiveError('OFFICIAL_STORAGE_CHANGED');
    // First-account add preserves signed-out state. Login is never an implicit switch.
    await this.saveJournal({ schema: 1, id: transactionId, operation: 'login', loginMode: 'save-only', original, phase: 'authorizing', backup, ...this.hostBinding(),
      target: { id: transactionId, label: tr("liveSwitch.f55c4f895a"), expectedEmail: '', capturedAt: new Date().toISOString(), identitySource: 'user', ...this.hostBinding() }, oldGeneration: lifecycle.generation });
  }
  async captureLogin(metadata: CaptureMetadata, expectedTransactionId?: string): Promise<SavedLogin> {
    const journal = await this.journal();
    if (expectedTransactionId !== undefined && journal?.id !== expectedTransactionId) throw new LiveError('RECOVERY_CHANGED');
    if (journal?.operation !== 'login' || journal.phase !== 'authorizing') throw new LiveError('NO_LOGIN_TO_CAPTURE');
    const current = await this.slots.read(journal.backup);
    if (!equalSlots(current, await this.slots.read(journal.backup))) throw new LiveError('OFFICIAL_STORAGE_CHANGED');
    // The official composite store may write one slot only. Never mix its new login with
    // an unchanged old-account fallback. The original slots remain in the recovery journal.
    const fresh: TokenSlots = { ...(current.keyringState ? { keyringState: current.keyringState } : {}), keyring: current.keyring === journal.backup.keyring ? null : current.keyring, file: current.file === journal.backup.file ? null : current.file };
    if (fresh.keyring === null && fresh.file === null) throw new LiveError('LOGIN_TOKEN_NOT_UPDATED');
    validateSlots(fresh); assertSlotIdentity(fresh, metadata.expectedEmail);
    // Reserve the transaction ID for its saved copy, so a crash between vault and
    // ordinary index writes can be recovered without duplicate profiles.
    const saved = await this.saveAccount(metadata, fresh, journal.id, () => this.assertJournalSnapshot(journal));
    journal.target = saved; journal.loginCurrent = current; await this.saveJournal(journal);
    return saved;
  }
  async recoverLogin(index: AccountIndex): Promise<void> {
    const journal = await this.journal();
    if (journal?.operation !== 'login' || journal.loginMode !== 'save-only') return;
    const raw = await this.vault.get(ACCOUNT_PREFIX + journal.id);
    if (raw === undefined) return;
    const { slots: _slots, ...saved } = await this.account(journal.id); void _slots;
    const current = index.read();
    if (current.some(account => account.id === saved.id)) return;
    if (current.length >= 50) throw new LiveError('SAVED_ACCOUNT_LIMIT');
    await index.write([...current, saved]);
    if (!index.read().some(account => account.id === saved.id)) throw new LiveError('LOGIN_INDEX_NOT_VERIFIED');
  }
  async completeLogin(id: string, lifecycle: Lifecycle): Promise<void> {
    await assertCredentialWriteSafe(lifecycle);
    const journal = await this.journal();
    if (journal?.operation !== 'login' || journal.phase !== 'authorizing') throw new LiveError('NO_LOGIN_TO_INSTALL');
    const { slots: _slots, ...saved } = await this.account(id); void _slots;
    if (journal.loginMode !== 'save-only' || id !== journal.id) throw new LiveError('LOGIN_TRANSACTION_MISMATCH');
    journal.target = saved; await this.saveJournal(journal);
    await this.restoreLogin(journal.id, lifecycle);
  }
  /** Automatic save-only restoration is authorized only for this transaction's
   * captured full official slots, or its unchanged original backup. */
  async restoreLogin(transactionId: string, lifecycle: Lifecycle, options: { reload?: boolean } = {}): Promise<void> {
    const journal = await this.journal();
    if (journal?.id !== transactionId || journal.operation !== 'login' || journal.loginMode !== 'save-only') throw new LiveError('RECOVERY_CHANGED');
    await this.restore(lifecycle, { ...options, expectedTransactionId: transactionId, expectedCurrent: journal.loginCurrent ?? journal.backup });
  }
  /** Kept for older callers; adding an account always returns to the original session. */
  async installLogin(id: string, lifecycle: Lifecycle): Promise<void> { await this.completeLogin(id, lifecycle); }
  /** Preserve a returned rotation in encrypted quarantine; this is not an authenticated account. */
  async stageQuotaRefresh(id: string, expected: TokenSlots, next: TokenSlots, previousPending?: TokenSlots): Promise<void> {
    const account = await this.account(id);
    if (!equalSlots(account.slots, expected)) throw new LiveError('ACCOUNT_QUOTA_REFRESH_CONFLICT');
    validateSlots(next); validateSlotScope(next);
    if (expected.keyringState !== next.keyringState || (expected.keyring === null) !== (next.keyring === null) || (expected.file === null) !== (next.file === null)) throw new LiveError('ACCOUNT_QUOTA_REFRESH_CONFLICT');
    const record = JSON.stringify({ schema: 1, accountId: id, expectedEmail: account.expectedEmail, hostId: account.hostId, expected, next });
    const key = QUOTA_PENDING_PREFIX + id, existingRaw = await this.vault.get(key);
    if (existingRaw !== undefined) {
      const existing = await this.pendingQuotaRefresh(id, expected);
      if (existing && equalSlots(existing, next)) {
        await this.vault.delete(QUOTA_UNKNOWN_PREFIX + id);
        if (await this.vault.get(QUOTA_UNKNOWN_PREFIX + id) !== undefined) throw new LiveError('ACCOUNT_QUOTA_REFRESH_SAVE_FAILED');
        return;
      }
      if (!existing || !previousPending || !equalSlots(existing, previousPending)) throw new LiveError('ACCOUNT_QUOTA_REFRESH_CONFLICT');
      if (await this.vault.get(key) !== existingRaw) throw new LiveError('ACCOUNT_QUOTA_REFRESH_CONFLICT');
    }
    await this.vault.store(key, record);
    if (await this.vault.get(key) !== record) throw new LiveError('ACCOUNT_QUOTA_REFRESH_SAVE_FAILED');
    await this.vault.delete(QUOTA_UNKNOWN_PREFIX + id);
    if (await this.vault.get(QUOTA_UNKNOWN_PREFIX + id) !== undefined) throw new LiveError('ACCOUNT_QUOTA_REFRESH_SAVE_FAILED');
  }
  /** Caller must revalidate this candidate with Google before commitQuotaRefresh. */
  async pendingQuotaRefresh(id: string, expected: TokenSlots): Promise<TokenSlots | undefined> {
    const account = await this.account(id), raw = await this.vault.get(QUOTA_PENDING_PREFIX + id);
    if (raw === undefined && await this.vault.get(QUOTA_UNKNOWN_PREFIX + id) !== undefined) throw new LiveError('ACCOUNT_QUOTA_REFRESH_OUTCOME_UNKNOWN');
    if (raw === undefined) return undefined;
    let record: { schema: number; accountId: string; expectedEmail: string; hostId?: string; expected: TokenSlots; next: TokenSlots };
    try {
      record = JSON.parse(raw) as typeof record;
      if (record.schema !== 1 || record.accountId !== id || record.expectedEmail !== account.expectedEmail || record.hostId !== account.hostId) throw 0;
      validateSlots(record.expected); validateSlots(record.next);
      if (record.expected.keyringState !== record.next.keyringState || (record.expected.keyring === null) !== (record.next.keyring === null) || (record.expected.file === null) !== (record.next.file === null)) throw 0;
    } catch { throw new LiveError('ACCOUNT_QUOTA_REFRESH_RECOVERY_INVALID'); }
    if (!equalSlots(record.expected, expected) || !equalSlots(account.slots, expected)) throw new LiveError('ACCOUNT_QUOTA_REFRESH_CONFLICT');
    return record.next;
  }
  /** Complete only a previously identity-verified refresh commit; never touch official slots.
   * Caller must hold the same host operation lock used for saved-account mutations. */
  private async recoverQuotaRefresh(id: string): Promise<void> {
    const key = QUOTA_REFRESH_PREFIX + id, raw = await this.vault.get(key);
    if (raw === undefined) return;
    let saved: { schema: 1; accountId: string; before: string; after: string }, before: LiveAccount, after: LiveAccount;
    try {
      saved = JSON.parse(raw) as typeof saved;
      if (saved.schema !== 1 || saved.accountId !== id || typeof saved.before !== 'string' || typeof saved.after !== 'string') throw 0;
      before = JSON.parse(saved.before) as LiveAccount; after = JSON.parse(saved.after) as LiveAccount;
      const { slots: beforeSlots, ...beforeMetadata } = before, { slots: afterSlots, ...afterMetadata } = after;
      if (before.id !== id || after.id !== id || JSON.stringify(beforeMetadata) !== JSON.stringify(afterMetadata)) throw 0;
      validateSlots(beforeSlots); validateSlots(afterSlots); validateSlotScope(beforeSlots); validateSlotScope(afterSlots);
      if (beforeSlots.keyringState !== afterSlots.keyringState || (beforeSlots.keyring === null) !== (afterSlots.keyring === null) || (beforeSlots.file === null) !== (afterSlots.file === null)) throw 0;
      assertSlotIdentity(afterSlots, before.expectedEmail);
    } catch { throw new LiveError('ACCOUNT_QUOTA_REFRESH_RECOVERY_INVALID'); }
    this.assertHost(before, 'ACCOUNT'); this.assertHost(after, 'ACCOUNT');
    const accountKey = ACCOUNT_PREFIX + id, current = await this.vault.get(accountKey);
    if (current !== saved.before && current !== saved.after) throw new LiveError('ACCOUNT_QUOTA_REFRESH_CONFLICT');
    if (current === saved.before) {
      await this.vault.store(accountKey, saved.after);
      if (await this.vault.get(accountKey) !== saved.after) throw new LiveError('ACCOUNT_QUOTA_REFRESH_SAVE_FAILED');
    }
    await ImportCandidateStore.syncOwner(this.vault, this.hostId, id, before.slots, after.slots);
    await this.vault.delete(QUOTA_UNKNOWN_PREFIX + id);
    if (await this.vault.get(QUOTA_UNKNOWN_PREFIX + id) !== undefined) throw new LiveError('ACCOUNT_QUOTA_REFRESH_SAVE_FAILED');
    await this.vault.delete(QUOTA_PENDING_PREFIX + id);
    if (await this.vault.get(QUOTA_PENDING_PREFIX + id) !== undefined) throw new LiveError('ACCOUNT_QUOTA_REFRESH_SAVE_FAILED');
    await this.vault.delete(key);
    if (await this.vault.get(key) !== undefined) throw new LiveError('ACCOUNT_QUOTA_REFRESH_SAVE_FAILED');
  }
  /** The query engine calls this only after Google validates the new bearer identity. */
  async commitQuotaRefresh(id: string, expected: TokenSlots, next: TokenSlots): Promise<LiveAccount> {
    const account = await this.account(id);
    if (!equalSlots(account.slots, expected)) throw new LiveError('ACCOUNT_QUOTA_REFRESH_CONFLICT');
    validateSlots(next); validateSlotScope(next); assertSlotIdentity(next, account.expectedEmail);
    if (expected.keyringState !== next.keyringState || (expected.keyring === null) !== (next.keyring === null) || (expected.file === null) !== (next.file === null)) throw new LiveError('ACCOUNT_QUOTA_REFRESH_CONFLICT');
    const accountKey = ACCOUNT_PREFIX + id, before = await this.vault.get(accountKey);
    if (before === undefined) throw new LiveError('ACCOUNT_QUOTA_REFRESH_CONFLICT');
    const actual = JSON.parse(before) as LiveAccount;
    if (actual.id !== account.id || actual.expectedEmail !== account.expectedEmail || actual.hostId !== account.hostId || !equalSlots(actual.slots, expected)) throw new LiveError('ACCOUNT_QUOTA_REFRESH_CONFLICT');
    const after = JSON.stringify({ ...actual, slots: next }), key = QUOTA_REFRESH_PREFIX + id;
    const record = JSON.stringify({ schema: 1, accountId: id, before, after });
    await this.vault.store(key, record);
    if (await this.vault.get(key) !== record) throw new LiveError('ACCOUNT_QUOTA_REFRESH_SAVE_FAILED');
    await this.recoverQuotaRefresh(id);
    return { ...actual, slots: next };
  }
  async account(id: string): Promise<LiveAccount> {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new LiveError('ACCOUNT_ID_INVALID');
    await this.recoverQuotaRefresh(id);
    return this.readAccount(id);
  }
  private async readAccount(id: string): Promise<LiveAccount> {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new LiveError('ACCOUNT_ID_INVALID');
    const raw = await this.vault.get(ACCOUNT_PREFIX + id);
    if (!raw) throw new LiveError('SECURE_LOGIN_MISSING');
    let account: LiveAccount;
    try {
      account = JSON.parse(raw) as LiveAccount;
      if (account.id !== id || !account.expectedEmail || !account.slots || account.hostId !== undefined && !validHostId(account.hostId) || account.migrationState !== undefined && !['pending', 'verified'].includes(account.migrationState) || account.verifiedSubject !== undefined && !/^[a-zA-Z0-9_-]{1,255}$/.test(account.verifiedSubject) || account.quotaDisplayId !== undefined && !validQuotaDisplayId(account.quotaDisplayId)) throw 0;
    } catch { throw new LiveError('SECURE_LOGIN_INVALID'); }
    this.assertHost(account, 'ACCOUNT');
    try { validateSlots(account.slots); } catch { throw new LiveError('SECURE_LOGIN_INVALID'); }
    return account;
  }
  private async recoveryRecord(): Promise<{ key: string; journal: Journal } | null> {
    const parse = (raw: string, key: string): { key: string; journal: Journal } => {
      const journal = parseJournal(raw);
      this.assertHost(journal, 'RECOVERY'); this.assertHost(journal.target, 'RECOVERY');
      this.snapshots.set(journal, { key, raw });
      return { key, journal };
    };
    const legacy = await this.recoveryStore.read(JOURNAL_KEY);
    if (this.recoveryKey === JOURNAL_KEY) return legacy ? parse(legacy, JOURNAL_KEY) : null;
    // Never ignore, migrate or overwrite an unbound/other-host legacy backup.
    // A same-host bound legacy transaction may only be completed in its original key.
    const previous = legacy ? parse(legacy, JOURNAL_KEY) : null;
    const current = await this.recoveryStore.read(this.recoveryKey);
    if (previous && current) throw new LiveError('RECOVERY_RECORD_CONFLICT');
    return current ? parse(current, this.recoveryKey) : previous;
  }
  async journal(): Promise<Journal | null> { return (await this.recoveryRecord())?.journal ?? null; }
  /** Explicit recovery choice only: preserve the current verified login without
   * writing credential slots. Archive the original encrypted journal before
   * changing its active verification target. Never delete the archive during
   * ordinary completion. Caller owns the same operation/recovery scope. */
  async retainCurrentLogin(lifecycle: Lifecycle, transactionId: string, guard?: VerificationGuard): Promise<void> {
    if (await this.hasCompletion()) throw new LiveError('RECOVERY_CLEANUP_PENDING');
    const record = await this.recoveryRecord();
    if (!record || record.journal.id !== transactionId || record.journal.operation === 'login') throw new LiveError('RECOVERY_CHANGED');
    const journal = record.journal, snapshot = this.snapshots.get(journal)!;
    await this.assertVerification(journal, guard);
    const before = await this.slots.read(journal.backup);
    const proof = await lifecycle.proof();
    if (!proof.authValid || proof.quotaSource !== 'server' || !validEmail(proof.email) || proof.generation !== lifecycle.generation ||
        proof.generation === journal.oldGeneration || proof.generation === 'stopped') throw new LiveError('HUB_IDENTITY_NOT_VERIFIED');
    validateSlots(before); assertSlotIdentity(before, proof.email);
    if (!equalSlots(before, await this.slots.read(journal.backup))) throw new LiveError('EXTERNAL_CHANGE');
    await this.assertVerification(journal, guard);
    const archiveKey = `${record.key}.retained.${transactionId}`;
    const retained = await this.recoveryStore.read(archiveKey);
    if (retained) {
      const previous = parseJournal(retained);
      this.assertHost(previous, 'RECOVERY');
      if (previous.id !== transactionId) throw new LiveError('RECOVERY_CHANGED');
    } else await this.recoveryStore.write(archiveKey, undefined, snapshot.raw);
    // Even an ambiguous archive write must not erase the active original copy.
    if (await this.recoveryStore.read(archiveKey) !== (retained ?? snapshot.raw)) throw new LiveError('RECOVERY_SAVE_NOT_VERIFIED');
    await this.assertVerification(journal, guard);
    const afterProof = await lifecycle.proof();
    if (!afterProof.authValid || afterProof.quotaSource !== 'server' || afterProof.generation !== proof.generation || afterProof.generation !== lifecycle.generation ||
        afterProof.email.toLowerCase() !== proof.email.toLowerCase() || !equalSlots(before, await this.slots.read(journal.backup))) throw new LiveError('EXTERNAL_CHANGE');
    await this.assertVerification(journal, guard);
    journal.phase = 'restored'; journal.backup = before; journal.original = { email: proof.email };
    journal.restoreGeneration = journal.oldGeneration; journal.verification = { state: 'pending', attempts: 0 };
    await this.saveJournal(journal);
  }
  private async assertJournalSnapshot(journal: Journal): Promise<void> {
    const snapshot = this.snapshots.get(journal), current = await this.recoveryRecord();
    const observed = current && this.snapshots.get(current.journal);
    if (!snapshot || !observed || snapshot.key !== observed.key || snapshot.raw !== observed.raw) throw new LiveError('RECOVERY_CHANGED');
  }
  private async saveJournal(j: Journal): Promise<void> {
    if (await this.hasCompletion()) throw new LiveError('RECOVERY_CLEANUP_PENDING');
    this.assertHost(j, 'RECOVERY'); this.assertHost(j.target, 'RECOVERY');
    const existing = await this.recoveryRecord();
    if (existing && existing.journal.id !== j.id) throw new LiveError('RECOVERY_PENDING');
    const key = existing?.key ?? this.recoveryKey;
    const snapshot = this.snapshots.get(j), previous = existing && this.snapshots.get(existing.journal)!;
    // A delayed callback cannot replace a newer revision, even with the same id,
    // phase, target and verification attempt count. Compare every original byte.
    if (snapshot?.key !== previous?.key || snapshot?.raw !== previous?.raw) throw new LiveError('RECOVERY_CHANGED');
    const revision = (existing?.journal.revision ?? 0) + 1;
    if (!Number.isSafeInteger(revision)) throw new LiveError('RECOVERY_CHANGED');
    j.revision = revision; j.writeId = randomUUID();
    const raw = JSON.stringify(j);
    await this.recoveryStore.write(key, previous?.raw, raw);
    this.snapshots.set(j, { key, raw });
  }
  async install(id: string, lifecycle: Lifecycle, transactionId: string = randomUUID(), stage?: (value: LiveInstallStage) => void): Promise<void> {
    await assertCredentialWriteSafe(lifecycle);
    stage?.('preflight');
    if (await this.hasCompletion()) throw new LiveError('RECOVERY_CLEANUP_PENDING');
    if (await this.journal()) throw new LiveError('RECOVERY_PENDING');
    const target = await this.account(id);
    if (await this.vault.get(QUOTA_UNKNOWN_PREFIX + id)) throw new LiveError('ACCOUNT_QUOTA_REFRESH_OUTCOME_UNKNOWN');
    if (await this.vault.get(QUOTA_PENDING_PREFIX + id)) throw new LiveError('ACCOUNT_QUOTA_REFRESH_PENDING');
    // Resolve the real scope and validate native size before stopping a healthy hub.
    const preflight = await this.slots.read();
    if (target.migrationState !== undefined) {
      const token = portableToken(target.slots, target.expectedEmail);
      target.slots = preflight.keyringState === 'unobserved' ? { keyring: null, file: token, keyringState: 'unobserved' } : migrationTargetSlots(token);
    }
    const { slots: savedSlots, ...summary } = target;
    const targetSlots = targetForScope(savedSlots, preflight);
    const original = await this.originalSession(lifecycle, preflight);
    if (!equalSlots(preflight, await this.slots.read(preflight))) throw new LiveError('OFFICIAL_STORAGE_CHANGED');
    stage?.('stop');
    await lifecycle.stop();
    const backup = await this.slots.read(preflight);
    if (!equalSlots(backup, preflight)) throw new LiveError('OFFICIAL_STORAGE_CHANGED');
    const journal: Journal = { schema: 1, id: transactionId, phase: 'prepared', backup, original, verification: { state: 'pending', attempts: 0 }, target: summary, oldGeneration: lifecycle.generation, ...this.hostBinding() };
    // Encrypted recovery is read back before any official store is modified.
    // SecretStorage exposes no fsync/durable-commit barrier to extensions.
    stage?.('backup');
    await this.saveJournal(journal);
    stage?.('credential-write');
    let writeAttempted = false;
    try { await assertCredentialWriteSafe(lifecycle); writeAttempted = true; await this.slots.write(targetSlots, backup); }
    catch (error) {
      // A changed recovery configuration can revoke admission after the clean
      // stop. If this transaction never dispatched a write and the original is
      // unchanged, recovery needs only restart + fresh verification, not a
      // credential rollback that would require the now-revoked write permission.
      if (!writeAttempted) {
        if (!equalSlots(backup, await this.slots.read(backup))) throw new LiveError('EXTERNAL_CHANGE');
        journal.phase = 'restored'; await this.saveJournal(journal);
        throw error;
      }
      // A killed helper can leave an in-flight operation in the OS keyring service.
      if (error instanceof LiveError && error.code === 'NATIVE_HELPER_TIMEOUT_OR_LIMIT') throw new LiveError('SWITCH_TIMEOUT_RECOVERY_REQUIRED');
      // Do not race a still-running native operation: adapters resolve only on process close.
      // Roll back only values known to belong to this transaction.
      try {
        const current = await this.slots.read(backup);
        if (![backup.keyring, targetSlots.keyring].includes(current.keyring) || ![backup.file, targetSlots.file].includes(current.file)) throw new LiveError('EXTERNAL_CHANGE');
        await assertCredentialWriteSafe(lifecycle);
        await this.slots.write(backup, current);
        if (!equalSlots(backup, await this.slots.read(backup))) throw new LiveError('RECOVERY_RESTORE_NOT_VERIFIED');
        journal.phase = 'restored'; await this.saveJournal(journal);
      } catch { throw new LiveError('SWITCH_FAILED_RECOVERY_REQUIRED'); }
      throw new LiveError('SWITCH_FAILED_STORAGE_RESTORED_RELOAD_REQUIRED');
    }
    stage?.('credential-readback');
    if (!equalSlots(targetSlots, await this.slots.read(backup))) throw new LiveError('SWITCH_INSTALL_NOT_VERIFIED');
    stage?.('journal-installed');
    const prepared = this.snapshots.get(journal)!;
    journal.phase = 'installed';
    try { await this.saveJournal(journal); }
    catch (error) {
      if (error instanceof LiveError && error.code === 'RECOVERY_SAVE_NOT_VERIFIED') {
        this.unconfirmedInstall = { id: transactionId, key: prepared.key, before: prepared.raw, after: JSON.stringify(journal), expected: { ...targetSlots }, scope: { ...backup }, attempted: false };
      }
      throw error;
    }
    stage?.('reconnect');
    await lifecycle.reload();
  }
  /** A timed-out journal acknowledgement must not strand a known installed target.
   * Under the original operation/recovery lock only, start those exact credentials
   * once. Keep the journal and pending state; this is not switch acceptance.
   */
  async resumeUnconfirmedInstall(lifecycle: Lifecycle, id: string, assertCurrent: () => Promise<void>): Promise<boolean> {
    const intent = this.unconfirmedInstall;
    if (!intent || intent.id !== id || intent.attempted) return false;
    if (lifecycle.restartMode !== 'component' || lifecycle.generation !== 'stopped') throw new LiveError('OFFICIAL_BACKEND_NOT_STOPPED');
    const check = async (): Promise<void> => {
      await assertCurrent();
      // Also reject a legacy/foreign record or malformed metadata, not only the
      // scoped key that this write originally used.
      const record = await this.recoveryRecord();
      if (!record || record.key !== intent.key || record.journal.id !== intent.id) throw new LiveError('RECOVERY_CHANGED');
      if (this.unconfirmedInstall !== intent || !await this.recoveryStore.pendingInstallMatches(intent.key, intent.before, intent.after)) throw new LiveError('RECOVERY_CHANGED');
      if (!equalSlots(intent.expected, await this.slots.read(intent.scope))) throw new LiveError('EXTERNAL_CHANGE');
      await assertCurrent();
    };
    await check(); await check();
    intent.attempted = true;
    await lifecycle.reload();
    await assertCurrent();
    if (!await this.recoveryStore.pendingInstallMatches(intent.key, intent.before, intent.after)) throw new LiveError('RECOVERY_CHANGED');
    return true;
  }
  /** Explicit verification may resume a stopped component without rewriting any
   * credential. Exact saved/backup bytes and the same journal must still match;
   * neither a mailbox hint nor a changed refresh credential authorizes a restart.
   * Caller holds the operation lock and supplies the native stopped lifecycle. */
  async resumeStoppedVerification(lifecycle: Lifecycle, guard: VerificationGuard): Promise<void> {
    const journal = await this.journal();
    if (!journal || !['installed', 'restored'].includes(journal.phase)) throw new LiveError('NO_SWITCH_TO_VERIFY');
    if (lifecycle.restartMode !== 'component' || lifecycle.generation !== 'stopped') throw new LiveError('OFFICIAL_BACKEND_NOT_STOPPED');
    const snapshot = JSON.stringify(journal);
    const assertResume = async (): Promise<void> => {
      await this.assertVerification(journal, guard);
      if (JSON.stringify(await this.journal()) !== snapshot) throw new LiveError('RECOVERY_VERIFICATION_STALE');
      guard.assertCurrent();
    };
    await assertResume();
    const expected = journal.phase === 'restored' ? journal.backup : targetForScope((await this.account(journal.target.id)).slots, journal.backup);
    if (!equalSlots(expected, await this.slots.read(journal.backup))) throw new LiveError('EXTERNAL_CHANGE');
    await assertResume();
    if (!equalSlots(expected, await this.slots.read(journal.backup))) throw new LiveError('EXTERNAL_CHANGE');
    await assertResume();
    await lifecycle.reload();
    await assertResume();
  }
  private async assertVerification(journal: Journal, guard?: VerificationGuard): Promise<void> {
    guard?.assertCurrent();
    if (guard && (journal.id !== guard.id || journal.phase !== guard.phase)) throw new LiveError('RECOVERY_VERIFICATION_STALE');
    const current = await this.journal();
    guard?.assertCurrent();
    if (!current || current.id !== journal.id || current.phase !== journal.phase || current.target.id !== journal.target.id) throw new LiveError(guard ? 'RECOVERY_VERIFICATION_STALE' : 'RECOVERY_CHANGED');
    const identity = (value: Journal): string => JSON.stringify([value.backup, value.target, value.oldGeneration, value.hostId, value.operation, value.loginMode, value.restoreGeneration]);
    if (identity(current) !== identity(journal) || journal.original !== undefined && JSON.stringify(current.original) !== JSON.stringify(journal.original) ||
        (current.revision ?? 0) < (journal.revision ?? 0) || current.revision === journal.revision && current.writeId !== journal.writeId) throw new LiveError(guard ? 'RECOVERY_VERIFICATION_STALE' : 'RECOVERY_CHANGED');
  }
  private async verifySession(journal: Journal, lifecycle: Lifecycle, expected: TokenSlots, email: string | null | undefined, previousGeneration: string, guard?: VerificationGuard): Promise<HubProof | null> {
    await this.assertVerification(journal, guard);
    const attempt: VerificationState = { state: 'pending', attempts: (journal.verification?.attempts ?? 0) + 1 };
    journal.verification = attempt; await this.saveJournal(journal);
    try {
      if (lifecycle.generation === previousGeneration || lifecycle.generation === 'stopped') throw new LiveError('HUB_IDENTITY_NOT_VERIFIED');
      const before = await this.slots.read(expected);
      await this.assertVerification(journal, guard);
      if (!sameStorageIdentity(expected, before)) throw new LiveError('VERIFICATION_STORAGE_MISMATCH');
      let result: HubProof | null;
      if (email === null) {
        const proof = await lifecycle.signedOutProof?.();
        if (!proof || proof.authValid !== false || proof.generation !== lifecycle.generation) throw new LiveError('HUB_SIGNED_OUT_NOT_VERIFIED');
        result = null;
      } else {
        const proof = await lifecycle.proof();
        if (!proof.authValid || !validEmail(proof.email) || proof.generation !== lifecycle.generation || proof.generation === previousGeneration || email !== undefined && proof.email.toLowerCase() !== email.toLowerCase() || proof.quotaSource !== 'server') throw new LiveError('HUB_IDENTITY_NOT_VERIFIED');
        // Stored/JWT hints cannot establish identity, but contradictions still block
        // completion, especially for legacy backups without a captured original email.
        validateSlots(before); assertSlotIdentity(before, proof.email);
        result = proof;
      }
      // Read both sides of live proof. Hints only reject contradictions, never establish auth.
      await this.assertVerification(journal, guard);
      const after = await this.slots.read(expected);
      if (!sameStorageIdentity(expected, after) || !sameStorageIdentity(before, after)) throw new LiveError('VERIFICATION_STORAGE_MISMATCH');
      if (result) { validateSlots(after); assertSlotIdentity(after, result.email); }
      await this.assertVerification(journal, guard);
      journal.verification = { ...attempt, state: 'verified', checkedAt: new Date().toISOString() }; await this.saveJournal(journal);
      return result;
    } catch (error) {
      await this.assertVerification(journal, guard);
      const code = error instanceof LiveError && VERIFICATION_ERRORS.has(error.code) ? error.code : 'VERIFICATION_RETRY_REQUIRED';
      journal.verification = { ...attempt, state: 'retry', checkedAt: new Date().toISOString(), code }; await this.saveJournal(journal);
      if (error instanceof ComponentRestoreFailure) throw error;
      throw new LiveError(code);
    }
  }
  async verify(lifecycle: Lifecycle, guard?: VerificationGuard): Promise<HubProof> {
    const j = await this.journal(); if (!j || j.phase !== 'installed') throw new LiveError('NO_SWITCH_TO_VERIFY');
    await this.assertVerification(j, guard);
    const account = await this.account(j.target.id);
    const expected = targetForScope(account.slots, j.backup);
    return (await this.verifySession(j, lifecycle, expected, j.target.expectedEmail, j.oldGeneration, guard))!;
  }
  async verifyRestored(lifecycle: Lifecycle, guard?: VerificationGuard): Promise<HubProof | null> {
    const j = await this.journal(); if (!j || j.phase !== 'restored') throw new LiveError('NO_RESTORATION_TO_VERIFY');
    const expectedEmail = j.original ? j.original.email : j.backup.keyring === null && j.backup.file === null ? null : undefined;
    // Legacy recovery has no trustworthy original mailbox. Only a fresh process
    // authenticated from matching backed-up storage can supply one, never a JWT,
    // cached panel label or user confirmation. Mixed/unsupported old slots fail closed.
    const proof = await this.verifySession(j, lifecycle, j.backup, expectedEmail, j.restoreGeneration ?? j.oldGeneration, guard);
    if (!j.original) { await this.assertVerification(j, guard); j.original = { email: proof?.email.toLowerCase() ?? null }; await this.saveJournal(j); }
    return proof;
  }
  private async refreshVerifiedTarget(journal: Journal, proof: HubProof, guard?: VerificationGuard): Promise<void> {
    await this.assertVerification(journal, guard);
    const target = await this.account(journal.target.id);
    const expected = targetForScope(target.slots, journal.backup);
    const current = await this.slots.read(expected);
    validateSlots(current); assertSlotIdentity(current, proof.email);
    if (!sameStorageIdentity(expected, current)) throw new LiveError('VERIFICATION_STORAGE_MISMATCH');
    if (!equalSlots(current, await this.slots.read(expected))) throw new LiveError('OFFICIAL_STORAGE_CHANGED');
    // A restarted official backend may renew only its access token. Retain that exact,
    // identity-verified native envelope for independent reads of this saved account.
    // A changed refresh token remains unproven and was rejected above.
    const raw = JSON.stringify({ ...target, slots: current }), key = ACCOUNT_PREFIX + target.id;
    await this.assertVerification(journal, guard);
    await this.vault.store(key, raw);
    if (await this.vault.get(key) !== raw) throw new LiveError('SECURE_SAVE_NOT_VERIFIED');
    if (!sameStorageIdentity(current, await this.slots.read(expected))) throw new LiveError('VERIFICATION_STORAGE_MISMATCH');
  }
  private resultKey(id: string): string {
    if (typeof id !== 'string' || !id || id.length > 256) throw new LiveError('RECOVERY_RECORD_INVALID');
    return `${this.recoveryKey}.account-result.${createHash('sha256').update(id).digest('hex')}`;
  }
  private get resultPointerKey(): string { return `${this.recoveryKey}.account-result.latest`; }
  private async resultRecord(id: string): Promise<{ raw: string; value: AccountResultRecord } | null> {
    const key=this.resultKey(id);await this.recoveryStore.settle(key);const raw=await this.recoveryStore.read(key);if(raw===undefined)return null;
    try {
      const value=JSON.parse(raw) as AccountResultRecord, a=value.summary;
      if(!value || Object.keys(value).some(k=>!['summary','journalRaw','expected','expectedEmail'].includes(k)) || !a || Object.keys(a).some(k=>!['schema','id','targetId','hostId','verifiedAt','committedAt','account','components'].includes(k)) ||
        a.schema!==1 || a.id!==id || typeof a.targetId!=='string' || !a.targetId || !Number.isFinite(Date.parse(a.verifiedAt)) || !['verified','committed'].includes(a.account) || !['pending','complete'].includes(a.components) ||
        (a.account==='committed')!==(typeof a.committedAt==='string') || a.committedAt!==undefined&&!Number.isFinite(Date.parse(a.committedAt)) || a.components==='complete'&&a.account!=='committed' || !validEmail(value.expectedEmail))throw 0;
      this.assertHost(a,'RECOVERY');const j=parseJournal(value.journalRaw);this.assertHost(j,'RECOVERY');
      if(j.id!==id || j.target.id!==a.targetId || j.phase!=='installed' || j.operation!==undefined || j.verification?.state!=='verified')throw 0;
      validateSlots(value.expected);validateSlotScope(value.expected);assertSlotIdentity(value.expected,value.expectedEmail);
      if(j.backup.keyringState!==value.expected.keyringState || j.target.expectedEmail.toLowerCase()!==value.expectedEmail.toLowerCase())throw 0;
      return {raw,value};
    } catch {throw new LiveError('RECOVERY_RECORD_INVALID');}
  }
  async accountResult(transactionId?: string): Promise<AccountResult | null> {
    if(transactionId!==undefined)return structuredClone((await this.resultRecord(transactionId))?.value.summary??null);
    await this.recoveryStore.settle(this.resultPointerKey);const raw=await this.recoveryStore.read(this.resultPointerKey);if(raw===undefined)return null;
    let id:string;try{const p=JSON.parse(raw);if(Object.keys(p).length!==1||typeof p.id!=='string')throw 0;id=p.id;}catch{throw new LiveError('RECOVERY_RECORD_INVALID');}
    const result=await this.resultRecord(id);if(!result)throw new LiveError('RECOVERY_RECORD_INVALID');return structuredClone(result.value.summary);
  }
  private async recordAccountVerified(journal: Journal, proof: HubProof): Promise<void> {
    const snapshot=this.snapshots.get(journal);if(!snapshot)throw new LiveError('RECOVERY_CHANGED');
    const expected=await this.slots.read(journal.backup);validateSlots(expected);assertSlotIdentity(expected,proof.email);
    const target=targetForScope((await this.account(journal.target.id)).slots,journal.backup);
    if(!sameStorageIdentity(target,expected))throw new LiveError('VERIFICATION_STORAGE_MISMATCH');
    await this.assertVerification(journal);
    const existing=await this.resultRecord(journal.id);
    if(existing){
      const old=parseJournal(existing.value.journalRaw);
      if(existing.value.summary.targetId!==journal.target.id || existing.value.expectedEmail.toLowerCase()!==proof.email.toLowerCase() || !sameStorageIdentity(existing.value.expected,expected) || JSON.stringify(old.backup)!==JSON.stringify(journal.backup))throw new LiveError('RECOVERY_CHANGED');
      // A fresh retry can update the exact verified journal receipt, never its original backup.
      if(existing.value.summary.account==='committed')throw new LiveError('RECOVERY_CHANGED');
      await this.recoveryStore.write(this.resultKey(journal.id),existing.raw,JSON.stringify({...existing.value,journalRaw:snapshot.raw,expected}));
    }else{
      const value:AccountResultRecord={summary:{schema:1,id:journal.id,targetId:journal.target.id,...this.hostBinding(),verifiedAt:new Date().toISOString(),account:'verified',components:'pending'},journalRaw:snapshot.raw,expected,expectedEmail:proof.email.toLowerCase()};
      await this.recoveryStore.write(this.resultKey(journal.id),undefined,JSON.stringify(value));
    }
    const before=await this.recoveryStore.read(this.resultPointerKey);await this.recoveryStore.write(this.resultPointerKey,before,JSON.stringify({id:journal.id}));
  }
  private async commitAccountResult(id:string, journalHash:string):Promise<void>{
    const record=await this.resultRecord(id);if(!record || createHash('sha256').update(record.value.journalRaw).digest('hex')!==journalHash)throw new LiveError('RECOVERY_CHANGED');
    if(record.value.summary.account==='committed')return;
    await this.recoveryStore.write(this.resultKey(id),record.raw,JSON.stringify({...record.value,summary:{...record.value.summary,account:'committed',committedAt:new Date().toISOString()}}));
  }
  async markComponentsComplete(id:string):Promise<void>{
    const record=await this.resultRecord(id);if(!record||record.value.summary.account!=='committed')throw new LiveError('RECOVERY_CHANGED');
    const active=await this.journal();if(active&&active.id!==id)throw new LiveError('RECOVERY_PENDING');
    if(record.value.summary.components==='complete')return;
    await this.recoveryStore.write(this.resultKey(id),record.raw,JSON.stringify({...record.value,summary:{...record.value.summary,components:'complete'}}));
  }
  /** No-write recovery: exact archived storage identity + NEW authenticated RPC.
   * No absence inference, component restart, rollback or credential mutation. */
  async verifyCommitted(lifecycle:Lifecycle,id:string):Promise<HubProof>{
    const record=await this.resultRecord(id);if(!record||record.value.summary.account!=='committed')throw new LiveError('NO_RECOVERY_BACKUP');
    const check=async():Promise<void>=>{const active=await this.journal();if(active&&active.id!==id)throw new LiveError('RECOVERY_PENDING');if((await this.resultRecord(id))?.raw!==record.raw)throw new LiveError('RECOVERY_CHANGED');};
    await check();const before=await this.slots.read(record.value.expected);
    if(!sameStorageIdentity(record.value.expected,before))throw new LiveError('VERIFICATION_STORAGE_MISMATCH');
    const proof=await lifecycle.proof();
    if(!proof.authValid||proof.quotaSource!=='server'||!validEmail(proof.email)||proof.email.toLowerCase()!==record.value.expectedEmail||proof.generation!==lifecycle.generation)throw new LiveError('HUB_IDENTITY_NOT_VERIFIED');
    validateSlots(before);assertSlotIdentity(before,proof.email);await check();const after=await this.slots.read(record.value.expected);
    if(!sameStorageIdentity(before,after)||!sameStorageIdentity(record.value.expected,after))throw new LiveError('VERIFICATION_STORAGE_MISMATCH');
    validateSlots(after);assertSlotIdentity(after,proof.email);await check();return proof;
  }
  private get completionKey(): string { return `${this.recoveryKey}.completion`; }
  private async completion(): Promise<{ raw: string; value: Completion } | null> {
    await this.recoveryStore.settle(this.completionKey);
    const raw = await this.recoveryStore.read(this.completionKey);
    if (raw === undefined) return null;
    return { raw, value: this.parseCompletion(raw) };
  }
  private parseCompletion(raw: string): Completion {
    let value: Completion;
    try {
      value = JSON.parse(raw) as Completion;
      if (value.schema !== 1 || typeof value.id !== 'string' || !value.id ||
          ![JOURNAL_KEY, this.recoveryKey].includes(value.key) || !/^[a-f0-9]{64}$/.test(value.hash) ||
          value.accountResult !== undefined && value.accountResult !== true || typeof value.marker !== 'string' || !value.marker || typeof value.deleted !== 'boolean') throw 0;
      const marker = JSON.parse(value.marker);
      if (marker?.owner?.schema !== 3 || marker.owner.id !== value.id || JSON.stringify(JSON.parse(marker.raw)) !== JSON.stringify(marker.owner) ||
          marker.owner.completion !== JSON.stringify({ id: value.id, ...this.hostBinding(), key: value.key, hash: value.hash, ...(value.accountResult ? { accountResult: true } : {}) })) throw 0;
    } catch { throw new LiveError('RECOVERY_RECORD_INVALID'); }
    this.assertHost(value, 'RECOVERY');
    return value;
  }
  async hasCompletion(): Promise<boolean> { return !!this.recoveryStore.pending(this.completionKey) || !!await this.completion(); }
  /** Mutex held throughout. No Hub call, credential write, or UI lease is involved.
   * The receipt commits verification, index promotion and the exact marker/journal.
   * It survives deletion ambiguity, disposal, lock cleanup failures and host restart. */
  async resumeCompletion(finalizer: RecoveryFinalizer): Promise<boolean> {
    const pending = this.recoveryStore.pending(this.completionKey);
    if (pending) {
      const value = this.parseCompletion(pending.after ?? pending.before!);
      const marker = await finalizer.identity(value.id);
      if (marker !== value.marker && !(marker === null && value.deleted)) throw new LiveError('RECOVERY_LOCK_OWNER_MISMATCH');
      await this.recoveryStore.retryFencedPending(this.completionKey);
    }
    let receipt = await this.completion();
    if (!receipt) {
      const marker = await finalizer.pending();
      if (!marker) return false;
      let binding: Pick<Completion, 'id' | 'hostId' | 'key' | 'hash' | 'accountResult'>;
      try {
        const snapshot = JSON.parse(marker);
        binding = JSON.parse(snapshot.owner.completion);
        if (snapshot.owner.schema !== 3 || snapshot.owner.id !== binding.id ||
            JSON.stringify(JSON.parse(snapshot.raw)) !== JSON.stringify(snapshot.owner) ||
            typeof binding.id !== 'string' || !binding.id || ![JOURNAL_KEY, this.recoveryKey].includes(binding.key) ||
            !/^[a-f0-9]{64}$/.test(binding.hash) || binding.accountResult !== undefined && binding.accountResult !== true) throw 0;
      }
      catch { throw new LiveError('RECOVERY_RECORD_INVALID'); }
      this.assertHost(binding, 'RECOVERY');
      const raw = JSON.stringify({ schema: 1, ...binding, marker, deleted: false });
      await this.recoveryStore.write(this.completionKey, undefined, raw);
      receipt = await this.completion();
      if (!receipt) throw new LiveError('RECOVERY_SAVE_NOT_VERIFIED');
    }
    const { value } = receipt;
    const record = await this.recoveryRecord();
    if (record) {
      const snapshot = this.snapshots.get(record.journal)!;
      if (record.journal.id !== value.id || snapshot.key !== value.key ||
          createHash('sha256').update(snapshot.raw).digest('hex') !== value.hash) throw new LiveError('RECOVERY_CHANGED');
    }
    const marker = await finalizer.identity(value.id);
    if (marker !== value.marker && !(marker === null && value.deleted)) throw new LiveError('RECOVERY_LOCK_OWNER_MISMATCH');
    let raw = receipt.raw;
    if (!value.deleted) {
      // The schema-3 marker fences old clients, including between process restarts.
      // Even a fresh process's stale absent read must cause an explicit deletion,
      // not be treated as evidence that the original journal has been removed.
      if (!record && value.key === JOURNAL_KEY && this.recoveryKey !== JOURNAL_KEY) throw new LiveError('RECOVERY_CHANGED');
      await this.recoveryStore.removeFenced(value.key, record ? this.snapshots.get(record.journal)!.raw : undefined);
      raw = JSON.stringify({ ...value, deleted: true });
      await this.recoveryStore.write(this.completionKey, receipt.raw, raw);
    }
    if(value.accountResult && this.recoveryStore.pending(this.resultKey(value.id)))await this.recoveryStore.retryFencedPending(this.resultKey(value.id));
    if(value.accountResult){const outcome=await this.resultRecord(value.id);if(!outcome||createHash('sha256').update(outcome.value.journalRaw).digest('hex')!==value.hash)throw new LiveError('RECOVERY_CHANGED');}
    await finalizer.clear(value.id, value.marker);
    if(value.accountResult)await this.commitAccountResult(value.id,value.hash);
    await this.recoveryStore.remove(this.completionKey, raw);
    return true;
  }
  /** Caller holds the same-host operation lock across verification, index promotion and cleanup. */
  async finishVerified(lifecycle: Lifecycle, index?: AccountIndex, guard?: VerificationGuard, finalizer?: RecoveryFinalizer): Promise<HubProof | null> {
    if (await this.hasCompletion()) throw new LiveError('RECOVERY_CLEANUP_PENDING');
    const journal = await this.journal(); if (!journal) throw new LiveError('NO_RECOVERY_BACKUP');
    await this.assertVerification(journal, guard);
    const proof = journal.phase === 'restored' ? await this.verifyRestored(lifecycle, guard) : await this.verify(lifecycle, guard);
    let committing = false;
    try {
      if (journal.phase === 'installed') {
        await this.refreshVerifiedTarget(journal, proof!, guard);
        if (index) await this.markImportedAfterVerification(index, guard);
      }
      const current = await this.journal();
      if (!current || current.id !== journal.id || current.phase !== journal.phase || current.verification?.state !== 'verified') throw new LiveError('RECOVERY_CHANGED');
      await this.assertVerification(journal, guard);
      const accountResult=current.phase==='installed'&&current.operation===undefined;
      if(accountResult)await this.recordAccountVerified(current,proof!);
      if (finalizer) {
        const snapshot = this.snapshots.get(current)!;
        const binding = { id: current.id, ...this.hostBinding(), key: snapshot.key,
          hash: createHash('sha256').update(snapshot.raw).digest('hex'), ...(accountResult ? {accountResult:true as const}: {}) };
        committing = true;
        const marker = await finalizer.prepare(current.id, JSON.stringify(binding));
        const receipt: Completion = { schema: 1, ...binding, marker, deleted: false };
        // From this point the durable receipt owns cleanup, even if the UI closes.
        // Do not rewrite the journal on an ambiguous receipt store rejection.
        committing = true;
        await this.recoveryStore.write(this.completionKey, undefined, JSON.stringify(receipt));
        await this.resumeCompletion(finalizer);
      } else {
        const hash=createHash('sha256').update(this.snapshots.get(current)!.raw).digest('hex');
        await this.finish(guard,current);committing=true;
        if(accountResult)await this.commitAccountResult(current.id,hash);
      }
      return proof;
    } catch (error) {
      if (committing) throw new LiveError('RECOVERY_CLEANUP_PENDING');
      await this.assertVerification(journal, guard);
      const code = error instanceof LiveError && VERIFICATION_ERRORS.has(error.code) ? error.code : 'VERIFICATION_RETRY_REQUIRED';
      const pending = await this.journal();
      if (pending?.id === journal.id) {
        pending.verification = { state: 'retry', attempts: pending.verification?.attempts ?? 1, checkedAt: new Date().toISOString(), code };
        await this.saveJournal(pending);
      }
      if (error instanceof ComponentRestoreFailure) throw error;
      throw new LiveError(code);
    }
  }
  async markImportedVerified(lifecycle: Lifecycle, index: AccountIndex): Promise<void> {
    await this.verify(lifecycle);
    await this.markImportedAfterVerification(index);
  }
  private async markImportedAfterVerification(index: AccountIndex, guard?: VerificationGuard): Promise<void> {
    const journal = await this.journal();
    if (!journal) throw new LiveError('NO_SWITCH_TO_VERIFY');
    await this.assertVerification(journal, guard);
    const account = await this.account(journal.target.id);
    if (account.migrationState === undefined) return;
    const current = index.read();
    if (!current.some(item => item.id === account.id)) throw new LiveError('MIGRATION_INDEX_CHANGED');
    const verified: LiveAccount = { ...account, migrationState: 'verified', identitySource: 'hub' };
    const { slots: _slots, ...summary } = verified; void _slots;
    const key = ACCOUNT_PREFIX + account.id, raw = JSON.stringify(verified);
    await this.assertVerification(journal, guard);
    await this.vault.store(key, raw);
    if (await this.vault.get(key) !== raw) throw new LiveError('SECURE_SAVE_NOT_VERIFIED');
    // A failed metadata update leaves the switch journal intact for retry/recovery. No
    // mark is ever produced from an imported JWT, archive label or quota snapshot.
    await this.assertVerification(journal, guard);
    await index.write(current.map(item => item.id === account.id ? summary : item));
    if (!index.read().some(item => item.id === account.id && item.migrationState === 'verified' && item.identitySource === 'hub')) throw new LiveError('MIGRATION_INDEX_CHANGED');
  }
  async restore(lifecycle: Lifecycle, options: { reload?: boolean; guardInstalled?: boolean; expectedTransactionId?: string; expectedCurrent?: TokenSlots } = {}): Promise<void> {
    await assertCredentialWriteSafe(lifecycle);
    if (await this.hasCompletion()) throw new LiveError('RECOVERY_CLEANUP_PENDING');
    const j = await this.journal(); if (!j) throw new LiveError('NO_RECOVERY_BACKUP');
    if (options.expectedTransactionId !== undefined && j.id !== options.expectedTransactionId) throw new LiveError('RECOVERY_CHANGED');
    if (options.expectedCurrent && !equalSlots(options.expectedCurrent, await this.slots.read(j.backup))) throw new LiveError('EXTERNAL_CHANGE');
    let expectedCurrent: TokenSlots | undefined;
    if (options.guardInstalled) {
      if (j.phase !== 'installed' || j.operation === 'login') throw new LiveError('RECOVERY_RECORD_INVALID');
      const current = await this.slots.read(j.backup);
      const target = await this.account(j.target.id);
      const targetSlots = targetForScope(target.slots, current);
      if (!equalSlots(current, targetSlots) && !equalSlots(current, j.backup)) throw new LiveError('EXTERNAL_CHANGE');
      expectedCurrent = current;
    }
    // A file-only journal never touched the keyring. Stop first so lost startup
    // logs or a different post-reload route cannot prevent safe file restoration.
    // Full native backups retain availability preflight and cannot be downgraded.
    if (j.backup.keyringState !== 'unobserved') await this.slots.read(j.backup);
    j.phase = 'prepared'; j.restoreGeneration = lifecycle.generation; j.verification = { state: 'pending', attempts: 0 };
    await this.saveJournal(j);
    if (options.expectedCurrent && !equalSlots(options.expectedCurrent, await this.slots.read(j.backup))) throw new LiveError('EXTERNAL_CHANGE');
    await this.assertJournalSnapshot(j);
    await lifecycle.stop();
    const current = await this.slots.read(j.backup);
    if (options.expectedCurrent && !equalSlots(options.expectedCurrent, current)) throw new LiveError('EXTERNAL_CHANGE');
    if (expectedCurrent && !equalSlots(current, expectedCurrent)) throw new LiveError('EXTERNAL_CHANGE');
    await this.assertJournalSnapshot(j);
    await assertCredentialWriteSafe(lifecycle);
    await this.slots.write(j.backup, current);
    // Do not report a completed recovery until its original scope is read back.
    // Unobserved keyrings remain unobserved, never interpreted as empty.
    if (!equalSlots(j.backup, await this.slots.read(j.backup))) throw new LiveError('RECOVERY_RESTORE_NOT_VERIFIED');
    j.phase = 'restored'; await this.saveJournal(j);
    // Cancellation can stop callbacks and restore safely without surprising the user
    // with a reload. The durable journal is retained until live verification succeeds.
    if (options.reload !== false) { await this.assertJournalSnapshot(j); await lifecycle.reload(); }
  }
  async finish(guard?: VerificationGuard, expected?: Journal): Promise<void> {
    // Low-level cleanup for trusted callers. UI must use finishVerified, which obtains
    // fresh live evidence before deleting the only recovery copy.
    // An unbound or other-host backup must never be silently discarded here.
    const record = await this.recoveryRecord();
    if (!record) return;
    guard?.assertCurrent();
    if (guard && (record.journal.id !== guard.id || record.journal.phase !== guard.phase)) throw new LiveError('RECOVERY_VERIFICATION_STALE');
    if (expected && JSON.stringify(record.journal) !== JSON.stringify(expected)) throw new LiveError('RECOVERY_CHANGED');
    await this.recoveryStore.remove(record.key, this.snapshots.get(record.journal)!.raw);
    if (this.unconfirmedInstall?.id === record.journal.id) this.unconfirmedInstall = undefined;
  }
}

export interface AccountImportOptions {
  replace?: Record<string, string>;
  signal?: AbortSignal;
  provider?: ConsumerRefreshProvider;
  query?: (account: LiveAccount, signal?: AbortSignal, options?: SavedAccountQuotaOptions) => Promise<ImportedAccountQuota>;
  phase?: SavedAccountQuotaOptions['phase'];
  quota?: (account: SavedLogin, result: ImportedAccountQuota) => void;
  assertCurrent?: () => Promise<void>;
}
