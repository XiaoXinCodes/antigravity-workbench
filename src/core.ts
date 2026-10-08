import { t as tr } from './i18n';
import { createHash } from 'node:crypto';

export const LIMITS = Object.freeze({ inputBytes: 256 * 1024, snapshotBytes: 48 * 1024, buckets: 64, accounts: 100 });
export const FRESH_MS = 5 * 60 * 1000;
export const SWITCH_BLOCKED = tr("core.f31c85cb6c");
export interface QuotaBucket { id: string; remainingFraction: number | null; resetAt: string | null; invalid: boolean }
export interface Snapshot {
  schemaVersion: 1;
  source: 'official-cli-statusline';
  identity: string;
  capturedAt: string;
  quotaState: 'available' | 'missing';
  buckets: QuotaBucket[];
}
export interface Account { identity: string; label: string; snapshot: Snapshot | null }
export type SnapshotAge = 'recent' | 'stale' | 'future';

export class InputError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'InputError'; }
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function safeText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\p{Cc}\p{Bidi_Control}\p{Zl}\p{Zp}]/u.test(value);
}
export function normalizeIdentity(value: unknown): string {
  if (!safeText(value, 254) || value.trim() !== value || /\s/u.test(value)) throw new InputError('INVALID_IDENTITY');
  // Google account emails and LDAP names are matched case-insensitively, without alias/dot rewriting.
  return value.toLowerCase();
}
export function normalizeLabel(value: unknown): string {
  if (!safeText(value, 80)) throw new InputError('INVALID_LABEL');
  const label = value.trim();
  if (!label) throw new InputError('INVALID_LABEL');
  return label;
}
export function identityKey(identity: string): string {
  return createHash('sha256').update(normalizeIdentity(identity), 'utf8').digest('hex');
}
export function parseJson(text: string, maximum = LIMITS.inputBytes): unknown {
  if (Buffer.byteLength(text, 'utf8') > maximum) throw new InputError('INPUT_TOO_LARGE');
  try { return JSON.parse(text) as unknown; } catch { throw new InputError('INVALID_JSON'); }
}
function isoTime(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  // Date.parse silently rolls impossible calendar dates (e.g. February 30) forward.
  const date = value.slice(0, 10);
  if (new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) return null;
  return new Date(time).toISOString();
}
function fraction(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}
export function collectStatusline(value: unknown, now: number = Date.now()): Snapshot {
  if (!record(value) || value.product !== 'antigravity') throw new InputError('WRONG_PRODUCT');
  const identity = normalizeIdentity(value.email);
  const entries = record(value.quota) ? Object.entries(value.quota) : [];
  if (entries.length > LIMITS.buckets) throw new InputError('TOO_MANY_BUCKETS');
  const buckets = entries.map(([id, entry]): QuotaBucket => {
    if (!safeText(id, 128)) throw new InputError('INVALID_BUCKET_ID');
    const raw = record(entry) ? entry : {};
    const remainingFraction = fraction(raw.remaining_fraction);
    const resetAt = isoTime(raw.reset_time);
    return { id, remainingFraction, resetAt, invalid: !record(entry) || (raw.remaining_fraction != null && remainingFraction === null) || (raw.reset_time != null && resetAt === null) };
  });
  return { schemaVersion: 1, source: 'official-cli-statusline', identity, capturedAt: new Date(now).toISOString(), quotaState: buckets.length ? 'available' : 'missing', buckets };
}
export function parseSnapshot(value: unknown, now: number = Date.now()): Snapshot {
  if (!record(value) || value.schemaVersion !== 1 || value.source !== 'official-cli-statusline') throw new InputError('INVALID_SNAPSHOT');
  const identity = normalizeIdentity(value.identity);
  const capturedAt = isoTime(value.capturedAt);
  if (!capturedAt || Date.parse(capturedAt) > now + 60_000) throw new InputError('INVALID_CAPTURE_TIME');
  if (!Array.isArray(value.buckets) || value.buckets.length > LIMITS.buckets) throw new InputError('INVALID_BUCKETS');
  const seen = new Set<string>();
  const buckets = value.buckets.map((entry: unknown): QuotaBucket => {
    if (!record(entry) || !safeText(entry.id, 128) || seen.has(entry.id) || typeof entry.invalid !== 'boolean') throw new InputError('INVALID_BUCKET');
    seen.add(entry.id);
    const remainingFraction = fraction(entry.remainingFraction);
    const resetAt = isoTime(entry.resetAt);
    if ((entry.remainingFraction !== null && remainingFraction === null) || (entry.resetAt !== null && resetAt === null)) throw new InputError('INVALID_BUCKET');
    return { id: entry.id, remainingFraction, resetAt, invalid: entry.invalid };
  });
  const quotaState = buckets.length ? 'available' : 'missing';
  if (value.quotaState !== quotaState) throw new InputError('INVALID_QUOTA_STATE');
  // Rebuild the allowlist even for persisted/imported snapshots. Never retain unknown properties.
  return { schemaVersion: 1, source: 'official-cli-statusline', identity, capturedAt, quotaState, buckets };
}
export function snapshotAge(snapshot: Snapshot, now: number = Date.now()): SnapshotAge {
  const age = now - Date.parse(snapshot.capturedAt);
  return age < -60_000 ? 'future' : age > FRESH_MS ? 'stale' : 'recent';
}
export function addAccount(accounts: readonly Account[], identityInput: string, labelInput: string): Account[] {
  const identity = normalizeIdentity(identityInput.trim());
  const label = normalizeLabel(labelInput);
  if (accounts.some(account => account.identity === identity)) throw new InputError('DUPLICATE_ACCOUNT');
  if (accounts.length >= LIMITS.accounts) throw new InputError('TOO_MANY_ACCOUNTS');
  return [...accounts, { identity, label, snapshot: null }];
}
export function mergeSnapshot(accounts: readonly Account[], snapshot: Snapshot): Account[] {
  const existing = accounts.find(account => account.identity === snapshot.identity);
  if (existing?.snapshot && Date.parse(existing.snapshot.capturedAt) >= Date.parse(snapshot.capturedAt)) return [...accounts];
  if (!existing) return addAccount(accounts, snapshot.identity, snapshot.identity.slice(0, 80)).map(account => account.identity === snapshot.identity ? { ...account, snapshot } : account);
  return accounts.map(account => account.identity === snapshot.identity ? { ...account, snapshot } : account);
}
export function restoreAccounts(value: unknown, now: number = Date.now()): Account[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > LIMITS.accounts) throw new InputError('INVALID_SAVED_ACCOUNTS');
  const seen = new Set<string>();
  return value.map((entry: unknown): Account => {
    if (!record(entry)) throw new InputError('INVALID_SAVED_ACCOUNT');
    const identity = normalizeIdentity(entry.identity);
    if (seen.has(identity)) throw new InputError('DUPLICATE_ACCOUNT');
    seen.add(identity);
    const snapshot = entry.snapshot === null ? null : parseSnapshot(entry.snapshot, now);
    if (snapshot && snapshot.identity !== identity) throw new InputError('IDENTITY_MISMATCH');
    return { identity, label: normalizeLabel(entry.label), snapshot };
  });
}
export function formatBucket(bucket: QuotaBucket): string {
  if (bucket.invalid) return tr("core.59115142b2", { p0: bucket.id });
  if (bucket.remainingFraction === null) return tr("core.26c9a94013", { p0: bucket.id });
  return tr("core.45380869e0", { p0: bucket.id, p1: (bucket.remainingFraction * 100).toFixed(2) });
}
