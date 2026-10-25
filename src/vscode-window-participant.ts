import * as vscode from 'vscode';
import { probeProcessIdentity } from './live-lock';
import { WindowSwitchError, type WindowBirth } from './window-switch-protocol';

export interface CurrentWindowSnapshot {
  host: WindowBirth;
  remoteName: string | null;
  workspace: { kind: 'folder' | 'workspace'; uri: string } | null;
  /** No public VS Code API exposes the active user profile. This is not the
   * default profile and must never be converted to an assumed profile name. */
  profile: 'not-exposed-by-public-api';
}
/** Concrete current-window APIs, deliberately separate from the missing
 * Windows launcher/profile binding. No activation side effects or RPC. */
export async function captureCurrentWindow(): Promise<CurrentWindowSnapshot> {
  const host = await probeProcessIdentity(process.pid);
  if (host.state !== 'alive') throw new WindowSwitchError('WINDOW_HOST_BINDING_UNVERIFIED');
  const workspaceFile = vscode.workspace.workspaceFile;
  const folders = vscode.workspace.workspaceFolders;
  let workspace: CurrentWindowSnapshot['workspace'] = null;
  if (workspaceFile && workspaceFile.scheme !== 'untitled') workspace = { kind: 'workspace', uri: workspaceFile.toString() };
  else if (!workspaceFile && folders?.length === 1) workspace = { kind: 'folder', uri: folders[0]!.uri.toString() };
  return { host: { pid: process.pid, startIdentity: host.startIdentity }, remoteName: vscode.env.remoteName ?? null,
    workspace, profile: 'not-exposed-by-public-api' };
}
function same(a: CurrentWindowSnapshot, b: CurrentWindowSnapshot): boolean {
  return a.host.pid === b.host.pid && a.host.startIdentity === b.host.startIdentity && a.remoteName === b.remoteName &&
    a.workspace?.kind === b.workspace?.kind && a.workspace?.uri === b.workspace?.uri;
}
/** This uses native save handling, including Save As/cancellation; it does not
 * dismiss dialogs or choose discard. Dirty custom editors/tabs remain a veto.
 * Saves are not a lock on future edits: native close veto remains enabled. */
export async function saveCurrentWindow(expected: CurrentWindowSnapshot): Promise<boolean> {
  if (!same(expected, await captureCurrentWindow())) throw new WindowSwitchError('WINDOW_PARTICIPANTS_CHANGED');
  if (!await vscode.workspace.saveAll(true)) return false;
  if (!same(expected, await captureCurrentWindow())) throw new WindowSwitchError('WINDOW_PARTICIPANTS_CHANGED');
  return !vscode.workspace.textDocuments.some(d => d.isDirty) && !vscode.workspace.notebookDocuments.some(d => d.isDirty) &&
    !vscode.window.tabGroups.all.some(g => g.tabs.some(t => t.isDirty));
}
/** Only callable by the coordinator after durable, validated handoff. This
 * request concerns the invoking window; it NEVER closes other windows. The
 * promise resolving does not establish exit or definitive cancellation. */
export async function requestCurrentWindowClose(expected: CurrentWindowSnapshot, assertArmed: () => Promise<void>, beforeDispatch?: () => Promise<void>): Promise<void> {
  await assertArmed();
  if (!await saveCurrentWindow(expected)) throw new WindowSwitchError('WINDOW_SAVE_CANCELLED');
  await assertArmed();
  if (!same(expected, await captureCurrentWindow())) throw new WindowSwitchError('WINDOW_PARTICIPANTS_CHANGED');
  await beforeDispatch?.();
  await vscode.commands.executeCommand('workbench.action.closeWindow');
}
