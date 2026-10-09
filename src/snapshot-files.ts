import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { identityKey, InputError, LIMITS, parseJson, parseSnapshot, restoreAccounts, type Account, type Snapshot } from './core';

const directoryQueues = new Map<string, Promise<void>>();

export async function ensurePrivateDirectory(directory: string): Promise<void> {
  if (!path.isAbsolute(directory)) throw new InputError('DIRECTORY_MUST_BE_ABSOLUTE');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stats = await fs.lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new InputError('UNSAFE_DIRECTORY');
  if (process.platform !== 'win32' && (stats.mode & 0o077) !== 0) throw new InputError('DIRECTORY_NOT_PRIVATE');
}
export async function withDirectoryLock<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  // Windows can deny CREATE_NEW while another local writer's lock deletion is
  // pending. Serialize local writers through cleanup; keep the disk lock for
  // other processes and never treat permission failures as acquired locks.
  const key = path.resolve(directory);
  const previous = directoryQueues.get(key) ?? Promise.resolve();
  const deadline = Date.now() + 2000;
  let expired = false;
  let timer: NodeJS.Timeout | undefined;
  const work = previous.then(() => {
    if (expired || Date.now() >= deadline) throw new InputError('STORAGE_BUSY');
    clearTimeout(timer);
    return withDirectoryFileLock(directory, operation, deadline);
  });
  const settled = work.then(() => undefined, () => undefined);
  directoryQueues.set(key, settled);
  void settled.then(() => { if (directoryQueues.get(key) === settled) directoryQueues.delete(key); });
  const waiting = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { expired = true; reject(new InputError('STORAGE_BUSY')); }, 2000);
  });
  try { return await Promise.race([work, waiting]); }
  finally { clearTimeout(timer); }
}
async function withDirectoryFileLock<T>(directory: string, operation: () => Promise<T>, deadline: number): Promise<T> {
  const lock = path.join(directory, '.write.lock');
  let handle;
  while (!handle) {
    try { handle = await fs.open(lock, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new InputError('STORAGE_BUSY');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  try { return await operation(); }
  finally { await handle.close(); await fs.unlink(lock); }
}
async function atomicWrite(directory: string, target: string, text: string): Promise<void> {
  const temporary = path.join(directory, `.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, target);
  } finally { await fs.unlink(temporary).catch(() => undefined); }
}
export async function readSnapshotFile(file: string, now = Date.now()): Promise<Snapshot> {
  const stats = await fs.lstat(file);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > LIMITS.snapshotBytes) throw new InputError('UNSAFE_SNAPSHOT_FILE');
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > LIMITS.snapshotBytes) throw new InputError('UNSAFE_SNAPSHOT_FILE');
    const buffer = Buffer.alloc(LIMITS.snapshotBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > LIMITS.snapshotBytes) throw new InputError('INPUT_TOO_LARGE');
    return parseSnapshot(parseJson(buffer.subarray(0, bytesRead).toString('utf8'), LIMITS.snapshotBytes), now);
  } finally { await handle.close(); }
}
export async function writeSnapshotFile(directory: string, snapshot: Snapshot): Promise<string> {
  await ensurePrivateDirectory(directory);
  const normalized = parseSnapshot(snapshot);
  const file = path.join(directory, `${identityKey(normalized.identity)}.json`);
  await withDirectoryLock(directory, async () => {
    try {
      const existing = await readSnapshotFile(file);
      if (Date.parse(existing.capturedAt) >= Date.parse(normalized.capturedAt)) return;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await atomicWrite(directory, file, `${JSON.stringify(normalized)}\n`);
  });
  return file;
}
export async function readSnapshotDirectory(directory: string, now = Date.now()): Promise<{ snapshots: Snapshot[]; failures: number; truncated: boolean }> {
  const stats = await fs.lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new InputError('UNSAFE_DIRECTORY');
  const snapshots: Snapshot[] = [];
  let failures = 0;
  let visited = 0;
  let totalEntries = 0;
  let truncated = false;
  const dir = await fs.opendir(directory);
  for await (const entry of dir) {
    if (++totalEntries > 1000) { truncated = true; break; }
    if (!/^[a-f0-9]{64}\.json$/u.test(entry.name)) continue;
    if (++visited > LIMITS.accounts) { truncated = true; break; }
    try {
      const snapshot = await readSnapshotFile(path.join(directory, entry.name), now);
      if (entry.name !== `${identityKey(snapshot.identity)}.json`) throw new InputError('IDENTITY_MISMATCH');
      snapshots.push(snapshot);
    } catch { failures++; }
  }
  return { snapshots, failures, truncated };
}

export async function readAccounts(directory: string): Promise<Account[]> {
  const file = path.join(directory, 'accounts.json');
  let handle;
  try { handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  try {
    const maximum = 4 * 1024 * 1024;
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > maximum) throw new InputError('INVALID_SAVED_ACCOUNTS');
    const buffer = Buffer.alloc(maximum + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maximum) throw new InputError('INPUT_TOO_LARGE');
    return restoreAccounts(parseJson(buffer.subarray(0, bytesRead).toString('utf8'), maximum));
  } finally { await handle.close(); }
}
export async function mutateAccounts(directory: string, transform: (accounts: Account[]) => Account[]): Promise<Account[]> {
  await ensurePrivateDirectory(directory);
  return withDirectoryLock(directory, async () => {
    const accounts = restoreAccounts(transform(await readAccounts(directory)));
    await atomicWrite(directory, path.join(directory, 'accounts.json'), `${JSON.stringify(accounts)}\n`);
    return accounts;
  });
}
