import { randomBytes } from 'node:crypto';
import { constants, promises as fs, Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';

const FILE_BYTES = 64 * 1024;
const FILE_COUNT = 5;
const EVENT_BYTES = 2048;
const PENDING_COUNT = 128;
const SCAN_LIMIT = 1024;
const FILE_NAME = /^debug-v1-\d{13}-[a-f0-9]{32}-\d{8}\.jsonl$/;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const NONBLOCK = constants.O_NONBLOCK ?? 0;
export const DEBUG_STORAGE_CODES = [
  'DEBUG_STORAGE_UNAVAILABLE', 'DEBUG_STORAGE_PERMISSION_DENIED', 'DEBUG_STORAGE_READ_ONLY',
  'DEBUG_STORAGE_FULL', 'DEBUG_STORAGE_BUSY', 'DEBUG_STORAGE_MISSING', 'DEBUG_STORAGE_PATH_UNSAFE',
  'DEBUG_STORAGE_NOT_PRIVATE', 'DEBUG_STORAGE_CHANGED', 'DEBUG_STORAGE_LIMIT',
  'DEBUG_STORAGE_INVALID_EVENT', 'DEBUG_STORAGE_QUEUE_FULL', 'DEBUG_STORAGE_INVALID_CONFIGURATION',
  'DEBUG_STORAGE_WRITE_INCOMPLETE',
] as const;
const unavailable = (code = 'DEBUG_STORAGE_UNAVAILABLE'): Error & {code: string} => Object.assign(new Error('DEBUG_STORAGE_UNAVAILABLE'), {code});
/** Return only fixed public codes; never retain OS messages, paths or causes. */
export function sanitizeDebugStorageError(error: unknown): Error & {code: string} {
  let code: unknown;
  try { const descriptor = error !== null && (typeof error === 'object' || typeof error === 'function') ? Object.getOwnPropertyDescriptor(error, 'code') : undefined; code = descriptor && 'value' in descriptor ? descriptor.value : undefined; }
  catch { /* Unknown errors remain generic. */ }
  if (typeof code === 'string' && DEBUG_STORAGE_CODES.includes(code as typeof DEBUG_STORAGE_CODES[number])) return unavailable(code);
  switch (code) {
    case 'EACCES': case 'EPERM': return unavailable('DEBUG_STORAGE_PERMISSION_DENIED');
    case 'EROFS': return unavailable('DEBUG_STORAGE_READ_ONLY');
    case 'ENOSPC': case 'EDQUOT': return unavailable('DEBUG_STORAGE_FULL');
    case 'EBUSY': case 'EMFILE': case 'ENFILE': return unavailable('DEBUG_STORAGE_BUSY');
    case 'ENOENT': return unavailable('DEBUG_STORAGE_MISSING');
    case 'ELOOP': case 'ENOTDIR': case 'EISDIR': return unavailable('DEBUG_STORAGE_PATH_UNSAFE');
    default: return unavailable();
  }
}
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
const sameFile = (left: Stats, right: Stats): boolean => left.dev === right.dev && left.ino === right.ino;
// lstat can finish after another process unlinks the resolved inode. This is
// normal retention, not a hardlink or symlink. Never read/write that snapshot.
const removedFile = (stat: Stats): boolean => stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 0;

export interface DebugLogStoreOptions {
  maxFileBytes?: number;
  maxFiles?: number;
  maxEventBytes?: number;
  maxPending?: number;
}

interface BoundDirectory { name: string; stat: Stats }
interface LogFile { name: string; stat: Stats }

// This also serializes separate windows hosted in one process. Separate extension
// hosts use different random session names and never append to one another's files.
const directoryQueues = new Map<string, Promise<void>>();

function limit(value: number | undefined, fallback: number, maximum: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) { throw unavailable('DEBUG_STORAGE_INVALID_CONFIGURATION'); }
  return result;
}

/** Private, best-effort diagnostic storage. No credential or application logs are read.
 *
 * POSIX mode/owner checks complement no-follow, exclusive creation and inode checks.
 * Node has no portable openat/unlinkat: a malicious process running as the same user
 * can still race ancestor replacement between checks. Windows ACLs are not exposed
 * by these APIs; mode/owner checks are used only where getuid is available. This is
 * not a security boundary against another process with the user's own privileges.
 */
export class DebugLogStore {
  private readonly directory: string;
  private readonly maxFileBytes: number;
  private readonly maxFiles: number;
  private readonly maxEventBytes: number;
  private readonly maxPending: number;
  private readonly session: string;
  private readonly uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  private directories: BoundDirectory[] | undefined;
  private currentFile: LogFile | undefined;
  private sequence = 0;
  private pending = 0;
  private disposed = false;
  private failure: Error & {code: string} | undefined;
  private tail: Promise<void> = Promise.resolve();

