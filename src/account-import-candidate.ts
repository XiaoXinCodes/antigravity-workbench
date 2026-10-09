import { createHash } from 'node:crypto';
import { LiveError, equalSlots, validateSlots, assertSlotIdentity, tokenAccountHint, type TokenSlots } from './live-storage';
import { refreshedSlots, rebaseRefreshedSlots } from './account-quota';
import type { LiveAccount, SecretVault } from './live-switch';

export const IMPORT_CANDIDATE_PREFIX = 'live-switch.import-candidate.v1.';
interface Candidate { schema: 1; source: string; account: LiveAccount; next?: TokenSlots; exchanging?: boolean; response?: unknown; receivedAt?: number }
// A failed write can already have committed. Keep returned rotations in memory until
// readback succeeds; a durable pre-exchange marker blocks reuse after a crash.
interface CandidateManifest { schema: 1; hostId?: string; sources: Record<string, string[]> }
const retained = new WeakMap<SecretVault, Map<string, Candidate>>();
export class ImportCandidateStore {
  private current?: Candidate;
  private readonly key: string;
  private readonly source: string;
  constructor(private readonly vault: SecretVault, private readonly initial: LiveAccount, sourceToken: string, private readonly targetId?: string) {
    this.source = createHash('sha256').update(JSON.stringify([initial.hostId, initial.expectedEmail, sourceToken])).digest('hex');
    this.key = IMPORT_CANDIDATE_PREFIX + this.source;
    // A candidate's preallocated ID survives a crash between manifest and secret
    // writes. Failed new imports cannot leave phantom owners of a later rotation.
    if (targetId === undefined) {
      const hex = this.source.slice(0, 32).split(''); hex[12] = '4'; hex[16] = '8';
      const id = hex.join(''); this.initial = { ...initial, id: `${id.slice(0,8)}-${id.slice(8,12)}-${id.slice(12,16)}-${id.slice(16,20)}-${id.slice(20)}` };
    }
  }
  private async load(): Promise<Candidate> {
    const memory = retained.get(this.vault)?.get(this.key);
    if (memory) { await this.register(memory.account.id); await this.save(memory); return structuredClone(memory); }
    const raw = await this.vault.get(this.key);
    if (raw === undefined) { const value: Candidate = { schema: 1, source: this.source, account: this.initial }; await this.register(value.account.id); await this.save(value); return value; }
    let parsed: Candidate;
    try {
      if (Buffer.byteLength(raw) > 2 * 1024 * 1024) throw 0;
      const value = JSON.parse(raw) as Candidate;
      if (value.schema !== 1 || value.source !== this.source || value.account.hostId !== this.initial.hostId || value.account.expectedEmail !== this.initial.expectedEmail || value.account.identitySource !== 'user' || typeof value.account.label !== 'string' || value.account.label.length > 80 || !Number.isFinite(Date.parse(value.account.capturedAt)) || Object.keys(value.account).some(key => !['id', 'label', 'expectedEmail', 'capturedAt', 'identitySource', 'hostId', 'slots'].includes(key)) || !/^[a-f0-9-]{36}$/.test(value.account.id) || value.exchanging !== undefined && typeof value.exchanging !== 'boolean' || Object.keys(value).some(key => !['schema', 'source', 'account', 'next', 'exchanging', 'response', 'receivedAt'].includes(key))) throw 0;
      validateSlots(value.account.slots); assertSlotIdentity(value.account.slots, this.initial.expectedEmail);
      if (value.next) validateSlots(value.next);
      if (value.response !== undefined && (!Number.isSafeInteger(value.receivedAt) || Buffer.byteLength(JSON.stringify(value.response)) > 256 * 1024)) throw 0;
      this.current = structuredClone(value);
      parsed = value;
    } catch { throw new LiveError('MIGRATION_RECOVERY_INVALID'); }
    await this.register(parsed.account.id); return parsed;
  }
  private static manifestKey(hostId?: string): string { return IMPORT_CANDIDATE_PREFIX + 'host.' + createHash('sha256').update(JSON.stringify(hostId ?? null)).digest('hex'); }
  private static async manifest(vault: SecretVault, hostId?: string): Promise<CandidateManifest> {
    const raw = await vault.get(this.manifestKey(hostId));
    if (raw === undefined) return { schema: 1, ...(hostId === undefined ? {} : { hostId }), sources: {} };
    try {
      if (Buffer.byteLength(raw) > 1024 * 1024) throw 0;
      const value = JSON.parse(raw) as CandidateManifest;
      if (value.schema !== 1 || value.hostId !== hostId || !value.sources || Array.isArray(value.sources) || Object.keys(value).some(key => !['schema', 'hostId', 'sources'].includes(key))) throw 0;
      for (const [source, owners] of Object.entries(value.sources)) if (!/^[a-f0-9]{64}$/.test(source) || !Array.isArray(owners) || !owners.length || owners.length > 50 || new Set(owners).size !== owners.length || owners.some(id => !/^[a-f0-9-]{36}$/.test(id))) throw 0;
      return value;
    } catch { throw new LiveError('MIGRATION_RECOVERY_INVALID'); }
  }
  private static async saveManifest(vault: SecretVault, value: CandidateManifest): Promise<void> {
    const key = this.manifestKey(value.hostId), raw = JSON.stringify(value);
    if (Buffer.byteLength(raw) > 1024 * 1024) throw new LiveError('SAVED_ACCOUNT_LIMIT');
    if (Object.keys(value.sources).length) { await vault.store(key, raw); if (await vault.get(key) !== raw) throw new LiveError('ACCOUNT_QUOTA_SECURE_SAVE_FAILED'); }
    else { await vault.delete(key); if (await vault.get(key) !== undefined) throw new LiveError('ACCOUNT_QUOTA_SECURE_SAVE_FAILED'); }
  }
  private async register(candidateId: string): Promise<void> {
    const value = await ImportCandidateStore.manifest(this.vault, this.initial.hostId), owner = this.targetId ?? candidateId;
    if (value.sources[this.source]?.includes(owner)) return;
    value.sources[this.source] = [...(value.sources[this.source] ?? []), owner];
    await ImportCandidateStore.saveManifest(this.vault, value);
  }
  /** Called under the same host operation lock before removing a saved copy.
   * Keep a rotation shared by another explicitly selected saved copy. */
  static async removeOwner(vault: SecretVault, hostId: string | undefined, id: string): Promise<void> {
    const value = await this.manifest(vault, hostId);
    for (const [source, owners] of Object.entries(value.sources)) {
      if (!owners.includes(id)) continue;
      const remaining = owners.filter(owner => owner !== id);
      if (remaining.length) value.sources[source] = remaining;
      else { const key = IMPORT_CANDIDATE_PREFIX + source; await vault.delete(key); if (await vault.get(key) !== undefined) throw new LiveError('ACCOUNT_QUOTA_SECURE_SAVE_FAILED'); retained.get(vault)?.delete(key); delete value.sources[source]; }
    }
    await this.saveManifest(vault, value);
  }
  /** Follow later identity-verified quota rotations while their recovery journal
   * still owns the latest token. In-flight import quarantine stays with its hooks. */
  static async syncOwner(vault: SecretVault, hostId: string | undefined, id: string, expected: TokenSlots, next: TokenSlots): Promise<void> {
    const manifest = await this.manifest(vault, hostId), oldGrant = tokenAccountHint(expected.keyring ?? expected.file!).refresh;
    for (const [source, owners] of Object.entries(manifest.sources)) {
      if (!owners.includes(id)) continue;
      const key = IMPORT_CANDIDATE_PREFIX + source, raw = await vault.get(key);
      if (raw === undefined) continue; // An interrupted transient cleanup may leave a reference.
      let value: Candidate;
      try {
        if (Buffer.byteLength(raw) > 2 * 1024 * 1024) throw 0;
        value = JSON.parse(raw) as Candidate;
        if (value.schema !== 1 || value.source !== source || value.account.hostId !== hostId) throw 0;
        validateSlots(value.account.slots);
      } catch { throw new LiveError('MIGRATION_RECOVERY_INVALID'); }
      if (value.next || value.response !== undefined || value.exchanging || tokenAccountHint(value.account.slots.keyring ?? value.account.slots.file!).refresh !== oldGrant) continue;
      const updated: Candidate = { ...value, account: { ...value.account, slots: rebaseRefreshedSlots(value.account.slots, next) } };
      const after = JSON.stringify(updated);
      let memory = retained.get(vault); if (!memory) { memory = new Map(); retained.set(vault, memory); } memory.set(key, updated);
      if (await vault.get(key) !== raw) throw new LiveError('ACCOUNT_QUOTA_REFRESH_CONFLICT');
      await vault.store(key, after); if (await vault.get(key) !== after) throw new LiveError('ACCOUNT_QUOTA_REFRESH_SAVE_FAILED'); memory.delete(key);
    }
  }
  private async save(value: Candidate): Promise<void> {
    this.current = structuredClone(value);
    let values = retained.get(this.vault);
    if (!values) { values = new Map(); retained.set(this.vault, values); }
    values.set(this.key, structuredClone(value));
    const raw = JSON.stringify(value);
    try { await this.vault.store(this.key, raw); if (await this.vault.get(this.key) !== raw) throw 0; }
    catch { throw new LiveError('ACCOUNT_QUOTA_SECURE_SAVE_FAILED'); }
    values.delete(this.key);
  }
  async account(): Promise<LiveAccount> { const value = await this.load(); if (value.exchanging && !value.next && value.response === undefined) throw new LiveError('ACCOUNT_QUOTA_REFRESH_OUTCOME_UNKNOWN'); return value.account; }
  async pending(expected: TokenSlots): Promise<TokenSlots | undefined> {
    const value = await this.load(); this.assertExpected(value, expected);
    if (value.exchanging && !value.next && value.response === undefined) throw new LiveError('ACCOUNT_QUOTA_REFRESH_OUTCOME_UNKNOWN');
    if (!value.next && value.response !== undefined) {
      const next = refreshedSlots(expected, value.response, value.receivedAt!);
      await this.stage(expected, next); return next;
    }
    return value.next;
  }
  private assertExpected(value: Candidate, expected: TokenSlots): void { if (!equalSlots(value.account.slots, expected)) throw new LiveError('ACCOUNT_QUOTA_REFRESH_CONFLICT'); }
  async exchange(expected: TokenSlots, run: () => Promise<unknown>): Promise<unknown> {
    const value = await this.load(); this.assertExpected(value, expected);
    if (value.exchanging) throw new LiveError('ACCOUNT_QUOTA_REFRESH_OUTCOME_UNKNOWN');
    try { await this.save({ ...value, exchanging: true }); }
    catch (error) {
      // No request has started. Preserve a retryable predecessor in memory and
      // attempt to clear a marker that may have committed before failed readback.
      try { await this.save({ ...value, exchanging: false }); } catch { /* Retained for the next explicit import. */ }
      throw error;
    }
    try {
      const response = await run();
      // Preserve the returned response before parsing/identity requests. A fresh
      // process can derive the same expiry from receivedAt without another exchange.
      await this.save({ ...value, exchanging: true, response, receivedAt: Date.now() });
      return response;
    }
    catch (error) {
      // Only an explicit OAuth rejection establishes that no rotation occurred.
      if (error instanceof LiveError && ['ACCOUNT_QUOTA_REAUTH_REQUIRED', 'ACCOUNT_QUOTA_CLIENT_UNVERIFIED', 'ACCOUNT_QUOTA_FORBIDDEN', 'ACCOUNT_QUOTA_RATE_LIMITED'].includes(error.code)) await this.save({ ...value, exchanging: false });
      throw error;
    }
  }
  async stage(expected: TokenSlots, next: TokenSlots): Promise<void> {
    const value = this.current ?? await this.load(); this.assertExpected(value, expected); validateSlots(next);
    await this.save({ schema: 1, source: this.source, account: value.account, next, exchanging: false });
  }
  async commit(expected: TokenSlots, next: TokenSlots): Promise<void> {
    const value = await this.load(); this.assertExpected(value, expected);
    if (!value.next || !equalSlots(value.next, next)) throw new LiveError('ACCOUNT_QUOTA_REFRESH_CONFLICT');
    await this.save({ schema: 1, source: this.source, account: { ...value.account, slots: next } });
  }
  // Completed candidates are reusable when cleanup fails, never refreshed from the archive again.
  async clear(): Promise<void> {
    // Retain the archive-to-latest binding after rotation: importing the same
    // encrypted file again must not submit its now-obsolete refresh token.
    if (this.current && !equalSlots(this.current.account.slots, this.initial.slots)) return;
    await this.vault.delete(this.key); if (await this.vault.get(this.key) !== undefined) throw new LiveError('ACCOUNT_QUOTA_SECURE_SAVE_FAILED');
    const manifest = await ImportCandidateStore.manifest(this.vault, this.initial.hostId); delete manifest.sources[this.source];
    await ImportCandidateStore.saveManifest(this.vault, manifest);
    retained.get(this.vault)?.delete(this.key);
  }
}
