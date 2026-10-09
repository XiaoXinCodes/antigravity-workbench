import { localizeMessage, t as tr } from './i18n';
import { validImageRequestId } from './direct-image-protocol';
import { inspectImageError, safeImageReason, MAX_DIAGNOSTIC_DELAY_SECONDS, type ImageErrorEvidence } from './image-error-evidence';
import { formatImageMessageSummary } from './image-error-message';
/** A bounded, fixed-field account of an image HTTP failure. Never retain a server message or raw body. */
export type ImageHttpCode =
  'IMAGE_DIRECT_AUTH_REQUIRED' | 'IMAGE_DIRECT_FORBIDDEN' | 'IMAGE_DIRECT_MODEL_OR_PROJECT_UNAVAILABLE' |
  'IMAGE_DIRECT_PROJECT_ACCESS_DENIED' | 'IMAGE_DIRECT_QUOTA_EXHAUSTED' | 'IMAGE_DIRECT_QUOTA_LIMITED' |
  'IMAGE_DIRECT_RATE_LIMITED' | 'IMAGE_DIRECT_CONCURRENCY_LIMITED' | 'IMAGE_DIRECT_CAPACITY_UNAVAILABLE' |
  'IMAGE_DIRECT_RESOURCE_EXHAUSTED' | 'IMAGE_DIRECT_SERVICE_UNAVAILABLE' | 'IMAGE_DIRECT_REQUEST_FAILED';
export type ImageProjectSource = 'saved-token' | 'loadCodeAssist';
export type ImageResponseShape = 'structured' | 'unstructured' | 'oversize';
const STATUSES = new Set(['RESOURCE_EXHAUSTED', 'PERMISSION_DENIED', 'NOT_FOUND', 'UNAVAILABLE', 'INVALID_ARGUMENT', 'UNAUTHENTICATED']);
const HARD_QUOTA = new Set(['INSUFFICIENT_QUOTA', 'BILLING_HARD_LIMIT_REACHED']);
const QUOTA = new Set(['QUOTA_EXCEEDED', 'QUOTA_EXHAUSTED', 'DAILY_QUOTA_EXCEEDED']);
const RATE = new Set(['RATE_LIMIT_EXCEEDED', 'RATE_LIMITED', 'TOO_MANY_REQUESTS', 'REQUEST_RATE_LIMIT_EXCEEDED']);
const CONCURRENCY = new Set(['CONCURRENT_REQUESTS_EXCEEDED', 'CONCURRENCY_LIMIT_EXCEEDED']);
const CAPACITY = new Set(['CAPACITY_EXCEEDED', 'MODEL_CAPACITY_EXHAUSTED', 'MODEL_OVERLOADED', 'BACKEND_UNAVAILABLE']);
const MODEL = new Set(['MODEL_NOT_FOUND', 'MODEL_NOT_SUPPORTED', 'MODEL_DISABLED']);
const PROJECT = new Set(['PROJECT_NOT_FOUND', 'PROJECT_NOT_ALLOWED', 'ACCESS_DENIED', 'PERMISSION_DENIED']);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeStatus = (value: unknown): string | undefined => typeof value === 'string' && STATUSES.has(value) ? value : undefined;
const safeReason = safeImageReason;
export function retryAfterSeconds(header: unknown, now = Date.now()): number | undefined {
  if (Array.isArray(header)) header = header.length === 1 ? header[0] : undefined;
  if (typeof header !== 'string' || header.length > 96) return undefined;
  if (/^\d{1,7}$/u.test(header)) { const n = Number(header); return n <= MAX_DIAGNOSTIC_DELAY_SECONDS ? n : undefined; }
  // HTTP-date must have the canonical GMT shape; Date.parse alone accepts numeric and unrelated text.
  if (!/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/u.test(header)) return undefined;
  const date = Date.parse(header);
  if (!Number.isFinite(date)) return undefined;
  const result = Math.ceil((date - now) / 1000);
  return result >= 0 && result <= MAX_DIAGNOSTIC_DELAY_SECONDS ? result : undefined;
}

export interface ImageHttpFailureFields {
  httpStatus: number; serviceStatus?: string; serviceReason?: string; retryAfterSeconds?: number;
  responseShape: ImageResponseShape; requestId?: string; respondedAt: string;
  projectSource?: ImageProjectSource; modelSource?: 'official-hub' | 'saved-account';
  evidence?: ImageErrorEvidence;
}
export type ImageHttpFailure = Error & ImageHttpFailureFields;

