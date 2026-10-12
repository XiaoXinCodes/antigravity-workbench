import { LockConflictError } from './live-lock';
import { catalogError } from './model-catalog-error';

export type DirectoryPhase = 'preparing' | 'loading';
/** Wait only for startup or proven ordinary lock contention. Never acquire,
 * remove, recover or weaken a lock here; the reader retains its own checks. */
export async function readWhenDirectoryReady<T>(read: () => Promise<T>, preparing: () => boolean, signal: AbortSignal,
  phase: (value: DirectoryPhase) => void, options: { timeoutMs?: number; pollMs?: number; now?: () => number } = {}): Promise<T> {
  const now = options.now ?? Date.now, deadline = now() + (options.timeoutMs ?? 30_000);
  let lastLock: unknown;
  const cancelled = () => { if (signal.aborted) throw Error('IMAGE_CANCELLED'); };
  const wait = async () => {
    cancelled();
    if (now() >= deadline) throw lastLock ?? catalogError('WAKE_DIRECTORY_INITIALIZING', 'binding', 'timeout');
    phase('preparing');
    await new Promise<void>((resolve, reject) => {
      const finish = () => { signal.removeEventListener('abort', abort); resolve(); };
      const timer = setTimeout(finish, Math.min(options.pollMs ?? 150, Math.max(1, deadline - now())));
      const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(Error('IMAGE_CANCELLED')); };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  };
  for (;;) {
    cancelled();
    if (preparing()) { await wait(); continue; }
    phase('loading');
    try { return await read(); }
    catch (error) {
      // A recovery lock, uncertain owner or another profile needs explicit
      // resolution. HTTP, binding and parse failures are never auto-retried.
      if (!(typeof LockConflictError === 'function' && error instanceof LockConflictError &&
        error.code === 'LIVE_OPERATION_OR_RECOVERY_LOCKED' && error.activity.state === 'active' &&
        ['account', 'image'].includes(error.activity.kind) && ['this-process', 'other-process'].includes(error.activity.scope))) throw error;
      lastLock = error; await wait();
    }
  }
}
