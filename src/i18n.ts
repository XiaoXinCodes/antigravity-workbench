import { zhCN, type MessageKey } from './i18n-zh';
import { en } from './i18n-en';

export type Dictionary = Readonly<Record<MessageKey, string>>;
export const languages = {
  'zh-CN': { label: '简体中文', messages: zhCN }, en: { label: 'English', messages: en },
} as const satisfies Record<string, { label: string; messages: Dictionary }>;
export type Language = keyof typeof languages;
let selected: Language = 'zh-CN';
const listeners = new Set<() => void>();
export function normalizeLanguage(value: unknown): Language { return typeof value === 'string' && Object.hasOwn(languages, value) ? value as Language : 'zh-CN'; }
export function locale(): Language { return selected; }
export function setLanguage(value: unknown): void {
  const next = normalizeLanguage(value); if (next === selected) return;
  selected = next; for (const listener of [...listeners]) listener();
}
export function onLanguageChange(listener: () => void): { dispose(): void } { listeners.add(listener); return { dispose: () => { listeners.delete(listener); } }; }
export function interpolate(template: string, params: Readonly<Record<string, string | number | undefined>> = {}): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name: string) => Object.hasOwn(params, name) ? String(params[name]) : match);
}
/** Unknown keys remain visible; missing translated keys fall back to Simplified Chinese. */
export function translate(key: string, params: Readonly<Record<string, string | number | undefined>> = {}, language: Language = selected, dictionaries: Partial<Record<Language, Readonly<Record<string, string>>>> = languagesAsDictionaries()): string {
  const own = (dict: Readonly<Record<string, string>> | undefined): string | undefined => dict && Object.hasOwn(dict, key) ? dict[key] : undefined;
  return interpolate(own(dictionaries[language]) ?? own(dictionaries['zh-CN']) ?? key, params);
}
function languagesAsDictionaries(): Record<Language, Dictionary> { return Object.fromEntries(Object.entries(languages).map(([key, entry]) => [key, entry.messages])) as Record<Language, Dictionary>; }
const generatedMessages = new Map<string, { key: MessageKey; params: Readonly<Record<string, string | number | undefined>> }>();
export function t(key: MessageKey, params: Readonly<Record<string, string | number | undefined>> = {}): string {
  const value = translate(key, params);
  generatedMessages.set(value, { key, params: { ...params } });
  if (generatedMessages.size > 2048) generatedMessages.delete(generatedMessages.keys().next().value!);
  return value;
}
export function escapeText(value: string): string { return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!); }
export function ht(key: MessageKey): string { return escapeText(t(key)); }

// Existing persisted statuses are plain strings. Relocalize only fields generated
// by the extension, never account labels, user prompts, model IDs, paths or files.
const patterns = Object.entries(zhCN).flatMap(([key, zh]) => [...new Set([zh, en[key as MessageKey]])].map(text => {
  const names: string[] = []; const literals: string[] = []; let offset = 0;
  for (const match of text.matchAll(/\{(p\d+)\}/g)) { literals.push(text.slice(offset, match.index)); names.push(match[1]!); offset = match.index! + match[0].length; }
  literals.push(text.slice(offset));
  return { key, names, literals, length: text.length };
})).sort((a, b) => b.length - a.length);
// Only these parameters are other generated messages. All other parameters stay
// opaque, including account names, prompts, model IDs and file paths.
const nestedMessages: Readonly<Record<string, readonly string[]>> = {"imageIteration.aa35853718": ["p0", "p3"], "liveUi.01c78ee2cf": ["p0"], "liveUi.b663503578": ["p0"], "liveUi.254260d5f2": ["p0"], "liveUi.9949291c78": ["p0"], "liveUi.f26fb5d18c": ["p0"], "liveUi.89c2c32335": ["p0"], "liveUi.db476d236f": ["p0"], "nativeHost.a7830058ff": ["p0", "p1"], "debugUi.a0cec5c2a2": ["p1", "p3"], "imageSessionStore.13a0c9b5f9": ["p0"], "directImageUi.5129adff5e": ["p1"], "imageOperationRecord.61ad8c9559": ["p13", "p18"], "imageOperationRecord.response": ["p1", "p2"]};
function relocalize(value: string, depth: number): string {
  if (!value || value.length > 64 * 1024 || depth > 4) return value;
  const generated = generatedMessages.get(value);
  if (generated) {
    const params = { ...generated.params };
    for (const name of nestedMessages[generated.key] ?? []) if (typeof params[name] === 'string') params[name] = params[name].split('\n').map(line => relocalize(line, depth + 1)).join('\n');
    return translate(generated.key, params);
  }
  const withCode = /^(.*)[（(]([A-Z][A-Z0-9_]{0,99})[）)]$/s.exec(value);
  if (withCode) return relocalize(withCode[1]!, depth + 1) + (selected === 'en' ? ` (${withCode[2]})` : `（${withCode[2]}）`);
  for (const item of patterns) {
    if (!value.startsWith(item.literals[0]!)) continue;
    let offset = item.literals[0]!.length, valid = true; const params: Record<string, string> = {};
    for (const [i, name] of item.names.entries()) {
      const literal = item.literals[i + 1]!;
      // Deterministic matching avoids regex backtracking on persisted text.
      const end = i === item.names.length - 1 ? value.length - literal.length : literal ? value.indexOf(literal, offset) : offset;
      if (end < offset || value.slice(end, end + literal.length) !== literal) { valid = false; break; }
      const parameter = value.slice(offset, end);
      params[name] = nestedMessages[item.key]?.includes(name) ? relocalize(parameter, depth + 1) : parameter;
      offset = end + literal.length;
    }
    if (valid && offset === value.length) return translate(item.key, params);
  }
  return value;
}
export function localizeMessage(value: string): string { return relocalize(value, 0); }
/** Trusted dictionaries are escaped for a nonce-protected script, never inserted as HTML. */
export function clientI18n(): string {
  const data = JSON.stringify(languagesAsDictionaries()).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return `const dictionaries=${data};let language=${JSON.stringify(locale())};
const tr=(key,params={})=>(Object.hasOwn(dictionaries[language],key)?dictionaries[language][key]:Object.hasOwn(dictionaries['zh-CN'],key)?dictionaries['zh-CN'][key]:key).replace(/\\{([a-zA-Z0-9_]+)\\}/g,(match,name)=>Object.hasOwn(params,name)?String(params[name]):match);
const applyLanguage=()=>{document.documentElement.lang=language;for(const n of document.querySelectorAll('[data-i18n]'))n.textContent=tr(n.dataset.i18n);for(const attr of ['aria-label','title','placeholder','alt'])for(const n of document.querySelectorAll('[data-i18n-'+attr+']'))n.setAttribute(attr,tr(n.getAttribute('data-i18n-'+attr)))};`;
}

export function localizeLines(value: string): string { return value.split('\n\n').map(block => { const translated = localizeMessage(block); return translated === block ? block.split('\n').map(localizeMessage).join('\n') : translated; }).join('\n\n'); }
