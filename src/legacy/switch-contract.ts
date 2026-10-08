/** No official credential format is registered. These are test-only contracts. */
export interface RuntimeFingerprint {
  extensionVersion: string;
  backendVersion: string;
  backendBuild: string;
  platform: string;
  arch: string;
  storageSchema: string;
}
export const SYNTHETIC_RUNTIME: Readonly<RuntimeFingerprint> = Object.freeze({
  extensionVersion: 'fixture-extension-1', backendVersion: 'fixture-backend-1',
  backendBuild: 'fixture-build-1', platform: 'synthetic', arch: 'synthetic',
  storageSchema: 'fixture-composite-v1',
});
export const LIVE_SWITCHING_SUPPORTED = false;
export function supportsSyntheticRuntime(runtime: RuntimeFingerprint): boolean {
  return Object.entries(SYNTHETIC_RUNTIME).every(([key, value]) => runtime[key as keyof RuntimeFingerprint] === value);
}
export type SwitchPhase = 'preparing' | 'quiescing' | 'snapshotting' | 'installing' | 'reloading' | 'verifying' | 'rolling-back' | 'committed' | 'rolled-back' | 'unknown';
export interface SwitchLease {
  record(phase: SwitchPhase): Promise<void>;
  release(): Promise<void>;
}
/** A lease excludes cooperating callers. It must survive controller recreation. */
export interface SwitchCoordinator { acquire(transactionId: string): Promise<SwitchLease> }
export interface OperationContext { signal: AbortSignal; transactionId: string }
export interface StorageSnapshot { reference: string; revision: string }
export interface StorageReceipt { revision: string }
export interface VersionedCredentialStorage {
  readonly mode: 'synthetic';
  readonly runtime: Readonly<RuntimeFingerprint>;
  /** Opaque handle; neither the controller nor its journal receives credentials. */
  snapshot(context: OperationContext): Promise<StorageSnapshot>;
  install(target: string, baseline: StorageSnapshot, context: OperationContext): Promise<StorageReceipt>;
  verifyInstalled(target: string, receipt: StorageReceipt, context: OperationContext): Promise<boolean>;
  /** Restore every slot, including absence, and reject concurrent foreign changes. */
  restore(baseline: StorageSnapshot, context: OperationContext): Promise<void>;
  verifyRestored(baseline: StorageSnapshot, context: OperationContext): Promise<boolean>;
}
export interface BackendObservation {
  subject: string;
  generation: string;
  windowCount: number;
  activeTaskCount: number;
}
export interface BackendAcknowledgment {
  challenge: string;
  subject: string;
  generation: string;
  observedAt: number;
  quota: { subject: string; generation: string; challenge: string; observedAt: number; source: 'backend' };
}
export interface BackendLifecycle {
  readonly mode: 'synthetic';
  inspect(context: OperationContext): Promise<BackendObservation>;
  /** Prevent new tasks/windows for the whole transaction, then prove the old backend stopped. */
  quiesce(context: OperationContext): Promise<{ stopped: boolean; workloadHeld: boolean }>;
  /** Must really reload credentials; a webview reconnect does not fulfill this port. */
  reload(challenge: string, context: OperationContext): Promise<void>;
  acknowledge(challenge: string, context: OperationContext): Promise<BackendAcknowledgment>;
  releaseWorkload(context: OperationContext): Promise<void>;
}
