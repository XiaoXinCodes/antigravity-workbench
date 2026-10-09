import { ht, localizeLines, localizeMessage, locale, onLanguageChange, t as tr } from './i18n';
import { verifiedCurrentAccountId } from './current-account';
import { type LastAccountFailure } from './last-account-failure';
import type { DebugUiState } from './debug-ui';
import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type { LiveAccountView, LiveQuotaState, LiveRecoveryPhase } from './live-ui';
import type { Account } from './core';
import type { WorkbenchLocations } from './workbench-locations';
import type { ProcessConflictState } from './official-process-recovery';

export interface WorkbenchState {
  processConflicts?: ProcessConflictState;
  processSwitchTarget?: string;
  version?: string;
  lastFailure?: LastAccountFailure;
  accounts: LiveAccountView[];
  locations?: WorkbenchLocations;
  debug?: DebugUiState;
  currentQuota?: LiveQuotaState;
  /** Only supplied by fresh official identity verification; never quota/cache labels. */
  activeEmail?: string;
  activeVerifiedAt?: string;
  identityChecking?: boolean;
  lastKnownAccountId?: string;
  identityVerifiedDuringRecovery?: boolean;
  currentLoginSave?: 'saved' | 'update';
  /** Kept for legacy storage compatibility; offline snapshots are not account logins. */
  snapshots: Account[];
  status: string;
  busy: boolean;
  pending: boolean;
  recoveryPhase?: LiveRecoveryPhase;
  storageMode?: string;
  loginMutationAvailable?: boolean;
  loginMutationReason?: string;
  warning: string | null;
  environment: { available: boolean; message: string };
  official?: { available: boolean; message: string };
}
const COMMANDS = new Set(['live.processScan', 'live.processEnd', 'live.processEndAll', 'live.processContinue', 'live.login', 'live.capture', 'live.switch', 'live.verify', 'live.quota', 'live.quotaCancel', 'live.restore', 'live.remove', 'live.export', 'live.import', 'images.open', 'openSettings', 'openHelp', 'recheck', 'openOfficialExtension', 'openHostSettings', 'openWorkbenchExtension', 'locations.copyExtension', 'locations.copyCredentials', 'locations.copyImageOutput', 'locations.openExtension', 'debug.catalog', 'debug.dismissCatalog', 'debug.toggle', 'debug.copyDirectory', 'debug.openDirectory', 'debug.preview', 'debug.exportPreview']);
const INDEPENDENT_COMMANDS = new Set(['live.quotaCancel', 'debug.catalog', 'debug.dismissCatalog', 'debug.toggle', 'debug.preview', 'debug.exportPreview', 'debug.copyDirectory', 'debug.openDirectory', 'openSettings', 'openHelp', 'openOfficialExtension', 'openWorkbenchExtension', 'openHostSettings', 'locations.copyExtension', 'locations.copyCredentials', 'locations.copyImageOutput', 'locations.openExtension']);
const RESTORABLE_PHASES = new Set<LiveRecoveryPhase>(['authorizing', 'prepared', 'installed', 'restored']);
function escape(value: string): string { return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!); }
function button(command: string, title: string, primary = false, id?: string, disabled = false, hint?: string): string {
  return `<button type="button" data-command="${command}"${id ? ` data-id="${escape(id)}"` : ''}${disabled ? ' disabled' : ''} class="${primary ? 'primary' : 'secondary'}"${hint ? ` aria-label="${escape(hint)}" title="${escape(hint)}"` : ''}>${title}</button>`;
}
function renderProcesses(state: WorkbenchState): string {
  const conflict = state.processConflicts;
  if (!conflict || conflict.canContinue && !state.processSwitchTarget) return '';
  const blocked = state.busy || state.pending || !state.environment.available;
  const canEnd = conflict.processes.filter(row => row.canEnd);
  const rows = conflict.processes.map(row => `<li><strong>PID ${row.pid}</strong><p>${escape(tr('officialProcess.started', { time: row.startedAt ? new Date(row.startedAt).toLocaleString() : tr('officialProcess.unknownTime') }))}</p><p>${escape(tr('officialProcess.parent', { pid: row.parentPid ?? '?', state: tr(`officialProcess.parent.${row.parentState}`) }))}</p><p>${escape(tr(row.scope ? `officialProcess.scope.${row.scope}` : `officialProcess.owner.${row.owner}`))} · ${ht('officialProcess.tasksUnknown')}</p>${button('live.processEnd', tr(row.endMode === 'force' ? state.processSwitchTarget ? 'officialProcess.forceAndSwitch' : 'officialProcess.forceButton' : state.processSwitchTarget ? 'officialProcess.endAndSwitch' : 'officialProcess.endButton'), false, row.id, blocked || !row.canEnd || canEnd.length > 1)}</li>`).join('');
  return `<section class="panel process-conflicts" aria-label="${ht('officialProcess.title')}"><h3>${ht('officialProcess.title')}</h3><p>${escape(tr(conflict.canContinue ? 'officialProcess.ready' : 'officialProcess.blocked'))}</p>${state.processSwitchTarget ? `<p>${escape(tr('officialProcess.switchNext', { account: state.processSwitchTarget }))}</p>` : ''}<ul>${rows}</ul>${conflict.limitation ? `<p>${escape(tr(conflict.limitation === 'platform' ? 'officialProcess.platformUnavailable' : conflict.limitation === 'windows-helper' ? 'officialProcess.windowsHelperUnavailable' : 'officialProcess.helperUnavailable'))}</p>` : ''}<div class="actions">${canEnd.length > 1 ? button('live.processEndAll', tr('officialProcess.batchEnd'), true, undefined, blocked) : ''}${button('live.processScan', tr('officialProcess.scan'), false, undefined, state.busy)}${conflict.canContinue && state.processSwitchTarget ? button('live.processContinue', tr('officialProcess.continue'), true, undefined, blocked) : ''}</div></section>`;
}
function renderCatalog(debug: DebugUiState | undefined): string {
  if (!debug?.catalogBusy && !debug?.catalogReport) return '';
  return `<section class="panel" id="catalog-panel" aria-label="${ht("workbenchView.d6ba667a14")}"><div class="section-head"><h2>${ht("workbenchView.d6ba667a14")}</h2>${button('debug.dismissCatalog', tr("workbenchView.158264afc5"))}</div><pre id="catalog-report" class="catalog-report" role="status" aria-live="polite">${escape(debug.catalogReport ? localizeLines(debug.catalogReport) : tr("workbenchView.8bbb38569d"))}</pre>${button('debug.catalog', debug.catalogBusy ? tr("workbenchView.cb98dd6d7d") : debug.catalogStopping ? tr("workbenchView.ee703eb597") : tr("workbenchView.471cada84e"), false, undefined, !!debug.catalogBusy || !!debug.catalogStopping)}</section>`;
}
function quotaDate(value: string | null): string {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString(locale(), { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : tr("workbenchView.4d8c1c5b42");
}
function renderQuota(quota: LiveQuotaState | undefined, expectedEmail: string, unavailable?: string): string {
  if (quota?.message) quota = { ...quota, message: localizeMessage(quota.message) };
  // Server results are account-bound. Cached login model configuration and results
  // associated with another email must never paint a saved account's quota bars.
  const candidate = quota?.snapshot?.source === 'server' ? quota.snapshot : undefined;
  const mismatch = !!candidate && candidate.email.trim().toLowerCase() !== expectedEmail.trim().toLowerCase();
  const snapshot = mismatch ? undefined : candidate;
  const rows = snapshot?.buckets.map(bucket => {
    const remaining = typeof bucket.remaining === 'number' && Number.isFinite(bucket.remaining) && bucket.remaining >= 0 && bucket.remaining <= 1 ? Math.round(bucket.remaining * 100) : null;
    const tone = remaining === null || bucket.disabled ? 'unknown' : remaining <= 15 ? 'low' : remaining <= 40 ? 'medium' : 'healthy';
    return `<li class="quota-row ${tone}"><div class="quota-model"><span>${escape(bucket.label)}</span><b>${bucket.disabled ? tr("workbenchView.460b3574e4") : remaining !== null ? `${remaining}%` : bucket.remainingAmount && /^\d{1,20}$/.test(bucket.remainingAmount) ? escape(bucket.remainingAmount) : tr("workbenchView.4d8c1c5b42")}</b></div>${remaining === null || bucket.disabled ? '' : `<progress max="100" value="${remaining}" aria-label="${escape(bucket.label)}${ht("workbenchView.ae7c747004")}${remaining}%"></progress>`}${bucket.resetAt ? `<small>${ht("workbenchView.bce2a872e0")}${escape(quotaDate(bucket.resetAt))}</small>` : ''}</li>`;
  }).join('');
  const message = mismatch ? tr("workbenchView.e92654f514") : quota?.message;
  return `<div class="account-quota" aria-label="${ht("workbenchView.d4747d65d6")}" aria-live="polite">${quota?.phase === 'loading' ? `<p class="quota-message loading-label">${escape(quota.message || tr("workbenchView.8afea0417e"))}</p>` : ''}${message && quota?.phase !== 'loading' ? `<p class="quota-message${mismatch || quota?.phase === 'error' || quota?.phase === 'mismatch' ? ' quota-warning' : ''}">${escape(message)}</p>` : ''}${snapshot ? `${rows ? `<ul class="quota-list">${rows}</ul>` : `<p class="quota-message">${ht("workbenchView.5ec2c72f9a")}</p>`}<p class="quota-source"><span>${quota?.phase === 'ready' ? tr("workbenchView.5671928b37") : tr("workbenchView.97a579c26a")}</span><span title="${ht("workbenchView.2748a0e238")}">${ht("workbenchView.e0a0d9df9e")}${escape(quotaDate(snapshot.observedAt))}</span></p>` : quota?.phase === 'loading' || message ? '' : `<p class="quota-empty">${escape(unavailable || tr("workbenchView.bcf32a9e98"))}<span>${unavailable ? '' : tr("workbenchView.57e0fcf147")}</span></p>`}</div>`;
}
export function renderWorkbench(state: WorkbenchState, nonce: string): string {
  state = { ...state, status: localizeMessage(state.status), warning: state.warning ? localizeMessage(state.warning) : null, ...(state.loginMutationReason ? { loginMutationReason: localizeMessage(state.loginMutationReason) } : {}), environment: { ...state.environment, message: localizeMessage(state.environment.message) }, ...(state.official ? { official: { ...state.official, message: localizeMessage(state.official.message) } } : {}) };
  const hostBlocked = !state.environment.available || state.official?.available === false;
  const blocked = state.busy || hostBlocked;
  const captureOnly = state.loginMutationAvailable === false;
  const captureBlocked = blocked || state.pending;
  const mutationBlocked = captureBlocked || captureOnly;
  const migrationBlocked = state.busy || state.pending || !state.environment.available;
  const phase = state.recoveryPhase ?? (state.pending ? 'checking' : 'none');
  const verify = phase === 'installed' || phase === 'restored';
  const restore = RESTORABLE_PHASES.has(phase);
  const restoreLabel = phase === 'restored' ? tr("workbenchView.5bbf610aad") : phase === 'authorizing' || phase === 'prepared' ? tr("workbenchView.96ec98e121") : tr("workbenchView.ce965cd194");
  const showStatus = state.busy || state.pending || (state.status && ![tr("workbenchView.d98a7e24c6"), tr("workbenchView.0746a7244b"), tr("workbenchView.3aeb83569c"), tr("workbenchView.1bd1893c09"), 'idle', tr("workbenchView.d47369e8f6")].includes(state.status));
  const activeEmail = !state.pending && state.activeEmail?.trim().toLowerCase();
  const lastKnown = !activeEmail && !state.pending ? state.accounts.find(account => account.id === state.lastKnownAccountId && account.hostCurrent === true) : undefined;
  const currentAccountId = verifiedCurrentAccountId(state.accounts, state.activeEmail, state.pending && !state.identityVerifiedDuringRecovery);
  const logins = state.accounts.map(account => {
    const active = account.id === currentAccountId;
    const unavailable = account.hostCurrent === false;
    const quotaBlocked = state.busy || !state.environment.available || state.pending || unavailable;
    const hostLabel = unavailable ? account.hostId ? tr("workbenchView.90cbf29694") : tr("workbenchView.a142dc8bf3") : account.hostCurrent === true ? tr("workbenchView.a519e13a7d") : tr("workbenchView.c2c66db80b");
    return `<article class="account${active ? ' active' : ''}"><div class="account-heading"><div class="avatar" aria-hidden="true">${escape(account.label.slice(0, 1).toUpperCase())}</div><div class="account-copy"><div class="account-title"><strong>${escape(account.label)}${active ? `<span class="current-badge">${ht("workbenchView.d381a6a80a")}</span>` : ''}</strong></div>${account.label !== account.expectedEmail ? `<span class="account-email">${escape(account.expectedEmail)}</span>` : ''}</div></div>${unavailable ? `<p class="account-host-warning">${escape(hostLabel)}</p>` : ''}${account.migrationState === 'pending' ? `<p class="account-migration-warning">${ht("workbenchView.1746554285")}</p>` : account.migrationState === 'verified' ? `<p class="account-meta">${account.hostCurrent === true ? tr("workbenchView.77a1864d31") : tr("workbenchView.d6472e23fc")}</p>` : ''}${renderQuota(account.quota, account.expectedEmail, unavailable ? tr("workbenchView.2d5d3fe1bf") : undefined)}<div class="account-actions" aria-label="${escape(hostLabel)}">${button('live.switch', active ? tr("workbenchView.fa48e89389") : tr("workbenchView.eff514b8b8"), false, account.id, mutationBlocked || unavailable || active, active ? tr("workbenchView.d936f4d240") : tr("workbenchView.5eb46a98f7", { p0: account.expectedEmail }))}${account.quota?.phase === 'loading' ? button('live.quotaCancel', tr("workbenchView.d2be45fdd9"), false, undefined, false, tr("workbenchView.95b32918fb")) : button('live.quota', tr("workbenchView.aee8874341"), false, account.id, quotaBlocked, tr("workbenchView.6553407ba8", { p0: account.expectedEmail }))}${button('live.remove', tr("workbenchView.6135d4159e"), false, account.id, migrationBlocked, tr("workbenchView.aca7c54e43", { p0: account.expectedEmail }))}</div></article>`;
  }).join('');
  return `<!DOCTYPE html><html lang="${locale()}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><title>Antigravity Workbench</title><style nonce="${nonce}">

:root{color-scheme:light dark}*{box-sizing:border-box}.catalog-report{white-space:pre-wrap;overflow-wrap:anywhere;font:11px/1.6 var(--vscode-editor-font-family,monospace)}html{overflow-y:auto}body{margin:0;min-width:0;padding:16px 12px;background:var(--vscode-sideBar-background,#181b20);color:var(--vscode-foreground,#e7ebf1);font:13px/1.5 var(--vscode-font-family,system-ui,sans-serif);overflow-wrap:anywhere}main{width:100%;min-width:0}button,summary{font:inherit}button{min-width:0;max-width:100%;cursor:pointer;border:1px solid transparent;border-radius:5px;padding:7px 10px;line-height:1.4;text-align:center;white-space:normal;overflow-wrap:anywhere}button:focus-visible,summary:focus-visible{outline:2px solid var(--vscode-focusBorder,#729ef1);outline-offset:2px}button:disabled{cursor:default;opacity:.45}.primary{color:var(--vscode-button-foreground,#fff);background:var(--vscode-button-background,#4774cf)}.primary:hover:not(:disabled){background:var(--vscode-button-hoverBackground,#5684df)}.secondary{color:var(--vscode-foreground,#e7ebf1);background:var(--vscode-button-secondaryBackground,#292f38)}.secondary:hover:not(:disabled){background:var(--vscode-button-secondaryHoverBackground,#343d49)}h1,h2,p{margin:0}h1{font-size:19px;line-height:1.25;font-weight:650;letter-spacing:-.3px}h2{font-size:13px;font-weight:650}.eyebrow{font-size:9px;letter-spacing:1.5px;font-weight:600;color:var(--vscode-descriptionForeground,#9ca7b7);margin-bottom:4px}.subtitle,.muted{color:var(--vscode-descriptionForeground,#9ca7b7);font-size:11px}.subtitle{margin-top:5px}.top{display:flex;flex-wrap:wrap;justify-content:space-between;gap:7px;align-items:flex-start;margin-bottom:18px}.top>div{min-width:0}.version{flex-shrink:0;font-size:10px;padding:2px 6px;border:1px solid var(--vscode-widget-border,#343d49);border-radius:20px;color:var(--vscode-descriptionForeground,#9ca7b7)}
.section{min-width:0;margin-bottom:18px}.section-head{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between;margin-bottom:8px}.count{font-size:10px;font-weight:400;color:var(--vscode-descriptionForeground,#9ca7b7);margin-left:6px}.actions{display:flex;gap:6px;flex-wrap:wrap}.actions button{flex:1 1 auto}.account-toolbar{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;margin:9px 0 6px}.account-toolbar>button{width:100%;font-size:12px}.account-tools{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:5px}.account-tools button{font-size:11px;padding:5px 4px;background:transparent;border-color:var(--vscode-widget-border,#343d49);color:var(--vscode-descriptionForeground,#a8b2c1)}.current-status{display:flex;gap:5px;align-items:center;margin:8px 0 11px;font-size:10px;color:var(--vscode-descriptionForeground,#9ca7b7)}.current-status::before{content:'';width:5px;height:5px;border-radius:50%;background:var(--vscode-descriptionForeground,#8190a5);flex-shrink:0}.current-status.verified::before{background:var(--vscode-charts-green,#57b898)}.panel{min-width:0;border:1px solid var(--vscode-widget-border,#343d49);border-radius:8px;background:var(--vscode-editor-background,#20252c);padding:13px}.empty h2{font-size:14px;margin-bottom:5px}.empty p{color:var(--vscode-descriptionForeground,#9ca7b7);font-size:11px}.status{border-left:2px solid var(--vscode-focusBorder,#729ef1);padding:9px 10px;margin-bottom:9px;background:var(--vscode-textBlockQuote-background,#252d39);font-size:11px;overflow-wrap:anywhere}.status p+div{margin-top:8px}.status.warning{border-color:var(--vscode-editorWarning-foreground,#d4a958)}.status.busy{border-color:var(--vscode-progressBar-background,#729ef1)}.status[hidden]{display:none}.oauth-reason{margin:9px 0;font-size:11px;color:var(--vscode-editorWarning-foreground,#d4a958)}
.process-conflicts{margin:10px 0;font-size:11px}.process-conflicts ul{padding:0;list-style:none}.process-conflicts li{padding:9px 0;border-bottom:1px solid var(--vscode-widget-border)}.process-conflicts p{margin:4px 0}.account-list{display:grid;grid-template-columns:minmax(0,1fr);gap:9px}.account{min-width:0;border:1px solid var(--vscode-widget-border,#343d49);border-radius:8px;background:var(--vscode-editor-background,#20252c);padding:11px}.account.active{border-color:var(--vscode-focusBorder,#6a91d3);box-shadow:inset 2px 0 var(--vscode-focusBorder,#6a91d3)}.account-heading{display:grid;grid-template-columns:27px minmax(0,1fr);align-items:center;gap:8px}.avatar{width:27px;height:27px;border-radius:7px;display:grid;place-items:center;color:var(--vscode-badge-foreground,#dce6f8);background:var(--vscode-badge-background,#33435b);font-size:12px;font-weight:600}.account-copy{min-width:0}.account-title{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}.account-title strong{min-width:0;overflow-wrap:anywhere;font-size:12px;font-weight:600}.account-email{display:block;overflow-wrap:anywhere;font-size:10px;color:var(--vscode-descriptionForeground,#a1adbd);margin-top:1px}.current-badge{flex-shrink:0;display:inline-flex;border-radius:4px;padding:1px 5px;font-size:9px;line-height:1.4;color:var(--vscode-textLink-foreground,#9ebefa);background:var(--vscode-button-secondaryBackground,#30415e)}.account-host-warning,.account-migration-warning{margin-top:7px;font-size:10px;color:var(--vscode-editorWarning-foreground,#d4a958)}.account-meta{font-size:10px;color:var(--vscode-descriptionForeground,#9ca7b7);margin-top:6px}.account-actions{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:5px;align-items:stretch;margin-top:10px;padding-top:8px;border-top:1px solid var(--vscode-widget-border,#343d49);min-width:0}.account-actions>button{font-size:11px;padding:4px 3px;background:transparent;color:var(--vscode-descriptionForeground,#b0bbcb)}.account-actions>button:hover:not(:disabled){background:var(--vscode-list-hoverBackground,#2b3441)}.account-actions>button:nth-child(2){color:var(--vscode-textLink-foreground,#9ebefa)}.account-actions>button:last-child:hover:not(:disabled){color:var(--vscode-errorForeground,#f08c86)}.account-quota{min-width:0;margin-top:11px}.quota-source{display:flex;flex-wrap:wrap;justify-content:space-between;gap:0 4px;font-size:9px;color:var(--vscode-descriptionForeground,#8f9cad);margin-top:9px;font-variant-numeric:tabular-nums}.quota-message{font-size:10px;color:var(--vscode-descriptionForeground,#9ca7b7);margin-top:6px;padding:6px 7px;border-radius:4px;background:var(--vscode-sideBar-background,#181b20)}.quota-warning{color:var(--vscode-editorWarning-foreground,#d4a958);border-left:2px solid currentColor}.loading-label::before{content:'↻';margin-right:5px}.quota-empty{font-size:11px;color:var(--vscode-descriptionForeground,#b0bbcb);padding:5px 0}.quota-empty span{display:block;font-size:10px;color:var(--vscode-descriptionForeground,#8f9cad);margin-top:3px}.quota-list{list-style:none;margin:0;padding:0}.quota-list li+li{margin-top:9px}.quota-model{display:flex;justify-content:space-between;align-items:flex-start;gap:8px;font-size:11px}.quota-model span{min-width:0;overflow-wrap:anywhere}.quota-model b{flex-shrink:0;font-size:11px;font-weight:600;font-variant-numeric:tabular-nums}.quota-row{--quota-color:var(--vscode-charts-green,#57b898)}.quota-row.medium{--quota-color:var(--vscode-charts-yellow,#d7b263)}.quota-row.low{--quota-color:var(--vscode-charts-red,#e7837e)}.quota-row.unknown{--quota-color:var(--vscode-descriptionForeground,#9ca7b7)}.quota-model b{color:var(--quota-color)}.quota-list progress{display:block;appearance:none;border:0;border-radius:3px;width:100%;height:4px;margin:4px 0;accent-color:var(--quota-color);background:var(--vscode-widget-border,#343d49)}.quota-list progress::-webkit-progress-bar{background:var(--vscode-widget-border,#343d49);border-radius:3px}.quota-list progress::-webkit-progress-value{background:var(--quota-color);border-radius:3px}.quota-list progress::-moz-progress-bar{background:var(--quota-color);border-radius:3px}.quota-list small{display:block;font-size:9px;color:var(--vscode-descriptionForeground,#8f9cad);font-variant-numeric:tabular-nums}
.account-transfer{margin-top:9px;font-size:10px;color:var(--vscode-descriptionForeground,#9ca7b7)}.work-sections{display:grid;grid-template-columns:minmax(0,1fr);gap:9px}.tool-section{min-width:0}.tool-section p{font-size:11px;color:var(--vscode-descriptionForeground,#9ca7b7);margin:5px 0 9px}.tool-section>.primary{width:100%;font-size:11px;padding:6px 8px}.text-button{padding:2px 0;background:none;color:var(--vscode-textLink-foreground,#9ebefa);font-size:10px;border:none}
footer{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:7px 10px;margin-top:12px;font-size:9px;color:var(--vscode-descriptionForeground,#8f9cad)}.progress{display:none;height:2px;position:fixed;top:0;left:0;right:0;background:var(--vscode-progressBar-background,#729ef1)}body.waiting .progress{display:block}
@media(max-width:270px){body{padding:13px 9px}.panel,.account{padding:10px}.actions button{flex-basis:100%;width:100%}.top{margin-bottom:15px}.quota-source{display:block}.account-tools button{font-size:10px}}
@media(max-width:190px){.account-toolbar{grid-template-columns:minmax(0,1fr)}body{padding:11px 7px}.eyebrow{letter-spacing:.8px}.account-heading{grid-template-columns:22px minmax(0,1fr);gap:6px}.avatar{width:22px;height:22px;font-size:10px}.panel,.account{padding:8px}.account-tools{gap:3px}.account-tools button{padding:5px 2px}.account-actions{gap:3px}.account-actions>button{font-size:10px}.quota-model{gap:5px}.quota-model b{font-size:10px}.account-title{gap:3px}}
@media(min-width:760px){body{padding:24px}.account-list{grid-template-columns:repeat(2,minmax(0,1fr));align-items:start}.account-toolbar{max-width:480px}.account-tools{max-width:480px}}
@media(prefers-reduced-motion:no-preference){body.waiting .progress{animation:pulse 1s ease-in-out infinite}@keyframes pulse{50%{opacity:.35}}}
</style></head><body><div class="progress" role="progressbar" aria-label="${ht("workbenchView.3b7e27cb43")}"></div><main>
<header class="top"><div><p class="eyebrow">ANTIGRAVITY</p><h1>${ht("workbenchView.f9e02d3c13")}</h1><p class="subtitle">${ht("workbenchView.b7d9f2753b")}</p></div><span class="version">${typeof state.version === 'string' && /^\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(state.version) ? state.version : tr("workbenchView.dc73097905")}</span></header>
<section class="section" aria-labelledby="accounts-heading"><div class="section-head"><h2 id="accounts-heading">${ht("workbenchView.311bb313fd")}<span class="count">${state.accounts.length ? tr("workbenchView.78ac141f4c", { p0: state.accounts.length }) : tr("workbenchView.452f1ad450")}</span></h2></div>
${showStatus ? `<div class="status${state.busy ? ' busy' : state.pending ? ' warning' : ''}" role="status" data-recovery-phase="${phase}"><p>${escape(state.status)}</p>${verify || restore ? `<div class="actions">${verify ? button('live.verify', tr("workbenchView.2e1b7b66de"), true, undefined, blocked) : ''}${restore ? button('live.restore', restoreLabel, !verify, undefined, blocked || (captureOnly && phase !== 'restored')) : ''}</div>` : ''}</div>` : ''}
${state.warning ? `<div class="status warning" role="alert">${escape(state.warning)}</div>` : ''}
<div class="account-toolbar" aria-label="${ht("workbenchView.b7d5411de6")}">${button('live.login', tr("workbenchView.91af6e57e7"), true, undefined, mutationBlocked, tr("workbenchView.f8ee1d2d2e"))}${button('live.capture', state.currentLoginSave === 'saved' && currentAccountId ? tr("workbenchView.1bd91a7d0c") : state.currentLoginSave === 'update' && currentAccountId ? tr("workbenchView.dd6eec0893") : tr("workbenchView.dafb62a962"), false, undefined, captureBlocked || state.currentLoginSave === 'saved' && !!currentAccountId, tr("workbenchView.134e0c6295"))}</div><p class="account-transfer">${ht("workbenchView.df905107eb")}</p><div class="account-tools" aria-label="${ht("workbenchView.9cc7f74985")}">${button('live.export', tr("workbenchView.476e06f788"), false, undefined, migrationBlocked || !state.accounts.some(account => account.hostCurrent === true), tr("workbenchView.31407f52c0"))}${button('live.import', tr("workbenchView.9c2aa49d9c"), false, undefined, migrationBlocked, tr("workbenchView.5f1e2217ee"))}</div><p class="current-status${activeEmail && !state.identityChecking ? ' verified' : ''}"${activeEmail && state.activeVerifiedAt ? ` title="${escape(tr("workbenchView.b9c235e243", { p0: quotaDate(state.activeVerifiedAt) }))}"` : ''}>${lastKnown ? tr("workbenchView.lastKnownLogin", { p0: escape(lastKnown.expectedEmail) }) : state.identityChecking ? tr("workbenchView.249825545e") : activeEmail ? state.accounts.some(account => account.hostCurrent === true && account.expectedEmail.trim().toLowerCase() === activeEmail) ? tr("workbenchView.716e587169") : tr("workbenchView.31679a5ff2", { p0: escape(activeEmail) }) : state.pending ? tr("workbenchView.17e7d078ed") : tr("workbenchView.ca462750dc")}</p>
${captureOnly ? `<p class="oauth-reason" role="status">${escape(state.loginMutationReason || tr("workbenchView.ad02b7826a"))}</p>${!hostBlocked ? button('recheck', tr("workbenchView.c25fb86b1e")) : ''}` : ''}
${renderProcesses(state)}
${state.accounts.length ? `<div class="account-list">${logins}</div>` : `<div class="panel empty"><h2>${ht("workbenchView.63f894d55b")}</h2><p>${ht("workbenchView.2baac78070")}</p></div>`}
${state.currentQuota?.snapshot && !state.accounts.some(account => account.hostCurrent !== false && account.expectedEmail.toLowerCase() === state.currentQuota!.snapshot!.email.toLowerCase()) ? `<p class="muted section-note">${ht("workbenchView.c70dbf24eb")}${escape(state.currentQuota.snapshot.email)}${ht("workbenchView.b53229f96c")}</p>` : ''}
</section>
<div class="work-sections"><section class="panel tool-section" aria-labelledby="images-heading"><h2 id="images-heading">${ht("workbenchView.c62a584592")}</h2><p>${ht("workbenchView.499cd0861b")}</p>${button('images.open', tr("workbenchView.8609a67d74"), true, undefined, state.busy || state.pending)}</section></div>
${hostBlocked ? `<div class="status warning" role="status"><p>${escape(!state.environment.available ? state.environment.message : state.official?.message || tr("workbenchView.41aedc0ef9"))}</p>${button('recheck', tr("workbenchView.c25fb86b1e"))}</div>` : ''}
${renderCatalog(state.debug)}
<footer><span>Antigravity Workbench</span><button type="button" class="text-button" data-command="openSettings">${ht("workbenchView.df3d58c7d8")}</button><button type="button" class="text-button" data-command="openHelp">${ht("workbenchView.df01e14ded")}</button></footer>
</main><script nonce="${nonce}">const api=acquireVsCodeApi();const previous=api.getState()||{};const expanded=previous.expanded||{};document.querySelectorAll('details[data-persist]').forEach(detail=>{if(!detail.hasAttribute('data-required-open'))detail.open=!!expanded[detail.id];detail.addEventListener('toggle',()=>{expanded[detail.id]=detail.open;api.setState({expanded});});});const catalogReport=document.getElementById('catalog-report');if(catalogReport)catalogReport.scrollIntoView({block:'nearest'});const independent=new Set(${JSON.stringify([...INDEPENDENT_COMMANDS])});const pending=new Map();const session=Math.random().toString(36).slice(2);let sequence=0;document.addEventListener('click',event=>{const target=event.target.closest('button[data-command]');if(!target||target.disabled)return;const command=target.dataset.command;if(pending.has(command)||(!independent.has(command)&&[...pending.keys()].some(key=>!independent.has(key))))return;const requestId=session+'-'+(++sequence);pending.set(command,requestId);if(!independent.has(command))document.body.classList.add('waiting');api.postMessage({command,requestId,...(target.dataset.id?(command==='live.processEnd'?{processId:target.dataset.id}:{accountId:target.dataset.id}):{})});});window.addEventListener('message',event=>{const message=event.data;if(!message||message.type!=='complete'||pending.get(message.command)!==message.requestId)return;pending.delete(message.command);if(![...pending.keys()].some(key=>!independent.has(key)))document.body.classList.remove('waiting');});</script></body></html>`;
}

export class WorkbenchView implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private disposed = false;
  private running = false;
  private readonly inFlight = new Set<string>();
  private nonce = randomBytes(16).toString('hex');
  private lastHtml = '';
  private dispatchWarning: string | null = null;
  private readonly subscriptions: vscode.Disposable[] = [];
  constructor(private readonly state: () => WorkbenchState, private readonly onResolve?: () => void) { this.subscriptions.push(onLanguageChange(() => this.refresh())); }
  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view; this.nonce = randomBytes(16).toString('hex'); this.lastHtml = '';
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    this.subscriptions.push(view.webview.onDidReceiveMessage(async (message: unknown) => {
      if (this.disposed || this.view !== view || !message || typeof message !== 'object') return;
      const { command, accountId, requestId, processId } = message as { command?: unknown; accountId?: unknown; requestId?: unknown; processId?: unknown };
      const complete = async (): Promise<void> => { if (!this.disposed && this.view === view) await view.webview.postMessage({ type: 'complete', command, ...(requestId === undefined ? {} : { requestId }) }); };
      if (typeof command !== 'string' || !COMMANDS.has(command) || (requestId !== undefined && (typeof requestId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/u.test(requestId)))) { await complete(); return; }
      const accountAction = ['live.switch', 'live.remove', 'live.quota'].includes(command);
      const processAction = command === 'live.processEnd';
      const allowedKeys = accountAction ? ['command', 'accountId', 'requestId'] : processAction ? ['command', 'processId', 'requestId'] : ['command', 'requestId'];
      if (Object.keys(message).some(key => !allowedKeys.includes(key)) || !Object.hasOwn(message, 'command')) { await complete(); return; }
      const state = this.state();
      if (accountAction ? typeof accountId !== 'string' || !state.accounts.some(account => account.id === accountId) : accountId !== undefined) { await complete(); return; }
      if (processAction ? typeof processId !== 'string' || !state.processConflicts?.processes.some(row => row.id === processId && row.canEnd) : processId !== undefined) { await complete(); return; }
      if (['live.switch', 'live.quota'].includes(command) && state.accounts.find(account => account.id === accountId)?.hostCurrent === false) { await complete(); return; }
      if ((command === 'live.verify' && !['installed', 'restored'].includes(state.recoveryPhase ?? 'none')) || (command === 'live.restore' && !RESTORABLE_PHASES.has(state.recoveryPhase ?? 'none'))) { this.refresh(); await complete(); return; }
      const independent = INDEPENDENT_COMMANDS.has(command);
      if (this.inFlight.has(command) || (this.running && !independent)) { await complete(); return; }
      this.inFlight.add(command); if (!independent) this.running = true; this.dispatchWarning = null;
      try { await vscode.commands.executeCommand(`antigravityAccounts.${command}`, ...(processAction ? [processId] : accountId === undefined ? [] : [accountId])); }
      catch { if (command === 'live.quota') this.dispatchWarning = tr("workbenchView.229ba71468"); else if (command === 'live.quotaCancel') this.dispatchWarning = tr("workbenchView.d1fa2e4410"); else void vscode.window.showWarningMessage(tr("workbenchView.02466d6504")); }
      finally { this.inFlight.delete(command); if (!independent) this.running = false; if (!this.disposed) this.refresh(); await complete(); }
    }), view.onDidDispose(() => { if (this.view === view) { this.view = undefined; this.lastHtml = ''; } }));
    this.refresh();
    this.onResolve?.();
  }
  async revealCatalog(): Promise<void> {
    if (this.disposed) throw new Error('CATALOG_VIEW_UNAVAILABLE');
    this.refresh();
    if (this.view) this.view.show(false);
    else await vscode.commands.executeCommand('antigravityAccounts.accounts.focus');
    if (this.disposed || !this.view) throw new Error('CATALOG_VIEW_UNAVAILABLE');
    // State is rendered as HTML even before the webview script is ready.
    this.refresh();
  }
  refresh(): void {
    if (this.view && !this.disposed) {
      const state = this.state();
      const html = renderWorkbench({ ...state, warning: [state.warning ? localizeMessage(state.warning) : null, this.dispatchWarning ? localizeMessage(this.dispatchWarning) : null].filter(Boolean).join(' · ') || null }, this.nonce);
      if (html !== this.lastHtml) { this.lastHtml = html; this.view.webview.html = html; }
    }
  }
  dispose(): void { this.disposed = true; for (const subscription of this.subscriptions) subscription.dispose(); this.view = undefined; }
}
