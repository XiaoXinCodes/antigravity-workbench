import { t as tr } from './i18n';
import { createHash, randomUUID } from 'node:crypto';
import { DebugLogStore } from './debug-log-store';
import { debugErrorCode, sanitizeDebugData } from './debug-events';
import { captureImageResponseEvidence, sanitizeImageResponseEvidence, responseOwn } from './image-response-evidence';
import type { DirectImageRequest } from './direct-image-core';
import { imageEndpoint, imageEndpointHost, validImageRequestId } from './direct-image-protocol';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'];
type Response = { requestId?: string; httpStatus?: number; finishReason?: string; blockReason?: string; candidates?: number; parts?: number; code?: string };
export interface ImageOperationRecord {
  schema: 1; operationId: string; startedAt: string; endedAt?: string;
  accountRef: string; model: string; endpoint: 'daily' | 'production';
  ratio: string; size: string; quality: string; count: number; references: number;
  outcome: 'started' | 'complete' | 'partial' | 'cancelled' | 'failed';
  stage: 'preparing' | 'generating' | 'validating';
  attempted: number; completed: number; artifacts: number; png: number; jpeg: number;
  responses: Response[]; code?: string;
}
const pick = (value: unknown, values: readonly string[], fallback: string): string => typeof value === 'string' && values.includes(value) ? value : fallback;
const count = (value: unknown, max: number): number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max ? value : 0;
const iso = (value: unknown): string | undefined => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) ? value : undefined;
const model = (value: unknown): string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{2,127}$/.test(value) ? value : 'unknown';
export function imageOperationStart(request: DirectImageRequest, operationId?: string): ImageOperationRecord {
  return { schema: 1, operationId: operationId && UUID.test(operationId) ? operationId : randomUUID(), startedAt: new Date().toISOString(),
    accountRef: UUID.test(request.accountId) ? createHash('sha256').update(`image-account:${request.accountId}`).digest('hex').slice(0, 24) : 'unknown',
    model: model(request.modelId), endpoint: imageEndpoint(request.endpoint),
    ratio: pick(request.aspectRatio, RATIOS, 'unknown'), size: pick(request.size ?? 'auto', ['auto', '1K', '2K', '4K'], 'unknown'),
    quality: pick(request.quality ?? 'auto', ['auto', 'detail'], 'unknown'), count: count(request.count ?? 1, 4), references: count(request.references?.length, 3),
    outcome: 'started', stage: 'preparing', attempted: 0, completed: 0, artifacts: 0, png: 0, jpeg: 0, responses: [] };
}
/** Reuse the structural inspector, but retain no failure label for successful responses. */
export function imageOperationResponse(value: unknown): Response {
  const evidence = captureImageResponseEvidence(value, 'no-images');
  return { ...(evidence.transport ? { httpStatus: evidence.transport.httpStatus } : {}), finishReason: evidence.finishReason,
    blockReason: evidence.blockReason, ...(evidence.candidateCount !== undefined ? { candidates: evidence.candidateCount } : {}),
    ...(evidence.partCount !== undefined ? { parts: evidence.partCount } : {}) };
}
export function imageOperationFailure(error: unknown): Response {
  const safe = sanitizeDebugData(error) ?? {};
  const evidence = sanitizeImageResponseEvidence(safe.responseEvidence);
  return { code: debugErrorCode(error), ...(typeof safe.httpStatus === 'number' ? { httpStatus: safe.httpStatus } : {}),
    ...(evidence ? { finishReason: evidence.finishReason, blockReason: evidence.blockReason,
      ...(evidence.transport ? { httpStatus: evidence.transport.httpStatus } : {}),
      ...(evidence.candidateCount !== undefined ? { candidates: evidence.candidateCount } : {}),
      ...(evidence.partCount !== undefined ? { parts: evidence.partCount } : {}) } : {}) };
}
/** Persistence is re-read through a whitelist; arbitrary fields/strings and accessors never reach the UI. */
export function readImageOperation(value: unknown): ImageOperationRecord | undefined {
  const own = (key: string) => responseOwn(value, key);
  const id = own('operationId'), start = iso(own('startedAt')), end = iso(own('endedAt')), ref = own('accountRef');
  const responses = own('responses');
  if (own('schema') !== 1 || typeof id !== 'string' || !UUID.test(id) || !start || typeof ref !== 'string' || !/^(?:[a-f0-9]{24}|unknown)$/.test(ref) || !Array.isArray(responses) || responses.length > 4) return;
  const result: ImageOperationRecord = { schema: 1, operationId: id, startedAt: start, ...(end ? { endedAt: end } : {}), accountRef: ref,
    model: model(own('model')), endpoint: own('endpoint') === 'daily' ? 'daily' : 'production',
    ratio: pick(own('ratio'), RATIOS, 'unknown'), size: pick(own('size'), ['auto', '1K', '2K', '4K'], 'unknown'), quality: pick(own('quality'), ['auto', 'detail'], 'unknown'),
    count: count(own('count'), 4), references: count(own('references'), 3),
    outcome: pick(own('outcome'), ['started', 'complete', 'partial', 'cancelled', 'failed'], 'failed') as ImageOperationRecord['outcome'],
    stage: pick(own('stage'), ['preparing', 'generating', 'validating'], 'preparing') as ImageOperationRecord['stage'],
    attempted: count(own('attempted'), 4), completed: count(own('completed'), 4), artifacts: count(own('artifacts'), 32), png: count(own('png'), 32), jpeg: count(own('jpeg'), 32), responses: [] };
  for (let i = 0; i < responses.length; i++) {
    const row = responseOwn(responses, String(i));
    // The existing inspector supplies its fixed completion enums for a synthetic
    // structure containing only the already-safe scalar fields; no body is stored.
    const summary = imageOperationResponse({ candidates: [{ finishReason: responseOwn(row, 'finishReason') }], promptFeedback: { blockReason: responseOwn(row, 'blockReason') } });
    const http = responseOwn(row, 'httpStatus'), code = responseOwn(row, 'code');
    const requestId = responseOwn(row, 'requestId');
    result.responses.push({ ...(validImageRequestId(requestId) ? { requestId } : {}), ...(typeof http === 'number' && Number.isInteger(http) && http >= 100 && http <= 599 ? { httpStatus: http } : {}),
      ...(responseOwn(row, 'finishReason') !== undefined ? { finishReason: summary.finishReason } : {}),
      ...(responseOwn(row, 'blockReason') !== undefined ? { blockReason: summary.blockReason } : {}),
      ...(responseOwn(row, 'candidates') !== undefined ? { candidates: count(responseOwn(row, 'candidates'), 10000) } : {}),
      ...(responseOwn(row, 'parts') !== undefined ? { parts: count(responseOwn(row, 'parts'), 10000) } : {}),
      ...(typeof code === 'string' ? { code: debugErrorCode(new Error(code)) } : {}) });
  }
  if (typeof own('code') === 'string') result.code = debugErrorCode(new Error(own('code') as string));
  return result;
}
export class ImageOperationJournal {
  private store?: DebugLogStore;
  constructor(directory?: string) { if (directory) this.store = new DebugLogStore(directory); }
  async write(record: ImageOperationRecord): Promise<boolean> {
    const safe = readImageOperation(record);
    if (!safe || !this.store) return false;
    try { await this.store.append(JSON.stringify(safe), () => true); return true; } catch { return false; }
  }
  async read(): Promise<ImageOperationRecord[]> {
    if (!this.store) throw new Error('IMAGE_OPERATION_HISTORY_UNAVAILABLE');
    const records = new Map<string, ImageOperationRecord>();
    for (const line of await this.store.readLines()) {
      try { const safe = readImageOperation(JSON.parse(line)); if (safe) records.set(safe.operationId, safe); } catch { /* Ignore incomplete/invalid records. */ }
    }
    return [...records.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt)).slice(-20);
  }
  dispose(): void { this.store?.dispose(); }
}
export function formatImageOperations(records: ImageOperationRecord[]): string {
  return records.length ? records.map(r => tr("imageOperationRecord.61ad8c9559", { p0: r.startedAt, p1: r.operationId, p2: r.accountRef, p3: r.model, p4: r.endpoint, p5: imageEndpointHost(r.endpoint), p6: r.ratio, p7: r.size, p8: r.quality, p9: r.count, p10: r.attempted, p11: r.completed, p12: r.references, p13: r.outcome === 'started' ? tr("imageOperationRecord.c491cc836e") : r.outcome, p14: r.artifacts, p15: r.png, p16: r.jpeg, p17: r.code ? ` · ${r.code}` : '', p18: r.responses.map((s, i) => tr('imageOperationRecord.response', { p0: i + 1, p1: s.httpStatus ?? tr("imageOperationRecord.e7954a2f3a"), p2: s.finishReason ?? tr("imageOperationRecord.e7954a2f3a"), p3: s.code ? ` · ${s.code}` : '' })).join('\n') })).join('\n\n') : tr("imageOperationRecord.6653890421");
}