function classify(status: number, reason?: string, quotaFailure = false): ImageHttpCode {
  if (status === 401) return 'IMAGE_DIRECT_AUTH_REQUIRED';
  if (reason && HARD_QUOTA.has(reason)) return 'IMAGE_DIRECT_QUOTA_EXHAUSTED';
  if (reason && QUOTA.has(reason)) return 'IMAGE_DIRECT_QUOTA_LIMITED';
  if (reason && RATE.has(reason)) return 'IMAGE_DIRECT_RATE_LIMITED';
  if (reason && CONCURRENCY.has(reason)) return 'IMAGE_DIRECT_CONCURRENCY_LIMITED';
  if (reason && CAPACITY.has(reason)) return 'IMAGE_DIRECT_CAPACITY_UNAVAILABLE';
  if (reason && MODEL.has(reason)) return 'IMAGE_DIRECT_MODEL_OR_PROJECT_UNAVAILABLE';
  if (reason && PROJECT.has(reason)) return 'IMAGE_DIRECT_PROJECT_ACCESS_DENIED';
  if (status === 403) return 'IMAGE_DIRECT_FORBIDDEN';
  if (status === 404) return 'IMAGE_DIRECT_MODEL_OR_PROJECT_UNAVAILABLE';
  if (status === 429) return quotaFailure ? 'IMAGE_DIRECT_QUOTA_LIMITED' : 'IMAGE_DIRECT_RESOURCE_EXHAUSTED';
  if (status === 503) return 'IMAGE_DIRECT_SERVICE_UNAVAILABLE';
  return 'IMAGE_DIRECT_REQUEST_FAILED';
}

/** Keep explicit reasons and fixed diagnostic facts. Message hints never decide the failure code. */
export function imageHttpFailure(status: number, body: unknown, retryHeader: unknown, requestId?: string, shape: ImageResponseShape = 'unstructured', now = Date.now(), excludedText: readonly string[] = []): ImageHttpFailure {
  const root = object(body) && object(body.error) ? body.error : undefined;
  const serviceStatus = safeStatus(root?.status);
  const headerDelay = retryAfterSeconds(retryHeader, now);
  const { serviceReason, quotaFailure, detailDelay, evidence } = inspectImageError(root, retryHeader, headerDelay, excludedText);
  const retryAfter = headerDelay ?? detailDelay;
  const code = classify(status, serviceReason, quotaFailure);
  const error = new Error(code) as ImageHttpFailure;
  error.httpStatus = Number.isSafeInteger(status) && status >= 100 && status <= 599 ? status : 0;
  if (serviceStatus) error.serviceStatus = serviceStatus;
  if (serviceReason) error.serviceReason = serviceReason;
  if (retryAfter !== undefined) error.retryAfterSeconds = retryAfter;
  error.responseShape = shape;
  error.evidence = evidence;
  if (validImageRequestId(requestId)) error.requestId = requestId;
  error.respondedAt = new Date(now).toISOString();
  return error;
}

