import { summarizeImageErrorMessage, sanitizeImageMessageSummary, type ImageMessageSummary } from './image-error-message';
/** Fixed facts and canonical message semantics only; arbitrary server prose is not retained. */
export const IMAGE_HTTP_REASONS = [
  'QUOTA_EXCEEDED', 'QUOTA_EXHAUSTED', 'DAILY_QUOTA_EXCEEDED', 'INSUFFICIENT_QUOTA', 'BILLING_HARD_LIMIT_REACHED',
  'RATE_LIMIT_EXCEEDED', 'RATE_LIMITED', 'TOO_MANY_REQUESTS', 'REQUEST_RATE_LIMIT_EXCEEDED',
  'CONCURRENT_REQUESTS_EXCEEDED', 'CONCURRENCY_LIMIT_EXCEEDED',
  'CAPACITY_EXCEEDED', 'MODEL_CAPACITY_EXHAUSTED', 'MODEL_OVERLOADED', 'BACKEND_UNAVAILABLE',
  'MODEL_NOT_FOUND', 'MODEL_NOT_SUPPORTED', 'MODEL_DISABLED', 'PROJECT_NOT_FOUND', 'PROJECT_NOT_ALLOWED', 'ACCESS_DENIED', 'PERMISSION_DENIED',
] as const;
const REASONS = new Set<string>(IMAGE_HTTP_REASONS);
export const MAX_DIAGNOSTIC_DELAY_SECONDS = 30 * 86400;
const SIGNALS = ['minute-rate', 'daily-quota', 'quota-reset', 'capacity', 'concurrency', 'generic-resource'] as const;
const KINDS = ['error-info', 'retry-info', 'quota-failure', 'untyped', 'other'] as const;
const KEYS = ['quotaResetDelay', 'quotaResetTime', 'quota_limit', 'quota_limit_value', 'quota_metric', 'quota_location', 'model', 'service', 'consumer'] as const;
type Signal = typeof SIGNALS[number];
type Kind = typeof KINDS[number];
type MetadataKey = typeof KEYS[number];
type Presence = 'absent' | 'present' | 'invalid';
type DelayState = 'absent' | 'accepted' | 'rejected';
export interface ImageErrorEvidence {
  body: 'error-object' | 'unavailable';
  message: Presence; messageSignals?: Signal[];
  messageSummary?: ImageMessageSummary;
  details: 'absent' | 'array' | 'invalid' | 'over-limit'; detailTypes?: Kind[];
  reasons: 'absent' | 'recognized' | 'unrecognized' | 'mixed' | 'conflicting';
  metadata: Presence; metadataKeys?: MetadataKey[];
  retryHeader: DelayState; retryDetail: DelayState;
  headerDelaySeconds?: number; detailDelaySeconds?: number; quotaResetDelaySeconds?: number;
  quotaResetTime?: string;
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function own(value: unknown, key: string): unknown {
  if (!object(value)) return undefined;
  try { const d = Object.getOwnPropertyDescriptor(value, key); return d && 'value' in d ? d.value : undefined; } catch { return undefined; }
}
export const safeImageReason = (value: unknown): string | undefined => typeof value === 'string' && REASONS.has(value) ? value : undefined;
const delayNumber = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= MAX_DIAGNOSTIC_DELAY_SECONDS;
const timestamp = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/u.test(v) && Number.isFinite(Date.parse(v));

/** Google protobuf Duration and the h/m/s form used by quotaResetDelay; never an instruction to retry. */
export function diagnosticDelay(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.length > 48) return undefined;
  const m = /^(?:(\d{1,3})d)?(?:(\d{1,4})h)?(?:(\d{1,6})m)?(?:(\d{1,7}(?:\.\d{1,9})?)s)?$/u.exec(value);
  if (!m || !m.slice(1).some(x => x !== undefined)) return undefined;
  const n = Math.ceil(Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0));
  return delayNumber(n) ? n : undefined;
}

/** Rebuild stored diagnostics so arbitrary nested values cannot reach logs or a restored webview. */
export function sanitizeImageErrorEvidence(value: unknown): ImageErrorEvidence | undefined {
  const field = <T extends string>(key: string, allowed: readonly T[]): T | undefined => {
    const v = own(value, key); return typeof v === 'string' && allowed.includes(v as T) ? v as T : undefined;
  };
  const body = field('body', ['error-object', 'unavailable']);
  const message = field('message', ['absent', 'present', 'invalid']), details = field('details', ['absent', 'array', 'invalid', 'over-limit']);
  const reasons = field('reasons', ['absent', 'recognized', 'unrecognized', 'mixed', 'conflicting']);
  const metadata = field('metadata', ['absent', 'present', 'invalid']);
  const retryHeader = field('retryHeader', ['absent', 'accepted', 'rejected']), retryDetail = field('retryDetail', ['absent', 'accepted', 'rejected']);
  if (!body || !message || !details || !reasons || !metadata || !retryHeader || !retryDetail) return undefined;
  const out: ImageErrorEvidence = { body, message, details, reasons, metadata, retryHeader, retryDetail };
  const summary = sanitizeImageMessageSummary(own(value, 'messageSummary')); if (summary) out.messageSummary = summary;
  const values = <T extends string>(key: string, allowed: readonly T[]): T[] => {
    const rows = own(value, key); if (!Array.isArray(rows) || rows.length > allowed.length) return [];
    return allowed.filter(x => rows.includes(x));
  };
  const signals = values('messageSignals', SIGNALS), kinds = values('detailTypes', KINDS), keys = values('metadataKeys', KEYS);
  if (signals.length) out.messageSignals = signals;
  if (kinds.length) out.detailTypes = kinds;
  if (keys.length) out.metadataKeys = keys;
  for (const key of ['headerDelaySeconds', 'detailDelaySeconds', 'quotaResetDelaySeconds'] as const) {
    const n = own(value, key); if (delayNumber(n)) out[key] = n;
  }
  const reset = own(value, 'quotaResetTime'); if (timestamp(reset)) out.quotaResetTime = reset;
  return out;
}

