import { LiveError } from './live-storage';
import type { HubProof, Lifecycle } from './live-switch';
import { componentIdentityDigest, type ComponentVerification, type ComponentBirth, type ComponentReceipt } from './component-coordination';

export interface OwnComponentRuntime {
  host: ComponentBirth;
  /** Verifies the installed source hash, loaded module hook and restart commands. */
  contract(): Promise<'1.8.0'>;
  /** Exact own capability + process birth + file-only route, not global count. */
  ready(): Promise<{ hub: ComponentBirth; generation: string }>;
  proof(signal?: AbortSignal): Promise<HubProof>;
  /** Must settle only when the real hook settles, never on a deadline alone. */
  stop(): Promise<void>;
  /** Checks old birth exit, exports cleared and no other Hub of this host. */
  stopped(previous: ComponentBirth): Promise<boolean>;
  restart(): Promise<void>;
  /** Observe the already dispatched restart; must not create another setup. */
  awaitRestart?(): Promise<void>;
  assertOwner(): Promise<void>;
}
const same = (a: ComponentBirth, b: ComponentBirth): boolean => a.pid === b.pid && a.startIdentity === b.startIdentity;
/** Local half of the protocol. Never accepts an arbitrary PID to terminate.
 * Stopping an external participant must invoke its own instance of this adapter.
 * Generation remains in host memory: it may contain a capability secret.
 */