  constructor(directory: string, options: DebugLogStoreOptions = {}) {
    try {
      if (typeof directory !== 'string' || !directory || directory.includes('\0')) { throw unavailable('DEBUG_STORAGE_INVALID_CONFIGURATION'); }
      this.directory = path.resolve(directory);
      if (this.directory === path.parse(this.directory).root) { throw unavailable('DEBUG_STORAGE_INVALID_CONFIGURATION'); }
      // Configuration may tighten, never remove, the storage and memory bounds.
      this.maxFileBytes = limit(options.maxFileBytes, FILE_BYTES, FILE_BYTES);
      this.maxFiles = limit(options.maxFiles, FILE_COUNT, FILE_COUNT);
      this.maxEventBytes = limit(options.maxEventBytes, Math.min(EVENT_BYTES, this.maxFileBytes), Math.min(EVENT_BYTES, this.maxFileBytes));
      this.maxPending = limit(options.maxPending, PENDING_COUNT, PENDING_COUNT);
      this.session = randomBytes(16).toString('hex');
    } catch (error) { throw sanitizeDebugStorageError(error); }
  }

  async append(line: string, shouldWrite: () => boolean): Promise<void> {
    try {
      if (!this.allowed(shouldWrite)) { return; }
      if (this.failure) throw this.failure;
      if (!this.validLine(line)) throw unavailable('DEBUG_STORAGE_INVALID_EVENT');
      if (this.pending >= this.maxPending) throw unavailable('DEBUG_STORAGE_QUEUE_FULL');
      const record = Buffer.from(`${line}\n`, 'utf8');
      await this.enqueue(async () => {
        if (!this.allowed(shouldWrite)) { return; }
        if (this.failure) throw this.failure;
        try {
          if (!await this.checkDirectory(true, shouldWrite)) { return; }
          // Validate the bounded directory before writing, not just afterward.
          await this.retain(shouldWrite);
          if (!this.allowed(shouldWrite)) { return; }
          await this.writeRecord(record, shouldWrite);
          if (this.allowed(shouldWrite)) { await this.retain(shouldWrite); }
        } catch (error) {
          // A failing scan or cleanup must never permit unbounded future growth.
          this.failure = sanitizeDebugStorageError(error);
          throw this.failure;
        }
      });
    } catch (error) { throw sanitizeDebugStorageError(error); }
  }

  async readLines(): Promise<string[]> {
    try {
      if (this.disposed) return [];
      if (this.pending >= this.maxPending) throw unavailable('DEBUG_STORAGE_QUEUE_FULL');
      if (this.failure) throw this.failure;
      let result: string[] = [];
      await this.enqueue(async () => {
        if (this.disposed || !await this.checkDirectory(false)) { return; }
        const files = (await this.scan()).slice(-this.maxFiles);
        const lines: string[] = [];
        for (const file of files) {
          if (this.disposed) { break; }
          const content = await this.readFile(file);
          // Ignore incomplete final records after an interrupted write.
          const records = content.split('\n');
          records.pop();
          for (const line of records) { if (this.validLine(line)) { lines.push(line); } }
        }
        result = lines;
      });
      return result;
    } catch (error) { throw sanitizeDebugStorageError(error); }
  }

  async flush(): Promise<void> { await this.tail; }

  dispose(): void { this.disposed = true; }

  private allowed(shouldWrite: () => boolean): boolean {
    return !this.disposed && shouldWrite();
  }

  private validLine(line: string): boolean {
    if (typeof line !== 'string' || !line || line.length >= this.maxEventBytes || /[\r\n]/.test(line)
      || Buffer.byteLength(line, 'utf8') + 1 > this.maxEventBytes) { return false; }
    try {
      const parsed: unknown = JSON.parse(line);
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
    } catch { return false; }
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    this.pending += 1;
    const previous = directoryQueues.get(this.directory) ?? Promise.resolve();
    const work = previous.then(operation).finally(() => { this.pending -= 1; });
    const settled = work.then(() => undefined, () => undefined);
    directoryQueues.set(this.directory, settled);
    this.tail = settled;
    void settled.then(() => { if (directoryQueues.get(this.directory) === settled) { directoryQueues.delete(this.directory); } });
    return work;
  }

