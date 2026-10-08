import { t as tr } from './i18n';
import * as fs from 'node:fs/promises';
import { constants, type Stats } from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { LiveLocks } from './live-lock';
import { sameImagePath } from './image-files';

export type SavedImage = { file: string; width: number; height: number; sha256?: string; unavailable?: string;
  projectCopy?: { file: string; sha256: string } };
export type ImageOrigin = { taskId: string; imageIndex: number; rootTaskId: string; rootImageIndex: number;
  file: string; outputDirectory: string; sha256?: string; legacyUnverified?: true; width: number; height: number; accountId: string; modelId: string };
export type ImageTask = {
  accountId?: string; accountLabel?: string; accountSource?: 'current' | 'saved'; endpoint?: 'daily' | 'production';
  id: string; createdAt: string; prompt: string; promptSummary: string; modelId: string;
  ratio: string; size: string; quality: string; count: number; references: string[];
  phase: 'confirming' | 'preparing' | 'generating' | 'validating' | 'complete' | 'partial' | 'failed' | 'cancelled' | 'interrupted';
  status: string; outputDirectory: string; images: SavedImage[];
  origin?: ImageOrigin;
};
export type ImageDraft = { prompt: string; accountId: string; modelId: string; ratio: string; count: number; size: string; quality: string; followCurrent: boolean };
export type SavedDraft = { id: string; savedAt: string; draft: ImageDraft; outputDirectory: string; references: string[]; origin?: ImageOrigin };
export interface ImageSession { schema: 3; draft: ImageDraft; outputDirectory: string; references: string[]; tasks: ImageTask[];
  savedDrafts: SavedDraft[]; origin?: ImageOrigin }
export interface ImageSessionStorage { load(): Promise<ImageSession | undefined>; save(value: ImageSession): Promise<void>; flush(): Promise<void> }
export const SESSION_MAX_BYTES = 8 * 1024 * 1024;
export const SESSION_MAX_TASKS = 200;
export const SESSION_MAX_DRAFTS = 10;
const fail = (code = 'IMAGE_SESSION_INVALID'): never => { throw new Error(code); };
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : fail();
const str = (value: unknown, max: number): string => typeof value === 'string' && value.length <= max ? value : fail();
const num = (value: unknown, min: number, max: number): number => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : fail();
const pick = <T extends string>(value: unknown, values: readonly T[]): T => typeof value === 'string' && values.includes(value as T) ? value as T : fail();
const localPath = (value: unknown, empty = false): string => {
  const file = str(value, 4096);
  // eslint-disable-next-line no-control-regex
  return (empty && !file || path.isAbsolute(file)) && !/[\x00-\x1f]/u.test(file) ? file : fail();
};
const refs = (value: unknown): string[] => Array.isArray(value) && value.length <= 3 ? value.map(x => localPath(x)) : fail();
const ratios = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'] as const;
const identifier = (value: unknown): string => { const id = str(value, 64); return /^[a-f0-9-]{36}$/.test(id) ? id : fail(); };
const digest = (value: unknown): string => { const hash = str(value, 64); return /^[a-f0-9]{64}$/.test(hash) ? hash : fail(); };
function imagePath(value: unknown, directory?: string): string {
  const file = localPath(value);
  if (!/\.(png|jpe?g)$/i.test(file)) fail();
  if (directory) { const rel = path.relative(directory, file); if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) fail(); }
  return file;
}
function readOrigin(value: unknown): ImageOrigin {
  const o = object(value), outputDirectory = localPath(o.outputDirectory);
  if (o.legacyUnverified !== undefined && (o.legacyUnverified !== true || o.sha256 !== undefined)) fail();
  return { taskId: identifier(o.taskId), imageIndex: num(o.imageIndex, 0, 31), rootTaskId: identifier(o.rootTaskId), rootImageIndex: num(o.rootImageIndex, 0, 31),
    file: imagePath(o.file, outputDirectory), outputDirectory, ...(o.legacyUnverified === true ? { legacyUnverified: true as const } : { sha256: digest(o.sha256) }), width: num(o.width, 1, 8192), height: num(o.height, 1, 8192),
    accountId: str(o.accountId, 128), modelId: str(o.modelId, 256) };
}
function readDraft(value: unknown): ImageDraft {
  const d = object(value);
  if (typeof d.followCurrent !== 'boolean') fail();
  return { prompt: str(d.prompt, 12_000), accountId: str(d.accountId, 128), modelId: str(d.modelId, 256),
    ratio: pick(d.ratio, ratios), count: num(d.count, 1, 4), size: pick(d.size, ['auto', '1K', '2K', '4K']), quality: pick(d.quality, ['auto', 'detail']), followCurrent: d.followCurrent as boolean };
}
/** A private, versioned DTO, unrelated to the credential store or diagnostic log.
 * Invalid/unknown schemas are never silently truncated, migrated or overwritten. */
