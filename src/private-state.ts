import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { LiveLocks } from './live-lock';
import { LiveError } from './live-storage';
export interface LocalState<T> { transaction<R>(work: (state: T) => R): Promise<R>; read(): Promise<T> }
/** Reload inside the cross-process lock. No credential or bearer is stored here. */
export class PrivateState<T> implements LocalState<T> {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly directory: string, private readonly parse: (value: unknown) => T, private readonly initial: () => T) {}
  private async prepare(): Promise<void> {
    if (!path.isAbsolute(this.directory)) throw Error('AUTOMATION_STORAGE_UNSAFE');
    let current = path.parse(this.directory).root;
    for (const part of this.directory.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      try { await fs.mkdir(current, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
      const s = await fs.lstat(current);
      if (!s.isDirectory() || s.isSymbolicLink() || process.getuid && (s.uid !== process.getuid() && s.uid !== 0 || (s.mode & 0o022) !== 0 && !(s.mode & 0o1000))) throw Error('AUTOMATION_STORAGE_UNSAFE');
      if (current === this.directory && process.getuid && (s.uid !== process.getuid() || (s.mode & 0o077))) throw Error('AUTOMATION_STORAGE_UNSAFE');
    }
  }
  private async load(): Promise<T> {
    let handle;
    try { handle = await fs.open(path.join(this.directory, 'state.json'), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return this.initial(); throw e; }
    try {
      const s = await handle.stat();
      if (!s.isFile() || s.nlink !== 1 || s.size > 2 * 1024 * 1024 || process.getuid && (s.uid !== process.getuid() || (s.mode & 0o077))) throw Error('AUTOMATION_STORAGE_UNSAFE');
      const buffer = Buffer.alloc(2 * 1024 * 1024 + 1); let total = 0;
      while (total < buffer.length) { const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total); if (!bytesRead) break; total += bytesRead; }
      const after = await handle.stat();
      if (total > 2 * 1024 * 1024 || total !== s.size || s.mtimeMs !== after.mtimeMs || s.ctimeMs !== after.ctimeMs) throw Error('AUTOMATION_STORAGE_CHANGED');
      return this.parse(JSON.parse(buffer.subarray(0, total).toString('utf8')));
    } finally { await handle.close(); }
  }
  transaction<R>(work: (state: T) => R): Promise<R> {
    const run = this.tail.then(async () => {
      await this.prepare();
      const locks = new LiveLocks(this.directory, createHash('sha256').update(this.directory).digest('hex'));
      const transaction = () => locks.withOperation(async () => {
        const state = await this.load(), result = work(state), text = JSON.stringify(this.parse(state));
        if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw Error('AUTOMATION_STORAGE_LIMIT');
        const temp = path.join(this.directory, `.${randomUUID()}.tmp`);
        try {
          const file = await fs.open(temp, 'wx', 0o600);
          try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
          await this.prepare(); await fs.rename(temp, path.join(this.directory, 'state.json'));
          if (process.platform !== 'win32') { const dir = await fs.open(this.directory, 'r'); try { await dir.sync(); } finally { await dir.close(); } }
        } finally { await fs.unlink(temp).catch(() => undefined); }
        return result;
      });
      // Another window may briefly write between claim and sent marker. Wait
      // only for a live conflict or an incomplete marker. Every retry acquires
      // through LiveLocks again; uncertain records are never removed or used.
      const deadline = Date.now() + 2000;
      for (;;) {
        try { return await transaction(); }
        catch (e) { if (!(e instanceof LiveError) || !['LIVE_OPERATION_OR_RECOVERY_LOCKED', 'LOCK_RECORD_REQUIRES_MANUAL_CHECK'].includes(e.code) || Date.now() >= deadline) throw e; }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    });
    this.tail = run.catch(() => undefined); return run;
  }
  async read(): Promise<T> { await this.tail; await this.prepare(); return this.load(); }
}
