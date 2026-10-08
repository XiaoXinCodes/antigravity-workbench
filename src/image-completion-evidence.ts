/** Completion metadata only: no response prose, prompt, image bytes, IDs or arbitrary keys. */
const TYPES = ['unknown', 'missing', 'null', 'object', 'array', 'string', 'number', 'boolean', 'other'] as const;
const ROLES = ['model', 'user', 'missing', 'invalid', 'unrecognized', 'unknown'] as const;
const BLOCKS = ['BLOCK_REASON_UNSPECIFIED', 'SAFETY', 'OTHER', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'IMAGE_SAFETY', 'JAILBREAK', 'missing', 'invalid', 'unrecognized', 'unknown'] as const;
const CATEGORIES = ['HARM_CATEGORY_UNSPECIFIED', 'HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH', 'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_DANGEROUS_CONTENT', 'HARM_CATEGORY_CIVIC_INTEGRITY', 'HARM_CATEGORY_IMAGE_HATE', 'HARM_CATEGORY_IMAGE_DANGEROUS_CONTENT', 'HARM_CATEGORY_IMAGE_HARASSMENT', 'HARM_CATEGORY_IMAGE_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_JAILBREAK', 'missing', 'invalid', 'unrecognized'] as const;
const LEVELS = ['HARM_PROBABILITY_UNSPECIFIED', 'HARM_SEVERITY_UNSPECIFIED', 'NEGLIGIBLE', 'LOW', 'MEDIUM', 'HIGH', 'HARM_SEVERITY_NEGLIGIBLE', 'HARM_SEVERITY_LOW', 'HARM_SEVERITY_MEDIUM', 'HARM_SEVERITY_HIGH', 'missing', 'invalid', 'unrecognized'] as const;
const STATUSES = ['OK', 'CANCELLED', 'UNKNOWN', 'INVALID_ARGUMENT', 'DEADLINE_EXCEEDED', 'NOT_FOUND', 'ALREADY_EXISTS', 'PERMISSION_DENIED', 'RESOURCE_EXHAUSTED', 'FAILED_PRECONDITION', 'ABORTED', 'OUT_OF_RANGE', 'UNIMPLEMENTED', 'INTERNAL', 'UNAVAILABLE', 'DATA_LOSS', 'UNAUTHENTICATED', 'missing', 'invalid', 'unrecognized'] as const;
type FieldType = typeof TYPES[number];
interface TextField { type: FieldType; chars?: number }
interface Safety {
  type: FieldType; count?: number; blockedCount?: number;
  samples: { category: typeof CATEGORIES[number]; probability: typeof LEVELS[number]; severity: typeof LEVELS[number]; blocked: 'true' | 'false' | 'missing' | 'invalid' }[];
}
interface Feedback { type: FieldType; blockReason: typeof BLOCKS[number]; blockReasonMessage: TextField; safety: Safety }
interface ServiceError { scope: 'root' | 'payload'; type: FieldType; status: typeof STATUSES[number]; code?: number; message: TextField; detailsType: FieldType; detailCount?: number }
export interface ImageCompletionEvidence {
  candidateType: FieldType; contentType: FieldType; role: typeof ROLES[number]; finishMessage: TextField;
  safety: Safety; feedback: Feedback; outerFeedback?: Feedback; errors: ServiceError[];
}
function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  try { const d = Object.getOwnPropertyDescriptor(value, key); return d && 'value' in d ? d.value : undefined; } catch { return undefined; }
}
function type(v: unknown): FieldType { return v === undefined ? 'missing' : v === null ? 'null' : Array.isArray(v) ? 'array' : ['object', 'string', 'number', 'boolean'].includes(typeof v) ? typeof v as FieldType : 'other'; }
function member<T extends string>(v: unknown, values: readonly T[]): v is T { return typeof v === 'string' && values.includes(v as T); }
function enumValue<T extends string>(v: unknown, values: readonly T[]): T | 'missing' | 'invalid' | 'unrecognized' {
  return v === undefined ? 'missing' : typeof v !== 'string' ? 'invalid' : member(v, values) ? v : 'unrecognized';
}
const count = (v: unknown, max = 10000): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= max;
const text = (v: unknown): TextField => ({ type: type(v), ...(typeof v === 'string' ? { chars: Math.min(v.length, 64 * 1024 * 1024) } : {}) });
function safety(v: unknown): Safety {
  const out: Safety = { type: type(v), samples: [] };
  if (!Array.isArray(v)) return out;
  out.count = Math.min(v.length, 10000); out.blockedCount = 0;
  // Limit inspection as well as storage. A truncated array cannot prove absence of blocking.
  for (let i = 0; i < Math.min(v.length, 64); i++) {
    const rating = own(v, String(i)), blocked = own(rating, 'blocked');
    if (blocked === true) out.blockedCount++;
    if (i < 4) out.samples.push({ category: enumValue(own(rating, 'category'), CATEGORIES),
      probability: enumValue(own(rating, 'probability'), LEVELS), severity: enumValue(own(rating, 'severity'), LEVELS),
      blocked: blocked === true ? 'true' : blocked === false ? 'false' : blocked === undefined ? 'missing' : 'invalid' });
  }
  if (v.length > 64) delete out.blockedCount;
  return out;
}
function feedback(v: unknown): Feedback {
  return { type: type(v), blockReason: type(v) === 'object' ? enumValue(own(v, 'blockReason'), BLOCKS) : v === undefined ? 'missing' : 'unknown',
    blockReasonMessage: text(own(v, 'blockReasonMessage')), safety: safety(own(v, 'safetyRatings')) };
}
export function captureImageCompletion(value: unknown, payload: unknown, candidate: unknown): ImageCompletionEvidence {
  const content = own(candidate, 'content');
  const out: ImageCompletionEvidence = { candidateType: type(candidate), contentType: type(candidate) === 'object' ? type(content) : 'unknown',
    role: type(content) === 'object' ? enumValue(own(content, 'role'), ROLES) : 'unknown',
    finishMessage: text(own(candidate, 'finishMessage')), safety: safety(own(candidate, 'safetyRatings')),
    feedback: feedback(own(payload, 'promptFeedback')), errors: [] };
  if (value !== payload && own(value, 'promptFeedback') !== undefined) out.outerFeedback = feedback(own(value, 'promptFeedback'));
  for (const [scope, parent] of (value === payload ? [['payload', payload]] : [['root', value], ['payload', payload]]) as ['root' | 'payload', unknown][]) {
    const error = own(parent, 'error'); if (error === undefined) continue;
    const code = own(error, 'code'), details = own(error, 'details');
    out.errors.push({ scope, type: type(error), status: enumValue(own(error, 'status'), STATUSES),
      ...(count(code, 599) ? { code } : {}), message: text(own(error, 'message')), detailsType: type(details),
      ...(Array.isArray(details) ? { detailCount: Math.min(details.length, 10000) } : {}) });
  }
  return out;
}
function safeText(v: unknown): TextField | undefined {
  const t = own(v, 'type'), chars = own(v, 'chars');
  return member(t, TYPES) ? { type: t, ...(t === 'string' && count(chars, 64 * 1024 * 1024) ? { chars } : {}) } : undefined;
}
function safeSafety(v: unknown): Safety | undefined {
  const t = own(v, 'type'), n = own(v, 'count'), blocked = own(v, 'blockedCount'), samples = own(v, 'samples');
  if (!member(t, TYPES) || !Array.isArray(samples) || samples.length > 4) return undefined;
  const out: Safety = { type: t, ...(count(n) ? { count: n } : {}), ...(count(blocked, 64) ? { blockedCount: blocked } : {}), samples: [] };
  for (let i = 0; i < samples.length; i++) {
    const x = own(samples, String(i)), category = own(x, 'category'), probability = own(x, 'probability'), severity = own(x, 'severity'), b = own(x, 'blocked');
    if (!member(category, CATEGORIES) || !member(probability, LEVELS) || !member(severity, LEVELS) || !member(b, ['true', 'false', 'missing', 'invalid'])) return undefined;
    out.samples.push({ category, probability, severity, blocked: b });
  }
  return out;
}
function safeFeedback(v: unknown): Feedback | undefined {
  const t = own(v, 'type'), blockReason = own(v, 'blockReason'), blockReasonMessage = safeText(own(v, 'blockReasonMessage')), s = safeSafety(own(v, 'safety'));
  return member(t, TYPES) && member(blockReason, BLOCKS) && blockReasonMessage && s ? { type: t, blockReason, blockReasonMessage, safety: s } : undefined;
}
export function sanitizeImageCompletion(v: unknown): ImageCompletionEvidence | undefined {
  const candidateType = own(v, 'candidateType'), contentType = own(v, 'contentType'), role = own(v, 'role');
  const finishMessage = safeText(own(v, 'finishMessage')), s = safeSafety(own(v, 'safety')), f = safeFeedback(own(v, 'feedback')), errors = own(v, 'errors');
  if (!member(candidateType, TYPES) || !member(contentType, TYPES) || !member(role, ROLES) || !finishMessage || !s || !f || !Array.isArray(errors) || errors.length > 2) return undefined;
  const out: ImageCompletionEvidence = { candidateType, contentType, role, finishMessage, safety: s, feedback: f, errors: [] };
  const outer = safeFeedback(own(v, 'outerFeedback')); if (outer) out.outerFeedback = outer;
  for (let i = 0; i < errors.length; i++) {
    const x = own(errors, String(i)), scope = own(x, 'scope'), t = own(x, 'type'), status = own(x, 'status'), code = own(x, 'code'), message = safeText(own(x, 'message')), detailsType = own(x, 'detailsType'), n = own(x, 'detailCount');
    if (!member(scope, ['root', 'payload']) || !member(t, TYPES) || !member(status, STATUSES) || !message || !member(detailsType, TYPES)) return undefined;
    out.errors.push({ scope, type: t, status, ...(count(code, 599) ? { code } : {}), message, detailsType, ...(count(n) ? { detailCount: n } : {}) });
  }
  return out;
}
export function trimImageCompletion(value: ImageCompletionEvidence, fits: () => boolean): void {
  for (const s of [value.safety, value.feedback.safety, value.outerFeedback?.safety]) {
    if (s) while (s.samples.length && !fits()) s.samples.pop();
  }
}
/** Only explicit structured signals choose a cause. Free text and unknown enums never do. */
export function imageCompletionCode(failure: string, finishReason: string, c?: ImageCompletionEvidence): string {
  if (!['candidates', 'parts', 'no-images', 'service-error'].includes(failure)) return 'IMAGE_DIRECT_RESPONSE_INVALID';
  if (c?.errors.some(x => x.type === 'object')) return 'IMAGE_DIRECT_SERVICE_ERROR';
  if (['SAFETY', 'IMAGE_SAFETY'].includes(finishReason) || c && [c.feedback, c.outerFeedback].some(f => f && ['SAFETY', 'IMAGE_SAFETY'].includes(f.blockReason)) ||
      c && [c.safety, c.feedback.safety, c.outerFeedback?.safety].some(s => (s?.blockedCount ?? 0) > 0)) return 'IMAGE_DIRECT_CONTENT_BLOCKED';
  if (['RECITATION', 'IMAGE_RECITATION', 'LANGUAGE', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_PROHIBITED_CONTENT'].includes(finishReason) ||
      c && [c.feedback, c.outerFeedback].some(f => f && ['BLOCKLIST', 'PROHIBITED_CONTENT', 'JAILBREAK'].includes(f.blockReason))) return 'IMAGE_DIRECT_RESPONSE_RESTRICTED';
  if (finishReason === 'MAX_TOKENS') return 'IMAGE_DIRECT_OUTPUT_LIMIT';
  if (['MALFORMED_FUNCTION_CALL', 'UNEXPECTED_TOOL_CALL', 'TOO_MANY_TOOL_CALLS', 'MISSING_THOUGHT_SIGNATURE'].includes(finishReason)) return 'IMAGE_DIRECT_MODEL_STOPPED';
  return failure === 'candidates' ? 'IMAGE_DIRECT_NO_CANDIDATE' : failure === 'parts' || failure === 'no-images' ? 'IMAGE_DIRECT_NO_IMAGE_RETURNED' : 'IMAGE_DIRECT_RESPONSE_INVALID';
}
