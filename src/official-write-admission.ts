import { LiveError } from './live-storage';
import type { OfficialWriteContract } from './official-contract';

function drainTimer(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cancel = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); reject(new LiveError('CANCELLED')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, ms);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}
/** Both reviewed starts publish port and clear startingPromise without another
 * await. A genuine ready process therefore cannot be that start's pre-spawn work.
 * 1.9 can still await an older stop. Every such stop synchronously registers a
 * 5000ms completion timer. Registering a later 5000ms timer in the SAME host drains
 * the same-delay FIFO list and its promise continuations, provided the exact ready
 * process survives. A continuation's start then reuses that ready instance.
 * A new automatic stop clears its refs, so the same birth cannot pass afterward.
 * A different delay is unsafe: an earlier unrelated timer can put that other
 * delay list first, and overdue list batching may overtake older 5000ms timers.
 * Never replace this with wall-clock polling or an empty-process observation.
 * Scope excludes user/other-extension manual reconnect/config/retry during the
 * transaction; the product confirmation states that restriction. */
export async function admitReadyOfficialWrite(
  contract: OfficialWriteContract,
  readyIdentity: () => Promise<string>,
  wait: (ms: number, signal?: AbortSignal) => Promise<void> = drainTimer,
  signal?: AbortSignal,
): Promise<string> {
  if (contract !== '1.8.0' && contract !== '1.9.0') throw new LiveError('OFFICIAL_CREDENTIAL_WRITE_BARRIER_UNAVAILABLE');
  if (signal?.aborted) throw new LiveError('CANCELLED');
  const before = await readyIdentity();
  if (contract === '1.9.0') {
    if (![20, 22, 24].includes(Number(process.versions.node.split('.')[0]))) throw new LiveError('OFFICIAL_CREDENTIAL_WRITE_BARRIER_UNAVAILABLE');
    await wait(5000, signal);
  }
  if (signal?.aborted) throw new LiveError('CANCELLED');
  const after = await readyIdentity();
  if (signal?.aborted) throw new LiveError('CANCELLED');
  if (!before || before !== after) throw new LiveError('HUB_CHANGED_DURING_OPERATION');
  return after;
}
