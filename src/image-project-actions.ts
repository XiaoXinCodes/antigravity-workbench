import { t as tr } from './i18n';
import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { checkedDirectory } from './image-files';
import { readDirectRaster } from './direct-image-raster';
import type { SavedImage } from './image-session-store';

type Folder = Pick<vscode.WorkspaceFolder, 'uri' | 'name'>;
export function hostPath(uri: vscode.Uri, folders: readonly Folder[] = vscode.workspace.workspaceFolders ?? []): string | undefined {
  if (uri.scheme === 'file' && !uri.authority && path.isAbsolute(uri.fsPath)) return uri.fsPath;
  // remoteName alone also exists in a local UI host. Only map a remote URI
  // when this process can prove the WSL host; other providers fail inline.
  if (process.platform !== 'linux' || uri.scheme !== 'vscode-remote' || vscode.env.remoteName !== 'wsl' || !process.env.WSL_DISTRO_NAME ||
      uri.authority !== `wsl+${process.env.WSL_DISTRO_NAME}` || !folders.some(f => f.uri.scheme === uri.scheme && f.uri.authority === uri.authority)) return;
  return path.isAbsolute(uri.path) ? uri.path : undefined;
}
export function workspaceImage(file: string, folders: readonly Folder[] = vscode.workspace.workspaceFolders ?? []) {
  if (!path.isAbsolute(file)) return;
  const matches = folders.flatMap(folder => {
    const root = hostPath(folder.uri, folders);
    if (!root) return [];
    const relative = path.relative(root, file);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return [];
    return [{ folder, root, relative: relative.split(path.sep).join('/') }];
  });
  return matches.sort((a, b) => b.root.length - a.root.length)[0];
}
export function markdownImage(file: string, relative: string): string {
  const alt = path.basename(file).replace(/[\r\n]/g, ' ').replace(/[\\[\]]/g, '\\$&');
  const url = relative.split('/').map(segment => encodeURIComponent(segment).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())).join('/');
  return `![${alt}](${url})`;
}
export function documentImagePath(document: string, image: string): string {
  const relative = path.relative(path.dirname(document), image);
  if (!relative || path.isAbsolute(relative)) throw Error('IMAGE_PROJECT_HOST_MISMATCH');
  return relative.split(path.sep).join('/');
}
type Target = { id: number; document: vscode.TextDocument; version: number; selections: readonly vscode.Selection[]; column: vscode.ViewColumn | undefined; stale: boolean };
type Guard = () => void;
const sameSelections = (a: readonly vscode.Selection[], b: readonly vscode.Selection[]) => a.length === b.length && a.every((s, i) => s.isEqual(b[i]!));

/** Captures only editor identity/version/selection, never document text. A webview
 * focus event with no text editor does not discard the user's intended target. */
