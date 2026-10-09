/* eslint-disable no-control-regex -- Reject controls and foreign-host paths. */
import { localizeLines, onLanguageChange, t as tr } from './i18n';
import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { DebugLogStore, sanitizeDebugStorageError } from './debug-log-store';
import { DebugRecorder, installDebugRecorder, type DebugStore } from './debug-events';
import { isNativeStorageUri } from './native-host';

export interface DebugUiState { enabled: boolean; storageUnavailable: boolean; available: boolean; directory?: string; canOpen: boolean; host: 'local' | 'wsl' | 'remote' | 'web'; previewReady?: boolean; catalogBusy?: boolean; catalogStopping?: boolean; catalogReport?: string }
type Context = Pick<vscode.ExtensionContext, 'extension' | 'globalStorageUri'>;
export interface DebugRuntime { platform: NodeJS.Platform; desktop: boolean; remoteName?: string }
function nativePath(value: unknown, platform: NodeJS.Platform): value is string {
  return typeof value === 'string' && value.length <= 8192 && !/[\x00-\x1f\x7f]/u.test(value) && (platform === 'win32' ? /^[A-Za-z]:[\\/]/u.test(value) && path.win32.isAbsolute(value) : path.posix.isAbsolute(value) && !value.includes('\\') && !/^\/[A-Za-z]:/u.test(value));
}
/** Current extension-host storage only; never derive a path on the UI's other host. */
export function resolveDebugLocation(context: Context, runtime: DebugRuntime): Omit<DebugUiState, 'enabled' | 'storageUnavailable'> {
  const host = !runtime.desktop ? 'web' : context.extension.extensionKind === 2 && runtime.remoteName ? runtime.remoteName === 'wsl' ? 'wsl' : 'remote' : 'local';
  const available = runtime.desktop && ['win32', 'darwin', 'linux'].includes(runtime.platform) && [1, 2].includes(context.extension.extensionKind) && isNativeStorageUri(context.globalStorageUri, context.extension.extensionKind, runtime.remoteName, runtime.platform) && nativePath(context.globalStorageUri.fsPath, runtime.platform);
  return { available, host, canOpen: available && (context.extension.extensionKind === 1 || !runtime.remoteName), ...(available ? { directory: (runtime.platform === 'win32' ? path.win32 : path.posix).join(context.globalStorageUri.fsPath, 'debug-logs') } : {}) };
}
const stages = () => ({
  toggle: {label: tr("debugUi.75ac39a4e8"), code: 'DEBUG_TOGGLE_FAILED', recovery: tr("debugUi.e0c850a7f4")},
  'storage.read': {label: tr("debugUi.22208c2d5e"), code: 'DEBUG_STORAGE_UNAVAILABLE', recovery: tr("debugUi.4939ebaf36")},
  'clipboard.write': {label: tr("debugUi.82861109d5"), code: 'DEBUG_CLIPBOARD_FAILED', recovery: tr("debugUi.d17000f80d")},
  'directory.inspect': {label: tr("debugUi.cb297daf14"), code: 'DEBUG_DIRECTORY_INSPECT_FAILED', recovery: tr("debugUi.1a7d19fc4c")},
  'directory.open': {label: tr("debugUi.6e15bd283c"), code: 'DEBUG_DIRECTORY_OPEN_FAILED', recovery: tr("debugUi.58e5474b24")},
  'preview.document': {label: tr("debugUi.a407de9716"), code: 'DEBUG_PREVIEW_DOCUMENT_FAILED', recovery: tr("debugUi.f822ead389")},
  'preview.editor': {label: tr("debugUi.73549b05e8"), code: 'DEBUG_PREVIEW_EDITOR_FAILED', recovery: tr("debugUi.0112afdea7")},
  'export.dialog': {label: tr("debugUi.b2e236f1a6"), code: 'DEBUG_EXPORT_DIALOG_FAILED', recovery: tr("debugUi.b31414beba")},
  'export.write': {label: tr("debugUi.6bc245e4aa"), code: 'DEBUG_EXPORT_WRITE_FAILED', recovery: tr("debugUi.ab27dbc57f")},
} as const);
type Stage = keyof ReturnType<typeof stages>;
const details = (): Record<string, string> => ({
  DEBUG_STORAGE_PERMISSION_DENIED: tr("debugUi.0f5e5680d2"),
  DEBUG_STORAGE_READ_ONLY: tr("debugUi.c5c5903702"),
  DEBUG_STORAGE_FULL: tr("debugUi.7954e83a4e"),
  DEBUG_STORAGE_BUSY: tr("debugUi.526b99628d"),
  DEBUG_STORAGE_MISSING: tr("debugUi.f5147127c5"),
  DEBUG_STORAGE_PATH_UNSAFE: tr("debugUi.9cbfeb249a"),
  DEBUG_STORAGE_NOT_PRIVATE: tr("debugUi.ffd13fa208"),
  DEBUG_STORAGE_CHANGED: tr("debugUi.97192b90d1"),
  DEBUG_STORAGE_LIMIT: tr("debugUi.3bafd9edbb"),
  DEBUG_STORAGE_INVALID_EVENT: tr("debugUi.f85dc63c44"),
  DEBUG_STORAGE_QUEUE_FULL: tr("debugUi.ad4cc574a4"),
  DEBUG_STORAGE_INVALID_CONFIGURATION: tr("debugUi.19457173b8"),
  DEBUG_STORAGE_WRITE_INCOMPLETE: tr("debugUi.b0c8d849f9"),
  DEBUG_EXPORT_PATH_UNSUPPORTED: tr("debugUi.c640898190"),
  DEBUG_EXPORT_TOO_LARGE: tr("debugUi.9457f0b336"),
  DEBUG_EXPORT_PATH_UNSAFE: tr("debugUi.94169b18d0"),
  DEBUG_EXPORT_NOT_OWNED: tr("debugUi.83d8d611f2"),
  DEBUG_EXPORT_CHANGED: tr("debugUi.5618a06a53"),
  DEBUG_EXPORT_EXISTS: tr("debugUi.c2ba5c0f99"),
  DEBUG_EXPORT_PERMISSION_DENIED: tr("debugUi.34034da38c"),
  DEBUG_EXPORT_READ_ONLY: tr("debugUi.912361a29d"),
  DEBUG_EXPORT_FULL: tr("debugUi.ad2dfd9865"),
  DEBUG_EXPORT_MISSING: tr("debugUi.e46e0a536e"),
  DEBUG_EXPORT_BUSY: tr("debugUi.58b0fb6b32"),
});
function ownCode(error: unknown): unknown {
  try { const descriptor = error !== null && (typeof error === 'object' || typeof error === 'function') ? Object.getOwnPropertyDescriptor(error, 'code') : undefined; return descriptor && 'value' in descriptor ? descriptor.value : undefined; }
  catch { return undefined; }
}
function exportErrorCode(error: unknown): string {
  const code = ownCode(error);
  if (typeof code === 'string' && code.startsWith('DEBUG_EXPORT_') && Object.hasOwn(details(), code)) return code;
  switch (code) {
    case 'EEXIST': return 'DEBUG_EXPORT_EXISTS';
    case 'EACCES': case 'EPERM': return 'DEBUG_EXPORT_PERMISSION_DENIED';
    case 'EROFS': return 'DEBUG_EXPORT_READ_ONLY';
    case 'ENOSPC': case 'EDQUOT': return 'DEBUG_EXPORT_FULL';
    case 'ENOENT': return 'DEBUG_EXPORT_MISSING';
    case 'ELOOP': case 'ENOTDIR': case 'EISDIR': return 'DEBUG_EXPORT_PATH_UNSAFE';
    case 'EBUSY': case 'EMFILE': case 'ENFILE': return 'DEBUG_EXPORT_BUSY';
    default: return stages()['export.write'].code;
  }
}
class DebugUiFailure extends Error { constructor(readonly stage: Stage, readonly code: string) { super(code); } }
async function atStage<T>(stage: Stage, action: () => PromiseLike<T>): Promise<T> {
  try { return await action(); }
  catch (error) {
    const storageCode = stage === 'storage.read' || stage === 'directory.inspect' ? sanitizeDebugStorageError(error).code : undefined;
    const code = stage === 'directory.inspect' && storageCode === 'DEBUG_STORAGE_UNAVAILABLE' ? stages()[stage].code : storageCode ?? (stage === 'export.write' ? exportErrorCode(error) : stages()[stage].code);
    throw new DebugUiFailure(stage, code);
  }
}
function exportFailure(code: string): Error { return Object.assign(new Error(code), {code}); }
/** Save a reviewed sanitized snapshot to a new file only. Never overwrite or follow links. */
export async function writeDebugExport(filename: string, content: string): Promise<void> {
  try {
    if (!nativePath(filename, process.platform)) throw exportFailure('DEBUG_EXPORT_PATH_UNSUPPORTED');
    if (Buffer.byteLength(content) > 512 * 1024) throw exportFailure('DEBUG_EXPORT_TOO_LARGE');
    const parent = path.dirname(filename), root = path.parse(parent).root;
    let current = root;
    for (const part of parent.slice(root.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part); const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw exportFailure('DEBUG_EXPORT_PATH_UNSAFE');
    }
    const before = await fs.lstat(parent);
    if (typeof process.getuid === 'function' && before.uid !== process.getuid()) throw exportFailure('DEBUG_EXPORT_NOT_OWNED');
    const file = await fs.open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
    try {
      const opened = await file.stat(), now = await fs.lstat(parent);
      if (!opened.isFile() || opened.nlink !== 1 || now.isSymbolicLink() || before.dev !== now.dev || before.ino !== now.ino) throw exportFailure('DEBUG_EXPORT_CHANGED');
      await file.writeFile(content, 'utf8');
    } finally { await file.close(); }
  } catch (error) { throw exportFailure(exportErrorCode(error)); }
}
export interface DebugUiDependencies { store?: DebugStore; runtime?: DebugRuntime; diagnoseCatalog?(signal: AbortSignal): Promise<string>; revealCatalog?(): Promise<void> }
export function registerDebugUi(context: vscode.ExtensionContext, changed: () => void, dependencies: DebugUiDependencies = {}): { getState(): DebugUiState } {
  const runtime = (): DebugRuntime => dependencies.runtime ?? { platform: process.platform, desktop: vscode.env.uiKind === vscode.UIKind.Desktop, ...(vscode.env.remoteName ? {remoteName: vscode.env.remoteName} : {}) };
  const location = (): ReturnType<typeof resolveDebugLocation> => resolveDebugLocation(context, runtime());
  const initial = location();
  const inactive: DebugStore = { append: async () => undefined, readLines: async () => [], flush: async () => undefined, dispose() {} };
  const store = dependencies.store ?? (initial.directory ? new DebugLogStore(initial.directory) : inactive);
  const notify = (): void => { try { changed(); } catch { /* A stale view must not fail a debug command. */ } };
  const recorder = new DebugRecorder(store, {version: context.extension.packageJSON?.version, platform: runtime().platform, host: initial.host}, notify);
  context.subscriptions.push(installDebugRecorder(recorder));
  let disposed = false, toggling = false, previewing = false, exporting = false;
  let catalogRevision = 0;
  let catalogReport = '', catalogAbort: AbortController | undefined, catalogPending = false;
  let snapshotToExport = '';
  let preview = '';
  const updates = new vscode.EventEmitter<vscode.Uri>();
  const previewUri = vscode.Uri.parse('antigravity-debug-preview:/sanitized-diagnostics.txt');
  context.subscriptions.push(updates, vscode.workspace.registerTextDocumentContentProvider('antigravity-debug-preview', { onDidChange: updates.event, provideTextDocumentContent: () => localizeLines(preview) }));
  context.subscriptions.push(onLanguageChange(() => { updates.fire(previewUri); notify(); }));
  const getState = (): DebugUiState => ({...location(), ...recorder.getState(), previewReady: !!snapshotToExport, catalogBusy: !!catalogAbort, catalogStopping: catalogPending && !catalogAbort, catalogReport: localizeLines(catalogReport)});
  const command = (name: string, fallback: Stage, action: () => Promise<void>): void => {
    context.subscriptions.push(vscode.commands.registerCommand(`antigravityAccounts.debug.${name}`, async (...args: unknown[]) => {
      const editorExport = name === 'exportPreview' && args.length === 1 && !!args[0] && typeof args[0] === 'object' &&
        (args[0] as vscode.Uri).scheme === previewUri.scheme && typeof (args[0] as vscode.Uri).toString === 'function' &&
        (args[0] as vscode.Uri).toString() === previewUri.toString();
      if (disposed || (args.length && !editorExport)) return;
      try { await action(); }
      catch (error) {
        if (disposed) return;
        const failure = error instanceof DebugUiFailure ? error : new DebugUiFailure(fallback, stages()[fallback].code);
        const stage = stages()[failure.stage];
        void vscode.window.showWarningMessage(tr("debugUi.a0cec5c2a2", { p0: stage.label, p1: failure.stage, p2: failure.code, p3: details()[failure.code] ?? stage.recovery }));
      }
    }));
  };
  command('toggle', 'toggle', async () => {
    if (toggling || !location().available) return;
    toggling = true;
    try { await recorder.setEnabled(!recorder.getState().enabled); } finally { toggling = false; notify(); }
  });
  command('tools', 'storage.read', async () => {
    const options = [
      { label: tr("debugUi.ce1e4b9047"), command: 'debug.catalog' },
      { label: recorder.getState().enabled ? tr("debugUi.8f61a65eea") : tr("debugUi.9736e29cd6"), command: 'debug.toggle' },
      { label: tr("debugUi.d6ea4ce966"), command: 'debug.preview' },
      { label: tr("debugUi.ca7129f076"), command: 'debug.exportPreview' },
      { label: tr("debugUi.37e92cc4d6"), command: 'debug.copyDirectory' },
      { label: tr("debugUi.bcdb3b28c6"), command: 'openHostSettings' },
      { label: tr("debugUi.a169276e75"), command: 'locations.copyExtension' },
      { label: tr("debugUi.dee121e821"), command: 'locations.copyCredentials' },
      { label: tr("debugUi.8cd98f0ffe"), command: 'locations.copyImageOutput' },
      { label: tr("debugUi.62e21e47d6"), command: 'live.acceptance' },
    ];
    if (location().canOpen) options.push({ label: tr("debugUi.5f393841c1"), command: 'debug.openDirectory' });
    const selected = await vscode.window.showQuickPick(options, { title: tr("debugUi.389500d3f4"), placeHolder: tr("debugUi.62a4e46766") });
    if (!disposed && selected && options.some(option => option === selected)) await vscode.commands.executeCommand('antigravityAccounts.' + selected.command);
  });
  command('dismissCatalog', 'storage.read', async () => {
    ++catalogRevision; catalogAbort?.abort(); catalogAbort = undefined; catalogReport = ''; notify();
  });
  command('catalog', 'storage.read', async () => {
    if (catalogAbort || catalogPending) {
      if (!catalogReport) catalogReport = tr("debugUi.2a0e3e4aaf");
      notify(); await dependencies.revealCatalog?.(); return;
    }
    const revision = ++catalogRevision;
    const abort = new AbortController(); catalogAbort = abort; catalogReport = tr("debugUi.f00e3a659f"); notify();
    let onAbort: () => void = () => undefined;
    const interrupted = new Promise<string>((_resolve, reject) => { onAbort = () => reject(new Error('IMAGE_CANCELLED')); abort.signal.addEventListener('abort', onAbort, { once: true }); });
    let timedOut = false, revealFailed = false;
    const timer = setTimeout(() => { timedOut = true; abort.abort(); }, 60_000);
    const query = async (): Promise<string> => {
      let revealTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([dependencies.revealCatalog?.(), interrupted, new Promise<never>((_resolve, reject) => {
          revealTimer = setTimeout(() => reject(new Error('CATALOG_VIEW_UNAVAILABLE')), 5_000);
        })]);
      } catch { revealFailed = !abort.signal.aborted; throw new Error('CATALOG_VIEW_UNAVAILABLE'); }
      finally { clearTimeout(revealTimer); }
      if (disposed || abort.signal.aborted) throw new Error('IMAGE_CANCELLED');
      if (!runtime().desktop || !dependencies.diagnoseCatalog) return tr("debugUi.0c3f305828");
      catalogPending = true;
      try { return await dependencies.diagnoseCatalog(abort.signal); }
      finally { catalogPending = false; if (!disposed) notify(); }
    };
    try { const result = await Promise.race([query(), interrupted]); if (revision === catalogRevision) catalogReport = result; }
    catch {
      if (revision !== catalogRevision) return;
      catalogReport = revealFailed ? tr("debugUi.2f1bfb3a5c") : timedOut ? tr("debugUi.80b2693d41") : tr("debugUi.c0ea0adc31");
      // Only a failed reveal needs a notification: there is no visible inline surface.
      if (revealFailed && !disposed) void vscode.window.showWarningMessage(catalogReport);
    }
    finally { clearTimeout(timer); abort.signal.removeEventListener('abort', onAbort); if (catalogAbort === abort) catalogAbort = undefined; if (!disposed) notify(); else catalogReport = ''; }
  });
  command('copyDirectory', 'clipboard.write', async () => { const directory = location().directory; if (directory) await atStage('clipboard.write', () => vscode.env.clipboard.writeText(directory)); });
  command('openDirectory', 'directory.open', async () => {
    const value = location(); if (!value.canOpen || !value.directory) return;
    // Reveal only an existing, validated diagnostic directory; never create files while OFF.
    await atStage('storage.read', () => recorder.preview());
    if (disposed) return;
    const stat = await atStage('directory.inspect', async () => { try { return await fs.lstat(value.directory!); } catch (error) { if (ownCode(error) === 'ENOENT') return undefined; throw error; } });
    if (disposed) return;
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new DebugUiFailure('directory.inspect', 'DEBUG_STORAGE_PATH_UNSAFE');
    if (stat) await atStage('directory.open', () => vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(value.directory!)));
    else if (!disposed) void vscode.window.showInformationMessage(tr("debugUi.6b02a8bdb2"));
  });
  const showPreview = async (snapshot: string): Promise<void> => {
    preview = snapshot || tr("debugUi.2daed3e6a1"); updates.fire(previewUri);
    const document = await atStage('preview.document', () => vscode.workspace.openTextDocument(previewUri));
    if (disposed) return;
    await atStage('preview.editor', () => vscode.window.showTextDocument(document, {preview: true}));
  };
  command('preview', 'preview.document', async () => {
    if (previewing || !location().available) return;
    previewing = true;
    try {
      const snapshot = exporting ? snapshotToExport : await atStage('storage.read', () => recorder.preview());
      if (disposed) return;
      await showPreview(snapshot);
      if (disposed) return;
      snapshotToExport = snapshot; notify();
    } finally { previewing = false; }
  });
  command('exportPreview', 'export.write', async () => {
    if (exporting || previewing || !location().available) return;
    if (!snapshotToExport) { void vscode.window.showInformationMessage(tr("debugUi.d02bf98309")); return; }
    exporting = true;
    const snapshot = snapshotToExport;
    try {
      await showPreview(snapshot);
      if (disposed) return;
      const target = await atStage('export.dialog', () => vscode.window.showSaveDialog({ title: tr("debugUi.acebb95448"), defaultUri: vscode.Uri.file(path.join(location().directory!, 'antigravity-debug-export.txt')), filters: {'Text': ['txt']} }));
      if (!target || disposed) return;
      if (target.scheme !== 'file' || target.authority !== '' || !location().available) throw new DebugUiFailure('export.write', 'DEBUG_EXPORT_PATH_UNSUPPORTED');
      await atStage('export.write', () => writeDebugExport(target.fsPath, snapshot));
      if (!disposed) void vscode.window.showInformationMessage(tr("debugUi.228505aab3"));
    } finally { exporting = false; }
  });
  context.subscriptions.push({dispose: () => { disposed = true; catalogAbort?.abort(); catalogReport = ''; preview = ''; snapshotToExport = ''; }});
  return {getState};
}
