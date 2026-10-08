import * as vscode from 'vscode';
import { setLanguage } from './i18n';
export const LANGUAGE_SETTING = 'antigravityAccounts.language';
/** User-level application setting. Workspace recommendations cannot override it. */
export function registerI18n(context: vscode.ExtensionContext): void {
  const read = (): void => {
    const config = vscode.workspace.getConfiguration('antigravityAccounts');
    setLanguage(config.inspect<string>('language')?.globalValue ?? 'zh-CN');
  };
  read();
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration(LANGUAGE_SETTING)) read(); }));
}