export class OwnComponentLifecycle implements Lifecycle {
  readonly restartMode = 'component';
  private state: 'new' | 'preparing' | 'ready' | 'stopping' | 'stopped' | 'starting' | 'failed' = 'new';
  private birth: ComponentBirth | undefined;
  private expectedGeneration = '';
  private work: Promise<void> | undefined;
  private startDispatched = false;
  constructor(private readonly runtime: OwnComponentRuntime) {}
  get generation(): string { return this.expectedGeneration; }
  async describe(): Promise<ComponentReceipt> {
    await this.runtime.assertOwner();
    if (!this.birth || this.work) throw new LiveError('COMPONENT_ACTION_PENDING');
    if (this.state === 'failed') {
      if (this.startDispatched) await this.reload();
      else if (await this.runtime.stopped(this.birth)) this.state = 'stopped';
      else { await this.assertReady(); this.state = 'ready'; }
    }
    if (this.state === 'ready') await this.assertReady();
    else if (this.state !== 'stopped' || !await this.runtime.stopped(this.birth)) throw new LiveError('COMPONENT_ACTION_PENDING');
    return { host: this.runtime.host, hub: this.birth, contract: await this.runtime.contract(), verification: 'identity-v1', ...(this.state === 'stopped' ? { stopped: true } : {}) };
  }
  async prepare(verifyIdentity = true): Promise<ComponentReceipt> {
    if (this.state !== 'new') throw new LiveError('COMPONENT_TRANSACTION_STATE');
    this.state = 'preparing';
    await this.runtime.assertOwner();
    const contract = await this.runtime.contract();
    if (contract !== '1.8.0') throw new LiveError('COMPONENT_CONTRACT_UNSUPPORTED');
    const before = await this.runtime.ready();
    // Recovery must also work when the installed credentials no longer
    // authenticate. Exact process, capability and file-route proof still apply.
    const proof = verifyIdentity ? await this.runtime.proof() : undefined;
    const after = await this.runtime.ready();
    if (!same(before.hub, after.hub) || before.generation !== after.generation ||
        proof && (proof.generation !== after.generation || !proof.authValid || proof.quotaSource !== 'server')) throw new LiveError('HUB_CHANGED_DURING_OPERATION');
    await this.runtime.assertOwner();
    this.birth = after.hub; this.expectedGeneration = after.generation; this.state = 'ready';
    return { host: this.runtime.host, hub: after.hub, contract, verification: 'identity-v1' };
  }
  async proof(signal?: AbortSignal): Promise<HubProof> {
    if (this.state !== 'ready' || !this.birth) throw new LiveError('OFFICIAL_HUB_NOT_READY');
    await this.assertReady();
    const proof = await this.runtime.proof(signal);
    await this.assertReady();
    if (proof.generation !== this.expectedGeneration || !proof.authValid || proof.quotaSource !== 'server') throw new LiveError('HUB_CHANGED_DURING_QUERY');
    return proof;
  }
  async verify(challenge: string): Promise<ComponentVerification> {
    const proof = await this.proof();
    const digest = componentIdentityDigest(proof.email, challenge);
    return { host: this.runtime.host, hub: { ...this.birth! }, digest };
  }
  private async assertReady(): Promise<void> {
    await this.runtime.assertOwner();
    const current = await this.runtime.ready();
    if (!this.birth || !same(current.hub, this.birth) || current.generation !== this.expectedGeneration) throw new LiveError('HUB_CHANGED_DURING_OPERATION');
  }
  async stop(): Promise<void> {
    if (this.work) throw new LiveError('COMPONENT_ACTION_PENDING');
    if (this.state === 'stopped') {
      if (!this.birth || !await this.runtime.stopped(this.birth)) throw new LiveError('COMPONENT_RESTART_DURING_WRITE');
      return;
    }
    if (this.state !== 'ready') throw new LiveError('COMPONENT_TRANSACTION_STATE');
    const operation = (async () => {
      await this.assertReady();
      this.state = 'stopping';
      this.startDispatched = false;
      try {
        await this.runtime.stop();
        if (!this.birth || !await this.runtime.stopped(this.birth)) throw new LiveError('OFFICIAL_BACKEND_NOT_STOPPED');
        await this.runtime.assertOwner();
        this.state = 'stopped';
      } catch (error) { this.state = 'failed'; throw error; }
    })();
    this.work = operation;
    try { await operation; } finally { if (this.work === operation) this.work = undefined; }
  }
  async reload(): Promise<void> {
    if (this.work) throw new LiveError('COMPONENT_ACTION_PENDING');
    if (this.state === 'ready') { await this.assertReady(); return; }
    if (!this.birth || !['stopped', 'failed'].includes(this.state)) throw new LiveError('COMPONENT_TRANSACTION_STATE');
    const operation = (async () => {
      await this.runtime.assertOwner();
      if (this.startDispatched) {
        // Adopt late readiness or join observation of the original attempt.
        // Command settlement is not setup settlement; never dispatch a second
        // setup just because a deadline or first ready observation failed.
        let ready;
        try { ready = await this.runtime.ready(); }
        catch (error) {
          if (!(error instanceof LiveError) || error.code !== 'OFFICIAL_HUB_NOT_READY' || !this.runtime.awaitRestart) throw error;
          await this.runtime.awaitRestart();
          ready = await this.runtime.ready();
        }
        if (same(ready.hub, this.birth!)) throw new LiveError('HUB_CHANGED_DURING_OPERATION');
        await this.runtime.assertOwner();
        this.birth = ready.hub; this.expectedGeneration = ready.generation; this.state = 'ready';
        return;
      }
      // A failed stop may have left the exact original ready instance alive.
      // Do not restart over it; never accept a different ready birth here.
      if (this.state === 'failed') {
        try { await this.assertReady(); this.state = 'ready'; return; }
        catch { /* Require an affirmative exit before any restart. */ }
      }
      if (!await this.runtime.stopped(this.birth!)) throw new LiveError('OFFICIAL_BACKEND_NOT_STOPPED');
      this.state = 'starting';
      try {
        this.startDispatched = true;
        await this.runtime.restart();
        const ready = await this.runtime.ready();
        if (same(ready.hub, this.birth!)) throw new LiveError('HUB_CHANGED_DURING_OPERATION');
        await this.runtime.assertOwner();
        this.birth = ready.hub; this.expectedGeneration = ready.generation; this.state = 'ready';
      } catch (error) { this.state = 'failed'; throw error; }
    })();
    this.work = operation;
    try { await operation; } finally { if (this.work === operation) this.work = undefined; }
  }
}
