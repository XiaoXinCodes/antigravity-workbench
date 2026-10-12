import { createWorkbenchPanel } from './workbench-host';
import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { clientI18n, ht, locale, onLanguageChange, t } from './i18n';
import type { DebugUiState } from './debug-ui';
import { routeWorkbenchNavigation } from './workbench-navigation';
import { workbenchStyles, workbenchStart, workbenchEnd, workbenchNavigationScript, type WorkbenchPage } from './workbench-ui';

type SupportPage = 'settings' | 'help' | 'diagnostics';
const label = (key: Parameters<typeof ht>[0]): string => `<span data-i18n="${key}">${ht(key)}</span>`;
const button = (action: string, key: Parameters<typeof ht>[0], primary = false): string => `<button type="button" data-support-action="${action}"${primary ? ' class="primary"' : ''}>${label(key)}</button>`;
export function supportHtml(page: SupportPage, nonce: string): string {
  const heading = page === 'settings' ? 'ui.settings' : page === 'help' ? 'ui.help' : 'ui.advanced';
  const settings = `<section class="wb-panel"><h2>${label('ui.interface')}</h2><div class="wb-settings-row"><div><h3>${label('ui.language')}</h3><p>${label('ui.languageHint')}</p></div><select id="support-language" data-setting="language" aria-label="Language / 语言"><option value="zh-CN">简体中文</option><option value="en">English</option></select></div><div class="wb-settings-row"><div><h3>${label('ui.appearance')}</h3><p>${label('ui.appearanceHint')}</p></div>${button('theme', 'ui.chooseTheme')}</div><div class="wb-settings-row"><div><h3>${label('privacy.title')}</h3><p>${label('privacy.hint')}</p></div><input id="support-privacy" data-setting="hideIdentity" type="checkbox" aria-label="${ht('privacy.title')}" data-i18n-aria-label="privacy.title"></div></section><details class="wb-panel"><summary>${label('ui.endpoint')}</summary><p class="wb-subtitle">${label('ui.endpointHint')}</p><label for="support-endpoint">${label('advanced.endpoint')}</label><select id="support-endpoint" data-setting="images.endpoint"><option value="daily">Daily</option><option value="production">Production</option></select></details><section class="wb-panel"><h2>${label('ui.runtime')}</h2><div class="actions">${button('recheck', 'workbenchView.c25fb86b1e')}${button('official','ui.officialExtension')}${button('workbench','ui.thisExtension')}${button('host', 'ui.runtime')}</div></section>`;
  const help = `<div class="wb-grid"><section class="wb-panel"><h2>${label('ui.accounts')}</h2><p class="wb-subtitle">${label('ui.accountsSubtitle')}</p><div class="actions"><button data-wb-nav="accounts">${label('ui.accounts')}</button><button data-wb-nav="history">${label('history.title')}</button></div></section><section class="wb-panel"><h2>${label('ui.images')}</h2><p class="wb-subtitle">${label('workbenchView.499cd0861b')}</p><button data-wb-nav="images">${label('ui.images')}</button></section><section class="wb-panel"><h2>${label('ui.schedules')}</h2><p class="wb-subtitle">${label('alerts.hint')}</p><div class="actions"><button data-wb-nav="automation">${label('ui.schedules')}</button><button data-wb-nav="alerts">${label('ui.alerts')}</button></div></section><section class="wb-panel"><h2>${label('ui.records')}</h2><p class="wb-subtitle">${label('ui.recordHint')}</p><button data-wb-nav="records">${label('observations.title')}</button></section></div><section class="wb-panel"><h2>${label('ui.guide')}</h2><p class="wb-subtitle">${label('ui.guideHint')}</p>${button('guide','ui.openGuide')}</section><section class="wb-panel"><h2>${label('ui.advanced')}</h2><p class="wb-subtitle">${label('ui.troubleshootingHint')}</p><button data-wb-nav="diagnostics">${label('ui.advanced')}</button></section>`;
  const diagnostics = `<section class="wb-panel"><div class="wb-section-head"><h2>${label('ui.runtime')}</h2>${button('host','ui.runtime')}</div><div class="actions">${button('recheck','workbenchView.c25fb86b1e')}${button('extensionPath','ui.extensionPath')}${button('credentialPath','ui.credentialPath')}${button('imagePath','ui.imagePath')}</div><p id="support-host" class="wb-subtitle"></p></section><section class="wb-panel"><h2>${label('ui.catalog')}</h2><div class="actions">${button('catalog','ui.catalog')}${button('dismissCatalog','workbenchView.158264afc5')}${button('imageAccount','ui.imageAccountDiagnostic')}${button('imageProject','ui.imageProjectDiagnostic')}</div><pre id="support-catalog"></pre></section><section class="wb-panel"><div class="wb-section-head"><h2>${label('ui.logs')}</h2>${button('toggleLogs','ui.toggleLogs')}</div><p class="wb-subtitle">${label('ui.logsHint')}</p><p id="support-log-state" class="wb-subtitle"></p><div class="actions">${button('previewLogs','ui.previewLogs')}${button('exportLogs','ui.exportLogs')}${button('logPath','ui.copyLogPath')}${button('logFolder','ui.openLogFolder')}</div></section><section class="wb-panel"><h2>${label('officialProcess.title')}</h2><div class="actions"><button data-wb-nav="accounts">${label('ui.accounts')}</button>${button('acceptance','ui.acceptance')}${button('tools','ui.nativeTools')}</div></section>`;
  return `<!doctype html><html lang="${locale()}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'"><style nonce="${nonce}">${workbenchStyles}.wb-content>.wb-stack{max-width:1100px}.wb-panel>pre{background:var(--wb-bg);padding:12px;border-radius:8px}.wb-panel>pre:empty{display:none}</style></head><body data-wb-page="${page}"><main>${workbenchStart(page as WorkbenchPage)}<header class="wb-page-heading"><h1>${label(heading)}</h1></header><div class="wb-stack">${page === 'settings' ? settings : page === 'help' ? help : diagnostics}</div><p id="support-notice" class="wb-error" role="status" aria-live="polite"></p><footer class="wb-footer">Antigravity Workbench · <span id="support-version"></span></footer>${workbenchEnd}</main><script nonce="${nonce}">${clientI18n()}const api=acquireVsCodeApi();${workbenchNavigationScript}
const notice=document.getElementById('support-notice');let pending=false;
document.addEventListener('change',event=>{const el=event.target;if(!el.dataset.setting)return;if(pending)return;pending=true;el.disabled=true;api.postMessage({type:'setting',key:el.dataset.setting,value:el.type==='checkbox'?el.checked:el.value})});
document.addEventListener('click',event=>{const button=event.target.closest('button[data-support-action]');if(button&&!button.disabled)api.postMessage({type:'action',action:button.dataset.supportAction})});
window.addEventListener('message',event=>{const m=event.data;if(!m)return;if(m.type==='language'){language=m.language;applyLanguage()}if(m.type==='state'){document.getElementById('support-version').textContent=m.version;const lang=document.getElementById('support-language'),privacy=document.getElementById('support-privacy'),endpoint=document.getElementById('support-endpoint');if(lang)lang.value=m.language;if(privacy)privacy.checked=m.hidden;if(endpoint)endpoint.value=m.endpoint;const host=document.getElementById('support-host'),catalog=document.getElementById('support-catalog'),log=document.getElementById('support-log-state');if(host)host.textContent=m.host||'';if(catalog)catalog.textContent=m.catalog||'';if(log)log.textContent=m.logState||''}if(m.type==='complete'){pending=false;for(const el of document.querySelectorAll('[data-setting]'))el.disabled=false;notice.textContent=tr(m.ok?'ui.settingsSaved':'ui.settingsFailed')}});api.postMessage({type:'ready'});</script></body></html>`;
}

