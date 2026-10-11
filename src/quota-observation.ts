/** Display/history identity only. Never use this in request, credential or task guards. */
export interface QuotaObservationAccount {
  id: string; expectedEmail: string; hostId?: string; capturedAt?: string;
  migrationState?: string; quotaDisplayId?: string; verifiedSubject?: string;
}
export function validQuotaDisplayId(value: unknown): value is string {
  return typeof value === 'string' && (/^[a-f0-9-]{36}$/.test(value) || value.length <= 40 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)));
}
export function quotaObservationFingerprint(account: QuotaObservationAccount): string {
  return JSON.stringify([account.id, account.expectedEmail, account.hostId, account.quotaDisplayId ?? account.capturedAt, account.migrationState,
    ...(account.verifiedSubject ? [account.verifiedSubject] : [])]);
}
export function quotaObservationMatches(account: QuotaObservationAccount, fingerprint: string): boolean {
  if (quotaObservationFingerprint(account) === fingerprint) return true;
  // Existing history used the capture timestamp. A normal recapture retains that
  // origin; explicit record replacement assigns a new UUID and cannot match it.
  const origin = account.quotaDisplayId ?? account.capturedAt;
  return typeof origin === 'string' && Number.isFinite(Date.parse(origin)) &&
    fingerprint === JSON.stringify([account.id, account.expectedEmail, account.hostId, origin, account.migrationState]);
}
