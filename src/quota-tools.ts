import { displayAccount, displayEmail, hideIdentityText, onIdentityPresentationChange } from './identity-presentation';
import * as vscode from 'vscode';
import { localizeMessage, locale, onLanguageChange, t as tr } from './i18n';
import { accountQuotaSnapshot, accountQuotaStale, quotaEntries, quotaValue } from './quota-presentation';
import { QuotaPreferences, pinnedQuota } from './quota-preferences';
import { ManualQuotaBatch } from './quota-batch';
import type { LiveAccountView, LiveUiController } from './live-ui';

interface QuotaPick extends vscode.QuickPickItem { accountId?: string; key?: string; identity: string }
export function registerQuotaTools(context: vscode.ExtensionContext, live: LiveUiController, changed: () => void) {
  const preferences = new QuotaPreferences(context.globalState);
  let disposed = false, error = '';
  let pick: vscode.QuickPick<QuotaPick> | undefined;
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  status.command = 'antigravityAccounts.quota.quickPick'; status.name = tr('quota.quickPick');
  const date = (value: string | null | undefined) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString(locale()) : tr('workbenchView.4d8c1c5b42');
  const batch = new ManualQuotaBatch(() => live.getAccounts(), async id => {
    if (disposed || live.getState().busy || live.getState().pending) throw Error('QUOTA_BATCH_BLOCKED');
    await vscode.commands.executeCommand('antigravityAccounts.live.quota', id);
  }, () => { void Promise.resolve(vscode.commands.executeCommand('antigravityAccounts.live.quotaCancel')).catch(() => undefined); }, () => { refresh(); changed(); });
  const canRead = () => !disposed && !live.getState().busy && !live.getState().pending && live.getState().environment.available;
  const refreshButton = { iconPath: new vscode.ThemeIcon('refresh'), tooltip: tr('quota.batch') };
  const cancelButton = { iconPath: new vscode.ThemeIcon('debug-stop'), tooltip: tr('quota.cancel') };
  const unpinButton = { iconPath: new vscode.ThemeIcon('pinned'), tooltip: tr('quota.unpin') };
  const favoriteButton = { iconPath: new vscode.ThemeIcon('star-empty'), tooltip: tr('quota.favorite') };
  const unfavoriteButton = { iconPath: new vscode.ThemeIcon('star-full'), tooltip: tr('quota.unfavorite') };
  const pinButton = { iconPath: new vscode.ThemeIcon('pin'), tooltip: tr('quota.pin') };
  function rows(): QuotaPick[] {
    const prefs = preferences.getState(), result: QuotaPick[] = [];
    for (const account of live.getAccounts()) {
      result.push({ label: displayAccount(account), kind: vscode.QuickPickItemKind.Separator, identity: account.id });
      const entries = quotaEntries(account).sort((a, b) => Number(prefs.favorites.includes(b.key)) - Number(prefs.favorites.includes(a.key)));
      if (!entries.length) result.push({ label: displayEmail(account.expectedEmail, live.getAccounts()), description: tr('quota.empty'), accountId: account.id, identity: account.id + ':empty', buttons: [] });
      for (const row of entries) result.push({ identity: JSON.stringify([account.id, row.key]), accountId: account.id, key: row.key,
        label: (prefs.favorites.includes(row.key) ? '$(star-full) ' : '') + row.bucket.label,
        description: `${displayAccount(account)} · ${quotaValue(row.bucket)}${accountQuotaStale(account) ? tr('quota.staleSuffix') : ''}`,
        detail: [displayEmail(account.expectedEmail, live.getAccounts()), tr('quota.observed', { p0: date(accountQuotaSnapshot(account)?.observedAt) }), tr('quota.reset', { p0: date(row.bucket.resetAt) }), account.quota?.phase === 'loading' ? tr('quota.loading') : account.quota?.message ? hideIdentityText(localizeMessage(account.quota.message), live.getAccounts()) : ''].filter(Boolean).join(' · '),
        buttons: [prefs.favorites.includes(row.key) ? unfavoriteButton : favoriteButton, pinButton] });
    }
    return result;
  }
  function refresh(): void {
    if (disposed) return;
    status.name = tr('quota.quickPick');
    const prefs = preferences.getState(), pinned = pinnedQuota(live.getAccounts(), prefs.pin);
    if (!prefs.pin) status.hide();
    else {
      status.text = pinned ? `$(graph) ${displayAccount(pinned.account).slice(0, 18)} · ${pinned.row.bucket.label.slice(0, 24)} ${quotaValue(pinned.row.bucket)}${accountQuotaStale(pinned.account) ? tr('quota.staleSuffix') : ''}` : `$(graph) ${tr('quota.pinMissing')}`;
      status.tooltip = pinned ? [displayEmail(pinned.account.expectedEmail, live.getAccounts()), pinned.row.bucket.label, tr('quota.observed', { p0: date(accountQuotaSnapshot(pinned.account)?.observedAt) }), tr('quota.reset', { p0: date(pinned.row.bucket.resetAt) }), tr('quota.quickPick')].join('\n') : tr('quota.pinMissing');
      status.show();
    }
    if (pick) {
      const value = pick.value, active = pick.activeItems[0]?.identity, selected = pick.selectedItems[0]?.identity;
      pick.title = tr('quota.quickPick'); pick.placeholder = error ? localizeMessage(error) : tr('quota.pickHint');
      refreshButton.tooltip = tr('quota.batch'); cancelButton.tooltip = tr('quota.cancel'); unpinButton.tooltip = tr('quota.unpin'); favoriteButton.tooltip = tr('quota.favorite'); unfavoriteButton.tooltip = tr('quota.unfavorite'); pinButton.tooltip = tr('quota.pin');
      pick.items = rows(); pick.value = value;
      pick.activeItems = pick.items.filter(item => item.identity === active); pick.selectedItems = pick.items.filter(item => item.identity === selected);
      pick.busy = batch.getState().running || live.getAccounts().some(account => account.quota?.phase === 'loading');
      pick.buttons = [refreshButton, cancelButton, ...(prefs.pin ? [unpinButton] : [])];
    }
  }
  const save = async (operation: () => Promise<void>): Promise<void> => {
    try { await operation(); error = ''; } catch { error = tr('quota.preferencesFailed'); }
    if (!disposed) { refresh(); changed(); }
  };
  const target = (id: unknown, key: unknown): { account: LiveAccountView; key: string } | undefined => {
    if (typeof id !== 'string' || typeof key !== 'string' || key.length > 1000) return;
    const account = live.getAccounts().find(item => item.id === id);
    return account && quotaEntries(account).some(row => row.key === key) ? { account, key } : undefined;
  };
  const command = (name: string, fn: (...args: unknown[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand('antigravityAccounts.quota.' + name, (...args: unknown[]) => disposed ? undefined : fn(...args)));
  const cancel = () => { if (batch.getState().running) batch.cancel(); else void Promise.resolve(vscode.commands.executeCommand('antigravityAccounts.live.quotaCancel')).catch(() => undefined); };
  command('refreshAll', () => batch.getState().running ? batch.start() : canRead() ? batch.start() : undefined);
  command('cancel', cancel);
  command('favorite', (id, key) => { const row = target(id, key); if (row) return save(() => preferences.favorite(row.key)); });
  command('pin', (id, key) => { const row = target(id, key); if (row && row.account.hostCurrent !== false) return save(() => preferences.pin(row.account, row.key)); });
  command('unpin', () => save(() => preferences.pin()));
  command('quickPick', () => {
    if (pick) { pick.show(); return; }
    const current = vscode.window.createQuickPick<QuotaPick>(); pick = current; current.matchOnDescription = true; current.matchOnDetail = true;
    const subscriptions = [current.onDidHide(() => { if (pick === current) pick = undefined; for (const subscription of subscriptions) subscription.dispose(); current.dispose(); }),
      current.onDidTriggerButton(async button => { if (button === unpinButton) await save(() => preferences.pin()); else if (button === cancelButton) cancel(); else if (button === refreshButton && canRead()) await batch.start(); }),
      current.onDidTriggerItemButton(async event => { const row = target(event.item.accountId, event.item.key); if (!row) return; if (event.button === favoriteButton || event.button === unfavoriteButton) await save(() => preferences.favorite(row.key)); else if (event.button === pinButton && row.account.hostCurrent !== false) await save(() => preferences.pin(row.account, row.key)); }),
      current.onDidAccept(() => { const item = current.selectedItems[0], row = item && target(item.accountId, item.key); if (row && row.account.hostCurrent !== false) void save(() => preferences.pin(row.account, row.key)); })];
    refresh(); current.show();
  });
  const timer = setInterval(refresh, 15_000); timer.unref?.();
  context.subscriptions.push(status, onLanguageChange(refresh), onIdentityPresentationChange(refresh), { dispose: () => { disposed = true; batch.dispose(); clearInterval(timer); pick?.hide(); status.dispose(); } });
  refresh();
  return { refresh, preferences, getState: () => ({ ...preferences.getState(), batch: batch.getState(), ...(error ? { error } : {}) }) };
}
