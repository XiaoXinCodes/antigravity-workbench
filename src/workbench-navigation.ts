import * as vscode from 'vscode';
import { t } from './i18n';
const routes: Readonly<Record<string, readonly [string, ...string[]]>> = {
  accounts: ['antigravityAccounts.workbench.open'], images: ['antigravityAccounts.images.open'],
  records: ['antigravityAccounts.observations.open'], history: ['antigravityAccounts.quota.history'],
  automation: ['antigravityAccounts.automation.open', 'tasks'], alerts: ['antigravityAccounts.automation.open', 'alerts'],
  settings: ['antigravityAccounts.openSettings'], help: ['antigravityAccounts.openHelp'], diagnostics: ['antigravityAccounts.support.diagnostics'],
};
/** Handles only the exact navigation envelope, never arbitrary commands or arguments. */
export function routeWorkbenchNavigation(message: unknown): boolean {
  if (!message || typeof message !== 'object' || (message as { type?: unknown }).type !== 'workbench.navigate') return false;
  const target = (message as { target?: unknown }).target;
  if (Object.keys(message).length !== 2 || typeof target !== 'string' || !Object.hasOwn(routes, target)) return true;
  const route = routes[target]!;
  void Promise.resolve(vscode.commands.executeCommand(route[0], ...route.slice(1))).catch(() => vscode.window.showWarningMessage(t('ui.navigationFailed')));
  return true;
}
