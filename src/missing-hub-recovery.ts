import { generation, hasOfficialHubApi, noteObservedHubRestart } from './live-hub';
import { LiveError } from './live-storage';
import { sameOfficialProcess, type OfficialProcessIdentity } from './official-process';
import type { ProcessConflictState } from './official-process-recovery';
import { OFFICIAL_FOCUS, OFFICIAL_RECONNECT } from './official-restart';

export type HubRecoveryResult = 'signed-in' | 'signed-out';
export interface MissingHubRuntime {
  api(): unknown; assertCurrent(): void;
  scan(): Promise<ProcessConflictState>;
  identity(): OfficialProcessIdentity | undefined;
  /** Host-only full peer proof; never exposed to the Webview. */
  peerIdentity?(): string;
  expectedPeerIdentity?: string | undefined;
  expectedCurrent?: OfficialProcessIdentity;
  expectedGeneration?: string;
  stop?(): Promise<void>;
  execute(command: string): PromiseLike<unknown>;
  proof(): Promise<{ generation: string; signedOut?: boolean }>;
  wait?(ms: number): Promise<void>;
}
export function canRecoverWithPeers(state: ProcessConflictState): boolean {
  return !state.limitation && state.currentCount !== undefined && state.totalCount !== undefined
    && state.totalCount === state.currentCount + state.processes.length
    && state.processes.every(row => row.owner === 'other' && row.scope === 'other-window'
      && row.parentState === 'alive' && row.credentialScopeVerified === true);
}
/** Component-only recovery; never writes credentials or continues a switch.
 * Official reconnect returns before setup, which may wait for user retry. After
 * dispatch, retain the shared lock until a stable current Hub answers fresh RPC.
 * UI cancellation only ends observation; a later check joins the same operation.
 */