export function readImageSession(value: unknown, restored = false): ImageSession {
  const row = object(value);
  if (row.schema !== 1 && row.schema !== 2 && row.schema !== 3) fail('IMAGE_SESSION_SCHEMA_UNSUPPORTED');
  const draft = readDraft(row.draft);
  if (!Array.isArray(row.tasks) || row.tasks.length > SESSION_MAX_TASKS) fail('IMAGE_SESSION_LIMIT');
  const ids = new Set<string>();
  const tasks = (row.tasks as unknown[]).map(value => {
    const t = object(value), id = str(t.id, 64), createdAt = str(t.createdAt, 32);
    if (!/^[a-f0-9-]{36}$/.test(id) || ids.has(id) || !Number.isFinite(Date.parse(createdAt))) fail();
    ids.add(id);
    const outputDirectory = localPath(t.outputDirectory);
    if (!Array.isArray(t.images) || t.images.length > 32) fail();
    const images = (t.images as unknown[]).map(value => {
      const i = object(value), file = imagePath(i.file, outputDirectory);
      const image: SavedImage = { file, width: num(i.width, 1, 8192), height: num(i.height, 1, 8192) };
      if (i.sha256 !== undefined) image.sha256 = digest(i.sha256);
      if (row.schema !== 1 && i.projectCopy !== undefined) { const copy = object(i.projectCopy); image.projectCopy = { file: imagePath(copy.file), sha256: digest(copy.sha256) }; }
      return image;
    });
    const task: ImageTask = { id, createdAt, prompt: str(t.prompt, 12_000), promptSummary: str(t.promptSummary, 141), modelId: str(t.modelId, 256),
      ratio: pick(t.ratio, [...ratios, '原始']), size: pick(t.size, ['auto', '1K', '2K', '4K', '原始']), quality: pick(t.quality, ['auto', 'detail', '原始']), count: num(t.count, 0, 4),
      references: refs(t.references), outputDirectory, images,
      phase: pick(t.phase, ['confirming', 'preparing', 'generating', 'validating', 'complete', 'partial', 'failed', 'cancelled', 'interrupted']), status: str(t.status, 4000) };
    if (t.accountId !== undefined) task.accountId = str(t.accountId, 128);
    if (t.accountLabel !== undefined) task.accountLabel = str(t.accountLabel, 512);
    if (t.accountSource !== undefined) task.accountSource = pick(t.accountSource, ['current', 'saved']);
    if (t.endpoint !== undefined) task.endpoint = pick(t.endpoint, ['daily', 'production']);
    if (row.schema !== 1 && t.origin !== undefined) { task.origin = readOrigin(t.origin); if (task.origin.taskId === task.id || task.origin.rootTaskId === task.id || row.schema === 2 && task.origin.legacyUnverified) fail(); }
    if (restored && ['confirming', 'preparing', 'generating', 'validating'].includes(task.phase)) {
      task.status = task.phase === 'confirming' ? tr("imageSessionStore.323d6e2791") : tr("imageSessionStore.14ad5eca20");
      task.phase = 'interrupted';
    }
    return task;
  });
  const byId = new Map(tasks.map(task => [task.id, task]));
  // The cloud candidate extended schema 1 without recording source digests.
  // Preserve those relationships explicitly; never invent a verified digest.
  const cloudOrigin = (id: unknown, index: unknown, before = tasks.length): ImageOrigin => {
    const parent = byId.get(identifier(id)) ?? fail(), imageIndex = num(index, 0, 31);
    if (tasks.indexOf(parent) >= before) fail();
    const image = parent.images[imageIndex] ?? fail();
    return { taskId: parent.id, imageIndex, rootTaskId: parent.origin?.rootTaskId ?? parent.id,
      rootImageIndex: parent.origin?.rootImageIndex ?? imageIndex, file: image.file, outputDirectory: parent.outputDirectory,
      width: image.width, height: image.height, accountId: parent.accountId ?? '', modelId: parent.modelId, legacyUnverified: true };
  };
  if (row.schema === 1) for (const [index, raw] of (row.tasks as unknown[]).entries()) {
    const t = object(raw);
    if (t.parentTaskId !== undefined) tasks[index]!.origin = cloudOrigin(t.parentTaskId, t.parentImageIndex, index);
    else if (t.parentImageIndex !== undefined) fail();
  }
  for (const task of tasks) {
    const seen = new Set<string>(); let current: ImageTask | undefined = task;
    while (current) { if (seen.has(current.id)) fail(); seen.add(current.id); current = current.origin ? byId.get(current.origin.taskId) : undefined; }
    if (task.origin) {
      if (!task.origin.legacyUnverified && (task.accountId !== task.origin.accountId || !task.references.includes(task.origin.file))) fail();
      const parent = byId.get(task.origin.taskId);
      if (parent && (task.origin.rootTaskId !== (parent.origin?.rootTaskId ?? parent.id) || task.origin.rootImageIndex !== (parent.origin?.rootImageIndex ?? task.origin.imageIndex))) fail();
    }
  }
  const savedDrafts: SavedDraft[] = [];
  if (row.schema !== 1 && row.savedDrafts !== undefined) {
    if (!Array.isArray(row.savedDrafts) || row.savedDrafts.length > SESSION_MAX_DRAFTS) fail('IMAGE_SESSION_LIMIT');
    const seen = new Set<string>();
    for (const value of row.savedDrafts as unknown[]) { const b = object(value), id = identifier(b.id), savedAt = str(b.savedAt, 32);
      if (seen.has(id) || !Number.isFinite(Date.parse(savedAt))) fail(); seen.add(id);
      const saved: SavedDraft = { id, savedAt, draft: readDraft(b.draft), references: refs(b.references), outputDirectory: localPath(b.outputDirectory, true) };
      if (b.origin !== undefined) { saved.origin = readOrigin(b.origin); if (row.schema === 2 && saved.origin.legacyUnverified) fail(); }
      if (saved.origin && !saved.origin.legacyUnverified && (!saved.references.includes(saved.origin.file) || saved.draft.followCurrent || saved.draft.accountId !== saved.origin.accountId)) fail();
      savedDrafts.push(saved);
    }
  }
  const session: ImageSession = { schema: 3, draft, outputDirectory: localPath(row.outputDirectory, true), references: refs(row.references), tasks, savedDrafts };
  if (row.schema === 1 && row.edit !== undefined) {
    const edit = object(row.edit), backup = object(edit.backup);
    session.origin = cloudOrigin(edit.parentTaskId, edit.parentImageIndex);
    const kept = { draft: readDraft(backup.draft), outputDirectory: localPath(backup.outputDirectory, true), references: refs(backup.references) };
    const key = createHash('sha256').update(JSON.stringify(kept)).digest('hex');
    savedDrafts.push({ id: `${key.slice(0,8)}-${key.slice(8,12)}-4${key.slice(13,16)}-8${key.slice(17,20)}-${key.slice(20,32)}`,
      savedAt: byId.get(session.origin.taskId)!.createdAt, ...kept });
  }
  if (row.schema !== 1 && row.origin !== undefined) {
    session.origin = readOrigin(row.origin);
    if (row.schema === 2 && session.origin.legacyUnverified) fail();
    if (!session.origin.legacyUnverified && (!session.references.includes(session.origin.file) || draft.followCurrent || draft.accountId !== session.origin.accountId)) fail();
  }
  return session;
}
const hash = (text: string | undefined): string => text === undefined ? 'absent' : createHash('sha256').update(text).digest('hex');
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

