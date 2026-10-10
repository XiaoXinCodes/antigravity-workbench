import * as vscode from 'vscode';
import * as path from 'node:path';
import { PrivateState, type LocalState } from './private-state';
import { initialQuotaHistory, parseQuotaHistory, QuotaHistory, type QuotaHistoryState, type QuotaObservation } from './quota-history';
import { quotaHistoryHtml } from './quota-history-view';
import { accountDisplayFingerprint, accountQuotaSnapshot, quotaEntries, quotaIsStale, quotaFraction } from './quota-presentation';
import { displayAccount, hideIdentityText, onIdentityPresentationChange } from './identity-presentation';
import { locale, onLanguageChange, t as tr } from './i18n';
import type { LiveUiController } from './live-ui';
import type { ImageQuotaSnapshot } from './image-quota';
export function registerQuotaHistory(context: vscode.ExtensionContext, live: LiveUiController, deps: { store?: LocalState<QuotaHistoryState>; now?: () => number } = {}) {
  const now = deps.now ?? Date.now;
  let panel: vscode.WebviewPanel | undefined, disposed = false, tail = Promise.resolve();
  const lastErrors = new Map<string, unknown>();
  let storageNotice = false;
  const notice = async (owner: vscode.WebviewPanel) => { storageNotice = true; await owner.webview.postMessage({ type: 'notice', text: tr('history.storageFailed') }); };
  const emit = async () => {
    const owner = panel; if (!owner || disposed) return;
    try { const state = await history.read(); if (owner !== panel || disposed) return;
      const accounts = live.getAccounts(); await owner.webview.postMessage({ type: 'state', state: { now: now(), retentionDays: state.retentionDays, accounts: accounts.map(a => ({ id: a.id, label: displayAccount(a) })), rows: state.rows.filter(r => accounts.some(a => a.id === r.accountId)).map(r => ({ ...r, fingerprint: undefined, accountLabel: displayAccount(accounts.find(a => a.id === r.accountId)!), label: hideIdentityText(r.label, accounts) })) } });
    } catch { await notice(owner); }
  };
  const history = new QuotaHistory(deps.store ?? new PrivateState(path.join(context.globalStorageUri.fsPath, 'quota-history'), parseQuotaHistory, initialQuotaHistory), () => live.getAccounts(), () => { void emit(); }, now);
  const observe = () => {
    tail = tail.then(async () => {
      if (disposed || !live.getState().accountStorageReady) return;
      for (const account of live.getAccounts()) {
        const fingerprint = accountDisplayFingerprint(account), snapshot = accountQuotaSnapshot(account);
        if (account.quota?.accountFingerprint !== fingerprint) continue;
        if (account.quota.phase === 'ready' && snapshot && !quotaIsStale(snapshot.observedAt, now())) {
          lastErrors.delete(account.id);
          for (const row of quotaEntries(account)) await history.record({ accountId: account.id, fingerprint, kind: 'bucket', key: row.key, label: row.bucket.label.slice(0, 200), observedAt: snapshot.observedAt, fraction: quotaFraction(row.bucket.remaining), resetAt: row.bucket.resetAt ?? null, unavailable: row.bucket.disabled === true });
        } else if (account.quota.phase === 'error' && lastErrors.get(account.id) !== account.quota) {
          lastErrors.set(account.id, account.quota);
          const prior = (await history.read({ accountId: account.id, kind: 'bucket' })).rows;
          for (const row of new Map(prior.map(r => [r.key, r])).values()) await history.gap(row);
        }
      }
      await history.reconcile();
    }).catch(() => undefined); return tail;
  };
  const imageObservation = (snapshot: ImageQuotaSnapshot, fingerprint: string) => history.record({ accountId: snapshot.accountId, fingerprint, kind: 'image-model', key: JSON.stringify([snapshot.endpoint, snapshot.modelId]), label: snapshot.modelId, observedAt: snapshot.queriedAt, fraction: quotaFraction(snapshot.remainingFraction), resetAt: snapshot.resetAt });
  const imageGap = (accountId: string, fingerprint: string, modelId: string, endpoint: string) => history.gap({ accountId, fingerprint, kind: 'image-model', key: JSON.stringify([endpoint, modelId]), label: modelId });
  const handle = async (raw: unknown, owner: vscode.WebviewPanel) => {
    if (disposed || panel !== owner || !raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    const m = raw as Record<string, unknown>;
    if (!['ready', 'retention', 'clear'].includes(String(m.type))) return;
    try {
      if (m.type === 'ready') await owner.webview.postMessage({ type: 'language', language: locale() });
      if (m.type === 'retention') await history.settings(Number(m.days));
      if (m.type === 'clear') {
        if (m.all === true) await history.clear();
        else if (Array.isArray(m.ids) && m.ids.length <= 5000 && m.ids.every(x => typeof x === 'string')) { const ids = new Set(m.ids); await history.store.transaction(s => { s.rows = s.rows.filter(r => !ids.has(r.id)); }); }
      }
      await emit();
    } catch { if (panel === owner) await notice(owner); }
  };
  context.subscriptions.push(vscode.commands.registerCommand('antigravityAccounts.quota.history', () => {
    if (panel) { panel.reveal(); return; }
    panel = vscode.window.createWebviewPanel('antigravityQuotaHistory', tr('history.title'), vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] }); const owner = panel; owner.webview.html = quotaHistoryHtml();
    context.subscriptions.push(owner.webview.onDidReceiveMessage(m => handle(m, owner)), owner.onDidDispose(() => { if (panel === owner) { panel = undefined; storageNotice = false; } }));
  }), onIdentityPresentationChange(() => { void emit(); }), onLanguageChange(() => { if (panel) { panel.title = tr('history.title'); void panel.webview.postMessage({ type: 'language', language: locale() }); if (storageNotice) void notice(panel); void emit(); } }), { dispose: () => { disposed = true; panel?.dispose(); } });
  return { history, observe, imageObservation, imageGap, refresh: () => { void observe(); void emit(); } };
}
export type ImageHistoryObserver = { imageObservation(snapshot: ImageQuotaSnapshot, fingerprint: string): Promise<void>; imageGap(accountId: string, fingerprint: string, modelId: string, endpoint: string): Promise<void> };
export type HistoryObservation = QuotaObservation;