export class MissingHubRecovery {
  private active: Promise<HubRecoveryResult> | undefined;
  private waiter: AbortController | undefined;
  get pending(): boolean { return !!this.active; }
  cancel(): void { this.waiter?.abort(); }
  async observe(timeoutMs = 45_000): Promise<HubRecoveryResult> {
    if (!this.active) throw new LiveError('HUB_RECOVERY_PENDING');
    const controller = new AbortController();
    // Coalesce callers onto the same actual operation, never a new dispatch.
    this.waiter?.abort(); this.waiter = controller;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([this.active, new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(new LiveError('HUB_RECOVERY_CANCELLED')), { once: true });
        timer = setTimeout(() => { reject(new LiveError('HUB_RECOVERY_TIMEOUT')); controller.abort(); }, timeoutMs);
      })]);
    } finally { clearTimeout(timer); if (this.waiter === controller) this.waiter = undefined; }
  }
  async run(runtime: MissingHubRuntime, hold: (fn: () => Promise<void>) => Promise<void>, timeoutMs = 45_000): Promise<HubRecoveryResult> {
    if (this.active) throw new LiveError('HUB_RECOVERY_PENDING');
    const wait = runtime.wait ?? (ms => new Promise<void>(resolve => { const timer = setTimeout(resolve, ms); timer.unref(); }));
    let outcome: HubRecoveryResult = 'signed-in';
    const actual = Promise.resolve().then(() => hold(async () => {
      const dispatchWaiter = this.waiter;
      const check = (): void => { runtime.assertCurrent(); if (dispatchWaiter?.signal.aborted) throw new LiveError('HUB_RECOVERY_CANCELLED'); };
      check();
      const epoch = (): string => { const api = runtime.api(); return hasOfficialHubApi(api) ? generation(api) : 'stopped'; };
      const initialGeneration = epoch();
      if (runtime.expectedGeneration !== undefined && initialGeneration !== runtime.expectedGeneration) throw new LiveError('HUB_CHANGED_DURING_OPERATION');
      const peerKey = (): string => runtime.peerIdentity?.() ?? '';
      const initial = await runtime.scan(); check();
      if (!canRecoverWithPeers(initial) || initial.processes.length && !runtime.peerIdentity) throw new LiveError('HUB_RECOVERY_PROCESS_BLOCKED');
      const peers = peerKey();
      if (runtime.expectedPeerIdentity !== undefined && peers !== runtime.expectedPeerIdentity) throw new LiveError('HUB_CHANGED_DURING_OPERATION');
      const original = runtime.identity();
      if (runtime.stop) {
        if (initial.currentCount !== 1 || !initial.current?.credentialScopeVerified || !original || !runtime.expectedCurrent || !sameOfficialProcess(original, runtime.expectedCurrent)) throw new LiveError('HUB_CHANGED_DURING_OPERATION');
      } else if (initial.currentCount !== 0 || initial.current) throw new LiveError('HUB_RECOVERY_PROCESS_BLOCKED');
      await wait(100); const stable = await runtime.scan(); check();
      if (epoch() !== initialGeneration || !canRecoverWithPeers(stable) || peerKey() !== peers || stable.currentCount !== initial.currentCount || original && (!runtime.identity() || !sameOfficialProcess(original, runtime.identity()!))) throw new LiveError('HUB_CHANGED_DURING_OPERATION');
      // From the first stop/start dispatch onward, errors/cancel cannot prove
      // that asynchronous official setup has ended. Keep the actual fence.
      let changed = false, stopFailed = false, alreadyRestarted = false;
      if (runtime.stop) {
        try { await runtime.stop(); } catch { stopFailed = true; changed = true; }
        // Await actual stop settlement AND two scans without this host's Hub.
        for (let stableCount = 0; !stopFailed && stableCount < 2;) {
          try {
            runtime.assertCurrent(); const state = await runtime.scan();
            const replacement = runtime.identity();
            if (canRecoverWithPeers(state) && state.currentCount === 1 && state.current?.credentialScopeVerified && replacement && original && !sameOfficialProcess(original, replacement)) {
              if (peerKey() !== peers) changed = true;
              alreadyRestarted = true; break;
            }
            if (canRecoverWithPeers(state) && state.currentCount === 0 && !hasOfficialHubApi(runtime.api())) { if (peerKey() !== peers) changed = true; ++stableCount; }
            else stableCount = 0;
          } catch { stableCount = 0; }
          if (stableCount === 2) break;
          await wait(200);
        }
      }
      // Once dispatched, cancellation ends UI observation, not the authorized
      // stop/start sequence. Finish it without a second command sequence.
      if (!runtime.stop) { check(); if (epoch() !== initialGeneration) throw new LiveError('HUB_CHANGED_DURING_OPERATION'); }
      if (!stopFailed && !alreadyRestarted) {
        try {
          runtime.assertCurrent(); await runtime.execute(OFFICIAL_RECONNECT);
          runtime.assertCurrent(); await runtime.execute(OFFICIAL_FOCUS);
        } catch { /* Command failure also leaves asynchronous setup uncertain. */ }
      }
      for (;;) {
        try {
          runtime.assertCurrent(); const state = await runtime.scan(); runtime.assertCurrent();
          if (peerKey() !== peers) changed = true;
          const api = runtime.api(), process = runtime.identity();
          if (canRecoverWithPeers(state) && state.currentCount === 1 && state.current?.credentialScopeVerified && process && hasOfficialHubApi(api)) {
            const capability = { port: api.port, csrfToken: api.csrfToken }, expected = generation(capability);
            const proof = await runtime.proof(); runtime.assertCurrent();
            const stableState = await runtime.scan(); runtime.assertCurrent();
            const identity = runtime.identity(), currentApi = runtime.api();
            if (peerKey() !== peers) changed = true;
            if (canRecoverWithPeers(stableState) && stableState.currentCount === 1 && stableState.current?.credentialScopeVerified && identity && sameOfficialProcess(process, identity)
              && hasOfficialHubApi(currentApi) && generation(currentApi) === expected && proof.generation === expected) {
              if (changed) throw new PeerChanged();
              noteObservedHubRestart(capability); outcome = proof.signedOut ? 'signed-out' : 'signed-in'; return;
            }
          }
        } catch (error) {
          // A verified current completes launch even if peers changed externally;
          // release the fence but do not report recovery success in that case.
          if (error instanceof PeerChanged) throw new LiveError('HUB_CHANGED_DURING_OPERATION');
        }
        await wait(1000);
      }
    })).then(() => outcome);
    this.active = actual;
    const clear = (): void => { if (this.active === actual) this.active = undefined; };
    void actual.then(clear, clear);
    return this.observe(timeoutMs);
  }
}
class PeerChanged extends Error {}
