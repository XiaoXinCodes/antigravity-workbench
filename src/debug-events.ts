import { imageEndpointHost, validImageRequestId } from './direct-image-protocol';
import { sanitizeImageResponseEvidence, trimImageResponseEvidence } from './image-response-evidence';
/** Diagnostics are constructed from fixed fields/enums; no raw log or error capture. */
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { sanitizeDebugStorageError } from './debug-log-store';
import { IMAGE_GUARD_REASONS, sanitizeImageArgumentShape } from './image-guard';
import { IMAGE_HTTP_REASONS, MAX_DIAGNOSTIC_DELAY_SECONDS, sanitizeImageErrorEvidence } from './image-error-evidence';

export const DEBUG_OPERATIONS = ['image.generate', 'account.login', 'account.capture', 'account.switch', 'account.verify', 'account.quota', 'account.restore', 'account.remove', 'account.export', 'account.import', 'account.refresh'] as const;
export type DebugOperation = typeof DEBUG_OPERATIONS[number];
export const DEBUG_PHASES = ['start', 'preparing', 'validating', 'configured', 'spawning', 'probing', 'generating', 'saving', 'running', 'cancelling', 'verifying', 'recovering', 'result', 'status'] as const;
export type DebugPhase = typeof DEBUG_PHASES[number];
export const DEBUG_OUTCOMES = ['completed', 'failed', 'cancelled', 'partial', 'blocked', 'timed_out', 'interrupted'] as const;
export type DebugOutcome = typeof DEBUG_OUTCOMES[number];
const ACCEPTANCE = ['account-saved', 'oauth-original-restored', 'switch-verified', 'restore-verified', 'quota-ready', 'quota-failed', 'account-removed'] as const;
const STATUSES = ['starting', 'running', ...DEBUG_OUTCOMES] as const;
// Deliberate literal allowlist, reviewed when new fixed application codes are added.
const DEBUG_CODES = new Set([
  'NATIVE_HOST_PATH_REQUIRED',
  'WORKSPACE_TRUST_REQUIRED',
  'NATIVE_DESKTOP_REQUIRED',
  'NATIVE_RUNTIME_REQUIRED',
  'REMOTE_HOST_UNVERIFIED',
  'ACCOUNT_ID_COLLISION',
  'ACCOUNT_ID_INVALID',
  'ACCOUNT_QUOTA_ACCOUNT_CHANGED',
  'ACCOUNT_QUOTA_ACCOUNT_INVALID',
  'ACCOUNT_QUOTA_ALREADY_RUNNING',
  'ACCOUNT_QUOTA_CLIENT_UNVERIFIED',
  'ACCOUNT_QUOTA_EMPTY',
  'ACCOUNT_QUOTA_ENDPOINT_BLOCKED',
  'ACCOUNT_QUOTA_FORBIDDEN',
  'ACCOUNT_QUOTA_IDENTITY_INVALID',
  'ACCOUNT_QUOTA_IDENTITY_MISMATCH',
  'ACCOUNT_QUOTA_QUEUE_FULL',
  'ACCOUNT_QUOTA_RATE_LIMITED',
  'ACCOUNT_QUOTA_REAUTH_REQUIRED',
  'ACCOUNT_QUOTA_REDIRECT_BLOCKED',
  'ACCOUNT_QUOTA_REFRESH_CONFLICT',
  'ACCOUNT_QUOTA_REFRESH_OUTCOME_UNKNOWN',
  'ACCOUNT_QUOTA_REFRESH_PENDING',
  'ACCOUNT_QUOTA_REFRESH_RECOVERY_INVALID',
  'ACCOUNT_QUOTA_REFRESH_SAVE_FAILED',
  'ACCOUNT_QUOTA_REQUEST_FAILED',
  'ACCOUNT_QUOTA_RESPONSE_INVALID',
  'ACCOUNT_QUOTA_RESPONSE_TOO_LARGE',
  'ACCOUNT_QUOTA_SECURE_SAVE_FAILED',
  'ACCOUNT_QUOTA_TIMEOUT',
  'ACCOUNT_QUOTA_TOKEN_CONFLICT',
  'ACCOUNT_QUOTA_TOKEN_UNSUPPORTED',
  'ARGUMENT_ALIAS',
  'ARGUMENT_SHAPE',
  'ASPECT_RATIO',
  'CALL_LIMIT',
  'CANCELLED',
  'CAPTURE_HUB_CHANGED',
  'CLOSE_ALL_AGY_PROCESSES',
  'CLOSE_OTHER_AGY_PROCESSES',
  'OFFICIAL_UNOWNED_HUB_TASK_UNKNOWN', 'OFFICIAL_PROCESS_OWNERSHIP_UNVERIFIED',
  'OFFICIAL_HUB_PROCESS_UNVERIFIED', 'OFFICIAL_BACKEND_STOP_TIMEOUT',
  'OFFICIAL_PROCESS_END_UNAVAILABLE', 'OFFICIAL_PROCESS_SELECTION_STALE',
  'OFFICIAL_PROCESS_END_CANCELLED', 'OFFICIAL_PROCESS_END_DENIED',
  'DEBUG_STORAGE_UNAVAILABLE',
  'DIRECTORY_MUST_BE_ABSOLUTE',
  'DIRECTORY_NOT_PRIVATE',
  'DUPLICATE_ACCOUNT',
  'EVENT_SHAPE',
  'EXTERNAL_CHANGE',
  'FRAMEWORK_METADATA',
  'HOST_ACCOUNT_MISMATCH',
  'HOST_ACCOUNT_UNBOUND',
  'HOST_IDENTITY_UNAVAILABLE',
  'HOST_ID_INVALID',
  'HOST_RECOVERY_MISMATCH',
  'HOST_RECOVERY_UNBOUND',
  'HUB_AUTH_INVALID',
  'HUB_CHANGED_DURING_OPERATION',
  'HUB_CHANGED_DURING_QUERY',
  'HUB_EMAIL_MISSING',
  'HUB_FRESH_IDENTITY_REQUIRED',
  'HUB_IDENTITY_NOT_VERIFIED',
  'HUB_QUOTA_ACCOUNT_MISMATCH',
  'HUB_QUOTA_EMPTY',
  'HUB_QUOTA_RESPONSE_INVALID',
  'HUB_RESPONSE_INVALID',
  'HUB_RESPONSE_TOO_LARGE',
  'HUB_RPC_FAILED',
  'HUB_RPC_TIMEOUT',
  'HUB_SIGNED_OUT_NOT_VERIFIED',
  'IDENTITY_MISMATCH',
  'IMAGE_ACCOUNT_RECOVERY_PENDING',
  'RECOVERY_VERIFICATION_TIMEOUT', 'RECOVERY_VERIFICATION_STALE',
  'IMAGE_ACCOUNT_OPERATION_BUSY', 'IMAGE_OPERATION_HISTORY_UNAVAILABLE',
  'ACCOUNT_SWITCH_IMAGE_RUNNING', 'OFFICIAL_COMPONENT_RESTART_UNAVAILABLE', 'OFFICIAL_COMPONENT_RESTART_TIMEOUT', 'SWITCH_FAILED_ORIGINAL_RESTORED',
  'OFFICIAL_COMPONENT_RECONNECT_FAILED', 'OFFICIAL_COMPONENT_FOCUS_FAILED',
  'IMAGE_ARTIFACT_PATH_REJECTED',
  'IMAGE_DIRECT_ACCOUNT_CHANGED',
  'IMAGE_DIRECT_AUTH_REQUIRED',
  'IMAGE_DIRECT_CURRENT_TOKEN_UNAVAILABLE',
  'IMAGE_DIRECT_FORBIDDEN',
  'IMAGE_DIRECT_HOST_MISMATCH',
  'IMAGE_DIRECT_IDENTITY_CHECK_FAILED',
  'IMAGE_DIRECT_IDENTITY_MISMATCH',
  'IMAGE_DIRECT_MODEL_OR_PROJECT_UNAVAILABLE',
  'IMAGE_DIRECT_MODEL_UNVERIFIED',
  'IMAGE_DIRECT_OUTCOME_UNKNOWN',
  'IMAGE_DIRECT_PROJECT_CONFLICT',
  'IMAGE_DIRECT_PROJECT_INVALID',
  'IMAGE_DIRECT_PROJECT_LOOKUP_FAILED',
  'IMAGE_DIRECT_PROJECT_LOOKUP_INVALID',
  'IMAGE_DIRECT_PROJECT_MISSING',
  'IMAGE_DIRECT_QUOTA_EXHAUSTED',
  'IMAGE_DIRECT_QUOTA_LIMITED',
  'IMAGE_DIRECT_RATE_LIMITED',
  'IMAGE_DIRECT_CONCURRENCY_LIMITED',
  'IMAGE_DIRECT_CAPACITY_UNAVAILABLE',
  'IMAGE_DIRECT_RESOURCE_EXHAUSTED',
  'IMAGE_DIRECT_SERVICE_UNAVAILABLE',
  'IMAGE_DIRECT_PROJECT_ACCESS_DENIED',
  'IMAGE_DIRECT_REQUEST_FAILED',
  'IMAGE_DIRECT_RESPONSE_INVALID',
  'IMAGE_DIRECT_NO_IMAGE_RETURNED',
  'IMAGE_DIRECT_NO_CANDIDATE',
  'IMAGE_DIRECT_CONTENT_BLOCKED',
  'IMAGE_DIRECT_RESPONSE_RESTRICTED',
  'IMAGE_DIRECT_OUTPUT_LIMIT',
  'IMAGE_DIRECT_MODEL_STOPPED',
  'IMAGE_DIRECT_SERVICE_ERROR',
  'IMAGE_DIRECT_SCOPE_INVALID',
  'IMAGE_DIRECT_ENDPOINT_INVALID',
  'IMAGE_DIRECT_ENDPOINT_CHANGED',
  'IMAGE_DIRECT_PROJECT_ENDPOINT_MISMATCH',
  'IMAGE_DIRECT_SECRET_INVALID',
  'IMAGE_DIRECT_SECRET_MISSING',
  'IMAGE_DIRECT_SUMMARY_MISMATCH',
  'IMAGE_DIRECT_VAULT_READ_FAILED',
  'IMAGE_AUTH_REQUIRED',
  'IMAGE_CANCELLED',
  'IMAGE_CANCEL_TIMEOUT',
  'IMAGE_CLI_CAPABILITY_MISSING',
  'IMAGE_CLI_INIT_TIMEOUT',
  'IMAGE_CLI_INPUT_FAILED',
  'IMAGE_CLI_MALFORMED_OUTPUT',
  'IMAGE_CLI_MISSING_IMAGE_PATH',
  'IMAGE_CLI_MISSING_RESULT',
  'IMAGE_CLI_NOT_FOUND',
  'IMAGE_CLI_OUTPUT_TOO_LARGE',
  'IMAGE_CLI_PROBE_FAILED',
  'IMAGE_CLI_PROBE_TIMEOUT',
  'IMAGE_CLI_START_FAILED',
  'IMAGE_CLI_VERSION_UNSUPPORTED',
  'IMAGE_CONFIGURATION_CHANGED',
  'IMAGE_CONFIGURATION_TIMEOUT',
  'IMAGE_DIRECTORY_CHANGED',
  'IMAGE_EXTERNAL_CUSTOMIZATIONS_UNSUPPORTED',
  'IMAGE_FILE_CHANGED',
  'IMAGE_GENERATION_FAILED',
  'IMAGE_GENERATION_NOT_CONFIRMED',
  'IMAGE_GUARD_NOT_CONFIRMED',
  'IMAGE_HOOK_PATH_UNSUPPORTED',
  'IMAGE_INVALID_PNG',
  'IMAGE_LINK_REJECTED',
  'IMAGE_LOCAL_DIRECTORY_REQUIRED',
  'IMAGE_LOCAL_IO_ERROR',
  'IMAGE_LOCAL_REFERENCE_REQUIRED',
  'IMAGE_NAME',
  'IMAGE_NATIVE_LINUX_CLI_REQUIRED',
  'IMAGE_OUTPUT_REQUIRED',
  'IMAGE_PARENT_CUSTOMIZATIONS_UNSUPPORTED',
  'IMAGE_PATH_OUTSIDE_OUTPUT',
  'IMAGE_PERMISSION_DENIED',
  'IMAGE_PNG_REQUIRED',
  'IMAGE_PROMPT_INVALID',
  'IMAGE_QUOTA_EXHAUSTED',
  'IMAGE_REQUEST_INVALID',
  'IMAGE_REQUEST_SCOPE_DENIED',
  'IMAGE_SCRIPT_CONSENT_REQUIRED',
  'IMAGE_TEMP_CLEANUP_FAILED',
  'IMAGE_TIMEOUT',
  'IMAGE_TOOL_SCOPE_UNVERIFIED',
  'IMAGE_TRUSTED_LOCAL_DESKTOP_REQUIRED',
  'IMAGE_UNEXPECTED_TOOL',
  'IMAGE_UNSAFE_CLI_SETTINGS',
  'IMAGE_UNSAFE_FILE',
  'IMAGE_WORKER_EXITED',
  'IMAGE_WORKER_START_FAILED',
  'IMAGE_WORKER_TIMEOUT',
  'INPUT_LIMIT',
  'INPUT_TIMEOUT',
  'INPUT_TOO_LARGE',
  'INVALID_BUCKET',
  'INVALID_BUCKETS',
  'INVALID_BUCKET_ID',
  'INVALID_CAPTURE_TIME',
  'INVALID_IDENTITY',
  'INVALID_JSON',
  'INVALID_LABEL',
  'INVALID_QUOTA_STATE',
  'INVALID_SAVED_ACCOUNT',
  'INVALID_SAVED_ACCOUNTS',
  'INVALID_SNAPSHOT',
  'INVALID_SYNTHETIC_SLOT',
  'INVALID_SYNTHETIC_SUBJECT',
  'INVALID_TIMEOUT',
  'INVALID_TRANSACTION_ID',
  'KEYRING_COLLECTION_AMBIGUOUS',
  'KEYRING_ENCODING_INVALID',
  'KEYRING_FILE_IDENTITY_AMBIGUOUS',
  'KEYRING_RESPONSE_INVALID',
  'KEYRING_UNAVAILABLE',
  'KEYRING_WRITE_FAILED',
  'LINUX_KEYRING_SIZE_LIMIT',
  'LOCAL_FILE_REQUIRED',
  'LOCK_CLEANUP_IN_PROGRESS',
  'LOCK_CLEANUP_STATUS_UNKNOWN',
  'LOCK_OPERATION_REQUIRED',
  'LOCK_OWNERSHIP_CHANGED',
  'LOCK_OWNERSHIP_LOST',
  'LOCK_OWNER_INVALID',
  'LOCK_PARENT_UNSAFE',
  'LIVE_OPERATION_OR_RECOVERY_LOCKED',
  'LIVE_OPERATION_IN_PROGRESS',
  'LOCK_BELONGS_TO_OTHER_PROFILE',
  'LOCK_PROCESS_IDENTITY_UNAVAILABLE',
  'LOCK_PROCESS_STATUS_UNKNOWN',
  'LOCK_PROCESS_STILL_ALIVE',
  'LOCK_RECORD_REQUIRES_MANUAL_CHECK',
  'LOCK_RECORD_UNREADABLE',
  'LOCK_RECORD_UNWRITABLE',
  'LOCK_RELEASED',
  'LOCK_REQUIRES_INSPECTION',
  'LOGIN_ACCOUNT_NOT_SAVED',
  'LOGIN_CANCELLED',
  'LOGIN_FAILED_RECOVERY_REQUIRED',
  'LOGIN_HUB_CHANGED',
  'LOGIN_HUB_NOT_VERIFIED',
  'LOGIN_INDEX_NOT_VERIFIED',
  'LOGIN_NOT_AUTHENTICATED',
  'LOGIN_STORAGE_TIMEOUT_RECOVERY_REQUIRED',
  'LOGIN_TIMEOUT',
  'LOGIN_TOKEN_NOT_UPDATED',
  'LOGIN_TRANSACTION_MISMATCH',
  'MACOS_KEYRING_SIZE_LIMIT',
  'MIGRATION_ACCOUNTS_INVALID',
  'MIGRATION_ACCOUNT_INVALID',
  'MIGRATION_ACCOUNT_SELECTION_INVALID',
  'MIGRATION_ARCHIVE_INVALID',
  'MIGRATION_ARCHIVE_TOO_LARGE',
  'MIGRATION_ARGUMENTS_UNSUPPORTED',
  'MIGRATION_DECRYPT_FAILED',
  'MIGRATION_DUPLICATE_ACCOUNT',
  'MIGRATION_ENCRYPT_FAILED',
  'MIGRATION_FILE_CHANGED',
  'MIGRATION_EXPORT_FILE_CHANGED',
  'MIGRATION_FILE_EXISTS',
  'MIGRATION_FILE_READ_FAILED',
  'MIGRATION_FILE_URI_INVALID',
  'MIGRATION_FILE_WRITE_FAILED',
  'MIGRATION_EXPORT_CONFIRM_REQUIRED',
  'MIGRATION_EXPORT_BUSY',
  'MIGRATION_EXPORT_NAME_INVALID',
  'MIGRATION_IMPORT_FAILED',
  'MIGRATION_INDEX_CHANGED',
  'MIGRATION_PASSWORD_INVALID',
  'MIGRATION_PASSWORD_MISMATCH',
  'MIGRATION_PATH_UNSAFE',
  'MIGRATION_PAYLOAD_INVALID',
  'MIGRATION_RECOVERY_INVALID',
  'MIGRATION_RECOVERY_REQUIRED',
  'MIGRATION_ROLLBACK_REQUIRED',
  'MIGRATION_TARGET_SIZE_LIMIT',
  'MIGRATION_TOKEN_CONFLICT',
  'MIGRATION_TOKEN_INVALID',
  'NATIVE_HELPER_TIMEOUT_OR_LIMIT',
  'NATIVE_HELPER_UNAVAILABLE',
  'NO_LOGIN_TO_CAPTURE',
  'NO_LOGIN_TO_INSTALL',
  'NO_RECOVERY_BACKUP',
  'NO_RESTORATION_TO_VERIFY',
  'NO_SAVED_OFFICIAL_LOGIN',
  'NO_SWITCH_TO_VERIFY',
  'OFFICIAL_BACKEND_CONTRACT_UNVERIFIED',
  'OFFICIAL_BACKEND_NOT_STOPPED',
  'OFFICIAL_BACKEND_UNAVAILABLE',
  'OFFICIAL_ENTRY_UNAVAILABLE',
  'OFFICIAL_EXTENSION_CONTRACT_UNVERIFIED',
  'OFFICIAL_EXTENSION_MISSING',
  'OFFICIAL_FILE_CHANGED',
  'OFFICIAL_FILE_ENCODING_INVALID',
  'OFFICIAL_FILE_READ_FAILED',
  'OFFICIAL_FILE_UNSAFE',
  'OFFICIAL_HOST_MISMATCH',
  'OFFICIAL_HUB_API_UNAVAILABLE',
  'OFFICIAL_HUB_NOT_READY',
  'OFFICIAL_LIFECYCLE_NOT_LOADED',
  'OFFICIAL_PATH_UNSAFE',
  'OFFICIAL_STORAGE_CAPTURE_ONLY',
  'OFFICIAL_STORAGE_CHANGED',
  'OFFICIAL_STORAGE_MODE_CHANGED',
  'OFFICIAL_STORAGE_MODE_MISMATCH',
  'OFFICIAL_STORAGE_READBACK_FAILED',
  'OFFICIAL_STORAGE_SCOPE_MISMATCH',
  'OFFICIAL_WSL_BACKEND_CONTRACT_UNVERIFIED',
  'OFFICIAL_WSL_EXECUTABLE_INVALID',
  'ONLY_PERSONAL_OAUTH_SUPPORTED',
  'OPEN_OFFICIAL_ANTIGRAVITY_FIRST',
  'ORIGINAL_SESSION_UNVERIFIED',
  'OVERRIDE_OR_REMOTE_AUTH_UNSUPPORTED',
  'PLATFORM_UNSUPPORTED',
  'PROCESS_CHECK_FAILED',
  'PROMPT',
  'QUOTA_QUERY_CANCELLED',
  'QUOTA_QUERY_FAILED',
  'QUOTA_QUERY_TIMEOUT',
  'QUOTA_REPORT_EMPTY',
  'RECOVERY_CHANGED',
  'RECOVERY_DELETE_FAILED',
  'RECOVERY_IDENTITY_UNAVAILABLE',
  'RECOVERY_LOCK_OWNER_MISMATCH',
  'RECOVERY_PENDING',
  'RECOVERY_RECORD_CONFLICT',
  'RECOVERY_RECORD_INVALID',
  'RECOVERY_RESTORE_NOT_VERIFIED',
  'RECOVERY_SAVE_NOT_VERIFIED',
  'RECOVERY_STORAGE_NOT_VERIFIED',
  'REFERENCE_COUNT',
  'REFERENCE_PATH',
  'REFERENCE_SHAPE',
  'SAVED_ACCOUNT_LIMIT',
  'SAVED_DATA_REQUIRES_REPAIR',
  'SECURE_LOGIN_INVALID',
  'SECURE_LOGIN_MISSING',
  'SECURE_REMOVE_NOT_VERIFIED',
  'SECURE_SAVE_NOT_VERIFIED',
  'STATE_IO',
  'STORAGE_BUSY',
  'STORAGE_CONFLICT',
  'STORED_TOKEN_EMAIL_MISMATCH',
  'SWITCH_FAILED_RECOVERY_REQUIRED',
  'SWITCH_FAILED_STORAGE_RESTORED_RELOAD_REQUIRED',
  'SWITCH_INSTALL_NOT_VERIFIED',
  'SWITCH_TIMEOUT_RECOVERY_REQUIRED',
  'TEMP_CLEANUP_FAILED',
  'TOKEN_FORMAT_UNSUPPORTED',
  'TOKEN_SIZE_INVALID',
  'TOOL_NAME',
  'TOO_MANY_ACCOUNTS',
  'TOO_MANY_BUCKETS',
  'UNCLASSIFIED_ERROR',
  'UNKNOWN_ARGUMENT',
  'UNSAFE_DIRECTORY',
  'UNSAFE_SNAPSHOT_FILE',
  'USAGE',
  'VERIFICATION_RETRY_REQUIRED',
  'VERIFICATION_STORAGE_MISMATCH',
  'WRONG_PRODUCT',
  'WSL_FILE_IDENTITY_UNVERIFIED',
  'WSL_FILE_ROUTE_UNVERIFIED',
]);
export interface DebugMetadata { version: unknown; platform: unknown; host: unknown }
export interface DebugSpan { event(phase: DebugPhase, data?: unknown): void; end(outcome: DebugOutcome, data?: unknown): void }
export interface DebugStore { append(line: string, shouldWrite: () => boolean): Promise<void>; readLines(): Promise<string[]>; flush(): Promise<void>; dispose(): void }
export interface DebugEvent { schema: 1; at: string; version: string; platform: string; host: string; operation: DebugOperation; operationId: string; phase: DebugPhase; elapsedMs: number; outcome?: DebugOutcome; data?: Record<string, unknown> }
/** Own data properties only: never call getters, toJSON, toString, prototypes or raw error serialization. */
function own(value: unknown, key: string): unknown {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
  try { const descriptor = Object.getOwnPropertyDescriptor(value, key); return descriptor && 'value' in descriptor ? descriptor.value : undefined; } catch { return undefined; }
}
function member<T extends string>(value: unknown, values: readonly T[]): value is T { return typeof value === 'string' && values.includes(value as T); }
function code(value: unknown): string { return typeof value === 'string' && DEBUG_CODES.has(value) ? value : 'UNCLASSIFIED_ERROR'; }
export function debugErrorCode(error: unknown): string { return code(own(error, 'code') ?? own(error, 'message')); }
export function debugFailureOutcome(value: unknown): DebugOutcome {
  const safe = code(value);
  if (['IMAGE_CANCELLED', 'LOGIN_CANCELLED', 'QUOTA_QUERY_CANCELLED'].includes(safe)) return 'cancelled';
  if (['IMAGE_TIMEOUT', 'IMAGE_WORKER_TIMEOUT', 'IMAGE_CANCEL_TIMEOUT', 'IMAGE_CONFIGURATION_TIMEOUT', 'LOGIN_TIMEOUT', 'QUOTA_QUERY_TIMEOUT', 'ACCOUNT_QUOTA_TIMEOUT', 'IMAGE_CLI_INIT_TIMEOUT', 'IMAGE_CLI_PROBE_TIMEOUT', 'HUB_RPC_TIMEOUT'].includes(safe)) return 'timed_out';
  return 'failed';
}
function count(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 10000; }
export function sanitizeDebugData(value: unknown): Record<string, unknown> | undefined {
  const result: Record<string, unknown> = {};
  const errorCode = own(value, 'code'); if (errorCode !== undefined) result.code = code(errorCode);
  const endpoint = own(value, 'imageEndpoint');
  if (endpoint === 'daily' || endpoint === 'production') {
    result.imageEndpoint = endpoint;
    result.imageHost = imageEndpointHost(endpoint);
  }
  const httpStatus = own(value, 'httpStatus');
  if (typeof httpStatus === 'number' && Number.isSafeInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599) result.httpStatus = httpStatus;
  const serviceStatus = own(value, 'serviceStatus');
  if (member(serviceStatus, ['RESOURCE_EXHAUSTED', 'PERMISSION_DENIED', 'NOT_FOUND', 'UNAVAILABLE', 'INVALID_ARGUMENT', 'UNAUTHENTICATED'])) result.serviceStatus = serviceStatus;
  const serviceReason = own(value, 'serviceReason');
  if (member(serviceReason, IMAGE_HTTP_REASONS)) result.serviceReason = serviceReason;
  const retryAfterSeconds = own(value, 'retryAfterSeconds');
  if (typeof retryAfterSeconds === 'number' && Number.isSafeInteger(retryAfterSeconds) && retryAfterSeconds >= 0 && retryAfterSeconds <= MAX_DIAGNOSTIC_DELAY_SECONDS) result.retryAfterSeconds = retryAfterSeconds;
  const evidence = sanitizeImageErrorEvidence(own(value, 'evidence')); if (evidence) result.evidence = evidence;
  const responseEvidence = sanitizeImageResponseEvidence(own(value, 'responseEvidence')); if (responseEvidence) result.responseEvidence = responseEvidence;
  const responseShape = own(value, 'responseShape');
  if (member(responseShape, ['structured', 'unstructured', 'oversize'])) result.responseShape = responseShape;
  const requestId = own(value, 'requestId');
  if (validImageRequestId(requestId)) result.requestId = requestId;
  const respondedAt = own(value, 'respondedAt');
  if (typeof respondedAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(respondedAt) && Number.isFinite(Date.parse(respondedAt))) result.respondedAt = respondedAt;
  const projectSource = own(value, 'projectSource');
  if (member(projectSource, ['saved-token', 'loadCodeAssist'])) result.projectSource = projectSource;
  if (own(value, 'modelSource') === 'official-hub' || own(value, 'modelSource') === 'saved-account') result.modelSource = own(value, 'modelSource');
  for (const key of ['count', 'completedCount', 'requestedCount'] as const) { const v = own(value, key); if (count(v)) result[key] = v; }
  const acceptance = own(value, 'acceptance'); if (member(acceptance, ACCEPTANCE)) result.acceptance = acceptance;
  const status = own(value, 'status'); if (member(status, STATUSES)) result.status = status;
  const guard = own(value, 'guard'), reason = own(guard, 'reason'), generationAllowed = own(guard, 'generationAllowed');
  if (own(guard, 'version') === 1 && member(reason, IMAGE_GUARD_REASONS) && (typeof generationAllowed === 'boolean' || generationAllowed === 'unknown')) { const argumentShape = sanitizeImageArgumentShape(own(guard, 'argumentShape')); result.guard = { version: 1, reason, generationAllowed, ...(argumentShape ? {argumentShape} : {}) }; }
  return Object.keys(result).length ? result : undefined;
}
export function debugErrorData(error: unknown): Record<string, unknown> { return {...sanitizeDebugData(error), code: debugErrorCode(error)}; }
function metadata(value: DebugMetadata): {version: string; platform: string; host: string} {
  const version = value.version, platform = value.platform, host = value.host;
  return { version: typeof version === 'string' && /^\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(version) ? version : 'unknown', platform: member(platform, ['win32', 'darwin', 'linux']) ? platform : 'unknown', host: member(host, ['local', 'wsl', 'remote', 'web']) ? host : 'unknown' };
}
/** Rebuild persisted events before preview/export; disk content is never emitted verbatim. */
export function sanitizeStoredDebugEvent(value: unknown): DebugEvent | undefined {
  const at = own(value, 'at'), operation = own(value, 'operation'), operationId = own(value, 'operationId'), phase = own(value, 'phase'), elapsedMs = own(value, 'elapsedMs'), outcome = own(value, 'outcome');
  if (own(value, 'schema') !== 1 || typeof at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(at) || !Number.isFinite(Date.parse(at)) || !member(operation, DEBUG_OPERATIONS) || typeof operationId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(operationId) || !member(phase, DEBUG_PHASES) || typeof elapsedMs !== 'number' || !Number.isSafeInteger(elapsedMs) || elapsedMs < 0 || elapsedMs > 7 * 86400000 || (outcome !== undefined && !member(outcome, DEBUG_OUTCOMES))) return undefined;
  const data = sanitizeDebugData(own(value, 'data'));
  return { schema: 1, at, ...metadata({version: own(value, 'version'), platform: own(value, 'platform'), host: own(value, 'host')}), operation, operationId, phase, elapsedMs, ...(outcome === undefined ? {} : {outcome}), ...(data ? {data} : {}) };
}
const EMPTY_SPAN: DebugSpan = Object.freeze({ event() {}, end() {} });
export class DebugRecorder {
  private enabled = false;
  private disposed = false;
  private epoch = 0;
  private failure = false;
  private readonly info: ReturnType<typeof metadata>;
  constructor(private readonly store: DebugStore, info: DebugMetadata, private readonly changed: () => void = () => undefined) { this.info = metadata(info); }
  private notify(): void { try { this.changed(); } catch { /* A stale/disposed view cannot break logging. */ } }
  getState(): { enabled: boolean; storageUnavailable: boolean } { return { enabled: this.enabled && !this.disposed, storageUnavailable: this.failure }; }
  async setEnabled(enabled: boolean): Promise<void> {
    if (this.disposed || enabled === this.enabled) return;
    this.enabled = enabled; this.epoch++; this.failure = false;
    // Flip the generation synchronously, then drain in-flight writes before OFF is reported.
    if (!enabled) { try { await this.store.flush(); } catch { this.failure = true; } }
    this.notify();
  }
  begin(operation: DebugOperation, requestedOperationId?: string): DebugSpan {
    if (!this.enabled || this.disposed || this.failure || !member(operation, DEBUG_OPERATIONS)) return EMPTY_SPAN;
    const epoch = this.epoch, operationId = typeof requestedOperationId === 'string' &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(requestedOperationId)
      ? requestedOperationId : randomUUID(), start = performance.now(); let ended = false;
    const current = (): boolean => this.enabled && !this.disposed && !this.failure && epoch === this.epoch;
    const write = (phase: DebugPhase, input?: unknown, outcome?: DebugOutcome): void => {
      if (!current() || ended || !member(phase, DEBUG_PHASES)) return;
      const data = sanitizeDebugData(input);
      const event: DebugEvent = { schema: 1, at: new Date().toISOString(), ...this.info, operation, operationId, phase, elapsedMs: Math.min(7 * 86400000, Math.max(0, Math.floor(performance.now() - start))), ...(outcome ? {outcome} : {}), ...(data ? {data} : {}) };
      const responseEvidence = sanitizeImageResponseEvidence(data?.responseEvidence);
      if (data && responseEvidence) {
        data.responseEvidence = responseEvidence;
        trimImageResponseEvidence(responseEvidence, () => Buffer.byteLength(JSON.stringify(event)) + 1 <= 2048);
      }
      const fail = (): void => { if (!this.disposed && !this.failure) { this.failure = true; this.notify(); } };
      try { void this.store.append(JSON.stringify(event), current).catch(fail); } catch { fail(); }
    };
    write('start');
    return { event: (phase, data) => write(phase, data), end: (outcome, data) => { if (!member(outcome, DEBUG_OUTCOMES)) return; write('result', data, outcome); ended = true; } };
  }
  async preview(): Promise<string> {
    try {
      await this.store.flush();
      const lines = await this.store.readLines(), events: string[] = [];
      for (const line of lines) {
        if (Buffer.byteLength(line) > 2048) continue;
        try { const item = sanitizeStoredDebugEvent(JSON.parse(line) as unknown); if (item) events.push(JSON.stringify(item)); } catch { /* Discard malformed or unrecognized records. */ }
      }
      return events.join('\n') + (events.length ? '\n' : '');
    } catch (error) { this.failure = true; this.notify(); throw sanitizeDebugStorageError(error); }
  }
  dispose(): void { if (!this.disposed) { this.disposed = true; this.enabled = false; this.epoch++; this.store.dispose(); } }
}
let recorder: DebugRecorder | undefined;
export function installDebugRecorder(value: DebugRecorder): { dispose(): void } { recorder = value; return { dispose: () => { if (recorder === value) recorder = undefined; value.dispose(); } }; }
/** This facade is deliberately inert unless the explicit current-window toggle is ON. */
export function beginDebugOperation(operation: DebugOperation, operationId?: string): DebugSpan { try { return recorder?.begin(operation, operationId) ?? EMPTY_SPAN; } catch { return EMPTY_SPAN; } }
