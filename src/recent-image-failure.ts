import { t as tr } from './i18n';
import { debugErrorCode, sanitizeDebugData } from './debug-events';
import { sanitizeImageErrorEvidence, type ImageErrorEvidence } from './image-error-evidence';
import { formatImageMessageSummary } from './image-error-message';
import { sanitizeImageResponseEvidence, trimImageResponseEvidence, type ImageResponseEvidence } from './image-response-evidence';

export const RECENT_IMAGE_FAILURE_KEY = 'image.lastFailure.v1';
export type ImageFailureStage = 'preparing' | 'generating' | 'validating';
export interface RecentImageFailure {
  schema: 1; at: string; operationId: string; modelId: string; stage: ImageFailureStage; code: string;
  httpStatus?: number; serviceStatus?: string; serviceReason?: string; retryAfterSeconds?: number;
  responseShape?: 'structured' | 'unstructured' | 'oversize'; requestId?: string; respondedAt?: string;
  projectSource?: 'saved-token' | 'loadCodeAssist'; modelSource?: 'official-hub' | 'saved-account'; evidence?: ImageErrorEvidence;
  responseEvidence?: ImageResponseEvidence;
}
interface State { get<T>(key: string): T | undefined; update(key: string, value: unknown): Thenable<void> }
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._/-]{2,127}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const STAGES: readonly ImageFailureStage[] = ['preparing', 'generating', 'validating'];
const MAX_BYTES = 4096;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function own(value: unknown, key: string): unknown {
  if (!object(value)) return undefined;
  try { const descriptor = Object.getOwnPropertyDescriptor(value, key); return descriptor && 'value' in descriptor ? descriptor.value : undefined; }
  catch { return undefined; }
}
function validModel(value: unknown): value is string {
  return typeof value === 'string' && MODEL.test(value) && /(?:^|[-_.])image(?:[-_.]|$)/iu.test(value);
}

/** Rebuild from an explicit allowlist before either writing or showing stored state. */
export function readRecentImageFailure(value: unknown): RecentImageFailure | undefined {
  if (own(value, 'schema') !== 1) return undefined;
  const at = own(value, 'at'), operationId = own(value, 'operationId'), modelId = own(value, 'modelId');
  const stage = own(value, 'stage'), code = own(value, 'code');
  if (typeof at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(at) || !Number.isFinite(Date.parse(at)) ||
      typeof operationId !== 'string' || !UUID.test(operationId) || !validModel(modelId) ||
      typeof stage !== 'string' || !STAGES.includes(stage as ImageFailureStage) ||
      typeof code !== 'string' || !/^IMAGE_[A-Z_]{3,64}$/u.test(code) || debugErrorCode(new Error(code)) !== code) return undefined;
  const safe = sanitizeDebugData(value) ?? {};
  const result: RecentImageFailure = { schema: 1, at, operationId, modelId, stage: stage as ImageFailureStage, code };
  if (typeof safe.httpStatus === 'number') result.httpStatus = safe.httpStatus;
  if (typeof safe.serviceStatus === 'string') result.serviceStatus = safe.serviceStatus;
  if (typeof safe.serviceReason === 'string') result.serviceReason = safe.serviceReason;
  if (typeof safe.retryAfterSeconds === 'number') result.retryAfterSeconds = safe.retryAfterSeconds;
  if (safe.responseShape === 'structured' || safe.responseShape === 'unstructured' || safe.responseShape === 'oversize') result.responseShape = safe.responseShape;
  if (typeof safe.requestId === 'string') result.requestId = safe.requestId;
  if (typeof safe.respondedAt === 'string') result.respondedAt = safe.respondedAt;
  if (safe.projectSource === 'saved-token' || safe.projectSource === 'loadCodeAssist') result.projectSource = safe.projectSource;
  if (safe.modelSource === 'official-hub' || safe.modelSource === 'saved-account') result.modelSource = safe.modelSource;
  const evidence = sanitizeImageErrorEvidence(safe.evidence); if (evidence) result.evidence = evidence;
  const responseEvidence = sanitizeImageResponseEvidence(safe.responseEvidence); if (responseEvidence) result.responseEvidence = responseEvidence;
  // Preserve the failure location and aggregate counts even if unusual shapes
  // fill the sample budget. Never discard the entire recent failure for size.
  if (responseEvidence) trimImageResponseEvidence(responseEvidence, () => Buffer.byteLength(JSON.stringify(result)) <= MAX_BYTES);
  return Buffer.byteLength(JSON.stringify(result)) <= MAX_BYTES ? result : undefined;
}

export function captureRecentImageFailure(error: unknown, modelId: string, stage: ImageFailureStage, operationId: string, now = Date.now()): RecentImageFailure {
  const safe = sanitizeDebugData(error) ?? {};
  const observed = debugErrorCode(error);
  const code = observed.startsWith('IMAGE_') ? observed : 'IMAGE_DIRECT_REQUEST_FAILED';
  const value = readRecentImageFailure({ ...safe, schema: 1, at: new Date(now).toISOString(), operationId, modelId, stage, code });
  if (!value) throw new Error('IMAGE_DIRECT_SCOPE_INVALID');
  return value;
}

