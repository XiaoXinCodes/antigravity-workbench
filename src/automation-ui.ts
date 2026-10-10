import * as vscode from 'vscode';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { locale, localizeMessage, onLanguageChange, t as tr } from './i18n';
import { displayAccount, hideIdentityText, identityAlias, identityHidden, onIdentityPresentationChange, setIdentityHidden } from './identity-presentation';
import { PrivateState, type LocalState } from './private-state';
import { initialWakeState, parseWakeState, type WakeState } from './wake-state';
import { WakeEngine } from './wake-engine';
import { createWakeAccounts, type WakeAccounts } from './wake-accounts';
import { quotaPercent } from './quota-presentation';
import { wakeOccurrences } from './wake-schedule';
import { automationHtml } from './automation-view';
import { accountDisplayFingerprint, accountQuotaSnapshot, quotaEntries } from './quota-presentation';
import { observeQuotaAlerts, type AlertSample } from './quota-alerts';
import type { LiveUiController } from './live-ui';
export function registerIdentityPrivacy(context: vscode.ExtensionContext): void {
  const read = () => setIdentityHidden(vscode.workspace.getConfiguration('antigravityAccounts').inspect<boolean>('hideIdentity')?.globalValue === true);
  read(); context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('antigravityAccounts.hideIdentity')) read(); }));
  context.subscriptions.push(vscode.commands.registerCommand('antigravityAccounts.privacy.toggle', () => vscode.workspace.getConfiguration('antigravityAccounts').update('hideIdentity', !identityHidden(), vscode.ConfigurationTarget.Global)));
}
export function registerAutomationUi(context: vscode.ExtensionContext, live: LiveUiController, deps: { store?: LocalState<WakeState>; accounts?: WakeAccounts; now?: () => number; notice?: (text: string) => void } = {}) {
  const now = deps.now ?? Date.now, store = deps.store ?? new PrivateState(path.join(context.globalStorageUri.fsPath, 'automation'), parseWakeState, initialWakeState), accounts = deps.accounts ?? createWakeAccounts(context, live);
  let panel: vscode.WebviewPanel | undefined, disposed = false, sequence = 0, modelsAbort: AbortController | undefined, alertTail = Promise.resolve();
  const catalog = new Map<string, { accountId: string; fingerprint: string; endpoint: 'daily' | 'production'; models: string[]; queriedAt: number }>();
  let lastNotice = '';
  const post = (message: Record<string, unknown>) => {
    if (message.type === 'notice' && typeof message.text === 'string') lastNotice = message.text;
    return panel?.webview.postMessage(message);
  };
  const format = (time: number, zone = 'Etc/UTC') => new Intl.DateTimeFormat(locale(), { timeZone: zone, dateStyle: 'medium', timeStyle: 'short' }).format(time) + ` (${zone})`;
  const emit = async () => {
    const owner = panel; if (!owner || disposed) return;
    try {
      const state = await store.read(); if (owner !== panel || disposed) return;
      const rows = live.getAccounts();
      const label = (id: string) => { const a = rows.find(a => a.id === id); return a ? displayAccount(a) : identityAlias(id); };
      await owner.webview.postMessage({ type: 'state', state: { enabled: state.enabled, hidden: identityHidden(), alerts: state.alerts, accounts: rows.filter(a => accounts.fingerprint(a.id)).map(a => ({ id: a.id, label: displayAccount(a) })),
        tasks: state.tasks.map(t => ({ ...t, fingerprint: undefined, accountLabel: label(t.accountId), nextLabel: format(t.nextDue, t.schedule.timezone), triggerLabel: tr(`advanced.${t.schedule.mode ?? 'calendar'}`), recoveryLabel: t.recovery ? tr('advanced.baseline', { p0: format(t.recovery.observedAt, t.schedule.timezone), p1: t.recovery.fraction === null ? tr('automation.unknownUsage') : quotaPercent(t.recovery.fraction) }) + (t.recovery.valid === false ? ' · ' + tr('advanced.baselineInvalid') : '') : '', running: state.instances.some(i => i.taskId === t.id && ['sent', 'preparing'].includes(i.phase)) })),
        instances: state.instances.slice(-100).reverse().map(i => ({ id: i.id, label: `${label(i.accountId)} · ${i.modelId} · ${format(i.due)} · ${tr(i.manual ? 'automation.manual' : 'automation.scheduled')} · ${tr(`automation.phase.${i.phase}`)}${i.code && i.phase !== 'succeeded' ? ` (${['WAKE_QUOTA_WAITING','WAKE_QUOTA_UNAVAILABLE','WAKE_QUOTA_NOT_FULL','WAKE_QUOTA_STALE'].includes(i.code) ? tr(`advanced.${i.code as 'WAKE_QUOTA_WAITING'}`) : i.code})` : ''}\n${tr('automation.usage', { p0: i.outputTokens ?? tr('automation.unknownUsage'), p1: i.totalTokens ?? tr('automation.unknownUsage') })}` })) } });
    } catch (e) { if (owner === panel) await post({ type: 'notice', text: tr('automation.failed', { p0: safeCode(e) }) }); }
  };
  const engine = new WakeEngine(store, accounts, () => { void emit(); }, now);
  let consentFlight: Promise<boolean> | undefined;
  const requestConsent = async (): Promise<boolean> => {
    if ((await store.read()).consent) return true;
    const yes = tr('automation.consent'); if (await vscode.window.showWarningMessage(tr('automation.cost'), { modal: true }, yes) !== yes) return false;
    await engine.consent(); return true;
  };
  const consent = (): Promise<boolean> => consentFlight ??= requestConsent().finally(() => { consentFlight = undefined; });
  const handle = async (raw: unknown, owner: vscode.WebviewPanel) => {
    if (disposed || panel !== owner || !raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    const m = raw as Record<string, unknown>, type = m.type;
    if (typeof type !== 'string' || !['ready', 'models', 'save', 'preview', 'enable', 'pause', 'resume', 'test', 'cancel', 'remove', 'alerts', 'privacy'].includes(type)) return;
    if (m.requestId !== undefined && (typeof m.requestId !== 'string' || !/^\d{1,15}$/.test(m.requestId))) return;
    let modelRequest: { abort: AbortController; revision: number } | undefined;
    try {
      if (type === 'ready') await post({ type: 'language', language: locale() });
      if (type === 'models') {
        if (typeof m.accountId !== 'string' || !['daily', 'production'].includes(String(m.endpoint))) throw Error('WAKE_ACCOUNT_CHANGED');
        const id = m.accountId, endpoint = m.endpoint as 'daily' | 'production', fingerprint = accounts.fingerprint(id); if (!fingerprint) throw Error('WAKE_ACCOUNT_CHANGED');
        modelsAbort?.abort(); const abort = new AbortController(); modelsAbort = abort; const revision = ++sequence;
        modelRequest = { abort, revision };
        for (const [key, entry] of catalog) if (entry.accountId === id && entry.endpoint === endpoint) catalog.delete(key);
        void post({ type: 'notice', text: tr('automation.loading') });
        const models = await accounts.models(id, endpoint, abort.signal);
        if (abort.signal.aborted || revision !== sequence || panel !== owner || accounts.fingerprint(id) !== fingerprint) return;
        const key = randomUUID(); catalog.set(key, { accountId: id, fingerprint, endpoint, models: models.map(x => x.id), queriedAt: now() });
        if (catalog.size > 50) catalog.delete(catalog.keys().next().value!);
        await post({ type: 'models', accountId: id, endpoint, catalogKey: key, models }); await post({ type: 'notice', text: models.length ? models.every(model => model.classification === 'unclassified') ? tr('automation.modelTypesUnspecified') : '' : tr('automation.noChatModels') });
      } else if (type === 'save') {
        const entry = typeof m.catalogKey === 'string' ? catalog.get(m.catalogKey) : undefined;
        if (!entry || entry.accountId !== m.accountId || entry.endpoint !== m.endpoint || entry.fingerprint !== accounts.fingerprint(entry.accountId) || now() - entry.queriedAt >= 300_000 || typeof m.modelId !== 'string' || !entry.models.includes(m.modelId)) throw Error('WAKE_MODEL_SELECTION_STALE');
        const state = await store.read(), existing = state.tasks.find(t => t.id === m.id);
        if (m.id !== '' && (!existing || existing.revision !== m.revision)) throw Error('WAKE_TASK_CHANGED');
        await engine.save({ id: existing?.id ?? randomUUID(), revision: randomUUID(), accountId: entry.accountId, fingerprint: entry.fingerprint, modelId: m.modelId, endpoint: entry.endpoint, schedule: m.schedule as Parameters<typeof wakeOccurrences>[0], enabled: false, outputBudget: m.outputBudget as number, nextDue: 0 }, existing?.revision);
        await post({ type: 'notice', text: tr('automation.paused') });
      } else if (type === 'preview') { await post({ type: 'preview', times: wakeOccurrences(m.schedule as Parameters<typeof wakeOccurrences>[0], now(), 5), timezone: (m.schedule as { timezone: string }).timezone, recovery: (m.schedule as { mode?: string }).mode === 'quota-recovery' }); }
      else if (type === 'enable') { if (typeof m.enabled !== 'boolean') return; if (!m.enabled || await consent()) { if (panel === owner && !disposed) await engine.enable(m.enabled); } }
      else if (['pause', 'resume', 'test', 'cancel', 'remove'].includes(type)) {
        const before = (await store.read()).tasks.find(t => t.id === m.id);
        if (typeof m.id !== 'string' || !before) throw Error('WAKE_TASK_MISSING');
        if (typeof m.revision !== 'string' || m.revision !== before.revision) throw Error('WAKE_TASK_CHANGED');
        const approved = async () => {
          if (!await consent() || disposed || panel !== owner) return false;
          if (!(await store.read()).tasks.some(t => t.id === before.id && t.revision === before.revision)) throw Error('WAKE_TASK_CHANGED');
          return true;
        };
        if (type === 'pause') await engine.pause(m.id, false, before.revision);
        if (type === 'resume' && await approved()) { const previous = (await store.read()).instances.some(i => i.taskId === m.id && i.phase === 'unknown'); if (previous) await post({ type: 'notice', text: tr('automation.confirmUnknown') }); await engine.pause(m.id, true, before.revision); }
        if (type === 'test' && await approved()) await engine.test(m.id, before.revision);
        if (type === 'cancel') await engine.cancel(m.id, before.revision);
        if (type === 'remove') await engine.remove(m.id, before.revision);
      } else if (type === 'alerts') {
        if (typeof m.low !== 'boolean' || typeof m.exhausted !== 'boolean' || typeof m.recovered !== 'boolean' || !Number.isInteger(m.threshold) || Number(m.threshold) < 1 || Number(m.threshold) > 99) throw Error('ALERT_SETTINGS_INVALID');
        await store.transaction(s => { s.alerts = { low: m.low as boolean, exhausted: m.exhausted as boolean, recovered: m.recovered as boolean, threshold: m.threshold as number }; });
      } else if (type === 'privacy' && typeof m.hidden === 'boolean') await vscode.workspace.getConfiguration('antigravityAccounts').update('hideIdentity', m.hidden, vscode.ConfigurationTarget.Global);
    } catch (e) {
      const code = safeCode(e);
      if (panel === owner && !(type === 'models' && (modelRequest?.abort.signal.aborted || modelRequest && modelRequest.revision !== sequence || /CANCELLED/.test(code)))) {
        await post({ type: 'notice', text: code === 'WAKE_MODELS_UNAVAILABLE' ? tr('automation.noChatModels') : tr('automation.failed', { p0: code }) });
      }
    }
    finally { if (panel === owner) { await emit(); await post({ type: 'complete', requestType: type, requestId: m.requestId }); } }
  };
  const observe = (extra: AlertSample[] = []) => {
    alertTail = alertTail.then(async () => {
      if (disposed) return;
      const samples: AlertSample[] = [];
      for (const a of live.getAccounts()) {
        const snapshot = accountQuotaSnapshot(a); if (!snapshot || a.quota?.phase !== 'ready' || a.quota.accountFingerprint !== accountDisplayFingerprint(a)) continue;
        for (const row of quotaEntries(a)) if (!row.bucket.disabled) samples.push({ accountId: a.id, fingerprint: accountDisplayFingerprint(a), quotaKey: row.key, modelLabel: row.bucket.label, observedAt: snapshot.observedAt, fraction: row.bucket.remaining });
      }
      for (const sample of extra) if (accounts.fingerprint(sample.accountId) === sample.fingerprint) samples.push(sample);
      for (const alert of await observeQuotaAlerts(store, samples, now())) {
        if (accounts.fingerprint(alert.accountId) !== alert.fingerprint) continue;
        const a = live.getAccounts().find(a => a.id === alert.accountId); if (!a) continue;
        const text = hideIdentityText(tr('alerts.notice', { p0: displayAccount(a), p1: alert.modelLabel, p2: tr(`alerts.edge.${alert.edge}`) }), live.getAccounts());
        if (deps.notice) deps.notice(text); else void vscode.window.showInformationMessage(text);
      }
    }).catch(() => undefined);
    return alertTail;
  };
  context.subscriptions.push(vscode.commands.registerCommand('antigravityAccounts.automation.open', () => {
    if (panel) { panel.reveal(); return; }
    panel = vscode.window.createWebviewPanel('antigravityAutomation', tr('automation.title'), vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
    const owner = panel; owner.webview.html = automationHtml(owner.webview.cspSource);
    context.subscriptions.push(owner.webview.onDidReceiveMessage(m => handle(m, owner)), owner.onDidDispose(() => { if (panel === owner) { panel = undefined; lastNotice = ''; modelsAbort?.abort(); } }));
  }), onIdentityPresentationChange(() => { void emit(); }), onLanguageChange(() => { if (panel) { panel.title = tr('automation.title'); void post({ type: 'language', language: locale() }); if (lastNotice) void post({ type: 'notice', text: localizeMessage(lastNotice) }); void emit(); } }));
  let polling = false;
  const timer = setInterval(() => {
    if (polling || disposed) return; polling = true;
    void store.read().then(s => s.enabled || s.instances.some(i => ['sent', 'preparing'].includes(i.phase)) ? engine.tick() : undefined).then(() => emit()).catch(() => undefined).finally(() => { polling = false; });
  }, 15_000); timer.unref?.();
  context.subscriptions.push({ dispose: () => { disposed = true; clearInterval(timer); modelsAbort?.abort(); engine.dispose(); panel?.dispose(); } });
  return { engine, observe, refresh: () => { void observe(); void emit(); }, store };
}
function safeCode(e: unknown): string { return e instanceof Error && /^[A-Z_0-9]{1,100}$/.test(e.message) ? e.message : 'AUTOMATION_REQUEST_FAILED'; }
