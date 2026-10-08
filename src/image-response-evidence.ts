/** Bounded structural evidence only. No text, arbitrary key names, image data or headers. */
import { captureImageCompletion, sanitizeImageCompletion, trimImageCompletion, imageCompletionCode, type ImageCompletionEvidence } from './image-completion-evidence';
const KEYS = ['response', 'candidates', 'content', 'parts', 'inlineData', 'inline_data', 'mimeType', 'mime_type', 'data', 'text', 'thought', 'thoughtSignature', 'fileData', 'functionCall', 'finishReason', 'finishMessage', 'promptFeedback', 'blockReason', 'blockReasonMessage', 'safetyRatings', 'role', 'index', 'tokenCount', 'citationMetadata', 'groundingMetadata', 'avgLogprobs', 'logprobsResult', 'urlContextMetadata', 'usageMetadata', 'modelVersion', 'responseId', 'error'] as const;
const TYPES = ['unknown', 'missing', 'null', 'object', 'array', 'string', 'number', 'boolean', 'other'] as const;
const FAILURES = ['content-type', 'body-limit', 'json', 'root', 'wrapper', 'candidates', 'parts', 'no-images', 'service-error', 'inline-data', 'mime', 'base64', 'png', 'jpeg', 'image-limit', 'image-bytes-limit'] as const;
const MIMES = ['unknown', 'missing', 'invalid', 'image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif', 'other'] as const;
const CONTENT_TYPES = ['missing', 'application/json', 'text/event-stream', 'text/plain', 'text/html', 'other'] as const;
const FINISH = ['STOP', 'MAX_TOKENS', 'SAFETY', 'RECITATION', 'LANGUAGE', 'OTHER', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT', 'IMAGE_RECITATION', 'NO_IMAGE', 'IMAGE_OTHER', 'MALFORMED_FUNCTION_CALL', 'UNEXPECTED_TOOL_CALL', 'TOO_MANY_TOOL_CALLS', 'MISSING_THOUGHT_SIGNATURE', 'FINISH_REASON_UNSPECIFIED', 'unknown', 'missing', 'unrecognized'] as const;
// Accept schema-v1 block values when reading persisted records.
const BLOCK = [...FINISH, 'BLOCK_REASON_UNSPECIFIED', 'JAILBREAK', 'invalid'] as const;
type FieldType = typeof TYPES[number];
type Failure = typeof FAILURES[number];
interface Shape { keys: (typeof KEYS[number])[]; types: FieldType[]; otherKeys: number }
export interface ImageTransportEvidence { httpStatus: number; contentType: typeof CONTENT_TYPES[number]; bodyBytes: number }
export interface ImageResponseEvidence {
  schema: 1; failure: Failure; structure: 'observed' | 'unavailable'; rootType: FieldType; root: Shape; wrapperType: FieldType;
  payload: Shape; candidatesType: FieldType; candidateCount?: number; candidate: Shape;
  partsType: FieldType; partCount?: number; textPartCount?: number; inlinePartCount?: number;
  finishReason: typeof FINISH[number]; blockReason: typeof BLOCK[number];
  content?: Shape; feedback?: Shape; completion?: ImageCompletionEvidence;
  partSamples: { index: number; shape: Shape; inlineType: FieldType; mime: typeof MIMES[number]; dataType: FieldType; encodedChars?: number }[];
  failedPart?: number; transport?: ImageTransportEvidence; truncated?: true;
}
export function responseOwn(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  try { const d = Object.getOwnPropertyDescriptor(value, key); return d && 'value' in d ? d.value : undefined; } catch { return undefined; }
}
function type(value: unknown): FieldType { return value === undefined ? 'missing' : value === null ? 'null' : Array.isArray(value) ? 'array' : ['object', 'string', 'number', 'boolean'].includes(typeof value) ? typeof value as FieldType : 'other'; }
const number = (value: unknown, max = 64 * 1024 * 1024): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
function shape(value: unknown): Shape {
  const result: Shape = { keys: [], types: [], otherKeys: 0 };
  if (type(value) !== 'object') return result;
  let names: string[]; try { names = Object.keys(value as object); } catch { return result; }
  // Arbitrary response property names might themselves be prompt/token data.
  for (const key of KEYS) if (Object.hasOwn(value as object, key)) { result.keys.push(key); result.types.push(type(responseOwn(value, key))); }
  result.otherKeys = Math.min(10000, names.length - result.keys.length);
  return result;
}
function enumValue<T extends string>(v: unknown, values: readonly T[], fallback: T): T { return typeof v === 'string' && values.includes(v as T) ? v as T : fallback; }
function mime(value: unknown): typeof MIMES[number] { return value === undefined ? 'missing' : typeof value !== 'string' ? 'invalid' : enumValue(value.trim().toLowerCase(), MIMES, 'other'); }
function finish(value: unknown): typeof FINISH[number] { return value === undefined ? 'missing' : enumValue(value, FINISH, 'unrecognized'); }
const transportByResponse = new WeakMap<object, ImageTransportEvidence>();
export function responseContentType(value: unknown): ImageTransportEvidence['contentType'] {
  return value === undefined ? 'missing' : typeof value === 'string' ? enumValue(value.split(';')[0]?.trim().toLowerCase(), CONTENT_TYPES, 'other') : 'other';
}
export function rememberImageTransport(value: unknown, evidence: ImageTransportEvidence): void {
  if (value && typeof value === 'object') transportByResponse.set(value, { ...evidence });
}
export function captureImageResponseEvidence(value: unknown, failure: Failure, failedPart?: number, transport?: ImageTransportEvidence): ImageResponseEvidence {
  const available = !['content-type', 'json', 'body-limit'].includes(failure);
  const object = (v: unknown): boolean => type(v) === 'object';
  const wrapped = responseOwn(value, 'response');
  const hasWrapper = !!value && typeof value === 'object' && Object.hasOwn(value, 'response');
  const payload = hasWrapper ? wrapped : value, candidates = responseOwn(payload, 'candidates');
  const candidate = responseOwn(candidates, '0'), content = responseOwn(candidate, 'content'), parts = responseOwn(content, 'parts');
  const feedback = responseOwn(payload, 'promptFeedback');
  const result: ImageResponseEvidence = { schema: 1, failure, structure: available ? 'observed' : 'unavailable',
    rootType: available ? type(value) : 'unknown', root: shape(value), wrapperType: object(value) ? type(wrapped) : 'unknown',
    payload: shape(payload), candidatesType: object(payload) ? type(candidates) : 'unknown', candidate: shape(candidate),
    partsType: object(content) ? type(parts) : 'unknown',
    finishReason: object(candidate) ? finish(responseOwn(candidate, 'finishReason')) : 'unknown',
    blockReason: !object(payload) ? 'unknown' : feedback === undefined ? 'missing' : object(feedback) ? enumValue(responseOwn(feedback, 'blockReason'), BLOCK, responseOwn(feedback, 'blockReason') === undefined ? 'missing' : 'unrecognized') : 'unknown', partSamples: [] };
  if (available) { result.content = shape(content); result.feedback = shape(feedback); result.completion = captureImageCompletion(value, payload, candidate); }
  if (Array.isArray(candidates)) result.candidateCount = Math.min(candidates.length, 10000);
  if (Array.isArray(parts)) {
    result.partCount = Math.min(parts.length, 10000);
    result.textPartCount = 0; result.inlinePartCount = 0;
    for (let i = 0; i < Math.min(parts.length, 64); i++) {
      const part = responseOwn(parts, String(i));
      if (responseOwn(part, 'text') !== undefined) result.textPartCount++;
      const camel = responseOwn(part, 'inlineData'), snake = responseOwn(part, 'inline_data');
      const inline = camel !== undefined ? camel : snake;
      if (inline === undefined) continue;
      result.inlinePartCount++;
      if (result.partSamples.length < 8) {
        const encoded = responseOwn(inline, 'data'), camelMime = responseOwn(inline, 'mimeType');
        result.partSamples.push({ index: i, shape: shape(part), inlineType: type(inline),
          mime: object(inline) ? mime(camelMime !== undefined ? camelMime : responseOwn(inline, 'mime_type')) : 'unknown', dataType: object(inline) ? type(encoded) : 'unknown',
          ...(typeof encoded === 'string' ? { encodedChars: Math.min(encoded.length, 64 * 1024 * 1024) } : {}) });
      }
    }
  }
  if (number(failedPart, 63)) result.failedPart = failedPart;
  const metadata = transport ?? (value && typeof value === 'object' ? transportByResponse.get(value) : undefined);
  if (metadata) result.transport = { ...metadata };
  return result;
}
function sanitizeShape(value: unknown): Shape | undefined {
  const keys = responseOwn(value, 'keys'), types = responseOwn(value, 'types'), otherKeys = responseOwn(value, 'otherKeys');
  if (!Array.isArray(keys) || !Array.isArray(types) || keys.length > KEYS.length || keys.length !== types.length || !number(otherKeys, 10000)) return undefined;
  const out: Shape = { keys: [], types: [], otherKeys };
  for (let i = 0; i < keys.length; i++) {
    const k = responseOwn(keys, String(i)), t = responseOwn(types, String(i));
    if (typeof k !== 'string' || !KEYS.includes(k as typeof KEYS[number]) || typeof t !== 'string' || !TYPES.includes(t as FieldType)) return undefined;
    out.keys.push(k as typeof KEYS[number]); out.types.push(t as FieldType);
  }
  return out;
}
/** Rebuild persisted/adapter-supplied data without invoking accessors or echoing free text. */
export function sanitizeImageResponseEvidence(value: unknown): ImageResponseEvidence | undefined {
  const field = <T extends string>(key: string, values: readonly T[]): T | undefined => { const v = responseOwn(value, key); return typeof v === 'string' && values.includes(v as T) ? v as T : undefined; };
  const failure = field('failure', FAILURES), rootType = field('rootType', TYPES), wrapperType = field('wrapperType', TYPES), candidatesType = field('candidatesType', TYPES), partsType = field('partsType', TYPES);
  const root = sanitizeShape(responseOwn(value, 'root')), payload = sanitizeShape(responseOwn(value, 'payload')), candidate = sanitizeShape(responseOwn(value, 'candidate'));
  const textPartCount = responseOwn(value, 'textPartCount'), inlinePartCount = responseOwn(value, 'inlinePartCount');
  const finishReason = field('finishReason', FINISH), blockReason = field('blockReason', BLOCK);
  const samples = responseOwn(value, 'partSamples');
  const structure = field('structure', ['observed', 'unavailable']);
  if (responseOwn(value, 'schema') !== 1 || !failure || !structure || !rootType || !wrapperType || !candidatesType || !partsType || !root || !payload || !candidate || !finishReason || !blockReason || (textPartCount !== undefined && !number(textPartCount, 64)) || (inlinePartCount !== undefined && !number(inlinePartCount, 64)) || !Array.isArray(samples) || samples.length > 8) return undefined;
  const out: ImageResponseEvidence = { schema: 1, failure, structure, rootType, wrapperType, candidatesType, partsType, root, payload, candidate,
    ...(number(textPartCount, 64) ? { textPartCount } : {}), ...(number(inlinePartCount, 64) ? { inlinePartCount } : {}), finishReason, blockReason, partSamples: [] };
  if (responseOwn(value, 'truncated') === true) out.truncated = true;
  const content = sanitizeShape(responseOwn(value, 'content')), feedback = sanitizeShape(responseOwn(value, 'feedback'));
  const completion = sanitizeImageCompletion(responseOwn(value, 'completion'));
  if (content) out.content = content;
  if (feedback) out.feedback = feedback;
  if (completion) out.completion = completion;
  for (const key of ['candidateCount', 'partCount', 'failedPart'] as const) { const n = responseOwn(value, key); if (number(n, key === 'failedPart' ? 63 : 10000)) out[key] = n; }
  for (let i = 0; i < samples.length; i++) {
    const item = responseOwn(samples, String(i)), index = responseOwn(item, 'index'), itemShape = sanitizeShape(responseOwn(item, 'shape'));
    const inlineType = responseOwn(item, 'inlineType'), itemMime = responseOwn(item, 'mime'), dataType = responseOwn(item, 'dataType'), encodedChars = responseOwn(item, 'encodedChars');
    if (!number(index, 63) || !itemShape || typeof inlineType !== 'string' || !TYPES.includes(inlineType as FieldType) || typeof itemMime !== 'string' || !MIMES.includes(itemMime as typeof MIMES[number]) || typeof dataType !== 'string' || !TYPES.includes(dataType as FieldType)) return undefined;
    out.partSamples.push({ index, shape: itemShape, inlineType: inlineType as FieldType, mime: itemMime as typeof MIMES[number], dataType: dataType as FieldType, ...(number(encodedChars) ? { encodedChars } : {}) });
  }
  const transport = responseOwn(value, 'transport'), status = responseOwn(transport, 'httpStatus'), contentType = responseOwn(transport, 'contentType'), bodyBytes = responseOwn(transport, 'bodyBytes');
  if (number(status, 599) && status >= 100 && typeof contentType === 'string' && CONTENT_TYPES.includes(contentType as typeof CONTENT_TYPES[number]) && number(bodyBytes)) out.transport = { httpStatus: status, contentType: contentType as typeof CONTENT_TYPES[number], bodyBytes };
  return out;
}
/** Trim only rebuilt allowlisted samples/shapes to fit the caller's record limit.
 * Location, types, MIME summary (when a sample fits), totals and transport survive.
 * Keys/types in a shape are a sample when truncated is true.
 */
export function trimImageResponseEvidence(value: ImageResponseEvidence, fits: () => boolean): void {
  if (fits()) return;
  value.truncated = true;
  while (value.partSamples.length && !fits()) value.partSamples.pop();
  if (value.completion) trimImageCompletion(value.completion, fits);
  for (const shape of [value.payload, value.root, value.candidate, value.content, value.feedback]) {
    if (shape) while (shape.keys.length && !fits()) { shape.keys.pop(); shape.types.pop(); }
  }
  if (!fits()) { delete value.content; delete value.feedback; }
}
export function imageResponseFailure(value: unknown, failure: Failure, failedPart?: number, transport?: ImageTransportEvidence): Error & { responseEvidence: ImageResponseEvidence; httpStatus?: number } {
  const responseEvidence = captureImageResponseEvidence(value, failure, failedPart, transport);
  const classifiable = failure === 'service-error' || failure === 'no-images' ||
    failure === 'candidates' && (['missing', 'null'].includes(responseEvidence.candidatesType) || responseEvidence.candidateCount === 0) ||
    failure === 'parts' && responseEvidence.completion?.candidateType === 'object' &&
      (['missing', 'null'].includes(responseEvidence.partsType) || ['missing', 'null'].includes(responseEvidence.completion.contentType));
  const code = classifiable ? imageCompletionCode(failure, responseEvidence.finishReason, responseEvidence.completion) : 'IMAGE_DIRECT_RESPONSE_INVALID';
  return Object.assign(new Error(code), { responseEvidence,
    ...(responseEvidence.transport ? { httpStatus: responseEvidence.transport.httpStatus } : {}) });
}
