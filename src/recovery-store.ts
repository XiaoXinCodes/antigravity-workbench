import { createHash } from 'node:crypto';
import { LiveError } from './live-storage';
import type { SecretVault } from './live-switch';

export interface RecoveryStoreClock {
  now(): number;
  set(callback: () => void, ms: number): unknown;
  clear(timer: unknown): void;
}
const realClock: RecoveryStoreClock = {
  now: () => performance.now(), set: (callback, ms) => setTimeout(callback, ms),
  clear: timer => clearTimeout(timer as NodeJS.Timeout),
};
export interface RecoveryStoreOptions { clock?: RecoveryStoreClock; timeoutMs?: number }
interface Write { before: string | undefined; after: string | undefined }
interface State {
  tail: Promise<void>; known: boolean; confirmed?: string | undefined; pending?: Write | undefined;
  // Hashes stay in memory only. They authorize waiting, never return cached secrets.
  retired: Set<string>;
}
const states = new WeakMap<SecretVault, Map<string, State>>();
const fingerprint = (raw: string | undefined): string => raw === undefined ? 'absent' : createHash('sha256').update(raw).digest('hex');

/** Serialize this host's instances, compare their exact read snapshots, and confirm
 * each single write using fresh API reads. The OS operation/recovery lock remains
 * mandatory across processes: SecretStorage does not offer an atomic CAS or fsync.
 */
export class RecoveryStore {
  private readonly time: RecoveryStoreClock;
  private readonly timeout: number;
  constructor(private readonly vault: SecretVault, options: RecoveryStoreOptions = {}) {
    this.time = options.clock ?? realClock;
    this.timeout = options.timeoutMs ?? 2500;
  }
  private state(key: string): State {
    let keys = states.get(this.vault);
    if (!keys) { keys = new Map(); states.set(this.vault, keys); }
    let state = keys.get(key);
    if (!state) { state = { tail: Promise.resolve(), known: false, retired: new Set() }; keys.set(key, state); }
    return state;
  }
  private async boundedRead(key: string, deadline: number): Promise<string | undefined> {
    if (this.time.now() >= deadline) throw new LiveError('RECOVERY_SAVE_NOT_VERIFIED');
    // Only a read is raced. Store/delete are always awaited, never abandoned.
    let timer: unknown;
    try {
      return await Promise.race([
        Promise.resolve().then(() => this.vault.get(key)),
        new Promise<never>((_, reject) => { timer = this.time.set(() => reject(new LiveError('RECOVERY_SAVE_NOT_VERIFIED')), deadline - this.time.now()); }),
      ]);
    } finally { this.time.clear(timer); }
  }
  private async confirm(key: string, write: Write, state: State, timeoutCode = 'RECOVERY_SAVE_NOT_VERIFIED'): Promise<void> {
    const deadline = this.time.now() + this.timeout;
    let wake: (() => void) | undefined, changes = 0, exact = 0;
    const subscription = this.vault.onDidChange?.(event => { if (event.key === key) { changes++; wake?.(); } });
    try {
      for (;;) {
        const seen = changes;
        const raw = await this.boundedRead(key, deadline);
        if (this.time.now() >= deadline) throw new LiveError(timeoutCode);
        if (raw === write.after) {
          // Two fresh reads; callbacks cannot certify bytes or advance revisions.
          if (++exact === 2) return;
          continue;
        }
        exact = 0;
        if (raw !== write.before && !state.retired.has(fingerprint(raw))) throw new LiveError('RECOVERY_CHANGED');
        const left = deadline - this.time.now();
        if (left <= 0) throw new LiveError(timeoutCode);
        // Retry only after a classified stale/missing predecessor, with event wakeup
        // and a bounded poll fallback for missed/coalesced remote change events.
        await new Promise<void>(resolve => {
          let active = true;
          const done = (): void => { if (!active) return; active = false; this.time.clear(timer); wake = undefined; resolve(); };
          wake = done; const timer = this.time.set(done, Math.min(100, left));
          if (changes !== seen) done();
        });
      }
    } catch (error) {
      if (error instanceof LiveError && error.code === 'RECOVERY_SAVE_NOT_VERIFIED' && timeoutCode !== error.code) throw new LiveError(timeoutCode);
      throw error;
    } finally { wake = undefined; subscription?.dispose(); }
  }
  private acknowledge(state: State, write: Write): void {
    state.retired.add(fingerprint(write.before));
    // Keep no credential bodies beyond the current/pending snapshots.
    if (state.retired.size > 128) state.retired.delete(state.retired.values().next().value!);
    state.confirmed = write.after; state.known = true; state.pending = undefined;
  }
  async read(key: string): Promise<string | undefined> {
    const state = this.state(key), raw = await this.boundedRead(key, this.time.now() + this.timeout);
    if (!state.pending && state.known && raw !== state.confirmed && state.retired.has(fingerprint(raw))) {
      const expected = state.confirmed;
      await this.confirm(key, { before: raw, after: expected }, state);
      return expected;
    }
    // Unknown content is returned for normal host/schema validation. It is never
    // overwritten merely because an in-memory revision was higher.
    return raw;
  }
  private async exclusive<T>(key: string, run: (state: State) => Promise<T>): Promise<T> {
    const state = this.state(key), prior = state.tail;
    let release!: () => void;
    state.tail = new Promise<void>(resolve => { release = resolve; });
    await prior;
    try { return await run(state); } finally { release(); }
  }
  async write(key: string, before: string | undefined, after: string): Promise<void> {
    await this.change(key, before, after);
  }
  async remove(key: string, before: string): Promise<void> { await this.change(key, before, undefined); }
  private async change(key: string, before: string | undefined, after: string | undefined): Promise<void> {
    await this.exclusive(key, async state => {
      // Never issue a second write over an unresolved first write.
      if (state.pending) { const pending = state.pending; await this.confirm(key, pending, state); this.acknowledge(state, pending); }
      if (await this.read(key) !== before) throw new LiveError('RECOVERY_CHANGED');
      const write = { before, after }; state.pending = write;
      // Do not catch and retry a mutation: a rejected promise may already have committed.
      if (after === undefined) await this.vault.delete(key); else await this.vault.store(key, after);
      await this.confirm(key, write, state, after === undefined ? 'RECOVERY_DELETE_FAILED' : 'RECOVERY_SAVE_NOT_VERIFIED');
      this.acknowledge(state, write);
    });
  }
  /** Read-only evidence for a stopped install whose bounded confirmation expired.
   * Only the exact pre-write or intended bytes from this instance are admissible.
   * No metadata/credential write and no success/cleanup is authorized by this.
   */
  async pendingInstallMatches(key: string, before: string, after: string): Promise<boolean> {
    const state = this.state(key);
    if (state.pending?.before !== before || state.pending.after !== after) return false;
    const raw = await this.boundedRead(key, this.time.now() + this.timeout);
    if (raw !== before && raw !== after) throw new LiveError('RECOVERY_CHANGED');
    return true;
  }
}
