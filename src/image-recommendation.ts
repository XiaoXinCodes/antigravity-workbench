import { accountDisplayFingerprint, quotaIsStale, quotaFraction } from './quota-presentation';
import type { AccountChoice } from './direct-image-binding';
import type { ImageQuotaSnapshot } from './image-quota';
import type { ImageEndpoint } from './direct-image-protocol';
export interface RecommendationRow { accountId: string; fingerprint: string; phase: 'waiting' | 'loading' | 'ready' | 'error' | 'cancelled'; snapshot?: ImageQuotaSnapshot }
export interface RecommendationState { loading: boolean; cancelled: boolean; modelId: string; endpoint: ImageEndpoint; rows: RecommendationRow[] }
/** Explicit metadata batch. It cannot select an account or submit an image. */
export class ImageRecommendation {
  private revision = 0;
  private expiry: ReturnType<typeof setTimeout> | undefined;
  private abort: AbortController | undefined;
  private pending: Promise<void> | undefined;
  private selectionKey = '';
  private state: RecommendationState = { loading: false, cancelled: false, modelId: '', endpoint: 'daily', rows: [] };
  constructor(private readonly accounts: () => AccountChoice[], private readonly readQuota: (id: string, model: string, signal: AbortSignal, endpoint: ImageEndpoint) => Promise<ImageQuotaSnapshot>, private readonly changed: () => void, private readonly observe?: (row: RecommendationRow) => void, private readonly now: () => number = Date.now) {}
  selection(modelId: string, endpoint: ImageEndpoint): void {
    const key = JSON.stringify([modelId, endpoint, this.accounts().map(a => [a.id, accountDisplayFingerprint(a)])]);
    if (key === this.selectionKey) return; this.cancel(); clearTimeout(this.expiry); this.selectionKey = key; this.state = { loading: false, cancelled: false, modelId, endpoint, rows: [] };
  }
  private scheduleExpiry(): void {
    clearTimeout(this.expiry);
    const next = this.state.rows.flatMap(r => r.snapshot ? [Date.parse(r.snapshot.queriedAt) + 60_000] : []).filter(t => t > this.now()).sort((a,b) => a-b)[0];
    if (next !== undefined) { this.expiry = setTimeout(() => { this.changed(); this.scheduleExpiry(); }, Math.max(1, next - this.now())); this.expiry.unref?.(); }
  }
  getState(): RecommendationState { return structuredClone(this.state); }
  usable(row: RecommendationRow): boolean {
    const a = this.accounts().find(a => a.id === row.accountId), s = row.snapshot;
    return !!a && accountDisplayFingerprint(a) === row.fingerprint && row.phase === 'ready' && !!s && s.accountId === a.id && s.modelId === this.state.modelId && s.endpoint === this.state.endpoint && !quotaIsStale(s.queriedAt, this.now()) && quotaFraction(s.remainingFraction) !== null && s.remainingFraction! > 0;
  }
  choose(id: unknown): RecommendationRow | undefined { return typeof id === 'string' ? this.state.rows.find(r => r.accountId === id && this.usable(r)) : undefined; }
  cancel(): void { ++this.revision; this.abort?.abort(); this.abort = undefined; this.pending = undefined; this.state = { ...this.state, loading: false, cancelled: true, rows: this.state.rows.map(r => r.phase === 'loading' || r.phase === 'waiting' ? { ...r, phase: 'cancelled' } : r) }; }
  start(modelId: string, endpoint: ImageEndpoint): Promise<void> {
    this.selection(modelId, endpoint); if (this.pending || !modelId) return this.pending ?? Promise.resolve();
    const revision = ++this.revision, abort = new AbortController(); this.abort = abort;
    const rows = this.accounts().filter(a => a.hostCurrent && a.migrationState !== 'pending').slice(0, 50).map(a => ({ accountId: a.id, fingerprint: accountDisplayFingerprint(a), phase: 'waiting' as const }));
    this.state = { loading: true, cancelled: false, modelId, endpoint, rows }; this.changed();
    const valid = () => revision === this.revision && !abort.signal.aborted;
    const work = (async () => {
      for (const row of rows) {
        if (!valid()) break;
        const account = this.accounts().find(a => a.id === row.accountId); if (!account || accountDisplayFingerprint(account) !== row.fingerprint) continue;
        const target = this.state.rows.find(r => r.accountId === row.accountId)!; target.phase = 'loading'; this.changed();
        try {
          const snapshot = await this.readQuota(row.accountId, modelId, abort.signal, endpoint);
          if (!valid()) break;
          const current = this.accounts().find(a => a.id === row.accountId);
          if (!current || accountDisplayFingerprint(current) !== row.fingerprint || snapshot.accountId !== row.accountId || snapshot.modelId !== modelId || snapshot.endpoint !== endpoint) throw Error('IMAGE_SAVED_ACCOUNT_CHANGED');
          target.snapshot = { ...snapshot }; target.phase = 'ready'; this.observe?.(structuredClone(target));
        } catch { if (!valid()) break; target.phase = 'error'; this.observe?.(structuredClone(target)); }
        this.changed();
      }
    })().finally(() => { if (this.pending === work) this.pending = undefined; if (valid()) { this.state.loading = false; this.abort = undefined; this.scheduleExpiry(); this.changed(); } });
    this.pending = work; return work;
  }
  dispose(): void { this.cancel(); clearTimeout(this.expiry); }
}