/** Fixed guidance, with only validated metadata from our own failure object. No raw response text. */
export function formatImageFailure(error: unknown): string {
  if (!(error instanceof Error) || !/^IMAGE_[A-Z_]+$/u.test(error.message)) return 'IMAGE_DIRECT_REQUEST_FAILED';
  const fields = error as Partial<ImageHttpFailure>;
  const hint: Record<string, string> = {
    IMAGE_PROMPT_REQUIRED: tr("directImageHttpError.promptRequired"),
    IMAGE_LOCAL_DIRECTORY_REQUIRED: tr("directImageHttpError.outputRequired"),
    IMAGE_DIRECT_SCOPE_INVALID: tr("directImageHttpError.scopeInvalid"),
    IMAGE_DIRECT_OUTCOME_UNKNOWN: tr("directImageHttpError.outcomeUnknown"),
    IMAGE_CANCELLED: tr("directImageHttpError.cancelled"),
    IMAGE_ACCOUNT_CHECK_TIMEOUT: tr("directImageHttpError.3cacc5a28e"),
    IMAGE_ACCOUNT_CHECK_CANCELLED: tr("directImageHttpError.856e89d10e"),
    IMAGE_SAVED_SELECTION_REQUIRED: tr("directImageHttpError.4d400659b5"),
    IMAGE_SAVED_ACCOUNT_REMOVED: tr("directImageHttpError.defd6b9b84"),
    IMAGE_SAVED_ACCOUNT_CHANGED: tr("directImageHttpError.90992213a2"),
    IMAGE_SAVED_AUTH_REQUIRED: tr("directImageHttpError.34e429bd30"),
    IMAGE_SAVED_AUTH_EXPIRED: tr("directImageHttpError.565c58243c"),
    IMAGE_SAVED_AUTH_PENDING: tr("directImageHttpError.69e6f04f3a"),
    IMAGE_SAVED_MODELS_FORBIDDEN: tr("directImageHttpError.bc9973af3d"),
    IMAGE_SAVED_MODELS_UNAVAILABLE: tr("directImageHttpError.dd2390bbac"),
    IMAGE_SAVED_MODELS_INVALID: tr("directImageHttpError.7f53a3f2dd"),
    IMAGE_SAVED_MODELS_TRANSIENT: tr("directImageHttpError.b484207952"),
    IMAGE_SAVED_MODELS_FAILED: tr("directImageHttpError.f5126937f7"),

    IMAGE_ACCOUNT_RECOVERY_PENDING: tr("directImageHttpError.d54de17dce"),
    IMAGE_ACCOUNT_OPERATION_BUSY: tr("directImageHttpError.047a692b4b"),
    IMAGE_OPERATION_HISTORY_UNAVAILABLE: tr("directImageHttpError.0a2513b436"),
    IMAGE_DIRECT_QUOTA_EXHAUSTED: tr("directImageHttpError.0ab5586c4a"),
    IMAGE_DIRECT_QUOTA_LIMITED: tr("directImageHttpError.62153fd6d6"),
    IMAGE_DIRECT_RATE_LIMITED: tr("directImageHttpError.7d8a2f46e6"),
    IMAGE_DIRECT_CONCURRENCY_LIMITED: tr("directImageHttpError.4b9f543908"),
    IMAGE_DIRECT_CAPACITY_UNAVAILABLE: tr("directImageHttpError.9ebed4e9fd"),
    IMAGE_DIRECT_RESOURCE_EXHAUSTED: tr("directImageHttpError.b84e0a6a29"),
    IMAGE_DIRECT_PROJECT_ACCESS_DENIED: tr("directImageHttpError.3979048a0d"),
    IMAGE_DIRECT_MODEL_OR_PROJECT_UNAVAILABLE: tr("directImageHttpError.293d760e63"),
    IMAGE_DIRECT_SERVICE_UNAVAILABLE: tr("directImageHttpError.436695e441"),
    IMAGE_DIRECT_NO_IMAGE_RETURNED: tr("directImageHttpError.3a4e22016b"),
    IMAGE_DIRECT_NO_CANDIDATE: tr("directImageHttpError.065159b552"),
    IMAGE_DIRECT_CONTENT_BLOCKED: tr("directImageHttpError.035ad37795"),
    IMAGE_DIRECT_RESPONSE_RESTRICTED: tr("directImageHttpError.75a27b9b8b"),
    IMAGE_DIRECT_OUTPUT_LIMIT: tr("directImageHttpError.9c4dcacde9"),
    IMAGE_DIRECT_MODEL_STOPPED: tr("directImageHttpError.07472df397"),
    IMAGE_DIRECT_SERVICE_ERROR: tr("directImageHttpError.b28b6a1eb8"),
  };
  const parts = [error.message];
  const guidance = hint[error.message]; if (guidance) parts.push(guidance);
  if (Number.isSafeInteger(fields.httpStatus) && fields.httpStatus! >= 100 && fields.httpStatus! <= 599) parts.push(`HTTP ${fields.httpStatus}`);
  if (safeStatus(fields.serviceStatus)) parts.push(`Google ${fields.serviceStatus}`);
  if (safeReason(fields.serviceReason)) parts.push(`reason ${fields.serviceReason}`);
  const summary = formatImageMessageSummary(fields.evidence?.messageSummary); if (summary) parts.push(summary);
  if (Number.isSafeInteger(fields.retryAfterSeconds) && fields.retryAfterSeconds! >= 0 && fields.retryAfterSeconds! <= MAX_DIAGNOSTIC_DELAY_SECONDS)
    parts.push(tr("directImageHttpError.959b4a0082", { p0: fields.retryAfterSeconds }));
  if (validImageRequestId(fields.requestId)) parts.push(tr("directImageHttpError.012b82635e", { p0: fields.requestId }));
  if (typeof fields.respondedAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(fields.respondedAt)) parts.push(tr("directImageHttpError.d60dbe2dfc", { p0: fields.respondedAt }));
  if (fields.modelSource === 'saved-account') parts.push(tr("directImageHttpError.749dd05fb7"));
  if (fields.modelSource === 'official-hub') parts.push(tr("directImageHttpError.d72f229625"));
  if (fields.projectSource === 'saved-token') parts.push(tr("directImageHttpError.1b302100e5"));
  if (fields.projectSource === 'loadCodeAssist') parts.push(tr("directImageHttpError.3722e894d5"));
  return parts.join(' · ');
}

/** Failure strings contain a stable code plus separately generated fixed fields.
 * Relocalize only that representation; prompts, account labels and paths never
 * pass through this helper. It also accepts an enclosing generated batch status. */
export function localizeImageFailure(value: string): string {
  const translated = localizeMessage(value);
  if (!/\bIMAGE_[A-Z_]+\b/u.test(value)) return translated;
  return translated.split(' · ').map(localizeMessage).join(' · ');
}
