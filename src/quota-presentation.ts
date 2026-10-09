import { t as tr } from './i18n';
import type { LiveAccountView, LiveQuotaSnapshot } from './live-ui';

export const QUOTA_FRESH_MS = 60_000;
export function quotaFraction(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}
/** Keep this function self-contained: the image webview embeds the same formatter. */
export function quotaPercent(fraction: number, nearFull = tr('imageQuota.bafbf5e6f8')): string {
  return fraction < 1 && Math.round(fraction * 10_000) === 10_000 ? nearFull : (fraction * 100).toFixed(2) + '%';
}
export function quotaIsStale(observedAt: string, now = Date.now()): boolean {
  const time = Date.parse(observedAt);
  return !Number.isFinite(time) || time > now || now - time >= QUOTA_FRESH_MS;
}
export function accountQuotaSnapshot(account: LiveAccountView): LiveQuotaSnapshot | undefined {
  const snapshot = account.quota?.snapshot;
  return snapshot?.source === 'server' && snapshot.email.trim().toLowerCase() === account.expectedEmail.trim().toLowerCase() ? snapshot : undefined;
}
export function accountQuotaStale(account: LiveAccountView, now = Date.now()): boolean {
  const snapshot = accountQuotaSnapshot(account);
  return !!snapshot && (account.quota?.phase !== 'ready' || quotaIsStale(snapshot.observedAt, now));
}
export type QuotaBucket = LiveQuotaSnapshot['buckets'][number];
export function quotaValue(bucket: QuotaBucket): string {
  const fraction = quotaFraction(bucket.remaining);
  return bucket.disabled ? tr('workbenchView.460b3574e4') : fraction !== null ? quotaPercent(fraction) : bucket.remainingAmount && /^\d{1,20}$/.test(bucket.remainingAmount) ? bucket.remainingAmount : tr('workbenchView.4d8c1c5b42');
}
/** Display families only. They do not imply a shared pool, model ID, or shared reset. */
export function quotaFamily(label: string): string {
  if (/gemini/i.test(label)) return 'Gemini';
  if (/claude|sonnet|opus|haiku/i.test(label)) return 'Claude';
  if (/gpt|openai/i.test(label)) return 'OpenAI';
  return 'other';
}
/** Server bucket IDs are quota identities, never callable model IDs or inferred pools.
 * Without an ID, a row remains visible/favoritable within this saved account. */
export function quotaBucketKey(bucket: QuotaBucket, accountId: string, index: number): string {
  return bucket.bucketId ? JSON.stringify(['bucket', bucket.groupId ?? '', bucket.bucketId, bucket.window ?? '']) : JSON.stringify(['local', accountId, bucket.label, index]);
}
export interface QuotaEntry { key: string; bucket: QuotaBucket; comparable: boolean }
export function quotaEntries(account: LiveAccountView): QuotaEntry[] {
  const buckets = accountQuotaSnapshot(account)?.buckets ?? [];
  const keys = buckets.map((bucket, index) => quotaBucketKey(bucket, account.id, index));
  return buckets.map((bucket, index) => {
    const unique = keys.filter(key => key === keys[index]).length === 1;
    return { key: unique ? keys[index]! : JSON.stringify(['duplicate', account.id, keys[index], index]), bucket, comparable: !!bucket.bucketId && unique };
  });
}
export function quotaChoices(accounts: LiveAccountView[]): { key: string; label: string }[] {
  const choices = new Map<string, string>();
  for (const account of accounts) for (const row of quotaEntries(account)) if (row.comparable) choices.set(row.key, row.bucket.label);
  return [...choices].map(([key, label]) => ({ key, label })).sort((a, b) => a.label.localeCompare(b.label));
}
export function comparedQuota(account: LiveAccountView, key: string): QuotaBucket | undefined {
  return quotaEntries(account).find(row => row.key === key && row.comparable)?.bucket;
}
export function accountDisplayFingerprint(account: { id: string; expectedEmail: string; hostId?: string; capturedAt?: string; migrationState?: string }): string {
  return JSON.stringify([account.id, account.expectedEmail, account.hostId, account.capturedAt, account.migrationState]);
}
