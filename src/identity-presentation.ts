import { createHash } from 'node:crypto';
import { t as tr } from './i18n';
interface Identity { id: string; label: string; expectedEmail: string }
let hidden = false;
const listeners = new Set<() => void>();
export function identityHidden(): boolean { return hidden; }
export function setIdentityHidden(value: boolean): void { if (hidden === value) return; hidden = value; for (const listener of [...listeners]) listener(); }
export function onIdentityPresentationChange(listener: () => void): { dispose(): void } { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; }
export function identityAlias(id: string): string { return tr('privacy.alias', { p0: createHash('sha256').update(id).digest('hex').slice(0, 10).toUpperCase() }); }
export function displayAccount(account: Identity): string { return hidden ? identityAlias(account.id) : account.label; }
export function displayEmail(email: string, accounts: readonly Identity[] = []): string {
  if (!hidden) return email; const account = accounts.find(a => a.expectedEmail.toLowerCase() === email.toLowerCase()); return identityAlias(account?.id ?? email.toLowerCase());
}
/** Called only for generated presentation text, never user prompts or credentials. */
export function hideIdentityText(value: string, accounts: readonly Identity[] = []): string {
  if (!hidden) return value;
  const replacements = accounts.flatMap(a => [[a.expectedEmail, identityAlias(a.id)], [a.label, identityAlias(a.id)]] as const).filter(([raw]) => raw.length > 0).sort((a, b) => b[0].length - a[0].length);
  // Single pass: alias text cannot be consumed by a shorter account label.
  let text = '', offset = 0;
  while (offset < value.length) { const found = replacements.find(([raw]) => value.slice(offset, offset + raw.length).toLowerCase() === raw.toLowerCase() && (!/[A-Za-z0-9]/.test(raw[0]!) || !/[A-Za-z0-9]/.test(value[offset - 1] ?? '')) && (!/[A-Za-z0-9]/.test(raw.at(-1)!) || !/[A-Za-z0-9]/.test(value[offset + raw.length] ?? ''))); if (found) { text += found[1]; offset += found[0].length; } else text += value[offset++]; }
  return text.replace(/[^\s<>"'@]+@[^\s<>"'@]+\.[A-Za-z]{2,}/g, email => displayEmail(email, accounts));
}
