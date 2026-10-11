import { LiveError } from './live-storage';

export type CatalogStage = 'binding' | 'lock' | 'transport' | 'parse';
export type CatalogFailureKind = 'binding' | 'lock' | 'http' | 'network' | 'tls' | 'timeout' | 'parse' | 'unknown';
export interface CatalogFailure { catalogStage: CatalogStage; catalogFailure: CatalogFailureKind; httpStatus?: number }

/** Fixed metadata only. Never keep an exception message, response, identity or bearer. */
export function catalogError(code: string, catalogStage: CatalogStage, catalogFailure: CatalogFailureKind, httpStatus?: number): Error & CatalogFailure {
  return Object.assign(new Error(code), { catalogStage, catalogFailure }, Number.isSafeInteger(httpStatus) && httpStatus! >= 100 && httpStatus! <= 599 ? { httpStatus: httpStatus! } : {});
}
export function catalogFailureDetails(error: unknown): CatalogFailure {
  const own = (key: string) => {
    if (!error || typeof error !== 'object') return undefined;
    try { const descriptor = Object.getOwnPropertyDescriptor(error, key); return descriptor && 'value' in descriptor ? descriptor.value : undefined; } catch { return undefined; }
  };
  const stage = own('catalogStage'), failure = own('catalogFailure'), httpStatus = own('httpStatus');
  if (['binding', 'lock', 'transport', 'parse'].includes(stage as string) && ['binding', 'lock', 'http', 'network', 'tls', 'timeout', 'parse', 'unknown'].includes(failure as string))
    return { catalogStage: stage as CatalogStage, catalogFailure: failure as CatalogFailureKind,
      ...(typeof httpStatus === 'number' && Number.isSafeInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? { httpStatus: httpStatus! } : {}) };
  const code = error instanceof LiveError ? error.code : own('message');
  if (code === 'LIVE_OPERATION_OR_RECOVERY_LOCKED') return { catalogStage: 'lock', catalogFailure: 'lock' };
  if (code === 'IMAGE_SAVED_MODELS_INVALID') return { catalogStage: 'parse', catalogFailure: 'parse' };
  if (code === 'IMAGE_SAVED_MODELS_FAILED' || code === 'IMAGE_SAVED_MODELS_TRANSIENT') return { catalogStage: 'transport', catalogFailure: 'unknown' };
  return { catalogStage: 'binding', catalogFailure: 'binding' };
}
/** Map non-image binding errors without confusing a host lock with an HTTP failure. */
export function catalogErrorCode(error: unknown): string {
  const code = error instanceof LiveError ? error.code : error instanceof Error ? error.message : '';
  if (code.startsWith('IMAGE_') && /^[A-Z_]+$/.test(code)) return code;
  if (code === 'LIVE_OPERATION_OR_RECOVERY_LOCKED') return 'IMAGE_ACCOUNT_OPERATION_BUSY';
  if (code === 'ACCOUNT_QUOTA_FORBIDDEN') return 'IMAGE_SAVED_MODELS_FORBIDDEN';
  if (['ACCOUNT_QUOTA_RESPONSE_INVALID', 'ACCOUNT_QUOTA_RESPONSE_TOO_LARGE'].includes(code)) return 'IMAGE_SAVED_MODELS_INVALID';
  if (/^(ACCOUNT_QUOTA_TIMEOUT|HUB_RPC_TIMEOUT)$/.test(code)) return 'IMAGE_ACCOUNT_CHECK_TIMEOUT';
  if (/REAUTH_REQUIRED|CLIENT_UNVERIFIED|TOKEN_UNSUPPORTED|TOKEN_CONFLICT/.test(code)) return 'IMAGE_SAVED_AUTH_REQUIRED';
  if (/REFRESH_PENDING|REFRESH_OUTCOME_UNKNOWN|SECURE_SAVE_FAILED|REFRESH_SAVE_FAILED/.test(code)) return 'IMAGE_SAVED_AUTH_PENDING';
  if (/REFRESH_CONFLICT|IDENTITY_MISMATCH|IDENTITY_INVALID/.test(code)) return 'IMAGE_SAVED_ACCOUNT_CHANGED';
  return 'IMAGE_SAVED_MODELS_FAILED';
}
