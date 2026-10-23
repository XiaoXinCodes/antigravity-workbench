import { LiveError } from './live-storage';

/** No ports, capabilities, account data or credentials cross this interface. */
export interface ComponentBirth { pid: number; startIdentity: string }
export interface ComponentReceipt { host: ComponentBirth; hub: ComponentBirth; contract: '1.8.0'; stopped?: boolean }
export interface ComponentCensus { complete: boolean; unknown: boolean; hosts: ComponentBirth[]; hubs: ComponentBirth[] }
export interface ComponentParticipant {
  host: ComponentBirth;
  prepare(): Promise<ComponentReceipt>;
  stop(): Promise<void>;
  resume(): Promise<void>;
  release(): Promise<void>;
}
export interface ComponentCoordinationRuntime {
  /** Only an explicit journal recovery may start a missing local verifier. */
  recovering?: boolean;
  census(): Promise<ComponentCensus>;
  participant(host: ComponentBirth): ComponentParticipant;
  assertOperation(): Promise<void>;
}
const key = (birth: ComponentBirth): string => `${birth.pid}:${birth.startIdentity}`;
const same = (a: readonly ComponentBirth[], b: readonly ComponentBirth[]): boolean =>
  a.length === b.length && new Set(a.map(key)).size === a.length &&
  new Set(b.map(key)).size === b.length && a.every(value => b.some(other => key(value) === key(other)));
const fail = (code: string): never => { throw new LiveError(code); };

/** Coordinates a finite, user-confirmed set of ready 1.8 instances. This is not
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
  private resumeAttempted = new Set<ComponentParticipant>();
  private released = new Set<ComponentParticipant>();
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
        const receipt = await participant.prepare();
        if (key(receipt.host) !== key(host) || receipt.contract !== '1.8.0') fail('COMPONENT_CONTRACT_UNSUPPORTED');
        this.receipts.push(receipt);
        if (receipt.stopped) this.attempted.add(participant);
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
      await this.closeImpl();
      throw error;
    }
  }
  private async stopImpl(): Promise<void> {
    if (this.phase !== 'ready' && this.phase !== 'restoring') fail('COMPONENT_TRANSACTION_STATE');
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
        await participant.resume(); this.resumed.add(participant);
      }
      this.attempted.add(participant); this.resumed.delete(participant);
      await participant.stop();
      this.resumeAttempted.delete(participant);
    }
    this.phase = 'stopped';
    await this.assertStopped();
  }
  async assertStopped(): Promise<void> {
    if (this.phase !== 'stopped') fail('COMPONENTS_NOT_STOPPED');
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
  private async resumeImpl(host?: ComponentBirth): Promise<void> {
    if (!['ready', 'stopping', 'stopped', 'restoring'].includes(this.phase)) fail('COMPONENT_TRANSACTION_STATE');
    this.phase = 'restoring';
    const targets = host ? this.participants.filter(value => key(value.host) === key(host)) : this.participants;
    if (host && targets.length !== 1) fail('COMPONENT_PARTICIPANTS_CHANGED');
    const errors: unknown[] = [];
    for (const participant of targets) {
      if (!this.attempted.has(participant) || this.resumed.has(participant)) continue;
      try {
        await this.runtime.assertOperation(); this.resumeAttempted.add(participant);
        await participant.resume(); this.resumed.add(participant);
      }
      catch (error) { errors.push(error); }
    }
    if (errors.length) fail('COMPONENT_RESTORE_FAILED');
  }
  private async closeImpl(): Promise<void> {
    if (this.phase === 'closed') return;
    // Caller must first resolve credential write/rollback. close never writes.
    let failed = false;
    if (this.attempted.size) {
      try { await this.resumeImpl(); } catch { failed = true; }
    }
    for (const participant of this.participants) {
      if (this.released.has(participant) || this.attempted.has(participant) && !this.resumed.has(participant)) continue;
      try { await participant.release(); this.released.add(participant); } catch { failed = true; }
    }
    if (failed) fail('COMPONENT_RESTORE_FAILED');
    this.phase = 'closed';
  }
}