export function inspectImageError(root: unknown, retryHeader: unknown, headerDelay: number | undefined, excludedText: readonly string[] = []) {
  const message = own(root, 'message'), details = own(root, 'details');
  const evidence: ImageErrorEvidence = { body: object(root) ? 'error-object' : 'unavailable', message: message === undefined ? 'absent' : typeof message === 'string' ? 'present' : 'invalid',
    details: details === undefined ? 'absent' : !Array.isArray(details) ? 'invalid' : details.length > 24 ? 'over-limit' : 'array',
    reasons: 'absent', metadata: 'absent', retryHeader: retryHeader === undefined ? 'absent' : headerDelay === undefined ? 'rejected' : 'accepted', retryDetail: 'absent' };
  if (headerDelay !== undefined) evidence.headerDelaySeconds = headerDelay;
  evidence.messageSummary = summarizeImageErrorMessage(message, excludedText);
  const semantics = evidence.messageSummary.semantics ?? [];
  const matches: Signal[] = [];
  if (semantics.some(x => ['request-rate', 'token-rate', 'rate-limit'].includes(x))) matches.push('minute-rate');
  if (semantics.includes('daily-limit')) matches.push('daily-quota');
  if (semantics.includes('capacity')) matches.push('capacity');
  if (semantics.includes('concurrency')) matches.push('concurrency');
  if (semantics.includes('generic-resource')) matches.push('generic-resource');
  if (matches.length) evidence.messageSignals = matches;
  const reasons = new Set<string>(), kinds = new Set<Kind>(), keys = new Set<MetadataKey>();
  let unknownReason = false, quotaFailure = false, detailDelay: number | undefined;
  if (Array.isArray(details) && details.length <= 24) for (const item of details) {
    if (!object(item)) { kinds.add('other'); continue; }
    const type = own(item, '@type');
    const kind: Kind = type === 'type.googleapis.com/google.rpc.ErrorInfo' ? 'error-info' : type === 'type.googleapis.com/google.rpc.RetryInfo' ? 'retry-info' :
      type === 'type.googleapis.com/google.rpc.QuotaFailure' ? 'quota-failure' : type === undefined ? 'untyped' : 'other';
    kinds.add(kind);
    if (kind === 'quota-failure') quotaFailure = true;
    if (kind === 'error-info' || kind === 'untyped') {
      const rawReason = own(item, 'reason'), reason = safeImageReason(rawReason);
      if (reason) reasons.add(reason); else if (rawReason !== undefined) unknownReason = true;
      const meta = own(item, 'metadata');
      if (object(meta)) {
        evidence.metadata = 'present';
        for (const key of KEYS) if (own(meta, key) !== undefined) keys.add(key);
        const delay = diagnosticDelay(own(meta, 'quotaResetDelay'));
        if (delay !== undefined) evidence.quotaResetDelaySeconds = Math.max(evidence.quotaResetDelaySeconds ?? 0, delay);
        const reset = own(meta, 'quotaResetTime'); if (timestamp(reset)) evidence.quotaResetTime = reset;
      } else if (meta !== undefined && evidence.metadata !== 'present') evidence.metadata = 'invalid';
    }
    if (kind === 'retry-info') {
      const delay = diagnosticDelay(own(item, 'retryDelay'));
      if (delay === undefined) { if (evidence.retryDetail !== 'accepted') evidence.retryDetail = 'rejected'; }
      else { detailDelay = Math.max(detailDelay ?? 0, delay); evidence.retryDetail = 'accepted'; }
    }
  }
  evidence.reasons = reasons.size > 1 ? 'conflicting' : reasons.size ? unknownReason ? 'mixed' : 'recognized' : unknownReason ? 'unrecognized' : 'absent';
  if (kinds.size) evidence.detailTypes = [...kinds];
  if (keys.size) evidence.metadataKeys = [...keys];
  if (detailDelay !== undefined) evidence.detailDelaySeconds = detailDelay;
  return { evidence, quotaFailure, detailDelay, serviceReason: reasons.size === 1 && !unknownReason ? [...reasons][0] : undefined };
}
