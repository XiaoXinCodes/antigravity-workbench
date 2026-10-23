import { LiveError, equalSlots, type TokenSlots } from './live-storage';
import { type Lifecycle, type HubProof, type LiveSwitchService, type RecoveryFinalizer } from './live-switch';
import type { AccountIndex } from './account-import';
import type { ComponentBirth, ComponentCoordination } from './component-coordination';

export interface ComponentSwitchRuntime {
  service: LiveSwitchService; group: ComponentCoordination; host: ComponentBirth; local: Lifecycle;
  readFileRoute(): Promise<boolean>;
  readCurrent(scope: TokenSlots): Promise<TokenSlots>;
  assertOperation(): Promise<void>;
  index: AccountIndex;
  finalizer: RecoveryFinalizer;
}
/** Credential transaction orchestration only. The UI holds the operation lock,
 * prepares every participant and obtains consent before invoking install.
 * Peers stay stopped through fresh verification or an explicit keep-current
 * choice. A failed verification never becomes a successful switch. */
export class ComponentSwitch {
  private phase: 'ready' | 'stopped' | 'verifying' = 'ready';
  readonly lifecycle: Lifecycle;
  constructor(private readonly runtime: ComponentSwitchRuntime) {
    this.lifecycle = {
      get generation() { return runtime.local.generation; }, restartMode: 'component',
      assertCredentialWriteSafe: async signal => {
        if (signal?.aborted) throw new LiveError('CANCELLED');
        await runtime.assertOperation();
        if (this.phase === 'verifying') await this.stop();
        if (this.phase === 'stopped') await runtime.group.assertStopped();
        else { await runtime.group.assertPrepared(); await runtime.local.proof(signal); }
      },
      stop: () => this.stop(), reload: () => this.resumeVerifier(),
      proof: signal => runtime.local.proof(signal),
    };
  }
  async fileOnlyGuard(allowStopped: boolean): Promise<boolean> {
    await this.runtime.assertOperation();
    if (this.phase === 'stopped') {
      if (!allowStopped) return false;
      await this.runtime.group.assertStopped(); return true;
    }
    return this.runtime.readFileRoute();
  }
  private async stop(): Promise<void> {
    if (this.phase === 'stopped') { await this.runtime.group.assertStopped(); return; }
    await this.runtime.group.stop(); this.phase = 'stopped';
  }
  async resumeVerifier(): Promise<void> {
    if (this.phase === 'ready') return;
    // Mark before awaiting, so a late start cannot leave write admission intact.
    this.phase = 'verifying'; await this.runtime.group.resume(this.runtime.host);
  }
  async install(account: string, transaction: string): Promise<HubProof | null> {
    await this.runtime.service.install(account, this.lifecycle, transaction);
    return this.finish();
  }
  async finish(): Promise<HubProof | null> {
    await this.runtime.assertOperation();
    return this.runtime.service.finishVerified(this.lifecycle, this.runtime.index, undefined, this.runtime.finalizer);
  }
  async recoverVerification(): Promise<HubProof | null> {
    // Rejoined actors may be ready, stopped, or have completed a late start.
    // Establish one known state before starting only the local verifier.
    await this.stop(); await this.resumeVerifier();
    return this.finish();
  }
  async restore(transaction: string): Promise<HubProof | null> {
    const journal = await this.runtime.service.journal();
    if (!journal || journal.id !== transaction || journal.operation === 'login' || journal.backup.keyringState !== 'unobserved') throw new LiveError('RECOVERY_CHANGED');
    await this.stop();
    const current = await this.runtime.readCurrent(journal.backup);
    const account = await this.runtime.service.account(journal.target.id);
    const target: TokenSlots = { file: account.slots.file, keyring: null, keyringState: 'unobserved' };
    // Refresh rotation or external login is not owned by this transaction.
    // Never overwrite it merely because the user asked to recover a switch.
    if (!equalSlots(current, journal.backup) && !equalSlots(current, target)) throw new LiveError('EXTERNAL_CHANGE');
    await this.runtime.service.restore(this.lifecycle, { expectedTransactionId: transaction, expectedCurrent: current });
    return this.finish();
  }
  async retainCurrent(transaction: string): Promise<HubProof | null> {
    await this.runtime.assertOperation();
    // Force a fresh component generation; this is a read/verify recovery choice,
    // not a credential replacement. The encrypted original remains archived.
    await this.stop(); await this.resumeVerifier();
    await this.runtime.service.retainCurrentLogin(this.lifecycle, transaction);
    return this.finish();
  }
}
