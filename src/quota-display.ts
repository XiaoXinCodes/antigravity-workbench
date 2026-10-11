/* eslint-disable no-control-regex -- Reject controls in persisted display fields. */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { PrivateState, type LocalState } from './private-state';
import { quotaObservationFingerprint, type QuotaObservationAccount } from './quota-observation';
import type { LiveQuotaSnapshot } from './live-ui';
import type { ImageQuotaSnapshot } from './image-quota';

interface AccountReading { accountId: string; identity: string; observedAt: string; buckets: LiveQuotaSnapshot['buckets'] }
interface ImageReading extends ImageQuotaSnapshot { identity: string }
export interface QuotaDisplayState { schema: 1; accounts: AccountReading[]; images: ImageReading[] }
export const initialQuotaDisplay = (): QuotaDisplayState => ({ schema: 1, accounts: [], images: [] });
const bad = (): never => { throw Error('QUOTA_DISPLAY_INVALID'); };
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : bad();
const text = (value: unknown, max: number): string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value) ? value : bad();
const time = (value: unknown): string => { const result = text(value, 64); return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(result) && Number.isFinite(Date.parse(result)) ? new Date(result).toISOString() : bad(); };
const fraction = (value: unknown): number | null => value === null || typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : bad();
const only = (value: Record<string, unknown>, keys: string[]): void => { if (Object.keys(value).some(key => !keys.includes(key))) bad(); };
const identity = (account: QuotaObservationAccount): string => createHash('sha256').update(quotaObservationFingerprint(account)).digest('hex');
function binding(value: Record<string, unknown>): { accountId: string; identity: string } {
  if (typeof value.accountId !== 'string' || !/^[a-f0-9-]{36}$/.test(value.accountId) || typeof value.identity !== 'string' || !/^[a-f0-9]{64}$/.test(value.identity)) bad();
  return { accountId: value.accountId as string, identity: value.identity as string };
}
export function parseQuotaDisplay(value: unknown): QuotaDisplayState {
  const state = object(value); only(state, ['schema', 'accounts', 'images']);
  if (state.schema !== 1 || !Array.isArray(state.accounts) || state.accounts.length > 50 || !Array.isArray(state.images) || state.images.length > 500) bad();
  const accounts = (state.accounts as unknown[]).map(item => {
    const row = object(item); only(row, ['accountId', 'identity', 'observedAt', 'buckets']);
    if (!Array.isArray(row.buckets) || row.buckets.length > 200) bad();
    const buckets = (row.buckets as unknown[]).map(item => {
      const bucket = object(item); only(bucket, ['label', 'remaining', 'resetAt', 'bucketId', 'groupId', 'window', 'remainingAmount', 'disabled']);
      const result: LiveQuotaSnapshot['buckets'][number] = { label: text(bucket.label, 200), remaining: fraction(bucket.remaining), resetAt: bucket.resetAt === null ? null : time(bucket.resetAt) };
      for (const key of ['bucketId', 'groupId', 'window'] as const) if (bucket[key] !== undefined) result[key] = text(bucket[key], 200);
      if (bucket.remainingAmount !== undefined) { if (typeof bucket.remainingAmount !== 'string' || !/^\d{1,20}$/.test(bucket.remainingAmount)) bad(); result.remainingAmount = bucket.remainingAmount as string; }
      if (bucket.disabled !== undefined) { if (typeof bucket.disabled !== 'boolean') bad(); result.disabled = bucket.disabled as boolean; }
      return result;
    });
    return { ...binding(row), observedAt: time(row.observedAt), buckets };
  });
  const images = (state.images as unknown[]).map(item => {
    const row = object(item); only(row, ['accountId', 'identity', 'modelId', 'endpoint', 'queriedAt', 'remainingFraction', 'resetAt']);
    if (row.endpoint !== 'daily' && row.endpoint !== 'production') bad();
    return { ...binding(row), modelId: text(row.modelId, 128), endpoint: row.endpoint as ImageQuotaSnapshot['endpoint'], queriedAt: time(row.queriedAt), remainingFraction: fraction(row.remainingFraction), resetAt: row.resetAt === null ? null : time(row.resetAt) };
  });
  return { schema: 1, accounts, images };
}

/** Last successful observations, never a grant, a directory or a freshness proof.
 * Store only bounded quota fields and opaque binding hashes, no email, bearer,
 * project, prompt, API capability, or arbitrary response. PrivateState reloads
 * under its cross-window lock before merging a write. */
