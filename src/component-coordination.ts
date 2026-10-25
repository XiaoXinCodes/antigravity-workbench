import { fileRouteFailureReason, type FileRouteFailureReason } from './file-route-failure';
import { createHmac } from 'node:crypto';
import { debugErrorCode } from './debug-events';
import { LiveError } from './live-storage';

/** No ports, capabilities, plaintext account identity or credentials cross this interface. */
export class ComponentParticipantFailure extends LiveError {
  readonly fileRouteFailureReason?: FileRouteFailureReason;
  constructor(code: string, readonly hostPid: number, cause?: unknown) { super(code); const reason = fileRouteFailureReason(cause); if (reason) this.fileRouteFailureReason = reason; }
}
export interface ComponentFailureDetail { hostPid: number; stage: 'prepare' | 'resume' | 'release'; code: string }
export class ComponentRestoreFailure extends LiveError {
  constructor(readonly componentFailures: ComponentFailureDetail[]) { super('COMPONENT_RESTORE_FAILED'); }
}
const detail = (hostPid: number, stage: ComponentFailureDetail['stage'], error: unknown): ComponentFailureDetail => ({ hostPid, stage, code: debugErrorCode(error) });
export interface ComponentBirth { pid: number; startIdentity: string }
export interface ComponentReceipt { host: ComponentBirth; hub: ComponentBirth; contract: '1.8.0'; stopped?: boolean; verification?: 'identity-v1' }
export interface ComponentVerification { host: ComponentBirth; hub: ComponentBirth; digest: string }
export function componentIdentityDigest(email: string, challenge: string): string {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(challenge) || !/^[^\s@]+@[^\s@]+$/.test(email.trim())) throw new LiveError('COMPONENT_IDENTITY_UNVERIFIED');
  return createHmac('sha256', challenge).update(email.trim().toLowerCase()).digest('hex');
}
export interface ComponentCensus { complete: boolean; unknown: boolean; hosts: ComponentBirth[]; hubs: ComponentBirth[] }
export interface ComponentParticipant {
  host: ComponentBirth;
  prepare(): Promise<ComponentReceipt>;
  stop(): Promise<void>;
  resume(): Promise<void>;
  release(): Promise<void>;
  verify?(challenge: string): Promise<ComponentVerification>;
}
export interface ComponentWaitTiming { participant: number; total: number; wait: 'backend-ready-ack' | 'fresh-identity-ack'; elapsedMs: number; outcome: 'completed' | 'failed' }
export interface ComponentCoordinationRuntime {
  timing?(sample: ComponentWaitTiming): void;
  progress?(stage: 'resume' | 'verify', completed: number, total: number): void;
  /** Only an explicit journal recovery may start a missing local verifier. */
  recovering?: boolean;
  requireVerification?: boolean;
  revalidateStopped?: boolean;
  census(): Promise<ComponentCensus>;
  participant(host: ComponentBirth): ComponentParticipant;
  assertOperation(): Promise<void>;
}
const key = (birth: ComponentBirth): string => `${birth.pid}:${birth.startIdentity}`;
const same = (a: readonly ComponentBirth[], b: readonly ComponentBirth[]): boolean =>
  a.length === b.length && new Set(a.map(key)).size === a.length &&
  new Set(b.map(key)).size === b.length && a.every(value => b.some(other => key(value) === key(other)));
const fail = (code: string): never => { throw new LiveError(code); };

/** Coordinates a finite, user-confirmed set of contract-verified instances. This is not
 * a fence on the official renderer: opening/reconnecting/configuring windows
 * during the transaction is unsupported. Native census checks detect observed
 * changes; they do not claim to prevent all future process starts.
 *
 * The caller holds the credential operation lock for this object's lifetime.
 * Every storage mutation (including rollback) must call assertStopped again.
 * Never use timeout as a successful stop, nor release while stop is in flight.
 */
