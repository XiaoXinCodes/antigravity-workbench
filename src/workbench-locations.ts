/* eslint-disable no-control-regex -- Do not offer malformed or foreign host paths. */
import * as vscode from 'vscode';
import * as os from 'node:os';
import * as path from 'node:path';
import { hostLabel, nativeHostStatus } from './native-host';

type LocationContext = Pick<vscode.ExtensionContext, 'extension' | 'extensionUri' | 'globalStorageUri'>;
export interface WorkbenchLocations {
  host: string;
  extensionPath?: string;
  credentialPath?: string;
  imageOutputPath?: string;
  canOpenExtension: boolean;
}
export interface LocationRuntime { platform: NodeJS.Platform; home: string; desktop: boolean; remoteName?: string }
function nativePath(value: unknown, platform: NodeJS.Platform): value is string {
  if (typeof value !== 'string' || value.length > 8192 || /[\x00-\x1f\x7f]/u.test(value)) return false;
  return platform === 'win32' ? /^[A-Za-z]:[\\/]/u.test(value) && path.win32.isAbsolute(value) : path.posix.isAbsolute(value) && !value.includes('\\') && !/^\/[A-Za-z]:/u.test(value);
}
/** Derive paths only. Never stat, open, read or inspect an official credential. */
export function resolveWorkbenchLocations(context: LocationContext, output: string, runtime: LocationRuntime): WorkbenchLocations {
  const result: WorkbenchLocations = { host: hostLabel(context, runtime.remoteName, runtime.platform), canOpenExtension: false };
  if (!nativeHostStatus(context, true, runtime.desktop, runtime.remoteName, runtime.platform).available) return result;
  if (nativePath(context.extensionUri.fsPath, runtime.platform)) {
    result.extensionPath = context.extensionUri.fsPath;
    // A workspace extension in a remote window cannot reveal its paths in the UI host OS.
    result.canOpenExtension = context.extension.extensionKind === 1 || !runtime.remoteName;
  }
  if (nativePath(runtime.home, runtime.platform)) result.credentialPath = (runtime.platform === 'win32' ? path.win32 : path.posix).join(runtime.home, '.gemini', 'jetski-standalone-oauth-token');
  if (nativePath(output, runtime.platform)) result.imageOutputPath = output;
  return result;
}
/** No command accepts a path/URI argument. All destinations come from current runtime state. */
export function registerWorkbenchLocations(context: vscode.ExtensionContext, output: () => string): { getState(): WorkbenchLocations } {
  let disposed = false;
  const getState = (): WorkbenchLocations => resolveWorkbenchLocations(context, output(), {
    platform: process.platform, home: os.homedir(), desktop: vscode.env.uiKind === vscode.UIKind.Desktop,
    ...(vscode.env.remoteName ? { remoteName: vscode.env.remoteName } : {}),
  });
  for (const [command, field] of [['copyExtension', 'extensionPath'], ['copyCredentials', 'credentialPath'], ['copyImageOutput', 'imageOutputPath']] as const) {
    context.subscriptions.push(vscode.commands.registerCommand(`antigravityAccounts.locations.${command}`, async (...args: unknown[]) => {
      if (disposed || args.length) return;
      const value = getState()[field];
      if (value) await vscode.env.clipboard.writeText(value);
    }));
  }
  context.subscriptions.push(vscode.commands.registerCommand('antigravityAccounts.locations.openExtension', async (...args: unknown[]) => {
    if (disposed || args.length || !getState().canOpenExtension) return;
    await vscode.commands.executeCommand('revealFileInOS', context.extensionUri);
  }), { dispose: () => { disposed = true; } });
  return { getState };
}
