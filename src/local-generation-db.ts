import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import * as fs from 'node:fs/promises';
import { constants, type Stats } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { parseLocalGeneration, type LocalGenerationRecord } from './local-generation-record';

const LIMIT = 32 * 1024 * 1024;
const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const safe = (s: Stats) => s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && (typeof process.getuid !== 'function' || s.uid === process.getuid());
/** The SQLite process owns only private copies and can be terminated on cancel. */
export async function queryGenerationSnapshot(snapshot: string, signal: AbortSignal, options: {engine?: 'auto' | 'wasm'; timeoutMs?: number} = {}): Promise<unknown> {
  if (signal.aborted) throw Error('LOCAL_DB_CANCELLED');
  const worker = new Worker(path.join(__dirname, 'local-generation-worker.js'), { workerData: {snapshot,engine:options.engine ?? 'auto'}, env: {}, execArgv: [], resourceLimits: {maxOldGenerationSizeMb: 128} });
  try {
    return await new Promise<unknown>((resolve,reject) => {
      let settled=false;
      const finish=(error?: Error,value?: unknown) => { if(settled)return;settled=true;clearTimeout(timer);signal.removeEventListener('abort',abort);if(error)reject(error);else resolve(value); };
      const abort=()=>finish(Error('LOCAL_DB_CANCELLED'));
      const timer=setTimeout(()=>finish(Error('LOCAL_DB_UNAVAILABLE')),options.timeoutMs ?? 10_000);
      signal.addEventListener('abort',abort,{once:true});
      worker.once('message',value=>finish(undefined,value));
      worker.once('error',()=>finish(Error('LOCAL_DB_UNAVAILABLE')));
      worker.once('exit',()=>finish(Error('LOCAL_DB_UNAVAILABLE')));
      if(signal.aborted)abort();
    });
  } finally { await worker.terminate(); }
}
export async function readLocalGenerationDb(selected: string, signal: AbortSignal, options: {engine?: 'auto' | 'wasm'; timeoutMs?: number} = {}): Promise<{ rows: LocalGenerationRecord[]; limited: boolean }> {
  if (signal.aborted) throw Error('LOCAL_DB_CANCELLED');
  // eslint-disable-next-line no-control-regex
  if (selected.length > 4096 || !path.isAbsolute(selected) || path.extname(selected).toLowerCase() !== '.db' || /[\u0000-\u001f]/.test(selected)) throw Error('LOCAL_DB_UNSAFE');
  const real = await fs.realpath(selected).catch(() => { throw Error('LOCAL_DB_UNAVAILABLE'); });
  if (real !== path.resolve(selected)) throw Error('LOCAL_DB_UNSAFE');
  const temp = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'ag-generation-'));
  const source: { name: string; stat: Stats; handle: Awaited<ReturnType<typeof fs.open>> }[] = [];
  try {
    await fs.chmod(temp, 0o700);
    const journal = () => fs.lstat(selected + '-journal').then(s => s.size > 0, e => { if (e.code === 'ENOENT') return false; throw e; });
    if (await journal()) throw Error('LOCAL_DB_CHANGED');
    for (const suffix of ['', '-wal']) {
      const name = selected + suffix;
      const stat = await fs.lstat(name).catch(e => { if (suffix && e.code === 'ENOENT') return undefined; throw Error('LOCAL_DB_UNAVAILABLE'); });
      if (!stat) continue;
      if (!safe(stat)) throw Error('LOCAL_DB_UNSAFE');
      if (stat.size > LIMIT) throw Error('LOCAL_DB_LIMIT');
      const handle = await fs.open(name, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      source.push({ name, stat, handle });
      const bound = await handle.stat(); if (!safe(bound) || !same(bound, stat)) throw Error('LOCAL_DB_CHANGED');
    }
    for (const file of source) {
      if (signal.aborted) throw Error('LOCAL_DB_CANCELLED');
      const target = path.join(temp, file.name === selected ? 'conversation.db' : 'conversation.db-wal');
      const output = await fs.open(target, 'wx', 0o600);
      try {
        const buffer = Buffer.alloc(128 * 1024); let offset = 0;
        while (offset < file.stat.size) {
          if (signal.aborted) throw Error('LOCAL_DB_CANCELLED');
          const n = (await file.handle.read(buffer, 0, Math.min(buffer.length, file.stat.size - offset), offset)).bytesRead;
          if (!n) throw Error('LOCAL_DB_CHANGED');
          let written = 0; while (written < n) { const size = (await output.write(buffer, written, n - written)).bytesWritten; if (!size) throw Error('LOCAL_DB_UNAVAILABLE'); written += size; }
          offset += n;
        }
      } finally { await output.close(); }
    }
    for (const file of source) {
      if (!same(file.stat, await file.handle.stat())) throw Error('LOCAL_DB_CHANGED');
      // Windows may leave the open handle's timestamps unchanged after rename.
      // A name that disappeared during copying is a changed source, even then.
      const named = await fs.lstat(file.name).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw Error('LOCAL_DB_CHANGED');
        throw error;
      });
      if (!same(file.stat, named)) throw Error('LOCAL_DB_CHANGED');
    }
    if (!source.some(f => f.name.endsWith('-wal')) && await fs.lstat(selected + '-wal').then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; })) throw Error('LOCAL_DB_CHANGED');
    if (await journal()) throw Error('LOCAL_DB_CHANGED');
    const result = await queryGenerationSnapshot(path.join(temp, 'conversation.db'), signal, options);
    if (signal.aborted) throw Error('LOCAL_DB_CANCELLED');
    if (!result || typeof result !== 'object' || !('rows' in result) || !Array.isArray(result.rows) || result.rows.length > 1000) throw Error('LOCAL_DB_UNSUPPORTED');
    // Filenames are session identifiers, never paths or conversation titles.
    const name = path.basename(selected, '.db');
    const session = /^[a-f0-9-]{36}$/i.test(name) ? name : 'session-' + createHash('sha256').update(selected).digest('hex').slice(0, 12);
    const rows = result.rows.map(row => {
      if (!Array.isArray(row) || row.length !== 2 || !Number.isSafeInteger(row[0]) || row[0] < 0 || typeof row[1] !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(row[1]) || row[1].length > 1_400_000) throw Error('LOCAL_DB_UNSUPPORTED');
      return parseLocalGeneration(session, row[0], Buffer.from(row[1], 'base64'));
    });
    return { rows, limited: 'limited' in result && result.limited === true };
  } catch (e) { if (e instanceof Error && /^LOCAL_DB_[A-Z_]+$/.test(e.message)) throw e; throw Error(signal.aborted ? 'LOCAL_DB_CANCELLED' : 'LOCAL_DB_UNAVAILABLE'); }
  finally { await Promise.allSettled(source.map(f => f.handle.close())); await fs.rm(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 }); }
}
