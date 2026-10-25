import { LiveError } from './live-storage';
import { componentIdentityDigest, type ComponentBirth, type ComponentReceipt, type ComponentVerification } from './component-coordination';
import type { HubProof, Lifecycle } from './live-switch';
import type { LocalComponentActor } from './component-mailbox';

export interface ReadOnlyComponentRuntime {
  host: ComponentBirth;
  assertOwner(): Promise<void>;
  /** Locally verified current Hub birth, without activating or reconnecting it. */
  ready(): Promise<{ hub: ComponentBirth; generation: string }> | { hub: ComponentBirth; generation: string };
  /** Must issue a fresh read-only identity request, never return cached proof. */
  proof(signal?: AbortSignal): Promise<HubProof>;
}
const birth = (v: ComponentBirth): boolean => !!v && Number.isSafeInteger(v.pid) && v.pid > 0 && typeof v.startIdentity === 'string' && /^linux:[a-f0-9-]{36}:[0-9]+$/.test(v.startIdentity);
const same = (a: ComponentBirth, b: ComponentBirth): boolean => a.pid === b.pid && a.startIdentity === b.startIdentity;
/** Recovery verification only. This adapter has no version lookup, stop/start
 * hook or credential writer. Its receipt contract is a legacy wire label, NOT
 * admission for an installed official version or a lifecycle pause guarantee. */
export class ReadOnlyComponentLifecycle implements Lifecycle, LocalComponentActor {
  readonly restartMode = 'unavailable' as const;
  private observedGeneration = '';
  private readonly host: ComponentBirth;
  constructor(private readonly runtime: ReadOnlyComponentRuntime) {
    if (!birth(runtime.host)) throw new LiveError('COMPONENT_IDENTITY_UNVERIFIED');
    this.host = { ...runtime.host };
  }
  get generation(): string { return this.observedGeneration; }
  private async observe(signal?: AbortSignal): Promise<{ proof: HubProof; hub: ComponentBirth }> {
    const cancelled = (): void => { if (signal?.aborted) throw new LiveError('CANCELLED'); };
    cancelled(); await this.runtime.assertOwner(); cancelled();
    const snapshot = await this.runtime.ready();
    if (!birth(snapshot.hub) || !snapshot.generation || !same(this.host, this.runtime.host)) throw new LiveError('COMPONENT_IDENTITY_UNVERIFIED');
    const before = { hub: { ...snapshot.hub }, generation: snapshot.generation };
    cancelled(); const proof = await this.runtime.proof(signal); cancelled();
    const after = await this.runtime.ready();
    await this.runtime.assertOwner(); cancelled();
    if (!birth(after.hub) || !same(before.hub, after.hub) || before.generation !== after.generation || proof.generation !== before.generation || !same(this.host, this.runtime.host)) throw new LiveError('HUB_CHANGED_DURING_QUERY');
    if (proof.authValid !== true || proof.quotaSource !== 'server' || typeof proof.email !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(proof.email.trim()) || !Number.isFinite(Date.parse(proof.observedAt))) throw new LiveError('HUB_FRESH_IDENTITY_REQUIRED');
    this.observedGeneration = before.generation;
    return { proof: structuredClone(proof), hub: before.hub };
  }
  async proof(signal?: AbortSignal): Promise<HubProof> { return (await this.observe(signal)).proof; }
  async prepare(): Promise<ComponentReceipt> {
    const { hub } = await this.observe();
    return { host: { ...this.host }, hub, contract: '1.8.0', verification: 'identity-v1' };
  }
  async describe(): Promise<ComponentReceipt> { return this.prepare(); }
  async verify(challenge: string): Promise<ComponentVerification> {
    // Validate the challenge before any runtime read/RPC.
    componentIdentityDigest('validation@example.invalid', challenge);
    const { hub, proof } = await this.observe();
    return { host: { ...this.host }, hub, digest: componentIdentityDigest(proof.email, challenge) };
  }
  async assertCredentialWriteSafe(): Promise<void> { throw new LiveError('OFFICIAL_CREDENTIAL_WRITE_BARRIER_UNAVAILABLE'); }
  async stop(): Promise<void> { throw new LiveError('COMPONENT_CONTRACT_UNSUPPORTED'); }
  async reload(): Promise<void> { throw new LiveError('COMPONENT_CONTRACT_UNSUPPORTED'); }
  async resume(): Promise<void> { throw new LiveError('COMPONENT_CONTRACT_UNSUPPORTED'); }
}
