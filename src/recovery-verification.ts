import { LiveError } from './live-storage';

export interface VerificationClock {
  now(): number;
  set(callback: () => void, delay: number): unknown;
  clear(timer: unknown): void;
}
const clock: VerificationClock = {
  now: () => Date.now(),
  set: (callback, delay) => { const timer = setTimeout(callback, delay); timer.unref?.(); return timer; },
  clear: timer => clearTimeout(timer as NodeJS.Timeout),
};
export interface VerificationLease {
  readonly id: string; readonly phase: 'installed' | 'restored'; readonly deadline: number;
  readonly abort: AbortController;
}
/** A bounded identity/retry window for one durable transaction and target phase.
 * Focus refreshes reuse even an expired lease. Only a new transaction/phase or
 * an explicit user verification action starts another window.
 */
export class RecoveryVerification {
  private current: VerificationLease | undefined;
  private expiry: unknown;
  private retry: unknown;
  private disposed = false;
  constructor(private readonly time: VerificationClock = clock, private readonly expired?: (lease: VerificationLease) => void) {}
  bind(id: string, phase: VerificationLease['phase'], renew = false): VerificationLease {
    if (this.disposed) throw new LiveError('RECOVERY_VERIFICATION_STALE');
    if (!renew && this.current?.id === id && this.current.phase === phase) return this.current;
    this.clear();
    const lease: VerificationLease = { id, phase, deadline: this.time.now() + 90_000, abort: new AbortController() };
    this.current = lease;
    this.expiry = this.time.set(() => {
      if (this.current !== lease) return;
      this.time.clear(this.retry); this.retry = undefined;
      lease.abort.abort(); this.expired?.(lease);
    }, 90_000);
    return lease;
  }
  matches(lease: VerificationLease): boolean { return !this.disposed && this.current === lease; }
  assertScope(lease: VerificationLease): void {
    if (!this.matches(lease)) throw new LiveError('RECOVERY_VERIFICATION_STALE');
  }
  assertReady(lease: VerificationLease): void {
    this.assertScope(lease);
    if (this.time.now() >= lease.deadline || lease.abort.signal.aborted) throw new LiveError('RECOVERY_VERIFICATION_TIMEOUT');
  }
  async proof<T>(lease: VerificationLease, read: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.assertReady(lease);
    return new Promise<T>((resolve, reject) => {
      const signal = lease.abort.signal;
      const aborted = () => { signal.removeEventListener('abort', aborted); reject(new LiveError(this.matches(lease) ? 'RECOVERY_VERIFICATION_TIMEOUT' : 'RECOVERY_VERIFICATION_STALE')); };
      signal.addEventListener('abort', aborted, { once: true });
      // Only the read-only proof is raced. Credential writes/cleanup are always
      // awaited under the account lock, never abandoned in a timed-out promise.
      Promise.resolve().then(() => { this.assertReady(lease); return read(signal); }).then(value => {
        signal.removeEventListener('abort', aborted);
        try { this.assertReady(lease); resolve(value); } catch (error) { reject(error); }
      }, error => { signal.removeEventListener('abort', aborted); reject(error); });
      if (signal.aborted) aborted();
    });
  }
  schedule(lease: VerificationLease, retry: () => void): boolean {
    try { this.assertReady(lease); } catch { return false; }
    if (this.retry !== undefined) return true;
    this.retry = this.time.set(() => {
      // An already queued callback may run after clearTimeout. It must not clear
      // a newer transaction's timer or enter its reconciliation path.
      if (!this.matches(lease)) return;
      this.retry = undefined;
      try { this.assertReady(lease); } catch { return; }
      retry();
    }, Math.min(1500, lease.deadline - this.time.now()));
    return true;
  }
  clear(): void {
    const previous = this.current;
    this.current = undefined;
    this.time.clear(this.expiry); this.time.clear(this.retry);
    this.expiry = undefined; this.retry = undefined;
    previous?.abort.abort();
  }
  dispose(): void { this.disposed = true; this.clear(); }
}
