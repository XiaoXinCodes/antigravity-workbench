import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFile, type ExecFileOptions } from 'node:child_process';
import { promisify } from 'node:util';
import { LiveError } from './live-storage';

export interface LockOwner { schema: 1 | 2; owner: string; id: string; pid: number; nonce?: string; startIdentity?: string | null; purpose?: 'image' }
export type ProcessIdentity = { state: 'alive'; startIdentity: string } | { state: 'dead' } | { state: 'unknown' };
export type ProcessProbe = (pid: number) => Promise<ProcessIdentity>;
export interface LockInspection { state: 'absent' | 'active' | 'stale' | 'uncertain'; reason?: string; owner?: LockOwner }
export interface LiveLockOptions { probe?: ProcessProbe; pid?: number; purpose?: 'image' }
export interface ProcessProbeRuntime {
  platform?: NodeJS.Platform;
  signal?: (pid: number) => void;
  read?: (file: string) => Promise<string>;
  run?: (executable: string, args: string[], options: ExecFileOptions & { encoding: 'utf8' }) => Promise<{ stdout: string }>;
}
interface Snapshot { owner: LockOwner; raw: string; dev: number; ino: number }
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const execute = promisify(execFile);

/** PID alone, elapsed time, and EPERM never establish that a lock is abandoned. */
export async function probeProcessIdentity(pid: number, runtime: ProcessProbeRuntime = {}): Promise<ProcessIdentity> {
  const platform = runtime.platform ?? process.platform;
  const signal = runtime.signal ?? (id => { process.kill(id, 0); });
  const read = runtime.read ?? (file => fs.readFile(file, 'utf8'));
  const run = runtime.run ?? execute;
  if (!Number.isSafeInteger(pid) || pid < 1) return { state: 'unknown' };
  try { signal(pid); }
  catch (error) { return { state: (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unknown' }; }
  try {
    let identity: string;
    if (platform === 'linux') {
      const [stat, boot] = await Promise.all([read(`/proc/${pid}/stat`), read('/proc/sys/kernel/random/boot_id')]);
      // comm (field 2) can contain whitespace and parentheses. Field 22 starts the
      // process identity; boot_id prevents a reboot from reusing the same identity.
      const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
      if (!/^\d+$/.test(fields[19] ?? '') || !UUID.test(boot.trim())) return { state: 'unknown' };
      identity = `linux:${boot.trim()}:${fields[19]}`;
    } else if (platform === 'darwin') {
      const result = await run('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 3000, maxBuffer: 4096, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } });
      const start = result.stdout.trim();
      if (!/^[A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4}$/.test(start)) return { state: 'unknown' };
      // ps has second precision. Same-second PID reuse remains classified active,
      // conservatively, rather than claiming that an indistinguishable owner died.
      identity = `darwin:${start}`;
    } else if (platform === 'win32') {
      const executable = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const script = `$ErrorActionPreference='Stop'; [Console]::Out.Write((Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks.ToString())`;
      const result = await run(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 3000, maxBuffer: 4096, windowsHide: true });
      if (!/^\d{10,30}$/.test(result.stdout.trim())) return { state: 'unknown' };
      identity = `win32:${result.stdout.trim()}`;
    } else return { state: 'unknown' };
    return { state: 'alive', startIdentity: identity };
  } catch {
    // A failed identity query can be a permission/OS error. Only a second explicit
    // ESRCH proves absence; helper exit status or an empty output never does.
    try { signal(pid); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return { state: 'dead' }; }
    return { state: 'unknown' };
  }
}

export class LiveLocks {
  private readonly operation: string;
  private readonly recovery: string;
  private readonly probe: ProcessProbe;
  private readonly pid: number;
  private heldOperation: LockOwner | undefined;
  private readonly purpose: 'image' | undefined;
  constructor(private readonly directory: string, private readonly owner: string, options: LiveLockOptions = {}) {
    this.operation = path.join(directory, '.agm-operation.lock');
    this.recovery = path.join(directory, '.antigravity-account-manager-switch.lock');
    this.probe = options.probe ?? probeProcessIdentity; this.pid = options.pid ?? process.pid;
    this.purpose = options.purpose;
  }
  private async read(location: string): Promise<Snapshot | null> {
    try {
      const dir = await fs.lstat(location); if (!dir.isDirectory() || dir.isSymbolicLink()) throw 0;
      const file = path.join(location, 'owner.json'), stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2048) throw 0;
      const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let raw: string;
      try {
        const actual = await handle.stat();
        if (actual.dev !== stat.dev || actual.ino !== stat.ino || actual.size > 2048) throw 0;
        raw = await handle.readFile('utf8');
      } finally { await handle.close(); }
      const item = JSON.parse(raw) as LockOwner;
      if (![1, 2].includes(item.schema) || !/^[a-f0-9]{64}$/.test(item.owner) || !UUID.test(item.id) || !Number.isSafeInteger(item.pid) || item.pid < 1) throw 0;
      if (item.schema === 2 && (!UUID.test(item.nonce ?? '') || item.startIdentity !== null && (typeof item.startIdentity !== 'string' || item.startIdentity.length < 1 || item.startIdentity.length > 256))) throw 0;
      if (item.purpose !== undefined && item.purpose !== 'image') throw 0;
      return { owner: item, raw, dev: dir.dev, ino: dir.ino };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        try { await fs.lstat(location); } catch (missing) { if ((missing as NodeJS.ErrnoException).code === 'ENOENT') return null; }
      }
      if (['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw new LiveError('LOCK_RECORD_UNREADABLE');
      // Legacy error code remains for compatibility; the UI describes this as an
      // incomplete write and an automatic safe retry, never asks users to inspect it.
      throw new LiveError('LOCK_RECORD_REQUIRES_MANUAL_CHECK');
    }
  }
  private async classify(snapshot: Snapshot | null): Promise<LockInspection> {
    if (!snapshot) return { state: 'absent' };
    const owner = snapshot.owner;
    if (owner.owner !== this.owner) return { state: 'uncertain', reason: 'LOCK_BELONGS_TO_OTHER_PROFILE', owner };
    let status: ProcessIdentity;
    try { status = await this.probe(owner.pid); } catch { status = { state: 'unknown' }; }
    if (status.state === 'unknown') return { state: 'uncertain', reason: 'LOCK_PROCESS_STATUS_UNKNOWN', owner };
    // Explicit ESRCH proves the PID absent even for pre-upgrade records. A second
    // probe and exact record/inode check are mandatory inside the removal claim.
    if (status.state === 'dead') return { state: 'stale', owner };
    // An alive legacy PID could be reused; without start identity it is uncertain.
    if (owner.schema !== 2 || !owner.startIdentity) return { state: 'uncertain', reason: 'LOCK_PROCESS_IDENTITY_UNAVAILABLE', owner };
    if (status.startIdentity !== owner.startIdentity) return { state: 'stale', owner };
    return { state: 'active', reason: 'LOCK_PROCESS_STILL_ALIVE', owner };
  }
  private async inspect(location: string): Promise<LockInspection> {
    try { return await this.classify(await this.read(location)); }
    catch (error) { return { state: 'uncertain', reason: error instanceof LiveError ? error.code : 'LOCK_PROCESS_STATUS_UNKNOWN' }; }
  }
  async inspectOperation(): Promise<LockInspection> { return this.inspect(this.operation); }
  /** Recognize only this instance's currently held, fully identified operation. */
  ownsOperation(inspection: LockInspection): boolean {
    const owner = inspection.owner, held = this.heldOperation;
    return inspection.state === 'active' && !!owner && !!held && owner.schema === 2 && !!owner.startIdentity &&
      owner.schema === held.schema && owner.owner === held.owner && owner.id === held.id && owner.pid === held.pid &&
      owner.nonce === held.nonce && owner.startIdentity === held.startIdentity && owner.purpose === held.purpose;
  }
  async inspectRecovery(): Promise<LockInspection> { return this.inspect(this.recovery); }
  private async create(location: string, id: string): Promise<LockOwner> {
    if (!UUID.test(id) || !/^[a-f0-9]{64}$/.test(this.owner)) throw new LiveError('LOCK_OWNER_INVALID');
    // The first saved account can precede official backend initialization. Never
    // create recursive directories or write through a symlink parent.
    try { await fs.lstat(this.directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = await fs.lstat(path.dirname(this.directory));
      if (!parent.isDirectory() || parent.isSymbolicLink()) throw new LiveError('LOCK_PARENT_UNSAFE');
      await fs.mkdir(this.directory, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
    }
    const dir = await fs.lstat(this.directory); if (!dir.isDirectory() || dir.isSymbolicLink()) throw new LiveError('LOCK_PARENT_UNSAFE');
    let status: ProcessIdentity;
    try { status = await this.probe(this.pid); } catch { status = { state: 'unknown' }; }
    const owner: LockOwner = { schema: 2, owner: this.owner, id, pid: this.pid, nonce: randomUUID(), startIdentity: status.state === 'alive' ? status.startIdentity : null,
      ...(location === this.operation && this.purpose === 'image' ? { purpose: this.purpose } : {}) };
    try { await fs.mkdir(location, { mode: 0o700 }); }
    catch (error) { throw new LiveError((error as NodeJS.ErrnoException).code === 'EEXIST' ? 'LIVE_OPERATION_OR_RECOVERY_LOCKED' : 'LOCK_RECORD_UNWRITABLE'); }
    // A crash before the complete marker is durable is uncertain, never stale by age.
    const handle = await fs.open(path.join(location, 'owner.json'), 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(owner)); await handle.sync(); } finally { await handle.close(); }
    return owner;
  }
  private same(a: Snapshot, b: Snapshot): boolean { return a.dev === b.dev && a.ino === b.ino && a.raw === b.raw; }
  private async readClaim(location: string): Promise<Snapshot | null> {
    let handle;
    try {
      const stat = await fs.lstat(location);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2048) throw 0;
      handle = await fs.open(location, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const actual = await handle.stat();
      if (actual.dev !== stat.dev || actual.ino !== stat.ino || actual.size > 2048) throw 0;
      const raw = await handle.readFile('utf8'), owner = JSON.parse(raw) as LockOwner;
      if (owner.schema !== 2 || !/^[a-f0-9]{64}$/.test(owner.owner) || !UUID.test(owner.id) || !UUID.test(owner.nonce ?? '') || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || owner.startIdentity !== null && (typeof owner.startIdentity !== 'string' || !owner.startIdentity || owner.startIdentity.length > 256)) throw 0;
      return { owner, raw, dev: stat.dev, ino: stat.ino };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new LiveError('LOCK_CLEANUP_STATUS_UNKNOWN');
    } finally { await handle?.close(); }
  }
  private async releaseClaim(location: string, expected: Snapshot): Promise<void> {
    const actual = await this.readClaim(location);
    if (!actual || !this.same(actual, expected)) throw new LiveError('LOCK_OWNERSHIP_CHANGED');
    // A live claimant releases only its own nonce. Other removers can act only on
    // verified dead claimants, so they cannot race this normal release.
    await fs.unlink(location);
  }
  private async recoverClaim(location: string, expected: Snapshot, depth: number): Promise<void> {
    const state = await this.classify(expected);
    if (state.state !== 'stale') throw new LiveError(state.state === 'active' ? 'LOCK_CLEANUP_IN_PROGRESS' : 'LOCK_CLEANUP_STATUS_UNKNOWN');
    const guardLocation = `${location}.next`, guard = await this.acquireClaim(guardLocation, depth + 1);
    try {
      const actual = await this.readClaim(location);
      if (!actual || !this.same(actual, expected)) throw new LiveError('LOCK_OWNERSHIP_CHANGED');
      const confirmedState = await this.classify(actual);
      if (confirmedState.state !== 'stale') throw new LiveError(confirmedState.state === 'active' ? 'LOCK_CLEANUP_IN_PROGRESS' : 'LOCK_CLEANUP_STATUS_UNKNOWN');
      const confirmed = await this.readClaim(location);
      if (!confirmed || !this.same(confirmed, expected)) throw new LiveError('LOCK_OWNERSHIP_CHANGED');
      await fs.unlink(location);
    } finally { await this.releaseClaim(guardLocation, guard); }
  }
  private async acquireClaim(location: string, depth = 0): Promise<Snapshot> {
    // A crash of a reaper is recoverable by another reaper, without pretending a
    // missing/old timestamp is proof. Bound pathological repeated crash chains.
    if (depth > 8) throw new LiveError('LOCK_CLEANUP_STATUS_UNKNOWN');
    const nextLocation = `${location}.next`, next = await this.readClaim(nextLocation);
    if (next) await this.recoverClaim(nextLocation, next, depth + 1);
    let status: ProcessIdentity;
    try { status = await this.probe(this.pid); } catch { status = { state: 'unknown' }; }
    const owner: LockOwner = { schema: 2, owner: this.owner, id: randomUUID(), pid: this.pid, nonce: randomUUID(), startIdentity: status.state === 'alive' ? status.startIdentity : null };
    const staging = path.join(this.directory, `.agm-claim-${owner.nonce}`);
    const handle = await fs.open(staging, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(owner)); await handle.sync(); } finally { await handle.close(); }
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          // Atomic exclusive publication: even a killed reaper cannot leave a
          // half-written active .release claim. Staging contains metadata only.
          await fs.link(staging, location);
          const published = await this.readClaim(location);
          if (!published || published.raw !== JSON.stringify(owner)) throw new LiveError('LOCK_OWNERSHIP_CHANGED');
          // A stale-claim reaper may still own its child guard after unlinking
          // the previous parent claim. Do not enter through that brief gap.
          if (await this.readClaim(nextLocation)) {
            await this.releaseClaim(location, published);
            throw new LiveError('LOCK_CLEANUP_IN_PROGRESS');
          }
          return published;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error instanceof LiveError ? error : new LiveError('LOCK_CLEANUP_STATUS_UNKNOWN');
          const existing = await this.readClaim(location);
          if (existing) await this.recoverClaim(location, existing, depth);
        }
      }
      throw new LiveError('LOCK_CLEANUP_IN_PROGRESS');
    } finally { await fs.unlink(staging); }
  }
  private async remove(location: string, expected: Snapshot, staleOnly = false): Promise<void> {
    // Every remover takes an exclusive claim INSIDE the directory. A competing
    // reaper must not unlink another window's freshly acquired owner.json after a
    // check/delete race. Retiring the entire claimed directory closes that gap.
    const claimLocation = path.join(location, '.release'), claim = await this.acquireClaim(claimLocation);
    let retired = false;
    try {
      const actual = await this.read(location);
      if (!actual || !this.same(actual, expected)) throw new LiveError('LOCK_OWNERSHIP_CHANGED');
      if (staleOnly) {
        const state = await this.classify(actual);
        if (state.state !== 'stale') throw new LiveError(state.reason ?? 'LOCK_OWNERSHIP_CHANGED');
      }
      const entries = await fs.readdir(location);
      if (entries.length !== 2 || !entries.includes('owner.json') || !entries.includes('.release')) throw new LiveError('LOCK_CLEANUP_IN_PROGRESS');
      const confirmed = await this.read(location), confirmedClaim = await this.readClaim(claimLocation);
      if (!confirmed || !this.same(confirmed, expected) || !confirmedClaim || !this.same(confirmedClaim, claim)) throw new LiveError('LOCK_OWNERSHIP_CHANGED');
      const destination = `${location}.retired.${claim.owner.nonce}`;
      await fs.rename(location, destination); retired = true;
      // Nothing in a retired directory is a credential or encrypted journal. A
      // crash here leaves inert metadata, never a lock at the active location.
      await fs.unlink(path.join(destination, 'owner.json'));
      await fs.unlink(path.join(destination, '.release')); await fs.rmdir(destination);
    } finally {
      if (!retired) await this.releaseClaim(claimLocation, claim);
    }
  }
  private async removeOwned(location: string, expected: LockOwner): Promise<void> {
    const actual = await this.read(location);
    if (!actual || JSON.stringify(actual.owner) !== JSON.stringify(expected)) throw new LiveError('LOCK_OWNERSHIP_CHANGED');
    await this.remove(location, actual);
  }
  private async recover(location: string): Promise<boolean> {
    const snapshot = await this.read(location); if (!snapshot) return false;
    const status = await this.classify(snapshot);
    if (status.state !== 'stale') throw new LiveError(status.reason ?? 'LOCK_PROCESS_STATUS_UNKNOWN');
    await this.remove(location, snapshot, true); return true;
  }
  async recoverAbandonedOperation(): Promise<boolean> { return this.recover(this.operation); }
  async withOperation<T>(fn: () => Promise<T>): Promise<T> {
    let lock: LockOwner;
    try { lock = await this.create(this.operation, randomUUID()); }
    catch (error) {
      if (!(error instanceof LiveError) || error.code !== 'LIVE_OPERATION_OR_RECOVERY_LOCKED') throw error;
      const state = await this.inspectOperation();
      if (state.state === 'active' || state.reason === 'LOCK_BELONGS_TO_OTHER_PROFILE') throw error;
      if (state.state === 'uncertain') throw new LiveError(state.reason ?? 'LOCK_PROCESS_STATUS_UNKNOWN');
      if (state.state === 'stale') await this.recoverAbandonedOperation();
      // Another window may win this single retry; never clear its live owner.
      lock = await this.create(this.operation, randomUUID());
    }
    this.heldOperation = lock;
    try { return await fn(); }
    finally { this.heldOperation = undefined; await this.removeOwned(this.operation, lock); }
  }
  async beginRecovery(id: string): Promise<void> { await this.create(this.recovery, id); }
  async assertRecovery(id: string): Promise<void> {
    const lock = (await this.read(this.recovery))?.owner;
    if (!lock || lock.owner !== this.owner || lock.id !== id) throw new LiveError('RECOVERY_LOCK_OWNER_MISMATCH');
  }
  async clearRecovery(id: string): Promise<void> {
    const snapshot = await this.read(this.recovery);
    if (!snapshot || snapshot.owner.owner !== this.owner || snapshot.owner.id !== id) throw new LiveError('RECOVERY_LOCK_OWNER_MISMATCH');
    await this.remove(this.recovery, snapshot);
  }
  async hasRecovery(): Promise<boolean> { return (await this.read(this.recovery)) !== null; }
  /** Read the host-bound encrypted journal first; call only inside withOperation.
   * A matching journal-backed marker is retained. This class NEVER deletes a journal.
   */
  async reconcileRecovery(journalId: string | null): Promise<'absent' | 'preserved' | 'created' | 'cleared'> {
    if (!this.heldOperation) throw new LiveError('LOCK_OPERATION_REQUIRED');
    const snapshot = await this.read(this.recovery);
    if (journalId !== null) {
      if (!snapshot) { await this.beginRecovery(journalId); return 'created'; }
      if (snapshot.owner.owner !== this.owner || snapshot.owner.id !== journalId) throw new LiveError('RECOVERY_LOCK_OWNER_MISMATCH');
      return 'preserved';
    }
    if (!snapshot) return 'absent';
    await this.recover(this.recovery); return 'cleared';
  }
  // Compatibility entry points are now safe automatic checks, not a manual override.
  async clearAbandonedOperation(): Promise<void> { await this.recoverAbandonedOperation(); }
  async clearAbandonedRecovery(): Promise<void> { await this.recover(this.recovery); }
}
