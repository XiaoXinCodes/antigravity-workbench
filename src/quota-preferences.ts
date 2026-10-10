import type * as vscode from 'vscode';
import { accountDisplayFingerprint, quotaEntries } from './quota-presentation';
import { writeQuotaPreferences } from './quota-ui-storage';
import type { LiveAccountView } from './live-ui';

const KEY = 'quota.presentation.v1';
export interface QuotaPin { accountId: string; fingerprint: string; key: string }
export interface QuotaPreferencesState { favorites: string[]; imageFavorites: string[]; pin?: QuotaPin }
const strings = (value: unknown): string[] => Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0 && item.length <= 1000))].slice(0, 300) : [];
export function readQuotaPreferences(value: unknown): QuotaPreferencesState {
  const row = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const candidate = row.pin && typeof row.pin === 'object' ? row.pin as Record<string, unknown> : {};
  const pin = typeof candidate.accountId === 'string' && /^[a-f0-9-]{36}$/u.test(candidate.accountId) && typeof candidate.fingerprint === 'string' && candidate.fingerprint.length <= 2000 && typeof candidate.key === 'string' && candidate.key.length <= 1000 ? { accountId: candidate.accountId, fingerprint: candidate.fingerprint, key: candidate.key } : undefined;
  return { favorites: strings(row.favorites), imageFavorites: strings(row.imageFavorites), ...(pin ? { pin } : {}) };
}
export class QuotaPreferences {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly storage: Pick<vscode.Memento, 'get' | 'update'>) {}
  getState(): QuotaPreferencesState { return readQuotaPreferences(this.storage.get(KEY)); }
  private write(transform: (current: QuotaPreferencesState) => QuotaPreferencesState): Promise<void> {
    const work = this.queue.then(() => writeQuotaPreferences(this.storage, current => transform(readQuotaPreferences(current))));
    this.queue = work.catch(() => undefined); return work.then(() => undefined);
  }
  favorite(key: string): Promise<void> { return this.write(current => ({ ...current, favorites: current.favorites.includes(key) ? current.favorites.filter(item => item !== key) : [...current.favorites, key].slice(-300) })); }
  favoriteImage(modelId: string): Promise<void> { return this.write(current => ({ ...current, imageFavorites: current.imageFavorites.includes(modelId) ? current.imageFavorites.filter(item => item !== modelId) : [...current.imageFavorites, modelId].slice(-300) })); }
  pin(account?: LiveAccountView, key?: string): Promise<void> {
    return this.write(current => {
      const rest = { ...current }; delete rest.pin;
      return account && key ? { ...rest, pin: { accountId: account.id, fingerprint: accountDisplayFingerprint(account), key } } : rest;
    });
  }
}
export function pinnedQuota(accounts: LiveAccountView[], pin?: QuotaPin) {
  const account = pin && accounts.find(item => item.id === pin.accountId && item.hostCurrent !== false && accountDisplayFingerprint(item) === pin.fingerprint);
  const row = account && quotaEntries(account).find(item => item.key === pin!.key);
  return account && row ? { account, row } : undefined;
}
