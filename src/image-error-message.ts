import { locale, t as tr } from './i18n';
/** Error.message only. Persist bounded, canonical semantics, never arbitrary server prose.
 * Exact request text is used in memory solely to exclude echoes; it is never returned. */
export const MAX_ERROR_MESSAGE_BYTES = 4096;
const MAX_WAIT = 30 * 86400;
const textMessages = () => ({
  capacity: tr("imageErrorMessage.0e302cc0c8"),
  'request-rate': tr("imageErrorMessage.43d968fa6d"),
  'token-rate': tr("imageErrorMessage.1d8744aff1"),
  'rate-limit': tr("imageErrorMessage.f9b558c568"),
  'daily-limit': tr("imageErrorMessage.1ac2f250d8"),
  'quota-zero': tr("imageErrorMessage.8c341b2878"),
  'quota-limit': tr("imageErrorMessage.c419604516"),
  concurrency: tr("imageErrorMessage.99321512f2"),
  eligibility: tr("imageErrorMessage.df5637875e"),
  'client-restricted': tr("imageErrorMessage.7e8e2d8594"),
  'project-access': tr("imageErrorMessage.72d7664018"),
  'api-disabled': tr("imageErrorMessage.a7eaf5c4a5"),
  'region-restricted': tr("imageErrorMessage.f5b8dd7919"),
  'billing-required': tr("imageErrorMessage.0efd419f8f"),
  authentication: tr("imageErrorMessage.0430f21274"),
  'model-unavailable': tr("imageErrorMessage.548fcb9de4"),
  'content-restricted': tr("imageErrorMessage.c979068b0d"),
  'invalid-request': tr("imageErrorMessage.34c0881c70"),
  'generic-resource': tr("imageErrorMessage.b84b28f103"),
} as const);
type Semantic = keyof ReturnType<typeof textMessages>;
const CODES = Object.keys(textMessages()) as Semantic[];
const OMISSIONS = ['credentials', 'url', 'email', 'private-path', 'prompt-echo', 'quoted-text', 'unrecognized-text', 'length-limit'] as const;
type Omission = typeof OMISSIONS[number];
export interface ImageMessageSummary {
  state: 'absent' | 'invalid' | 'empty' | 'summarized' | 'suppressed';
  semantics?: Semantic[];
  waitSeconds?: number;
  omissions?: Omission[];
}
function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  try { const d = Object.getOwnPropertyDescriptor(value, key); return d && 'value' in d ? d.value : undefined; } catch { return undefined; }
}
const validWait = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= MAX_WAIT;
const normalize = (text: string): string => text.normalize('NFKC')
  .replace(/\\u([0-9a-f]{4})/giu, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
  .replace(/\\[nrt]/gu, ' ').replace(/&(?:quot|apos|amp|lt|gt);/giu, ' ')
  .replace(/\s+/gu, ' ').trim().toLowerCase();

/** Partial, canonical interpretation, explicitly not a verbatim or complete message. */
export function summarizeImageErrorMessage(value: unknown, excludedText: readonly string[] = []): ImageMessageSummary {
  if (value === undefined) return { state: 'absent' };
  if (typeof value !== 'string') return { state: 'invalid' };
  if (!value.trim()) return { state: 'empty' };
  // Never slice arbitrary text across a secret/echo boundary and then retain the prefix.
  if (Buffer.byteLength(value) > MAX_ERROR_MESSAGE_BYTES) return { state: 'suppressed', omissions: ['length-limit'] };
  let text = normalize(value);
  const omissions = new Set<Omission>();
  const remove = (pattern: RegExp, kind: Omission): void => {
    text = text.replace(pattern, () => { omissions.add(kind); return ' [removed] '; });
  };
  for (const privateText of excludedText.slice(0, 34)) {
    if (typeof privateText !== 'string' || !privateText || privateText.length > 32768) continue;
    const normalized = normalize(privateText);
    const fragments = new Set([normalized, ...normalized.split(/[.!?。！？\n]/u).filter(x => x.trim().length >= 8).map(x => x.trim())]);
    // Bound partial-echo detection; no fragment/hash/length is retained in the result.
    const words = normalized.split(' ');
    for (let i = 0; i + 3 <= words.length && i < 96; i++) {
      const part = words.slice(i, i + 3).join(' '); if (part.length >= 12) fragments.add(part);
    }
    for (const fragment of fragments) if (fragment && text.includes(fragment)) {
      text = text.split(fragment).join(' [removed] '); omissions.add('prompt-echo');
    }
  }
  remove(/\b(?:bearer|basic)\s+\S+|\b(?:access[_ -]?token|refresh[_ -]?token|id[_ -]?token|api[_ -]?key|client[_ -]?secret|authorization|password)\s*["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu, 'credentials');
  remove(/\b(?:ya29\.[\w.-]+|aiza[\w-]+|eyj[\w-]+\.[\w-]+\.[\w-]+)|\b[a-z0-9_+/-]{32,}={0,2}\b/giu, 'credentials');
  remove(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+|\bwww\.[^\s<>"']+/giu, 'url');
  remove(/\b[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}\b/giu, 'email');
  remove(/(?:\b[a-z]:[\\/]|\\\\|\/(?:home|users|mnt|tmp|private|var|root|workspaces)\/)[^\s<>"']*/giu, 'private-path');
  remove(/\b(?:prompt|user input|input text|request body|contents|instructions?)\s*(?:[:=]|was\b|is\b).*/giu, 'prompt-echo');
  remove(/"[^"\n]*"|'[^'\n]*'|`[^`]*`|“[^”]*”|‘[^’]*’/gu, 'quoted-text');
  const rules: [Semantic, RegExp][] = [
    ['capacity', /(?:model|service|server).{0,40}overloaded|(?:no|insufficient|exhausted|unavailable)\s+(?:available\s+)?capacity|capacity.{0,32}(?:exhausted|unavailable|limited)|模型.{0,16}(?:容量不足|过载)/iu],
    ['request-rate', /requests?\s+per\s+(?:minute|second)|(?:rpm|rps)\s*(?:limit|exceeded)/iu],
    ['token-rate', /tokens?\s+per\s+(?:minute|second)|tpm\s*(?:limit|exceeded)/iu],
    ['rate-limit', /rate.{0,8}limit|too many requests|请求.{0,8}(?:频繁|限流)/iu],
    ['daily-limit', /daily.{0,16}(?:quota|limit)|(?:quota|limit).{0,16}per day|每日.{0,8}(?:配额|限额)/iu],
    ['quota-zero', /(?:quota|allowance|limit|remaining).{0,24}(?:\bis zero\b|[:=]\s*0\b|\bzero\b)|(?:配额|额度).{0,8}为零/iu],
    ['quota-limit', /(?:quota|allowance).{0,24}(?:exhausted|exceeded|insufficient)|(?:insufficient|exhausted).{0,16}quota|配额.{0,8}(?:不足|用尽)/iu],
    ['concurrency', /concurren(?:t|cy).{0,24}(?:limit|exceed)|too many.{0,16}concurrent|并发.{0,8}(?:限制|超出)/iu],
    ['eligibility', /(?:not eligible|ineligible|not entitled|subscription.{0,24}(?:does not|not).{0,16}(?:support|include))|not available.{0,24}(?:this|your) account|(?:账号|账户|订阅).{0,12}(?:无资格|不支持)/iu],
    ['client-restricted', /(?:client|application|app|user.agent).{0,40}(?:not allowed|not supported|unsupported|blocked|restricted|not authorized)|(?:unsupported|unauthorized|blocked)\s+(?:client|application)|only available.{0,32}(?:official|first.party|approved).{0,16}(?:client|application)|客户端.{0,12}(?:禁止|不支持|不允许)/iu],
    ['project-access', /project.{0,40}(?:not allowed|permission|access denied|forbidden)|项目.{0,12}(?:无权限|拒绝|不允许)/iu],
    ['api-disabled', /(?:api|service).{0,40}(?:not enabled|disabled|has not been used)|(?:api|服务).{0,8}未启用/iu],
    ['region-restricted', /(?:region|country|location).{0,40}(?:unsupported|not supported|unavailable|not available)|not available.{0,24}(?:region|country)|地区.{0,12}不可用/iu],
    ['billing-required', /billing.{0,24}(?:required|disabled|not enabled)|(?:paid|pro)\s+subscription\s+(?:is\s+)?required|需要.{0,8}(?:付费|结算)/iu],
    ['authentication', /(?:authentication|credentials?|token|authorization).{0,24}(?:invalid|expired|missing)|(?:invalid|expired|missing).{0,16}(?:credentials?|token)|insufficient.{0,12}(?:scope|authentication)|认证.{0,8}(?:无效|过期)/iu],
    ['model-unavailable', /model.{0,40}(?:not found|not supported|disabled|does not exist)|(?:unknown|unsupported)\s+model|模型.{0,8}(?:不存在|停用)/iu],
    ['content-restricted', /(?:content|prompt|input).{0,32}(?:safety|policy|blocked|filtered)|内容.{0,8}(?:限制|拦截)/iu],
    ['invalid-request', /invalid\s+(?:argument|parameter|request)|(?:请求|参数).{0,8}无效/iu],
    ['generic-resource', /resource (?:has been )?exhausted|resource_exhausted|资源耗尽/iu],
  ];
  const semantics = new Set<Semantic>();
  let waitSeconds: number | undefined;
  for (const clause of text.split(/[.!?;。！？；]/u)) {
    // Do not turn an explicit negation or echoed quote into a positive diagnosis.
    if (/\b(?:not|never)\s+(?:exhausted|overloaded|rate.limited)|\bno\s+(?:rate|quota|concurrency)\s+limit/iu.test(clause)) { omissions.add('unrecognized-text'); continue; }
    let known = false;
    for (const [code, rule] of rules) if (rule.test(clause)) {
      if (['request-rate', 'token-rate'].includes(code) && !/exceed|exhaust|throttl|limit|too many/iu.test(clause)) continue;
      semantics.add(code); known = true;
    }
    const wait = /\b(?:retry|try again|wait)(?:\s+(?:after|in|at least|for))?\s+(\d{1,7})\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b/iu.exec(clause);
    if (wait) {
      const seconds = Number(wait[1]) * (/^(?:m|minutes?|mins?)$/iu.test(wait[2]!) ? 60 : /^(?:h|hours?|hrs?)$/iu.test(wait[2]!) ? 3600 : 1);
      if (validWait(seconds)) { waitSeconds = Math.max(waitSeconds ?? 0, seconds); known = true; }
    }
    if (!known && clause.replace(/\[removed\]/gu, '').trim()) omissions.add('unrecognized-text');
  }
  if (semantics.size > 1) semantics.delete('generic-resource');
  if (semantics.has('request-rate') || semantics.has('token-rate')) semantics.delete('rate-limit');
  return { state: semantics.size || waitSeconds !== undefined ? 'summarized' : 'suppressed',
    ...(semantics.size ? { semantics: CODES.filter(x => semantics.has(x)) } : {}),
    ...(waitSeconds !== undefined ? { waitSeconds } : {}), ...(omissions.size ? { omissions: OMISSIONS.filter(x => omissions.has(x)) } : {}) };
}

/** Rehydrate codes/numbers only; an injected text field never becomes visible. */
export function sanitizeImageMessageSummary(value: unknown): ImageMessageSummary | undefined {
  const state = own(value, 'state');
  if (!['absent', 'invalid', 'empty', 'summarized', 'suppressed'].includes(state as string)) return undefined;
  const rawCodes = own(value, 'semantics'), rawOmissions = own(value, 'omissions'), wait = own(value, 'waitSeconds');
  const semantics = Array.isArray(rawCodes) && rawCodes.length <= CODES.length ? CODES.filter(x => rawCodes.includes(x)) : [];
  const omissions = Array.isArray(rawOmissions) && rawOmissions.length <= OMISSIONS.length ? OMISSIONS.filter(x => rawOmissions.includes(x)) : [];
  const summary = state === 'summarized' && (semantics.length || validWait(wait));
  return { state: state === 'summarized' && !summary ? 'suppressed' : state as ImageMessageSummary['state'],
    ...(summary && semantics.length ? { semantics } : {}), ...(summary && validWait(wait) ? { waitSeconds: wait } : {}),
    ...(omissions.length ? { omissions } : {}) };
}
export function formatImageMessageSummary(value: unknown): string {
  const summary = sanitizeImageMessageSummary(value); if (!summary) return '';
  const status = { absent: tr("imageErrorMessage.303ecd0c1c"), invalid: tr("imageErrorMessage.02047e7c11"), empty: tr("imageErrorMessage.2a0a012493"), suppressed: tr("imageErrorMessage.742f279aba"), summarized: tr("imageErrorMessage.bc8da4ef2d") };
  const parts = [`message：${status[summary.state]}`];
  for (const code of summary.semantics ?? []) parts.push(textMessages()[code]);
  if (summary.waitSeconds !== undefined) parts.push(tr("imageErrorMessage.19863edf44", { p0: summary.waitSeconds }));
  const omitted: Record<Omission, string> = { credentials: tr("imageErrorMessage.058f672b87"), url: tr("imageErrorMessage.0345cea6c0"), email: tr("imageErrorMessage.73075237fd"), 'private-path': tr("imageErrorMessage.5afcac4158"), 'prompt-echo': tr("imageErrorMessage.0b2e132134"), 'quoted-text': tr("imageErrorMessage.6cfb8f619c"), 'unrecognized-text': tr("imageErrorMessage.bdcc344d29"), 'length-limit': tr("imageErrorMessage.cc5347ee9f") };
  if (summary.omissions?.length) parts.push(tr("imageErrorMessage.70f198bacc", { p0: new Intl.ListFormat(locale(), { style: 'short', type: 'conjunction' }).format(summary.omissions.map(x => omitted[x])) }));
  return parts.join(' ');
}