export class QuotaDisplayCache {
  private state = initialQuotaDisplay();
  private loading: Promise<void> | undefined;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly accounts: () => QuotaObservationAccount[], private readonly store?: LocalState<QuotaDisplayState>) {}
  load(): Promise<void> { return this.loading ??= (async () => { try { if (this.store) this.state = parseQuotaDisplay(await this.store.read()); } catch { /* Unreadable display data cannot block account operations. */ } })(); }
  private present(row: { accountId: string; identity: string }): boolean { const account = this.accounts().find(a => a.id === row.accountId); return !!account && identity(account) === row.identity && account.migrationState !== 'pending'; }
  private prune(state: QuotaDisplayState): void {
    state.accounts = state.accounts.filter(row => this.present(row)).sort((a,b) => Date.parse(b.observedAt) - Date.parse(a.observedAt)).slice(0, 50);
    state.images = state.images.filter(row => this.present(row)).sort((a,b) => Date.parse(b.queriedAt) - Date.parse(a.queriedAt)).slice(0, 500);
    while (Buffer.byteLength(JSON.stringify(state)) > 1536 * 1024) {
      const account = state.accounts.at(-1), image = state.images.at(-1);
      if (account && (!image || Date.parse(account.observedAt) <= Date.parse(image.queriedAt))) state.accounts.pop();
      else if (image) state.images.pop();
      else break;
    }
  }
  private write(work: (state: QuotaDisplayState) => void): Promise<void> {
    const next = this.tail.then(async () => {
      await this.load();
      work(this.state); this.prune(this.state);
      if (!this.store) return;
      await this.store.transaction(state => { work(state); this.prune(state); });
      this.state = parseQuotaDisplay(await this.store.read());
    }).catch(() => undefined);
    this.tail = next; return next;
  }
  account(account: QuotaObservationAccount): LiveQuotaSnapshot | undefined {
    const row = this.state.accounts.find(row => row.accountId === account.id && row.identity === identity(account));
    return row && account.migrationState !== 'pending' ? { source: 'server', email: account.expectedEmail, observedAt: row.observedAt, buckets: structuredClone(row.buckets) } : undefined;
  }
  image(account: QuotaObservationAccount | undefined, modelId: string, endpoint: ImageQuotaSnapshot['endpoint']): ImageQuotaSnapshot | undefined {
    const row = account && this.state.images.find(row => row.accountId === account.id && row.identity === identity(account) && row.modelId === modelId && row.endpoint === endpoint);
    if (!row || account?.migrationState === 'pending') return;
    const { identity: ignored, ...snapshot } = row; void ignored; return structuredClone(snapshot);
  }
  async rememberAccount(account: QuotaObservationAccount, snapshot: LiveQuotaSnapshot): Promise<void> {
    if (snapshot.source !== 'server' || snapshot.email.toLowerCase() !== account.expectedEmail.toLowerCase()) return Promise.resolve();
    const row = parseQuotaDisplay({ schema: 1, accounts: [{ accountId: account.id, identity: identity(account), observedAt: snapshot.observedAt, buckets: snapshot.buckets }], images: [] }).accounts[0]!;
    return this.write(state => { if (!this.present(row)) return; const old = state.accounts.find(r => r.accountId === row.accountId && r.identity === row.identity); if (!old || Date.parse(old.observedAt) <= Date.parse(row.observedAt)) { state.accounts = state.accounts.filter(r => r.accountId !== row.accountId); state.accounts.unshift(row); } });
  }
  async rememberImage(account: QuotaObservationAccount, snapshot: ImageQuotaSnapshot): Promise<void> {
    if (account.id !== snapshot.accountId) return Promise.resolve();
    const row = parseQuotaDisplay({ schema: 1, accounts: [], images: [{ ...snapshot, identity: identity(account) }] }).images[0]!;
    return this.write(state => { if (!this.present(row)) return; const matches = (r: ImageReading) => r.accountId === row.accountId && r.identity === row.identity && r.modelId === row.modelId && r.endpoint === row.endpoint; const old = state.images.find(matches); if (!old || Date.parse(old.queriedAt) <= Date.parse(row.queriedAt)) { state.images = state.images.filter(r => !matches(r)); state.images.unshift(row); } });
  }
  reconcile(): Promise<void> { return this.write(() => undefined); }
  async flush(): Promise<void> { await this.tail; }
}
const caches = new WeakMap<object, QuotaDisplayCache>();
export function quotaDisplayCache(context: { globalStorageUri?: { fsPath?: string } }, accounts: () => QuotaObservationAccount[]): QuotaDisplayCache {
  let cache = caches.get(context); if (cache) return cache;
  const root = context.globalStorageUri?.fsPath;
  cache = new QuotaDisplayCache(accounts, root && path.isAbsolute(root) ? new PrivateState(path.join(root, 'quota-display'), parseQuotaDisplay, initialQuotaDisplay) : undefined);
  caches.set(context, cache); return cache;
}
