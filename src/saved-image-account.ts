import { summarizeImageCatalog, type CatalogSummary } from './image-catalog-diagnostic';
import { imageQuotaFromCatalog, type ImageQuotaRow } from './image-quota';
import { createHash } from 'node:crypto';
import { SavedAccountQuotaClient, type SavedQuotaRefresh } from './account-quota';
import type { LiveAccount } from './live-switch';
import { equalSlots } from './live-storage';
import type { AccountChoice, ImageModelChoice } from './direct-image-binding';
import type { BoundImageAccount } from './direct-image-core';
import type { ImageEndpoint } from './direct-image-protocol';

export interface SavedImageSnapshot { account: LiveAccount; revision: string }
export interface SavedImageStore {
  load(id: string): Promise<SavedImageSnapshot>;
  refresh(id: string, assertPresent: () => void): SavedQuotaRefresh;
  verify(id: string, revision: string, allowPending?: boolean): Promise<void>;
}
export interface SavedImageDependencies {
  accounts(): AccountChoice[];
  store(): Promise<SavedImageStore>;
  withOperation<T>(work: () => Promise<T>): Promise<T>;
  project(token: string, signal: AbortSignal, endpoint: ImageEndpoint): Promise<{ projectId: string; endpoint: ImageEndpoint }>;
  models(token: string, project: string, signal: AbortSignal, endpoint: ImageEndpoint): Promise<unknown>;
  parseModels(value: unknown): ImageModelChoice[];
  client?: SavedAccountQuotaClient;
  now?: () => number;
}
interface Prepared {
  key: string; accountId: string; revision: string; expiresAt: number; tokenExpiry: number;
  token: string; projectId: string; endpoint: ImageEndpoint; models: ImageModelChoice[]; catalog: CatalogSummary; quota: ImageQuotaRow[]; queriedAt: string; verify(signal: AbortSignal): Promise<void>;
}
const check = (signal: AbortSignal) => { if (signal.aborted) throw new Error('IMAGE_CANCELLED'); };
const fingerprint = (account: AccountChoice) => createHash('sha256').update(JSON.stringify([account.id, account.expectedEmail.toLowerCase(), account.hostId, account.capturedAt])).digest('hex');
/** Explicit selections, cache and bearer material stay in this host's memory.
 * Selecting an existing login permits its normal checks, not a new OAuth grant. */