export function registerWorkbenchSupport(context: vscode.ExtensionContext, deps: { helpUri: vscode.Uri; debug: () => DebugUiState }): { refresh(): void } {
  const panels = new Map<SupportPage, vscode.WebviewPanel>();
  const flights = new Set<vscode.WebviewPanel>();
  let disposed = false;
  const config = () => vscode.workspace.getConfiguration('antigravityAccounts');
  const globalValue = (key: string) => config().inspect(key)?.globalValue ?? config().inspect(key)?.defaultValue;
  const emit = async (owner: vscode.WebviewPanel) => {
    if (disposed || ![...panels.values()].includes(owner)) return;
    const debug = deps.debug();
    await owner.webview.postMessage({ type: 'state', version: context.extension.packageJSON.version, language: locale(), hidden: globalValue('hideIdentity') === true, endpoint: globalValue('images.endpoint') === 'production' ? 'production' : 'daily', host: debug.host, catalog: debug.catalogReport ?? '', logState: debug.enabled ? t('ui.logsOn') : t('ui.logsOff') });
  };
  const actions: Readonly<Record<string, string>> = {
    theme: 'workbench.action.selectTheme', recheck: 'antigravityAccounts.recheck', official: 'antigravityAccounts.openOfficialExtension', workbench: 'antigravityAccounts.openWorkbenchExtension', host: 'antigravityAccounts.openHostSettings',
    extensionPath: 'antigravityAccounts.locations.copyExtension', credentialPath: 'antigravityAccounts.locations.copyCredentials', imagePath: 'antigravityAccounts.locations.copyImageOutput', catalog: 'antigravityAccounts.debug.catalog', dismissCatalog: 'antigravityAccounts.debug.dismissCatalog', imageAccount: 'antigravityAccounts.images.diagnoseAccount', imageProject: 'antigravityAccounts.images.diagnoseProject', toggleLogs: 'antigravityAccounts.debug.toggle', previewLogs: 'antigravityAccounts.debug.preview', exportLogs: 'antigravityAccounts.debug.exportPreview', logPath: 'antigravityAccounts.debug.copyDirectory', logFolder: 'antigravityAccounts.debug.openDirectory', acceptance: 'antigravityAccounts.live.acceptance', tools: 'antigravityAccounts.debug.tools',
  };
  const open = (page: SupportPage) => {
    if (disposed) return;
    const existing = panels.get(page); if (existing) { existing.reveal(); void emit(existing); return; }
    const title = page === 'settings' ? t('ui.settings') : page === 'help' ? t('ui.help') : t('ui.advanced');
    const owner = createWorkbenchPanel(vscode, 'antigravitySupport.' + page, title, vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
    panels.set(page, owner); owner.webview.html = supportHtml(page, randomBytes(16).toString('hex'));
    context.subscriptions.push(owner.onDidDispose(() => { if (panels.get(page) === owner) panels.delete(page); flights.delete(owner); }), owner.webview.onDidReceiveMessage(async (m: unknown) => {
      if (disposed || panels.get(page) !== owner || !m || typeof m !== 'object' || Array.isArray(m)) return;
      if (routeWorkbenchNavigation(m)) return;
      const msg = m as Record<string, unknown>;
      if (msg.type === 'ready' && Object.keys(msg).length === 1) { await emit(owner); return; }
      if (flights.has(owner)) return;
      if (msg.type === 'setting' && Object.keys(msg).length === 3 && page === 'settings') {
        const valid = msg.key === 'language' && typeof msg.value === 'string' && ['zh-CN', 'en'].includes(msg.value) || msg.key === 'images.endpoint' && typeof msg.value === 'string' && ['daily', 'production'].includes(msg.value) || msg.key === 'hideIdentity' && typeof msg.value === 'boolean';
        if (!valid || typeof msg.key !== 'string') return;
        flights.add(owner); let ok = false;
        try { await config().update(msg.key, msg.value, vscode.ConfigurationTarget.Global); ok = true; } catch { /* Keep the prior host setting on failure. */ }
        finally { flights.delete(owner); if (panels.get(page) === owner && !disposed) { await emit(owner); await owner.webview.postMessage({ type: 'complete', ok }); } }
      } else if (msg.type === 'action' && Object.keys(msg).length === 2 && typeof msg.action === 'string') {
        if (msg.action === 'guide') { const doc = await vscode.workspace.openTextDocument(deps.helpUri); if (!disposed && panels.get(page) === owner) await vscode.window.showTextDocument(doc, { preview: true }); return; }
        if (!Object.hasOwn(actions, msg.action)) return;
        flights.add(owner);
        try { await vscode.commands.executeCommand(actions[msg.action]!); } catch { if (panels.get(page) === owner) await owner.webview.postMessage({ type: 'complete', ok: false }); }
        finally { flights.delete(owner); await emit(owner); }
      }
    }));
  };
  context.subscriptions.push(vscode.commands.registerCommand('antigravityAccounts.openSettings', () => open('settings')), vscode.commands.registerCommand('antigravityAccounts.openHelp', () => open('help')), vscode.commands.registerCommand('antigravityAccounts.support.diagnostics', () => open('diagnostics')), onLanguageChange(() => { for (const [page, owner] of panels) { owner.title = t(page === 'settings' ? 'ui.settings' : page === 'help' ? 'ui.help' : 'ui.advanced'); void owner.webview.postMessage({ type: 'language', language: locale() }); void emit(owner); } }), vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('antigravityAccounts')) for (const owner of panels.values()) void emit(owner); }), { dispose() { disposed = true; for (const owner of panels.values()) owner.dispose(); panels.clear(); } });
  return { refresh() { for (const owner of panels.values()) void emit(owner); } };
}