export function formatRecentImageFailure(value: RecentImageFailure | undefined): string {
  if (!value) return tr("recentImageFailure.da7dbb0c25");
  const parts = [tr("recentImageFailure.8385235236", { p0: value.code }), tr("recentImageFailure.9320aa99ab", { p0: value.modelId }), tr("recentImageFailure.eca56636b9", { p0: value.stage }), tr("recentImageFailure.819b2d029d", { p0: value.operationId }), tr("recentImageFailure.0e74f486cf", { p0: value.at })];
  if (value.httpStatus !== undefined) parts.push(`HTTP ${value.httpStatus}`);
  if (value.serviceStatus) parts.push(`Google ${value.serviceStatus}`);
  if (value.serviceReason) parts.push(`reason ${value.serviceReason}`);
  if (value.retryAfterSeconds !== undefined) parts.push(tr("recentImageFailure.06ea74336b", { p0: value.retryAfterSeconds }));
  if (value.requestId) parts.push(tr("recentImageFailure.012b82635e", { p0: value.requestId }));
  if (value.responseShape) parts.push(tr("recentImageFailure.704b96739f", { p0: value.responseShape }));
  if (value.responseEvidence) {
    const e = value.responseEvidence;
    parts.push(tr("recentImageFailure.2cce6a6a33", { p0: e.failure, p1: e.structure, p2: e.rootType, p3: e.wrapperType, p4: e.candidateCount ?? e.candidatesType, p5: e.partCount ?? e.partsType, p6: e.inlinePartCount ?? 'unknown', p7: e.textPartCount ?? 'unknown' }));
    if (e.transport) parts.push(tr("recentImageFailure.92beab9074", { p0: e.transport.contentType, p1: e.transport.bodyBytes }));
    if (e.partSamples.length) parts.push(tr("recentImageFailure.c241c2b312", { p0: e.partSamples.map(p => tr('recentImageFailure.partCharacters', { p0: p.index, p1: p.mime, p2: p.dataType, p3: p.encodedChars ?? 'unknown' })).join(', ') }));
    if (e.finishReason !== 'missing') parts.push(`finishReason ${e.finishReason}`);
    if (e.blockReason !== 'missing') parts.push(`blockReason ${e.blockReason}`);
    const c = e.completion;
    if (c) {
      parts.push(tr("recentImageFailure.3d7e0e2baa", { p0: c.candidateType, p1: c.contentType, p2: c.role, p3: e.finishReason, p4: c.finishMessage.type, p5: c.finishMessage.chars === undefined ? '' : tr('recentImageFailure.messageCharacters', { p0: c.finishMessage.chars }) }));
      parts.push(tr("recentImageFailure.038e895042", { p0: c.feedback.type, p1: c.feedback.blockReason, p2: c.feedback.blockReasonMessage.type, p3: c.safety.blockedCount ?? 'unknown', p4: c.feedback.safety.blockedCount ?? 'unknown' }));
      if (c.outerFeedback) parts.push(tr("recentImageFailure.ffb95df1ab", { p0: c.outerFeedback.type, p1: c.outerFeedback.blockReason }));
      for (const error of c.errors) parts.push(tr("recentImageFailure.ee7e2d5c63", { p0: error.scope, p1: error.type, p2: error.status, p3: error.code ?? 'unknown', p4: error.message.type, p5: error.detailCount ?? error.detailsType }));
    }
    if (e.truncated) parts.push(tr("recentImageFailure.3e71e25903"));
  }
  if (value.evidence) {
    const e = value.evidence;
    parts.push(tr("recentImageFailure.266ce3183d", { p0: e.body, p1: e.message, p2: e.details, p3: e.reasons, p4: e.metadata, p5: e.retryHeader, p6: e.retryDetail }));
    const summary = formatImageMessageSummary(e.messageSummary);
    if (summary) parts.push(summary);
    else if (e.message === 'present') parts.push(tr("recentImageFailure.3c129393f1"));
    if (e.messageSignals?.length) parts.push(tr("recentImageFailure.9c0cb56a67", { p0: e.messageSignals.join(', ') }));
    if (e.quotaResetDelaySeconds !== undefined) parts.push(tr("recentImageFailure.b30cfa93ac", { p0: e.quotaResetDelaySeconds }));
    if (e.quotaResetTime) parts.push(tr("recentImageFailure.2351f2274d", { p0: e.quotaResetTime }));
  }
  return parts.join(' · ');
}

/** Local VS Code memento, independent of the optional detailed debug recorder. */
export class RecentImageFailureStore {
  private current: RecentImageFailure | undefined;
  constructor(private readonly state: State) {
    try { this.current = readRecentImageFailure(state.get(RECENT_IMAGE_FAILURE_KEY)); }
    catch { this.current = undefined; }
  }
  get(): RecentImageFailure | undefined { return this.current; }
  async save(value: RecentImageFailure): Promise<void> {
    const safe = readRecentImageFailure(value);
    if (!safe) throw new Error('IMAGE_DIRECT_SCOPE_INVALID');
    await this.state.update(RECENT_IMAGE_FAILURE_KEY, safe);
    this.current = safe;
  }
  async clear(): Promise<void> {
    await this.state.update(RECENT_IMAGE_FAILURE_KEY, undefined);
    this.current = undefined;
  }
}