export class ImageProjectActions {
  private target: Target | undefined;
  private serial = 0;
  private inserting = false;
  constructor(context: vscode.ExtensionContext, private readonly changed: () => void) {
    const track = (editor: vscode.TextEditor | undefined) => { if (editor) this.capture(editor); };
    const listeners = [vscode.window.onDidChangeActiveTextEditor?.(track),
      vscode.window.onDidChangeTextEditorSelection?.(event => { if (event.textEditor.document === this.target?.document) this.capture(event.textEditor); }),
      vscode.workspace.onDidChangeTextDocument?.(event => { if (event.document === this.target?.document) {
        const active = vscode.window.activeTextEditor;
        if (active?.document === event.document) this.capture(active);
        else { this.target = { ...this.target, id: ++this.serial, version: event.document.version, stale: true }; this.changed(); }
      } }),
      vscode.workspace.onDidCloseTextDocument?.(document => { if (document === this.target?.document) { this.target = undefined; this.changed(); } })];
    for (const listener of listeners) if (listener) context.subscriptions.push(listener);
    if (vscode.window.activeTextEditor) this.capture(vscode.window.activeTextEditor, false);
  }
  private capture(editor: vscode.TextEditor, notify = true): void {
    const selections = editor.selections ?? [editor.selection];
    this.target = { id: ++this.serial, document: editor.document, version: editor.document.version, selections: [...selections], column: editor.viewColumn, stale: false };
    if (notify) this.changed();
  }
  state() {
    const t = this.target, usable = !!t && !t.document.isClosed;
    const native = usable ? hostPath(t.document.uri) : undefined;
    const reason = !usable ? tr("imageProjectActions.9977835b34") : t.document.isUntitled ? tr("imageProjectActions.db851ccfbb") : t.stale ? tr("imageProjectActions.7e5f25bd7a")
      : !native ? tr("imageProjectActions.d321feabf3") : !workspaceImage(native) ? tr("imageProjectActions.7a328be037") : '';
    return { id: usable ? t.id : 0, label: usable ? vscode.workspace.asRelativePath?.(t.document.uri, true) ?? path.basename(t.document.uri.path) : '',
      selectionCount: usable ? t.selections.length : 0, replacesSelection: usable && t.selections.some(s => !s.isEmpty),
      unsaved: usable && t.document.isUntitled, changed: usable && t.stale,
      reason, canInsert: !reason };
  }
  private pinned(id: unknown, required: boolean): Target | undefined {
    const t = this.target;
    if (!t || t.document.isClosed) { if (required) throw Error('IMAGE_PROJECT_TARGET_MISSING'); return; }
    if (id !== t.id || t.document.version !== t.version) throw Error('IMAGE_PROJECT_TARGET_CHANGED');
    if (required && t.stale) throw Error('IMAGE_PROJECT_TARGET_CHANGED');
    if (t.document.isUntitled) { if (required) throw Error('IMAGE_PROJECT_TARGET_UNSAVED'); return; }
    const native = hostPath(t.document.uri);
    if (!native) { if (required) throw Error('IMAGE_PROJECT_HOST_MISMATCH'); return; }
    if (!workspaceImage(native)) { if (required) throw Error('IMAGE_PROJECT_TARGET_OUTSIDE'); return; }
    return { ...t, selections: [...t.selections] };
  }
  private async projectFile(image: SavedImage): Promise<string> {
    const file = image.projectCopy?.file ?? image.file;
    if (!workspaceImage(file)) throw Error('IMAGE_PROJECT_OUTSIDE');
    const raster = await readDirectRaster(file, await checkedDirectory(path.dirname(file)));
    const expected = image.projectCopy?.sha256 ?? image.sha256;
    if (expected && expected !== raster.info.sha256) throw Error(image.projectCopy ? 'IMAGE_PROJECT_COPY_CHANGED' : 'IMAGE_EDIT_SOURCE_CHANGED');
    return file;
  }
  async copyPath(image: SavedImage, guard: Guard = () => undefined): Promise<string> {
    const file = await this.projectFile(image), location = workspaceImage(file)!;
    guard();
    await vscode.env.clipboard.writeText(location.relative);
    return tr("imageProjectActions.fd023f5e72", { p0: location.folder.name });
  }
  async copyMarkdown(image: SavedImage, targetId: unknown, guard: Guard = () => undefined): Promise<string> {
    const target = this.pinned(targetId, false), file = await this.projectFile(image), location = workspaceImage(file)!;
    if (target && this.target?.id !== target.id) throw Error('IMAGE_PROJECT_TARGET_CHANGED');
    const relative = target ? documentImagePath(hostPath(target.document.uri)!, file) : location.relative;
    guard();
    await vscode.env.clipboard.writeText(markdownImage(file, relative));
    return target ? tr("imageProjectActions.93d6cba0d3") : tr("imageProjectActions.ae34a05c21", { p0: location.folder.name });
  }
  async insertMarkdown(image: SavedImage, targetId: unknown, guard: Guard = () => undefined): Promise<string> {
    if (this.inserting) throw Error('IMAGE_PROJECT_TARGET_CHANGED');
    this.inserting = true;
    try {
      const target = this.pinned(targetId, true)!, file = await this.projectFile(image);
      const uri = target.document.uri;
      if (!target.selections.length || target.selections.length > 64) throw Error('IMAGE_PROJECT_TARGET_CHANGED');
      if (vscode.workspace.fs.isWritableFileSystem(uri.scheme) === false) throw Error('IMAGE_PROJECT_READONLY');
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.permissions !== undefined && (stat.permissions & vscode.FilePermission.Readonly)) throw Error('IMAGE_PROJECT_READONLY');
      if (this.target?.id !== target.id || target.document.version !== target.version || target.document.isClosed) throw Error('IMAGE_PROJECT_TARGET_CHANGED');
      const text = markdownImage(file, documentImagePath(hostPath(uri)!, file));
      guard();
      const editor = await vscode.window.showTextDocument(target.document, { ...(target.column !== undefined ? { viewColumn: target.column } : {}), preview: false, preserveFocus: false });
      guard();
      if (editor.document !== target.document || target.document.version !== target.version || target.document.isClosed ||
          this.target?.document !== target.document || !sameSelections(editor.selections, target.selections)) throw Error('IMAGE_PROJECT_TARGET_CHANGED');
      // TextEditor.edit additionally rejects edits if the document version changes.
      const applied = await editor.edit(builder => { for (const selection of target.selections) builder.replace(selection, text); }, { undoStopBefore: true, undoStopAfter: true });
      if (!applied) throw Error('IMAGE_PROJECT_READONLY');
      this.capture(editor);
      return tr("imageProjectActions.91508a2689", { p0: target.selections.length });
    } finally { this.inserting = false; }
  }
  async copyIntoProject(image: SavedImage, guard: Guard = () => undefined): Promise<{ file: string; sha256: string } | undefined> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (!folders.length) throw Error('IMAGE_PROJECT_OUTSIDE');
    const targetFolder = this.target && vscode.workspace.getWorkspaceFolder?.(this.target.document.uri) || folders[0]!;
    const selected = await vscode.window.showSaveDialog({ title: tr("imageProjectActions.db22bf19a0"),
      saveLabel: tr("imageProjectActions.c7df14fc07"), defaultUri: vscode.Uri.joinPath(targetFolder.uri, path.basename(image.file)),
      filters: { [tr('common.imagesFilter')]: [path.extname(image.file).slice(1)] } });
    if (!selected) return;
    guard();
    const requested = hostPath(selected), location = requested && workspaceImage(requested);
    if (!requested || !location) throw Error('IMAGE_PROJECT_OUTSIDE');
    const root = await checkedDirectory(location.root), parent = await checkedDirectory(path.dirname(requested));
    const target = path.join(parent, path.basename(requested)), rel = path.relative(root, target);
    if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw Error('IMAGE_PROJECT_OUTSIDE');
    const raster = await readDirectRaster(image.file, await checkedDirectory(path.dirname(image.file)));
    if (image.sha256 && image.sha256 !== raster.info.sha256) throw Error('IMAGE_EDIT_SOURCE_CHANGED');
    if (!(raster.mime === 'image/png' ? /\.png$/i : /\.jpe?g$/i).test(target)) throw Error('IMAGE_PROJECT_HOST_MISMATCH');
    const temp = path.join(parent, `.ag-image-${randomUUID()}.tmp`);
    guard();
    const handle = await fs.open(temp, 'wx', 0o600);
    try {
      try { await handle.writeFile(raster.data); await handle.sync(); } finally { await handle.close(); }
      if (await fs.realpath(parent) !== parent || await fs.realpath(location.root) !== root) throw Error('IMAGE_PROJECT_OUTSIDE');
      guard();
      try { await fs.link(temp, target); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw Error('IMAGE_PROJECT_EXISTS'); throw error; }
    } finally { await fs.unlink(temp); }
    return { file: target, sha256: raster.info.sha256 };
  }
}
