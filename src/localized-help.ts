import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import { locale, onLanguageChange } from './i18n';

/** Stable read-only document identity lets VS Code update an already open guide. */
export function registerLocalizedHelp(context: vscode.ExtensionContext): vscode.Uri {
  const uri = vscode.Uri.parse('antigravity-workbench-help:/GETTING_STARTED.md');
  const updates = new vscode.EventEmitter<vscode.Uri>();
  context.subscriptions.push(updates, vscode.workspace.registerTextDocumentContentProvider(uri.scheme, {
    onDidChange: updates.event,
    provideTextDocumentContent: async () => {
      const file = vscode.Uri.joinPath(context.extensionUri, 'docs', locale() === 'en' ? 'GETTING_STARTED.en.md' : 'GETTING_STARTED.md');
      const text = await fs.readFile(file.fsPath, 'utf8');
      // Relative links resolve to the bundled technical docs, on this extension host.
      return text.replace(/\]\(([A-Z][A-Z0-9_.-]*\.md)(#[A-Za-z0-9_-]+)?\)/g, (_match, name: string, anchor: string | undefined) => `](${vscode.Uri.joinPath(context.extensionUri, 'docs', name).toString()}${anchor ?? ''})`);
    },
  }), onLanguageChange(() => updates.fire(uri)));
  return uri;
}