  private validateDirectory(stat: Stats, leaf: boolean): void {
    if (!stat.isDirectory() || stat.isSymbolicLink()) { throw unavailable('DEBUG_STORAGE_PATH_UNSAFE'); }
    if (this.uid === undefined) { return; }
    if (leaf) {
      if (stat.uid !== this.uid || (stat.mode & 0o077) !== 0) { throw unavailable('DEBUG_STORAGE_NOT_PRIVATE'); }
    } else {
      if (stat.uid !== this.uid && stat.uid !== 0) { throw unavailable('DEBUG_STORAGE_NOT_PRIVATE'); }
      // Root/user-owned sticky temporary roots protect their user-owned children.
      if ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0) { throw unavailable('DEBUG_STORAGE_NOT_PRIVATE'); }
    }
  }

  private validateFile(stat: Stats): void {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw unavailable('DEBUG_STORAGE_PATH_UNSAFE');
    if (stat.size > this.maxFileBytes) throw unavailable('DEBUG_STORAGE_LIMIT');
    if (this.uid !== undefined && (stat.uid !== this.uid || (stat.mode & 0o077) !== 0)) throw unavailable('DEBUG_STORAGE_NOT_PRIVATE');
  }

  private async checkDirectory(create: boolean, shouldWrite?: () => boolean): Promise<boolean> {
    const root = path.parse(this.directory).root;
    const segments = this.directory.slice(root.length).split(path.sep).filter(Boolean);
    const names = [root];
    for (const segment of segments) { names.push(path.join(names[names.length - 1]!, segment)); }
    const checked: BoundDirectory[] = [];
    for (let index = 0; index < names.length; index += 1) {
      const name = names[index]!;
      let stat: Stats;
      try { stat = await fs.lstat(name); }
      catch (error) {
        if (!missing(error)) { throw error; }
        if (this.directories) { throw unavailable('DEBUG_STORAGE_MISSING'); }
        if (!create) { return false; }
        if (shouldWrite && !this.allowed(shouldWrite)) { return false; }
        // Verify the already-inspected parent chain before creating each component.
        for (const ancestor of checked) {
          const current = await fs.lstat(ancestor.name);
          this.validateDirectory(current, false);
          if (!sameFile(current, ancestor.stat)) { throw unavailable('DEBUG_STORAGE_CHANGED'); }
        }
        if (shouldWrite && !this.allowed(shouldWrite)) { return false; }
        try { await fs.mkdir(name, { mode: 0o700 }); }
        catch (mkdirError) { if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') { throw mkdirError; } }
        stat = await fs.lstat(name);
      }
      this.validateDirectory(stat, index === names.length - 1);
      const bound = this.directories?.[index];
      if (bound && !sameFile(stat, bound.stat)) { throw unavailable('DEBUG_STORAGE_CHANGED'); }
      checked.push({ name, stat });
    }
    // Detect swaps that happened while checking a deeper component.
    for (let index = 0; index < checked.length; index += 1) {
      const entry = checked[index]!;
      const current = await fs.lstat(entry.name);
      this.validateDirectory(current, index === checked.length - 1);
      if (!sameFile(current, entry.stat)) { throw unavailable('DEBUG_STORAGE_CHANGED'); }
    }
    this.directories = checked;
    return !shouldWrite || this.allowed(shouldWrite);
  }

  private async verifyHandle(file: LogFile, handle: FileHandle): Promise<Stats | undefined> {
    const stat = await handle.stat();
    // Retention in another process may unlink a handle we already opened.
    if (sameFile(stat, file.stat) && stat.nlink === 0) { return undefined; }
    this.validateFile(stat);
    if (!sameFile(stat, file.stat)) { throw unavailable('DEBUG_STORAGE_CHANGED'); }
    await this.checkDirectory(false);
    let current: Stats;
    try { current = await fs.lstat(path.join(this.directory, file.name)); }
    catch (error) { if (missing(error)) { return undefined; } throw error; }
    if (sameFile(current, stat) && removedFile(current)) return undefined;
    this.validateFile(current);
    if (!sameFile(current, stat)) { throw unavailable('DEBUG_STORAGE_CHANGED'); }
    return stat;
  }

  private async writeRecord(record: Buffer, shouldWrite: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 3 && this.allowed(shouldWrite); attempt += 1) {
      if (!await this.checkDirectory(false, shouldWrite)) { return; }
      let file = this.currentFile;
      let handle: FileHandle | undefined;
      try {
        if (file) {
          let stat: Stats;
          try { stat = await fs.lstat(path.join(this.directory, file.name)); }
          catch (error) { if (missing(error)) { this.currentFile = undefined; continue; } throw error; }
          if (sameFile(stat, file.stat) && removedFile(stat)) { this.currentFile = undefined; continue; }
          this.validateFile(stat);
          if (!sameFile(stat, file.stat)) { throw unavailable('DEBUG_STORAGE_CHANGED'); }
          if (stat.size + record.length > this.maxFileBytes) { this.currentFile = undefined; file = undefined; }
        }
        if (!this.allowed(shouldWrite)) { return; }
        if (!file) {
          // Reserve room before exclusive creation, bounding the aggregate even
          // if cancellation or a process exit prevents post-write cleanup.
          await this.retain(shouldWrite, 1);
          if (!await this.checkDirectory(false, shouldWrite)) { return; }
          if (this.sequence >= 99_999_999) { throw unavailable('DEBUG_STORAGE_LIMIT'); }
          const name = `debug-v1-${Date.now().toString().padStart(13, '0')}-${this.session}-${String(this.sequence++).padStart(8, '0')}.jsonl`;
          handle = await fs.open(path.join(this.directory, name), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_EXCL | NOFOLLOW | NONBLOCK, 0o600);
          file = { name, stat: await handle.stat() };
        } else {
          try { handle = await fs.open(path.join(this.directory, file.name), constants.O_WRONLY | constants.O_APPEND | NOFOLLOW | NONBLOCK); }
          catch (error) { if (missing(error)) { this.currentFile = undefined; continue; } throw error; }
        }
        const stat = await this.verifyHandle(file, handle);
        if (!stat) { this.currentFile = undefined; continue; }
        if (stat.size + record.length > this.maxFileBytes) { this.currentFile = undefined; continue; }
        if (!this.allowed(shouldWrite)) { return; }
        // One bounded write; do not continue a partial write after cancellation.
        const written = await handle.write(record, 0, record.length, null);
        if (written.bytesWritten !== record.length) { throw unavailable('DEBUG_STORAGE_WRITE_INCOMPLETE'); }
        this.currentFile = file;
        return;
      } finally { if (handle) { await handle.close(); } }
    }
    // Another process can rotate a file away before it is opened. Dropping a
    // diagnostic event after bounded retries is preferable to affecting work.
  }

  private async scan(): Promise<LogFile[]> {
    await this.checkDirectory(false);
    const result: LogFile[] = [];
    const directory = await fs.opendir(this.directory);
    let count = 0;
    for await (const entry of directory) {
      if (++count > SCAN_LIMIT) { throw unavailable('DEBUG_STORAGE_LIMIT'); }
      if (!FILE_NAME.test(entry.name)) { continue; }
      let stat: Stats;
      try { stat = await fs.lstat(path.join(this.directory, entry.name)); }
      catch (error) { if (missing(error)) { continue; } throw error; }
      if (removedFile(stat)) continue;
      this.validateFile(stat);
      result.push({ name: entry.name, stat });
    }
    await this.checkDirectory(false);
    return result.sort((left, right) => left.name.localeCompare(right.name));
  }

  private async retain(shouldWrite: () => boolean, reserve = 0): Promise<void> {
    if (!this.allowed(shouldWrite)) { return; }
    const files = await this.scan();
    for (const file of files.slice(0, Math.max(0, files.length - this.maxFiles + reserve))) {
      if (!await this.checkDirectory(false, shouldWrite)) { return; }
      let current: Stats;
      try { current = await fs.lstat(path.join(this.directory, file.name)); }
      catch (error) { if (missing(error)) { continue; } throw error; }
      if (sameFile(current, file.stat) && removedFile(current)) continue;
      this.validateFile(current);
      if (!sameFile(current, file.stat)) { throw unavailable('DEBUG_STORAGE_CHANGED'); }
      if (!this.allowed(shouldWrite)) { return; }
      try { await fs.unlink(path.join(this.directory, file.name)); }
      catch (error) { if (!missing(error)) { throw error; } }
      if (this.currentFile?.name === file.name) { this.currentFile = undefined; }
    }
  }

  private async readFile(file: LogFile): Promise<string> {
    await this.checkDirectory(false);
    let handle: FileHandle;
    try { handle = await fs.open(path.join(this.directory, file.name), constants.O_RDONLY | NOFOLLOW | NONBLOCK); }
    catch (error) { if (missing(error)) { return ''; } throw error; }
    try {
      const stat = await this.verifyHandle(file, handle);
      if (!stat || this.disposed) { return ''; }
      const buffer = Buffer.alloc(this.maxFileBytes);
      let total = 0;
      while (total < Math.min(stat.size, this.maxFileBytes)) {
        if (this.disposed) { return ''; }
        const read = await handle.read(buffer, total, Math.min(stat.size, this.maxFileBytes) - total, total);
        if (read.bytesRead === 0) { break; }
        total += read.bytesRead;
      }
      if (!await this.verifyHandle(file, handle)) { return ''; }
      return buffer.subarray(0, total).toString('utf8');
    } finally { await handle.close(); }
  }
}
