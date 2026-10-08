import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { constants } from 'node:fs';
import { ensurePrivateDirectory } from '../snapshot-files';
import type { SwitchCoordinator, SwitchLease, SwitchPhase } from './switch-contract';

/** Dedicated extension transaction metadata only; never accepts a credential-store path. */
export class FileSwitchCoordinator implements SwitchCoordinator {
  constructor(private readonly directory: string) {}
  async acquire(transactionId: string): Promise<SwitchLease> {
    if (!/^[a-f0-9-]{36}$/u.test(transactionId)) throw new Error('INVALID_TRANSACTION_ID');
    await ensurePrivateDirectory(this.directory);
    const lock = path.join(this.directory, '.account-switch.lock');
    // No stale-lock timeout, PID guessing or automatic deletion after restart.
    await fs.mkdir(lock, { mode: 0o700 });
    const owner = path.join(lock, 'owner.json');
    let released = false;
    try { await fs.writeFile(owner, JSON.stringify({ schemaVersion: 1, transactionId }), { flag: 'wx', mode: 0o600 }); }
    catch { throw new Error('LOCK_REQUIRES_INSPECTION'); }
    const verifyOwner = async (): Promise<void> => {
      if (released) throw new Error('LOCK_RELEASED');
      const stat = await fs.lstat(lock);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('LOCK_OWNERSHIP_LOST');
      const handle = await fs.open(owner, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > 200) throw new Error('LOCK_OWNERSHIP_LOST');
        const data = JSON.parse(await handle.readFile('utf8')) as { transactionId?: unknown };
        if (data.transactionId !== transactionId) throw new Error('LOCK_OWNERSHIP_LOST');
      } finally { await handle.close(); }
    };
    return {
      record: async (phase: SwitchPhase) => {
        await verifyOwner();
        const file = path.join(lock, 'journal.json');
        const temporary = path.join(lock, 'journal.pending');
        const handle = await fs.open(temporary, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify({ schemaVersion: 1, transactionId, phase })); await handle.sync(); }
        finally { await handle.close(); }
        await fs.rename(temporary, file);
      },
      release: async () => {
        await verifyOwner();
        await fs.unlink(path.join(lock, 'journal.json')).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
        await fs.unlink(owner);
        await fs.rmdir(lock);
        released = true;
      },
    };
  }
}