export class ComponentCoordination {
  private participants: ComponentParticipant[] = [];
  private receipts: ComponentReceipt[] = [];
  private attempted = new Set<ComponentParticipant>();
  private resumed = new Set<ComponentParticipant>();
  private stoppedConfirmed = new Set<ComponentParticipant>();
  private resumeAttempted = new Set<ComponentParticipant>();
  private released = new Set<ComponentParticipant>();
  private verified = false;
  private verificationFailed = false;
  private action = false;
  private phase: 'new' | 'preparing' | 'ready' | 'stopping' | 'stopped' | 'restoring' | 'closed' = 'new';
  constructor(private readonly runtime: ComponentCoordinationRuntime) {}
  private async census(): Promise<ComponentCensus> {
    await this.runtime.assertOperation();
    const snapshot = await this.runtime.census();
    if (!snapshot.complete || snapshot.unknown) fail('COMPONENT_CENSUS_UNVERIFIED');
    if (!same(snapshot.hosts, snapshot.hosts) || !same(snapshot.hubs, snapshot.hubs)) fail('COMPONENT_CENSUS_UNVERIFIED');
    await this.runtime.assertOperation();
    return snapshot;
  }
  private async exclusive(work: () => Promise<void>): Promise<void> {
    if (this.action) fail('COMPONENT_ACTION_PENDING');
    this.action = true;
    try { await work(); } finally { this.action = false; }
  }
  prepare(): Promise<void> { return this.exclusive(() => this.prepareImpl()); }
  stop(): Promise<void> { return this.exclusive(() => this.stopImpl()); }
  resume(host?: ComponentBirth): Promise<void> { return this.exclusive(() => this.resumeImpl(host)); }
  close(): Promise<void> { return this.exclusive(() => this.closeImpl()); }
  /** Caller must prove no credential mutation/journal occurred. Never use after
   * installed verification failure; this only restores a cancelled preparation. */
  restoreBeforeWrite(): Promise<void> { return this.exclusive(() => this.closeImpl(true)); }
  private async prepareImpl(): Promise<void> {
    if (this.phase !== 'new') fail('COMPONENT_TRANSACTION_STATE');
    this.phase = 'preparing';
    const before = await this.census();
    if (!before.hosts.length || before.hosts.length > 32) fail('COMPONENT_PARTICIPANTS_UNSUPPORTED');
    try {
      for (const host of before.hosts) {
        const participant = this.runtime.participant(host);
        // Retain before await, so a lost acknowledgement still gets released.
        this.participants.push(participant);
        let receipt: ComponentReceipt;
        try { receipt = await participant.prepare(); }
        catch (error) { if (error instanceof LiveError) throw new ComponentParticipantFailure(error.code, host.pid, error); throw error; }
        if (key(receipt.host) !== key(host) || receipt.contract !== '1.8.0') fail('COMPONENT_CONTRACT_UNSUPPORTED');
        if (this.runtime.requireVerification && (receipt.verification !== 'identity-v1' || !participant.verify)) throw new ComponentParticipantFailure('COMPONENT_CONTRACT_UNSUPPORTED', host.pid);
        this.receipts.push(receipt);
        if (receipt.stopped) { this.attempted.add(participant); this.stoppedConfirmed.add(participant); }
      }
      const after = await this.census();
      const hubsPreserved = this.runtime.recovering
        ? before.hubs.every(value => after.hubs.some(other => key(value) === key(other)))
        : same(before.hubs, after.hubs);
      if (!same(before.hosts, after.hosts) || !hubsPreserved ||
          !same(after.hubs, this.receipts.filter(value => !value.stopped).map(value => value.hub))) fail('COMPONENT_PARTICIPANTS_CHANGED');
      this.phase = 'ready';
    } catch (error) {
      // Adopted stopped actors can belong to a crashed credential write. Do
      // not restart them merely because discovery/preparation failed. The
      // caller must resolve that journal before explicitly calling close.
      if (this.attempted.size) { this.phase = 'stopping'; throw error; }
      try { await this.closeImpl(); } catch { /* Keep the preparation failure; durable actor diagnostics retain cleanup failures. */ }
      throw error;
    }
  }
  private async stopImpl(): Promise<void> {
    if (this.phase !== 'ready' && this.phase !== 'restoring') fail('COMPONENT_TRANSACTION_STATE');
    this.verified = false;
    this.phase = 'stopping';
    const before = await this.census();
    if (!same(before.hosts, this.receipts.map(value => value.host))) fail('COMPONENT_PARTICIPANTS_CHANGED');
    // Sequential requests are intentional. Each adapter verifies its own birth
    // immediately before its hook; a partial failure must still restore earlier
    // participants and the failing participant (its stop may have taken effect).
    for (const participant of this.participants) {
      if (this.attempted.has(participant) && !this.resumed.has(participant) && !this.resumeAttempted.has(participant)) continue;
      if (this.resumeAttempted.has(participant) && !this.resumed.has(participant)) {
        // A resume timeout is not a stopped instance. Its start may appear
        // after an empty scan. Join that original start before stopping it;
        // a failed/unknown join prohibits write admission.
        await this.measured(participant, 'backend-ready-ack', () => participant.resume()); this.resumed.add(participant); this.report('resume', this.resumed.size);
      }
      if (this.runtime.revalidateStopped) {
        const receipt = await participant.prepare();
        if (key(receipt.host) !== key(participant.host) || receipt.contract !== '1.8.0') fail('COMPONENT_CONTRACT_UNSUPPORTED');
        this.receipts[this.participants.indexOf(participant)] = receipt;
      }
      this.attempted.add(participant); this.resumed.delete(participant); this.stoppedConfirmed.delete(participant);
      await participant.stop();
      this.stoppedConfirmed.add(participant);
      this.resumeAttempted.delete(participant);
    }
    this.phase = 'stopped';
    await this.assertStopped();
  }
  async assertStopped(): Promise<void> {
    if (this.phase !== 'stopped') fail('COMPONENTS_NOT_STOPPED');
    if (this.runtime.revalidateStopped) {
      for (let i = 0; i < this.participants.length; i++) {
        const receipt = await this.participants[i]!.prepare();
        if (receipt.contract !== '1.8.0' || !receipt.stopped || key(receipt.host) !== key(this.receipts[i]!.host) || key(receipt.hub) !== key(this.receipts[i]!.hub)) fail('COMPONENT_CONTRACT_UNSUPPORTED');
      }
    }
    const snapshot = await this.census();
    if (!same(snapshot.hosts, this.receipts.map(value => value.host))) fail('COMPONENT_PARTICIPANTS_CHANGED');
    if (snapshot.hubs.length) fail('COMPONENT_RESTART_DURING_WRITE');
    if (this.phase !== 'stopped') fail('COMPONENTS_NOT_STOPPED');
  }
  async assertPrepared(): Promise<void> {
    if (this.phase !== 'ready') fail('COMPONENT_TRANSACTION_STATE');
    const snapshot = await this.census();
    if (!same(snapshot.hosts, this.receipts.map(row => row.host)) ||
        !same(snapshot.hubs, this.receipts.filter(row => !row.stopped).map(row => row.hub)) || this.phase !== 'ready') fail('COMPONENT_PARTICIPANTS_CHANGED');
  }
  private report(stage: 'resume' | 'verify', completed: number): void {
    try { this.runtime.progress?.(stage, completed, this.participants.length); } catch { /* Display must not alter the transaction. */ }
  }
  private async measured<T>(participant: ComponentParticipant, wait: ComponentWaitTiming['wait'], work: () => Promise<T>): Promise<T> {
    if (!this.runtime.timing) return work();
    const start = performance.now(); let outcome: ComponentWaitTiming['outcome'] = 'failed';
    try { const result = await work(); outcome = 'completed'; return result; }
    finally {
      try { this.runtime.timing?.({participant: this.participants.indexOf(participant) + 1, total: this.participants.length, wait, elapsedMs: Math.max(0, Math.round(performance.now() - start)), outcome}); } catch { /* Observation cannot change lifecycle settlement. */ }
    }
  }
  private async resumeImpl(host?: ComponentBirth): Promise<void> {
    if (!['ready', 'stopping', 'stopped', 'restoring'].includes(this.phase)) fail('COMPONENT_TRANSACTION_STATE');
    this.phase = 'restoring';
    const targets = host ? this.participants.filter(value => key(value.host) === key(host)) : this.participants;
    if (host && targets.length !== 1) fail('COMPONENT_PARTICIPANTS_CHANGED');
    const errors: ComponentFailureDetail[] = [];
    this.report('resume', this.resumed.size);
    for (const participant of targets) {
      if (!this.attempted.has(participant) || this.resumed.has(participant)) continue;
      try {
        await this.runtime.assertOperation(); this.resumeAttempted.add(participant);
        await this.measured(participant, 'backend-ready-ack', () => participant.resume()); this.resumed.add(participant); this.report('resume', this.resumed.size);
      }
      catch (error) { errors.push(detail(participant.host.pid, 'resume', error)); }
    }
    if (errors.length) throw new ComponentRestoreFailure(errors);
  }
  verifyAll(expectedEmail: string, challenge: string): Promise<void> {
    return this.exclusive(async () => {
      this.verified = false; this.verificationFailed = true;
      if (this.phase !== 'restoring' || this.participants.some(p => this.attempted.has(p) && !this.resumed.has(p))) fail('COMPONENT_RESTORE_REQUIRED');
      const digest = componentIdentityDigest(expectedEmail, challenge);
      const proofs: ComponentVerification[] = [];
      this.report('verify', 0);
      // Only read-only identity requests overlap. All workers settle before
      // surfacing errors; never release a lock while a sibling request is pending.
      const failures: {index: number; error: unknown}[] = [];
      let next = 0;
      const worker = async (): Promise<void> => {
        for (;;) {
          const index = next++; if (index >= this.participants.length) return;
          const participant = this.participants[index]!;
          try {
            await this.measured(participant, 'fresh-identity-ack', async () => {
              await this.runtime.assertOperation();
              if (!participant.verify) fail('COMPONENT_CONTRACT_UNSUPPORTED');
              const proof = await participant.verify!(challenge);
              await this.runtime.assertOperation();
              if (key(proof.host) !== key(participant.host) || proof.digest !== digest) fail('COMPONENT_IDENTITY_UNVERIFIED');
              const original = this.receipts[index]!;
              if (this.stoppedConfirmed.has(participant) && key(proof.hub) === key(original.hub)) fail('COMPONENT_IDENTITY_UNVERIFIED');
              proofs.push(proof); this.report('verify', proofs.length);
            });
          } catch (error) { failures.push({index,error}); }
        }
      };
      await Promise.all(Array.from({length: Math.min(2, this.participants.length)}, () => worker()));
      if (failures.length) throw failures.sort((a,b) => a.index-b.index)[0]!.error;
      const snapshot = await this.census();
      if (!same(snapshot.hosts, this.receipts.map(r => r.host)) || !same(snapshot.hubs, proofs.map(p => p.hub))) fail('COMPONENT_PARTICIPANTS_CHANGED');
      this.verified = true; this.verificationFailed = false;
    });
  }
  private async closeImpl(beforeWrite = false): Promise<void> {
    if (this.phase === 'closed') return;
    // Caller must first resolve credential write/rollback. close never writes.
    const errors: ComponentFailureDetail[] = [];
    if (this.attempted.size) {
      try { await this.resumeImpl(); } catch (error) {
        if (error instanceof ComponentRestoreFailure) errors.push(...error.componentFailures); else throw error;
      }
    }
    if (errors.length) throw new ComponentRestoreFailure(errors);
    if (this.verificationFailed || !beforeWrite && this.runtime.requireVerification && this.attempted.size > 0 && !this.verified) fail('COMPONENT_IDENTITY_UNVERIFIED');
    for (const participant of this.participants) {
      if (this.released.has(participant) || this.attempted.has(participant) && !this.resumed.has(participant)) continue;
      try { await participant.release(); this.released.add(participant); } catch (error) { errors.push(detail(participant.host.pid, 'release', error)); }
    }
    if (errors.length) throw new ComponentRestoreFailure(errors);
    this.phase = 'closed';
  }
}