/** Atomic private files in the extension host's workspace storage. A revision
 * check under a process-identity lock rejects stale writers from other windows. */
export class ImageSessionStore implements ImageSessionStorage {
  private expected: string | undefined;
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  constructor(private readonly directory: string | undefined) {}
  private async prepare(): Promise<string> {
    if (!this.directory || !path.isAbsolute(this.directory)) fail('IMAGE_SESSION_STORAGE_UNAVAILABLE');
    const directory = this.directory!;
    const root = path.parse(directory).root;
    let current = root;
    for (const part of directory.slice(root.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      try { await fs.mkdir(current, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail('IMAGE_SESSION_PATH_UNSAFE');
      if (process.getuid && (stat.uid !== process.getuid() && stat.uid !== 0 || (stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0)) fail('IMAGE_SESSION_PATH_UNSAFE');
      if (current === directory && process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)) fail('IMAGE_SESSION_NOT_PRIVATE');
    }
    return directory;
  }
  private checkFile(stat: Stats): void {
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > SESSION_MAX_BYTES || process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)) fail('IMAGE_SESSION_PATH_UNSAFE');
  }
  private async raw(directory: string): Promise<string | undefined> {
    let handle;
    try { handle = await fs.open(path.join(directory, 'session.json'), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); }
    catch (e) { if (missing(e)) return; throw e; }
    try {
      const before = await handle.stat(); this.checkFile(before);
      const buffer = Buffer.alloc(SESSION_MAX_BYTES + 1);
      let total = 0;
      while (total < buffer.length) { const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total); if (!bytesRead) break; total += bytesRead; }
      if (total > SESSION_MAX_BYTES) fail('IMAGE_SESSION_LIMIT');
      const after = await handle.stat();
      if (before.size !== total || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail('IMAGE_SESSION_CHANGED');
      return buffer.subarray(0, total).toString('utf8');
    } finally { await handle.close(); }
  }
  async load(): Promise<ImageSession | undefined> {
    try {
      const raw = await this.raw(await this.prepare());
      const value = raw === undefined ? undefined : readImageSession(JSON.parse(raw), true);
      this.expected = hash(raw);
      return value;
    } catch (e) { throw sessionError(e); }
  }
  save(value: ImageSession): Promise<void> {
    let text: string;
    try {
      text = JSON.stringify(readImageSession(value));
      if (Buffer.byteLength(text) > SESSION_MAX_BYTES || this.pending >= 64) fail('IMAGE_SESSION_LIMIT');
    } catch (e) { return Promise.reject(sessionError(e)); }
    this.pending++;
    const work = this.tail.then(async () => {
      if (this.expected === undefined) fail('IMAGE_SESSION_STORAGE_UNAVAILABLE');
      const directory = await this.prepare();
      const locks = new LiveLocks(directory, createHash('sha256').update(directory).digest('hex'));
      await locks.withOperation(async () => {
        if (hash(await this.raw(directory)) !== this.expected) fail('IMAGE_SESSION_CHANGED');
        const temp = path.join(directory, `.${randomUUID()}.tmp`);
        let created = false;
        try {
          const handle = await fs.open(temp, 'wx', 0o600); created = true;
          try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
          await this.prepare();
          await fs.rename(temp, path.join(directory, 'session.json')); created = false;
          this.expected = hash(text);
          if (process.platform !== 'win32') { const dir = await fs.open(directory, 'r'); try { await dir.sync(); } finally { await dir.close(); } }
        } finally { if (created) await fs.unlink(temp).catch(() => undefined); }
      });
    }).catch(e => { throw sessionError(e); }).finally(() => { this.pending--; });
    this.tail = work.then(() => undefined, () => undefined);
    return work;
  }
  async flush(): Promise<void> { await this.tail; }
}
function sessionError(error: unknown): Error {
  return error instanceof Error && /^IMAGE_SESSION_[A-Z_]+$/.test(error.message) ? error : new Error('IMAGE_SESSION_STORAGE_UNAVAILABLE');
}
export function sessionWarning(error: unknown): string {
  const code = sessionError(error).message;
  const reason = code === 'IMAGE_SESSION_LIMIT' ? tr("imageSessionStore.4d732dcc67") : code === 'IMAGE_SESSION_CHANGED' ? tr("imageSessionStore.bcd66ae7da") : tr("imageSessionStore.49e7c697b6");
  return tr("imageSessionStore.13a0c9b5f9", { p0: reason, p1: code });
}

/** No image content, deletion or official history access. Preview still performs
 * the existing full raster/path validation when the user opens an image. */
export async function checkSessionImages(tasks: ImageTask[]): Promise<void> {
  for (const task of tasks) for (const image of task.images) {
    try {
      const stat = await fs.lstat(image.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !sameImagePath(await fs.realpath(image.file), image.file) || !sameImagePath(await fs.realpath(task.outputDirectory), task.outputDirectory)) throw Error();
      delete image.unavailable;
    } catch (e) { image.unavailable = missing(e) ? tr("imageSessionStore.190c0bfed3") : tr("imageSessionStore.4d549987b4"); }
  }
}