export class SavedImageAccounts {
  private readonly selections = new Map<string, string>();
  private readonly cache = new Map<string, Prepared>();
  private readonly client: SavedAccountQuotaClient;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  constructor(private readonly deps: SavedImageDependencies) { this.client = deps.client ?? new SavedAccountQuotaClient(); this.now = deps.now ?? Date.now; }
  private selected(id: string): AccountChoice {
    const rows = this.deps.accounts().filter(x => x.id === id);
    if (rows.length !== 1) throw new Error('IMAGE_SAVED_ACCOUNT_REMOVED');
    const account = rows[0]!;
    if (!account.hostCurrent) throw new Error('IMAGE_DIRECT_HOST_MISMATCH');
    if (account.migrationState === 'pending') throw new Error('IMAGE_ACCOUNT_RECOVERY_PENDING');
    return account;
  }
  isSelected(id: string): boolean { try { return this.selections.get(id) === fingerprint(this.selected(id)); } catch { return false; } }
  /** The controller validates an explicit account selection. Background refresh
   * and retries cannot adopt a replacement account or select another login. */
  selectForWindow(id: string): void { this.selections.set(id, fingerprint(this.selected(id))); }
  forgetMissing(): void {
    for (const id of this.selections.keys()) if (!this.isSelected(id)) { this.selections.delete(id); for (const [key, value] of this.cache) if (value.accountId === id) this.cache.delete(key); }
  }
  private async prepare(id: string, signal: AbortSignal, endpoint: ImageEndpoint, force = false, diagnostic?: { assertCurrent(): Promise<void> }): Promise<Prepared> {
    check(signal); this.forgetMissing();
    if (!diagnostic && !this.isSelected(id)) throw new Error('IMAGE_SAVED_SELECTION_REQUIRED');
    const expected = fingerprint(this.selected(id));
    const assertPresent = () => {
      if (fingerprint(this.selected(id)) !== expected || !diagnostic && !this.isSelected(id)) throw new Error('IMAGE_SAVED_ACCOUNT_CHANGED');
    };
    const work = async () => {
      check(signal); assertPresent(); await diagnostic?.assertCurrent();
      return this.deps.withOperation(async () => {
        // Read *after* the shared host lock: a quota refresh or another lookup may have rotated the grant while queued.
        check(signal); assertPresent(); await diagnostic?.assertCurrent();
        const store = await this.deps.store();
        const snapshot = await store.load(id); assertPresent();
        if (snapshot.account.id !== id || snapshot.account.expectedEmail.toLowerCase() !== this.selected(id).expectedEmail.toLowerCase()) throw new Error('IMAGE_DIRECT_IDENTITY_MISMATCH');
        const key = [expected, endpoint, snapshot.revision].join(':');
        if (force && !diagnostic) this.cache.delete(key);
        const cached = this.cache.get(key);
        if (!diagnostic && cached && cached.expiresAt > this.now()) { await cached.verify(signal); return cached; }
        let expectedRevision = snapshot.revision;
        const refresh = store.refresh(id, assertPresent);
        const prepared = await this.client.withAccess(snapshot.account, signal, { refresh: {
          ...refresh,
          stage: async (expectedSlots, next) => { assertPresent(); await store.verify(id, expectedRevision, true); await refresh.stage(expectedSlots, next); },
          commit: async (expectedSlots, next) => {
            assertPresent(); await store.verify(id, expectedRevision, true); await refresh.commit(expectedSlots, next);
            const changed = await store.load(id); assertPresent();
            const { slots: ignoredBefore, ...beforeMetadata } = snapshot.account;
            const { slots: ignoredAfter, ...afterMetadata } = changed.account;
            void ignoredBefore; void ignoredAfter;
            if (JSON.stringify(beforeMetadata) !== JSON.stringify(afterMetadata) || !equalSlots(changed.account.slots, next)) throw new Error('IMAGE_SAVED_ACCOUNT_CHANGED');
            expectedRevision = changed.revision;
          },
        } }, async (access, requestSignal) => {
          assertPresent(); check(requestSignal);
          await diagnostic?.assertCurrent();
          const project = await this.deps.project(access.accessToken, requestSignal, endpoint);
          if (project.endpoint !== endpoint) throw new Error('IMAGE_DIRECT_PROJECT_ENDPOINT_MISMATCH');
          assertPresent(); check(requestSignal);
          await diagnostic?.assertCurrent();
          const response = await this.deps.models(access.accessToken, project.projectId, requestSignal, endpoint);
          access.assertPublicResponse(response);
          await diagnostic?.assertCurrent();
          const catalog = summarizeImageCatalog(response);
          let models: ImageModelChoice[] = [];
          try { models = this.deps.parseModels(response); } catch (error) { if (!diagnostic) throw error; }
          if (!diagnostic && !models.length) throw new Error('IMAGE_SAVED_MODELS_UNAVAILABLE');
          return { token: access.accessToken, tokenExpiry: access.expiry, projectId: project.projectId, models, catalog,
            quota: models.length ? imageQuotaFromCatalog(response, models) : [], queriedAt: new Date(this.now()).toISOString() };
        });
        check(signal); assertPresent();
        const committed = await store.load(id); assertPresent();
        const revision = committed.revision;
        if (revision !== expectedRevision) throw new Error('IMAGE_SAVED_ACCOUNT_CHANGED');
        // A committed refresh is reloaded inside the same host lock. Compare all identity metadata as well as revision on every send.
        if (committed.account.expectedEmail !== snapshot.account.expectedEmail || committed.account.hostId !== snapshot.account.hostId) throw new Error('IMAGE_SAVED_ACCOUNT_CHANGED');
        const verify = async (requestSignal: AbortSignal) => {
          check(requestSignal); assertPresent(); await diagnostic?.assertCurrent();
          if (prepared.tokenExpiry <= this.now() + 5_000) throw new Error('IMAGE_SAVED_AUTH_EXPIRED');
          await store.verify(id, revision); check(requestSignal); assertPresent();
        };
        const result: Prepared = { ...prepared, endpoint, accountId: id, revision, key: [expected, endpoint, revision].join(':'),
          expiresAt: Math.min(this.now() + 5 * 60_000, prepared.tokenExpiry - 30_000), verify };
        await verify(signal);
        if (diagnostic) return result;
        for (const [oldKey, value] of this.cache) if (value.accountId === id) this.cache.delete(oldKey);
        this.cache.set(result.key, result);
        return result;
      });
    };
    // Local metadata lookups queue; the existing filesystem lock also excludes quota/refresh/removal in other windows.
    const pending = this.queue.then(work, work); this.queue = pending.catch(() => undefined); return pending;
  }
  async choices(id: string, signal: AbortSignal, endpoint: ImageEndpoint, force = false): Promise<ImageModelChoice[]> {
    return (await this.prepare(id, signal, endpoint, force)).models.map(x => ({ ...x }));
  }
  async quota(id: string, modelId: string, signal: AbortSignal, endpoint: ImageEndpoint) {
    const prepared = await this.prepare(id, signal, endpoint, true);
    const row = prepared.quota.find(item => item.modelId === modelId);
    if (!row) throw Error('IMAGE_DIRECT_MODEL_UNVERIFIED');
    return { ...row, accountId: id, endpoint, queriedAt: prepared.queriedAt };
  }
  async diagnoseCatalog(id: string, signal: AbortSignal, endpoint: ImageEndpoint, assertCurrent: () => Promise<void>): Promise<CatalogSummary> {
    return (await this.prepare(id, signal, endpoint, true, { assertCurrent })).catalog;
  }
  async bind(id: string, modelId: string, signal: AbortSignal, endpoint: ImageEndpoint): Promise<BoundImageAccount> {
    const prepared = await this.prepare(id, signal, endpoint), model = prepared.models.find(x => x.id === modelId);
    if (!model) throw new Error('IMAGE_DIRECT_MODEL_UNVERIFIED');
    return Object.freeze({ token: prepared.token, projectId: prepared.projectId, modelId: model.id, accountId: id,
      endpoint, projectSource: 'loadCodeAssist' as const, modelSource: 'saved-account' as const,
      ...(model.modelEnum ? { modelEnum: model.modelEnum } : {}), verify: prepared.verify });
  }
}
/** Exact encrypted-record revision. The value never leaves extension-host memory. */
export function imageAccountRevision(raw: string): string { return createHash('sha256').update(raw).digest('hex'); }
