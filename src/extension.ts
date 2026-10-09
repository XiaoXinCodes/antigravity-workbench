import { registerLocalizedHelp } from './localized-help';
import { registerI18n } from './i18n-vscode';
import { localizeMessage, t as tr } from './i18n';
import { registerDebugUi } from './debug-ui';
import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { registerDirectImageUi } from './direct-image-ui';
import { createDirectImageIntegration } from './direct-image-vscode';
import { registerQuotaTools } from './quota-tools';
import { registerLiveUi } from './live-ui';
import { WorkbenchView } from './workbench-view';
import { registerWorkbenchLocations } from './workbench-locations';
import { addAccount, identityKey, InputError, mergeSnapshot, normalizeIdentity, normalizeLabel, SWITCH_BLOCKED, type Account } from './core';
import { ensurePrivateDirectory, mutateAccounts, readAccounts, readSnapshotDirectory, readSnapshotFile } from './snapshot-files';
export interface ExtensionDiagnosticsApi {
  getDiagnostics(): { warning: string | null; accountCount: number; liveSwitching: 'experimental'; liveStatus: string; debugEnabled: boolean };
}

let flushImageSession: (() => Promise<void>) | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<ExtensionDiagnosticsApi> {
  registerI18n(context);
  const helpUri = registerLocalizedHelp(context);
  let refreshDebug = (): void => undefined;
  const debug = registerDebugUi(context, () => refreshDebug(), { diagnoseCatalog: signal => direct.diagnoseCatalog(signal), revealCatalog: () => dashboard.revealCatalog() });
  const tree = { accounts: [] as Account[], warning: null as string | null, refresh: (): void => dashboard.refresh() };
  let accountChanged = (): void => undefined;
  let quotaChanged = (): void => undefined;
  const live = registerLiveUi(context, { changed: () => { tree.refresh(); accountChanged(); quotaChanged(); } });
  const quotaTools = registerQuotaTools(context, live, () => tree.refresh());
  quotaChanged = quotaTools.refresh;
  const direct = createDirectImageIntegration(context, () => live.getAccounts(), { accountsReady: () => live.getState().accountStorageReady });
  const images = registerDirectImageUi(context, direct, () => tree.refresh(), undefined, quotaTools.preferences);
  flushImageSession = images.flush;
  accountChanged = () => {
    const state = live.getState();
    images.accountStateChanged({ pending: state.pending, email: state.activeEmail ?? '',
      accountIds: live.getAccounts().filter(a => a.active).map(a => a.id) });
  };
  context.subscriptions.push(vscode.commands.registerCommand('antigravityAccounts.images.diagnoseAccount', async () => {
    try { void vscode.window.showInformationMessage(tr("extension.35e3da8122", { p0: await direct.diagnose(new AbortController().signal) })); }
    catch (error) { void vscode.window.showWarningMessage(tr("extension.35e3da8122", { p0: error instanceof Error && /^IMAGE_[A-Z_]+$/.test(error.message) ? error.message : 'IMAGE_DIRECT_REQUEST_FAILED' })); }
  }));
  context.subscriptions.push(vscode.commands.registerCommand('antigravityAccounts.images.diagnoseProject', async () => {
    try {
      const endpoint = direct.getEndpoint();
      const answer = await vscode.window.showWarningMessage(tr("extension.34e112f06f", { p0: endpoint === 'daily' ? 'Daily' : 'Production' }), { modal: true }, tr("extension.4fec499a78"));
      if (answer !== tr("extension.4fec499a78")) return;
      void vscode.window.showInformationMessage(tr("extension.f724f505b7", { p0: await direct.diagnoseProject(new AbortController().signal, endpoint) }));
    }
    catch (error) { void vscode.window.showWarningMessage(tr("extension.f724f505b7", { p0: error instanceof Error && /^IMAGE_[A-Z_]+$/.test(error.message) ? error.message : 'IMAGE_DIRECT_REQUEST_FAILED' })); }
  }));
  const locations = registerWorkbenchLocations(context, () => images.getOutputDirectory());
  const dashboard = new WorkbenchView(() => {
    const state = live.getState();
    return { version: context.extension.packageJSON.version, accounts: live.getAccounts(), snapshots: tree.accounts, warning: null, ...state, locations: locations.getState(), debug: debug.getState(), quotaPresentation: quotaTools.getState() }; // Legacy snapshot diagnostics never block the account workbench.
  }, () => { void live.ensureIdentity?.(); });
  refreshDebug = () => dashboard.refresh();
  context.subscriptions.push(dashboard, vscode.window.registerWebviewViewProvider('antigravityAccounts.accounts', dashboard));
  const stateDirectory = path.join(context.globalStorageUri.fsPath, 'metadata');
  const directory = path.join(context.globalStorageUri.fsPath, 'snapshots');
  let readOnly = false;
  try { tree.accounts = await readAccounts(stateDirectory); }
  catch { readOnly = true; tree.warning = tr("extension.0ca21660ee"); }
  let queue: Promise<void> = Promise.resolve();
  let disposed = false;
  const commit = async (transform: (accounts: Account[]) => Account[]): Promise<void> => {
    tree.accounts = await mutateAccounts(stateDirectory, transform);
    tree.refresh();
  };
  const run = (operation: () => Promise<void>): Promise<void> => {
    queue = queue.then(async () => {
      if (disposed) return;
      if (readOnly) throw new InputError('SAVED_DATA_REQUIRES_REPAIR');
      await operation();
    }).catch(error => {
      const code = error instanceof InputError ? error.code : 'LOCAL_IO_ERROR';
      tree.warning = tr("extension.0f85a0e89c", { p0: code });
      tree.refresh();
      // Informational notification dismissal must never block activation or the operation queue.
      void vscode.window.showWarningMessage(tree.warning);
    });
    return queue;
  };
  const refresh = async (): Promise<void> => {
    const result = await readSnapshotDirectory(directory);
    await commit(current => result.snapshots.reduce((accounts, snapshot) => mergeSnapshot(accounts, snapshot), current));
    tree.warning = result.failures || result.truncated ? tr("extension.a15c556294", { p0: result.failures, p1: result.truncated ? tr("extension.b53b76dd5d") : '' }) : null;
    tree.refresh();
  };
  const command = (name: string, operation: (...args: unknown[]) => Promise<void>): void => {
    context.subscriptions.push(vscode.commands.registerCommand(`antigravityAccounts.${name}`, (...args: unknown[]) => run(() => operation(...args))));
  };
  command('addAccount', async () => {
    const identity = await vscode.window.showInputBox({ title: tr("extension.217b76f0ec"), prompt: tr("extension.c1bd793f74"), validateInput: value => { try { normalizeIdentity(value.trim()); return null; } catch { return tr("extension.1a13dee174"); } } });
    if (identity === undefined) return;
    const label = await vscode.window.showInputBox({ title: tr("extension.b3666963e7"), value: identity.trim(), validateInput: value => { try { normalizeLabel(value); return null; } catch { return tr("extension.97ea06a1a0"); } } });
    if (label === undefined) return;
    await commit(accounts => addAccount(accounts, identity, label));
  });
  command('importSnapshot', async () => {
    const files = await vscode.window.showOpenDialog({ title: tr("extension.dda51ef12c"), canSelectMany: false, filters: { JSON: ['json'] } });
    if (!files?.[0]) return;
    if (files[0].scheme !== 'file') throw new InputError('LOCAL_FILE_REQUIRED');
    const snapshot = await readSnapshotFile(files[0].fsPath);
    await commit(accounts => mergeSnapshot(accounts, snapshot));
    void vscode.window.showInformationMessage(tr("extension.4d78a170ed"));
  });
  command('removeAccount', async (...args) => {
    const candidate = args[0] as { kind?: string; account: Account } | undefined;
    const selected = candidate?.kind === 'account' ? candidate.account : await vscode.window.showQuickPick(tree.accounts.map(account => ({ label: account.label, description: account.identity, account })));
    if (!selected) return;
    const account = 'account' in selected ? selected.account : selected;
    const answer = await vscode.window.showWarningMessage(tr("extension.605d54dc55", { p0: account.identity }), { modal: true }, tr("extension.6135d4159e"));
    if (answer !== tr("extension.6135d4159e")) return;
    // Dedicated, deterministic cache file only; never inspect or remove official credentials.
    await fs.unlink(path.join(directory, `${identityKey(account.identity)}.json`)).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    await commit(accounts => accounts.filter(item => item.identity !== account.identity));
  });
  command('reloadSnapshots', refresh);
  // The public refresh entry uses the same identity-bound inline query as each card.
  // CLI /usage has no independently verified account binding and is not mixed in.
  context.subscriptions.push(vscode.commands.registerCommand('antigravityAccounts.refresh', async (accountId?: unknown) => {
    if (!disposed) await vscode.commands.executeCommand('antigravityAccounts.live.quota', ...(accountId === undefined ? [] : [accountId]));
  }));
  context.subscriptions.push(vscode.commands.registerCommand('antigravityAccounts.recheck', async () => { await (live.recheck?.() ?? live.refresh()); tree.refresh(); }));
  context.subscriptions.push(vscode.commands.registerCommand('antigravityAccounts.openOfficialExtension', async () => {
    await vscode.commands.executeCommand('workbench.extensions.search', '@id:google.google-antigravity');
  }));
  context.subscriptions.push(vscode.commands.registerCommand('antigravityAccounts.openWorkbenchExtension', async () => {
    await vscode.commands.executeCommand('workbench.extensions.search', '@id:xiaoxincodes.antigravity-account-manager');
  }));
  context.subscriptions.push(vscode.commands.registerCommand('antigravityAccounts.openHostSettings', async () => {
    const choice = await vscode.window.showQuickPick([
      { label: tr("extension.8be128c891"), command: 'workbench.action.showRuntimeExtensions' },
      { label: tr("extension.3720942223"), command: 'workbench.action.openSettings', argument: '@id:remote.extensionKind' },
    ], { title: tr("extension.cd4c2be251"), placeHolder: tr("extension.26afa871dd") });
    if (choice) await vscode.commands.executeCommand(choice.command, ...(choice.argument ? [choice.argument] : []));
  }));
  context.subscriptions.push(vscode.commands.registerCommand('antigravityAccounts.openSettings', async () => { await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:xiaoxincodes.antigravity-account-manager'); }));
  context.subscriptions.push(vscode.commands.registerCommand('antigravityAccounts.openHelp', async () => {
    const document = await vscode.workspace.openTextDocument(helpUri);
    await vscode.window.showTextDocument(document, { preview: true });
  }));
  context.subscriptions.push(vscode.commands.registerCommand('antigravityAccounts.showCapabilities', async () => {
    await vscode.window.showInformationMessage(tr("extension.8b4fb011e0", { p0: localizeMessage(SWITCH_BLOCKED) }));
  }));
  context.subscriptions.push(vscode.commands.registerCommand('antigravityAccounts.openBridgeGuide', async () => {
    const bridge = context.asAbsolutePath('out/bridge.js');
    const text = [
      tr("extension.553e311794"), '',
      tr("extension.a5264564ae"), '',
      tr("extension.1f3710a6e4"),
      tr("extension.6257f19eba"),
      tr("extension.b696550413"),
      tr("extension.3a16302053"), '',
      tr("extension.9c4c28bcf1"),
      tr("extension.6ed5391f02"), bridge,
      tr("extension.65b896b7fc"),
      tr("extension.2d46f52e11"), directory, '',
      tr("extension.0998d87ba3"), '',
      tr("extension.a9d0671bf6"),
      tr("extension.67b5458871"), '',
      tr("extension.b8b2066d28"),
    ].join('\n');
    const doc = await vscode.workspace.openTextDocument({ content: text, language: 'markdown' });
    await vscode.window.showTextDocument(doc, { preview: true });
  }));
  if (!readOnly) {
    try { await ensurePrivateDirectory(directory); await run(refresh); }
    catch { tree.warning = tr("extension.aa62577f74"); tree.refresh(); }
  }
  // Repaint only. No backend polling, hidden account activation, or automatic login.
  const timer = setInterval(() => tree.refresh(), 15_000);
  context.subscriptions.push({ dispose: () => { disposed = true; clearInterval(timer); } });
  // Non-sensitive status only; never expose account identities, quota contents or credentials.
  return { getDiagnostics: () => ({ warning: tree.warning, accountCount: tree.accounts.length, liveSwitching: 'experimental', liveStatus: live.getStatus(), debugEnabled: debug.getState().enabled }) };
}

export async function deactivate(): Promise<void> { await flushImageSession?.(); }
