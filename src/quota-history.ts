import { randomUUID } from 'node:crypto';
import type { LocalState } from './private-state';
import { quotaFraction, accountDisplayFingerprint } from './quota-presentation';
export type ObservationKind = 'bucket' | 'image-model';
export interface QuotaObservation {
  id: string; accountId: string; fingerprint: string; kind: ObservationKind; key: string; label: string;
  observedAt: string | null; eventAt: string; fraction: number | null; resetAt: string | null;
  status: 'ready' | 'unknown' | 'unavailable' | 'failure';
}
export interface QuotaHistoryState { schema: 1; retentionDays: number; rows: QuotaObservation[]; seen: { accountId: string; fingerprint: string; kind: ObservationKind; key: string; observedAt: string }[] }
export interface HistoryFilter { accountId?: string; kind?: ObservationKind; key?: string; after?: number }
export interface HistoryAccount { id: string; expectedEmail: string; hostId?: string; capturedAt?: string; migrationState?: string }
export const initialQuotaHistory = (): QuotaHistoryState => ({ schema: 1, retentionDays: 30, rows: [], seen: [] });
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : bad();
const bad = (): never => { throw Error('QUOTA_HISTORY_INVALID'); };
const text = (v: unknown, max: number): string => typeof v === 'string' && v.length > 0 && v.length <= max ? v : bad();
const time = (v: unknown): string => { const s = text(v, 64); return Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s ? s : bad(); };
const kind = (v: unknown): ObservationKind => v === 'bucket' || v === 'image-model' ? v : bad();
export function parseQuotaHistory(value: unknown): QuotaHistoryState {
  const v = object(value); if (v.schema !== 1 || !Number.isInteger(v.retentionDays) || Number(v.retentionDays) < 1 || Number(v.retentionDays) > 90 || !Array.isArray(v.rows) || v.rows.length > 5000 || !Array.isArray(v.seen) || v.seen.length > 10000) bad();
  const rows = (v.rows as unknown[]).map(item => {
    const r = object(item), status = r.status; if (!['ready', 'unknown', 'unavailable', 'failure'].includes(String(status))) bad();
    const observedAt = r.observedAt === null ? null : time(r.observedAt), fraction = quotaFraction(r.fraction);
    if (r.fraction !== null && fraction === null || status === 'ready' && (fraction === null || observedAt === null) || status === 'failure' && (fraction !== null || observedAt !== null)) bad();
    return { id: text(r.id, 36), accountId: text(r.accountId, 36), fingerprint: text(r.fingerprint, 2000), kind: kind(r.kind), key: text(r.key, 1000), label: text(r.label, 200), observedAt, eventAt: time(r.eventAt), fraction, resetAt: r.resetAt === null ? null : time(r.resetAt), status: status as QuotaObservation['status'] };
  });
  if (new Set(rows.map(r => r.id)).size !== rows.length) bad();
  const seen = (v.seen as unknown[]).map(item => { const r = object(item); return { accountId: text(r.accountId, 36), fingerprint: text(r.fingerprint, 2000), kind: kind(r.kind), key: text(r.key, 1000), observedAt: time(r.observedAt) }; });
  return { schema: 1, retentionDays: Number(v.retentionDays), rows, seen };
}
const matches = (r: QuotaObservation, f: HistoryFilter) => (!f.accountId || r.accountId === f.accountId) && (!f.kind || r.kind === f.kind) && (!f.key || r.key === f.key) && (f.after === undefined || Date.parse(r.eventAt) >= f.after);
const same = (a: Pick<QuotaObservation, 'accountId' | 'fingerprint' | 'kind' | 'key'>, b: Pick<QuotaObservation, 'accountId' | 'fingerprint' | 'kind' | 'key'>) => a.accountId === b.accountId && a.fingerprint === b.fingerprint && a.kind === b.kind && a.key === b.key;
/** Observations, not consumption estimates. No sampling, interpolated values or credentials. */
export class QuotaHistory {
  constructor(readonly store: LocalState<QuotaHistoryState>, private readonly accounts: () => HistoryAccount[], private readonly changed: () => void = () => undefined, private readonly now: () => number = Date.now) {}
  private present(r: Pick<QuotaObservation, 'accountId' | 'fingerprint'>): boolean { const a = this.accounts().find(a => a.id === r.accountId); return !!a && accountDisplayFingerprint(a) === r.fingerprint; }
  private prune(s: QuotaHistoryState): void {
    const cutoff = this.now() - s.retentionDays * 86_400_000;
    s.rows = s.rows.filter(r => this.present(r) && Date.parse(r.eventAt) >= cutoff).sort((a, b) => Date.parse(a.eventAt) - Date.parse(b.eventAt)).slice(-5000);
    s.seen = s.seen.filter(r => this.present(r) && Date.parse(r.observedAt) >= cutoff).sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt)).slice(-10000);
    // Keep the complete JSON below the private-store 2 MiB bound, even with
    // long real identifiers. Prefer newest rows, then newest dedup watermarks.
    while (Buffer.byteLength(JSON.stringify(s)) > 1536 * 1024) {
      if (s.rows.length > 1) s.rows = s.rows.slice(Math.max(1, Math.ceil(s.rows.length / 10)));
      else if (s.seen.length > 1) s.seen = s.seen.slice(Math.max(1, Math.ceil(s.seen.length / 10)));
      else throw Error('QUOTA_HISTORY_LIMIT');
    }
  }
  async record(input: Omit<QuotaObservation, 'id' | 'eventAt' | 'status'> & { unavailable?: boolean }): Promise<void> {
    if (!input.observedAt || !Number.isFinite(Date.parse(input.observedAt)) || Date.parse(input.observedAt) > this.now() || !this.present(input)) return;
    await this.store.transaction(s => {
      if (!this.present(input)) return;
      const prior = s.seen.find(r => same(r, input)); if (prior && Date.parse(prior.observedAt) >= Date.parse(input.observedAt!)) return;
      const fraction = quotaFraction(input.fraction), resetAt = input.resetAt && Number.isFinite(Date.parse(input.resetAt)) ? new Date(input.resetAt).toISOString() : null;
      const row: QuotaObservation = { id: randomUUID(), accountId: input.accountId, fingerprint: input.fingerprint, kind: input.kind, key: input.key, label: input.label, observedAt: new Date(input.observedAt!).toISOString(), eventAt: new Date(input.observedAt!).toISOString(), fraction, resetAt, status: input.unavailable ? 'unavailable' : fraction === null ? 'unknown' : 'ready' };
      s.rows.push(row); const watermark = { accountId: input.accountId, fingerprint: input.fingerprint, kind: input.kind, key: input.key, observedAt: row.observedAt! };
      if (prior) Object.assign(prior, watermark); else s.seen.push(watermark); this.prune(s);
    }); this.changed();
  }
  async gap(input: Pick<QuotaObservation, 'accountId' | 'fingerprint' | 'kind' | 'key' | 'label'>): Promise<void> {
    if (!this.present(input)) return;
    await this.store.transaction(s => {
      if (!this.present(input)) return;
      const previous = s.rows.filter(r => same(r, input)).at(-1); if (previous?.status === 'failure') return;
      s.rows.push({ ...input, id: randomUUID(), observedAt: null, eventAt: new Date(this.now()).toISOString(), fraction: null, resetAt: null, status: 'failure' }); this.prune(s);
    }); this.changed();
  }
  async reconcile(): Promise<void> { await this.store.transaction(s => this.prune(s)); this.changed(); }
  async settings(days: number): Promise<void> { if (!Number.isInteger(days) || days < 1 || days > 90) throw Error('QUOTA_HISTORY_RETENTION_INVALID'); await this.store.transaction(s => { s.retentionDays = days; this.prune(s); }); this.changed(); }
  async clear(filter: HistoryFilter = {}): Promise<void> { await this.store.transaction(s => { s.rows = s.rows.filter(r => !matches(r, filter)); }); this.changed(); }
  async read(filter: HistoryFilter = {}): Promise<{ retentionDays: number; rows: QuotaObservation[] }> { const s = await this.store.read(); return { retentionDays: s.retentionDays, rows: s.rows.filter(r => this.present(r) && matches(r, filter) && Date.parse(r.eventAt) >= this.now() - s.retentionDays * 86_400_000) }; }
}
