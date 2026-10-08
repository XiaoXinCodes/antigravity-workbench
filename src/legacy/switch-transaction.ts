import { randomUUID } from 'node:crypto';
import { supportsSyntheticRuntime, type BackendAcknowledgment, type BackendLifecycle, type BackendObservation, type OperationContext, type RuntimeFingerprint, type StorageSnapshot, type SwitchCoordinator, type SwitchLease, type SwitchPhase, type VersionedCredentialStorage } from './switch-contract';
import { isSyntheticSubject } from './switch-storage';

export type SwitchCode = 'SYNTHETIC_ONLY' | 'UNSUPPORTED_RUNTIME' | 'INVALID_REQUEST' | 'BUSY_OR_RECOVERY_REQUIRED' | 'PREFLIGHT_FAILED' | 'CANCELLED' | 'STORAGE_VERIFICATION_FAILED' | 'IDENTITY_VERIFICATION_FAILED' | 'OPERATION_FAILED' | 'UNCERTAIN_OPERATION' | 'ROLLBACK_FAILED' | 'FINALIZATION_FAILED';
export interface SwitchResult {
  status: 'synthetic-committed' | 'rolled-back' | 'blocked' | 'unknown';
  code: SwitchCode;
  /** Synthetic subject only. Unknown states never retain an active-account claim. */
  activeSubject: string | null;
  phases: SwitchPhase[];
  recoveryRequired: boolean;
}
class SwitchFailure extends Error {
  constructor(readonly code: SwitchCode, readonly uncertain = false) { super(code); }
}
export interface SyntheticSwitchDependencies {
  storage: VersionedCredentialStorage;
  backend: BackendLifecycle;
  coordinator: SwitchCoordinator;
  operationTimeoutMs?: number;
  now?: () => number;
}
/** Transaction algorithm only. No live backend/storage adapter is shipped or activated. */
export class SyntheticSwitchController {
  private running = false;
  private poisoned = false;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  constructor(private readonly dependencies: SyntheticSwitchDependencies) {
    this.timeoutMs = dependencies.operationTimeoutMs ?? 10_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60_000) throw new Error('INVALID_TIMEOUT');
    this.now = dependencies.now ?? Date.now;
  }
  async switchTo(target: string, runtime: RuntimeFingerprint, signal?: AbortSignal): Promise<SwitchResult> {
    const phases: SwitchPhase[] = [];
    const result = (status: SwitchResult['status'], code: SwitchCode, activeSubject: string | null = null): SwitchResult => ({ status, code, activeSubject, phases: [...phases], recoveryRequired: status === 'unknown' });
    const { storage, backend, coordinator } = this.dependencies;
    if (!supportsSyntheticRuntime(runtime) || !supportsSyntheticRuntime(storage.runtime) || storage.mode !== 'synthetic' || backend.mode !== 'synthetic') return result('blocked', 'UNSUPPORTED_RUNTIME');
    if (!isSyntheticSubject(target)) return result('blocked', 'INVALID_REQUEST');
    if (signal?.aborted) return result('blocked', 'CANCELLED');
    if (this.running || this.poisoned) return result('blocked', 'BUSY_OR_RECOVERY_REQUIRED');
    this.running = true;
    const transactionId = randomUUID();
    let lease: SwitchLease | undefined;
    let baseline: StorageSnapshot | undefined;
    let before: BackendObservation | undefined;
    let mayHaveChanged = false;
    let finalizing = false;
    // Exceptions/messages from providers never become diagnostics: they may contain secrets.
    const call = async <T>(operation: (context: OperationContext) => Promise<T>, cleanup = false): Promise<T> => {
      if (!cleanup && signal?.aborted) throw new SwitchFailure('CANCELLED');
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      try {
        return await new Promise<T>((resolve, reject) => {
          const uncertain = () => { controller.abort(); reject(new SwitchFailure('UNCERTAIN_OPERATION', true)); };
          timer = setTimeout(uncertain, this.timeoutMs);
          if (!cleanup && signal) { onAbort = uncertain; signal.addEventListener('abort', onAbort, { once: true }); }
          // Abort/timeouts may not stop an adapter's pending write. Never race rollback against it.
          Promise.resolve().then(() => operation({ signal: controller.signal, transactionId })).then(resolve, reject);
        });
      } finally {
        if (timer) clearTimeout(timer);
        if (onAbort) signal?.removeEventListener('abort', onAbort);
      }
    };
    const phase = async (next: SwitchPhase, cleanup = false) => {
      await call(async () => { await lease!.record(next); }, cleanup);
      phases.push(next);
    };
    const unknown = async (code: SwitchCode): Promise<SwitchResult> => {
      this.poisoned = true;
      phases.push('unknown');
      // Keep the lock even if recording fails. An in-flight timed-out write can still settle later.
      if (lease) await call(async () => { await lease!.record('unknown'); }, true).catch(() => undefined);
      return result('unknown', code);
    };
    const checkAcknowledgment = (ack: BackendAcknowledgment, subject: string, challenge: string, since: number, oldGeneration: string): void => {
      const validTime = (value: number) => Number.isFinite(value) && value >= since && value <= this.now();
      if (ack.subject !== subject || !isSyntheticSubject(ack.subject) || ack.challenge !== challenge ||
          typeof ack.generation !== 'string' || !ack.generation || ack.generation === oldGeneration || !validTime(ack.observedAt) ||
          ack.quota?.source !== 'backend' || ack.quota.subject !== subject || ack.quota.generation !== ack.generation ||
          ack.quota.challenge !== challenge || !validTime(ack.quota.observedAt)) throw new SwitchFailure('IDENTITY_VERIFICATION_FAILED');
    };
    const reloadAndVerify = async (subject: string, oldGeneration: string, cleanup: boolean): Promise<void> => {
      const challenge = randomUUID();
      const since = this.now();
      await call(context => backend.reload(challenge, context), cleanup);
      const ack = await call(context => backend.acknowledge(challenge, context), cleanup);
      checkAcknowledgment(ack, subject, challenge, since, oldGeneration);
      const current = await call(context => backend.inspect(context), cleanup);
      if (current.subject !== subject || current.generation !== ack.generation || current.windowCount !== 1 || current.activeTaskCount !== 0) throw new SwitchFailure('IDENTITY_VERIFICATION_FAILED');
    };
    try {
      try { lease = await call(() => coordinator.acquire(transactionId)); }
      catch (error) {
        if (error instanceof SwitchFailure && error.uncertain) return await unknown('UNCERTAIN_OPERATION');
        return result('blocked', 'BUSY_OR_RECOVERY_REQUIRED');
      }
      await phase('preparing');
      before = await call(context => backend.inspect(context));
      if (before.windowCount !== 1 || before.activeTaskCount !== 0 || !isSyntheticSubject(before.subject) || typeof before.generation !== 'string' || !before.generation) throw new SwitchFailure('PREFLIGHT_FAILED');
      await phase('quiescing');
      mayHaveChanged = true;
      const stopped = await call(context => backend.quiesce(context));
      if (!stopped.stopped || !stopped.workloadHeld) throw new SwitchFailure('PREFLIGHT_FAILED');
      await phase('snapshotting');
      baseline = await call(context => storage.snapshot(context));
      await phase('installing');
      const receipt = await call(context => storage.install(target, baseline!, context));
      if (!await call(context => storage.verifyInstalled(target, receipt, context))) throw new SwitchFailure('STORAGE_VERIFICATION_FAILED');
      await phase('reloading');
      await reloadAndVerify(target, before.generation, false);
      await phase('verifying');
      // Verify the complete store again after backend reload; caches or refreshes must not silently alter attribution.
      if (!await call(context => storage.verifyInstalled(target, receipt, context))) throw new SwitchFailure('STORAGE_VERIFICATION_FAILED');
      await phase('committed');
      finalizing = true;
      await call(context => backend.releaseWorkload(context), true);
      await call(async () => { await lease!.release(); }, true);
      return result('synthetic-committed', 'SYNTHETIC_ONLY', target);
    } catch (error) {
      const code = error instanceof SwitchFailure ? error.code : 'OPERATION_FAILED';
      if (error instanceof SwitchFailure && error.uncertain) return await unknown('UNCERTAIN_OPERATION');
      if (finalizing) return await unknown('FINALIZATION_FAILED');
      if (!mayHaveChanged) {
        try { await call(async () => { await lease!.release(); }, true); }
        catch { return await unknown('FINALIZATION_FAILED'); }
        return result('blocked', code);
      }
      try {
        await phase('rolling-back', true);
        const stopped = await call(context => backend.quiesce(context), true);
        if (!stopped.stopped || !stopped.workloadHeld) throw new SwitchFailure('ROLLBACK_FAILED');
        if (baseline) {
          await call(context => storage.restore(baseline!, context), true);
          if (!await call(context => storage.verifyRestored(baseline!, context), true)) throw new SwitchFailure('ROLLBACK_FAILED');
        }
        await reloadAndVerify(before!.subject, before!.generation, true);
        if (baseline && !await call(context => storage.verifyRestored(baseline!, context), true)) throw new SwitchFailure('ROLLBACK_FAILED');
        await phase('rolled-back', true);
        await call(context => backend.releaseWorkload(context), true);
        await call(async () => { await lease!.release(); }, true);
        return result('rolled-back', code, before!.subject);
      } catch { return await unknown('ROLLBACK_FAILED'); }
    } finally { this.running = false; }
  }
}
