import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { PrivateState, type LocalState } from './private-state';
import { LiveError } from './live-storage';
import type { WindowBirth } from './window-switch-protocol';

export interface HostRecoveryJournal { id: string; phase: string; operation: string; target: { id: string } }
export interface HostRecoveryParticipant { workspaceKey: string; host: WindowBirth; hubs: WindowBirth[] }
export interface HostRecoveryRecord {
  schema: 1; attempt: string; journalId: string; targetId: string;
  originalOwner: WindowBirth; owner: WindowBirth; deadline: number;
  phase: 'prepared' | 'dispatched' | 'cancelled' | 'verified' | 'complete';
  participants: HostRecoveryParticipant[]; dispatched: string[];
  claims: { workspaceKey: string; host: WindowBirth }[]; verifiedHubs?: WindowBirth[]; retiredBirths?: WindowBirth[];
}
export interface HostRecoveryState { record?: HostRecoveryRecord; history?: HostRecoveryRecord[] }
export interface HostRecoveryIO {
  self(): Promise<WindowBirth>;
  inspect(birth: WindowBirth): Promise<'alive' | 'dead' | 'unknown'>;
  now(): number;
  /** Trusted adapter performs NEW read-only authentication, never cached UI identity. */
  assertOperation(): Promise<void>;
  fresh(participant: HostRecoveryParticipant, host: WindowBirth, targetId: string): Promise<{ host: WindowBirth; hub: WindowBirth; targetId: string }>;
}
export class HostRecoveryError extends LiveError {}
const fail = (code: string): never => { throw new HostRecoveryError(code); };
const id = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(v);
const validBirth = (b: WindowBirth): boolean => !!b && Object.keys(b).every(k => ['pid','startIdentity'].includes(k)) && Number.isSafeInteger(b.pid) && b.pid > 0 && typeof b.startIdentity === 'string' && b.startIdentity.length > 0 && b.startIdentity.length <= 256 && ![...b.startIdentity].some(c=>c.charCodeAt(0)<32||c.charCodeAt(0)===127);
const same = (a: WindowBirth, b: WindowBirth): boolean => a.pid === b.pid && a.startIdentity === b.startIdentity;
const birthKey = (b: WindowBirth): string => `${b.pid}:${b.startIdentity}`;
function installed(j: HostRecoveryJournal): void {
  if (!j || j.phase !== 'installed' || j.operation !== 'switch' || !id(j.id) || !id(j.target?.id)) fail('HOST_RECOVERY_NOT_INSTALLED');
}
function parse(value: unknown): HostRecoveryState {
  const s = value as HostRecoveryState, r = s?.record;
  if (!s || typeof s !== 'object' || Object.keys(s).some(k => !['record','history'].includes(k))) fail('HOST_RECOVERY_INVALID');
  if (s.history !== undefined) {
    if (!Array.isArray(s.history) || s.history.length > 32) fail('HOST_RECOVERY_INVALID');
    for (const old of s.history) { if (!old || !['complete','cancelled'].includes(old.phase)) fail('HOST_RECOVERY_INVALID'); parse({record:old}); }
    const attempts = [...s.history.map(old=>old.attempt), ...(r?[r.attempt]:[])];
    if (new Set(attempts).size !== attempts.length) fail('HOST_RECOVERY_INVALID');
  }
  if (!r) return structuredClone(s);
  if (Object.keys(r).some(k => !['schema','attempt','journalId','targetId','originalOwner','owner','deadline','phase','participants','dispatched','claims','verifiedHubs','retiredBirths'].includes(k)) ||
      r.schema !== 1 || !id(r.attempt) || !id(r.journalId) || !id(r.targetId) || !validBirth(r.originalOwner) || !validBirth(r.owner) || !Number.isSafeInteger(r.deadline) ||
      !['prepared','dispatched','cancelled','verified','complete'].includes(r.phase) || !Array.isArray(r.participants) || !r.participants.length || r.participants.length > 32 || !Array.isArray(r.dispatched) || !Array.isArray(r.claims)) fail('HOST_RECOVERY_INVALID');
  for (const p of r.participants) if (!p || Object.keys(p).some(k => !['workspaceKey','host','hubs'].includes(k)) || !id(p.workspaceKey) || !validBirth(p.host) || !Array.isArray(p.hubs) || p.hubs.length > 32 || p.hubs.some(b => !validBirth(b))) fail('HOST_RECOVERY_INVALID');
  if (r.retiredBirths !== undefined && (!Array.isArray(r.retiredBirths) || r.retiredBirths.length > 128 || r.retiredBirths.some(b=>!validBirth(b)))) fail('HOST_RECOVERY_INVALID');
  const old = [...r.participants.flatMap(p => [p.host,...p.hubs]),...(r.retiredBirths??[])];
  if (new Set(r.participants.map(p => p.workspaceKey)).size !== r.participants.length || new Set(old.map(birthKey)).size !== old.length || !r.participants.some(p => same(p.host,r.originalOwner)) ||
      new Set(r.dispatched).size !== r.dispatched.length || r.dispatched.some(w => !r.participants.some(p => p.workspaceKey === w)) ||
      r.claims.length > r.participants.length || new Set(r.claims.map(c => c.workspaceKey)).size !== r.claims.length || new Set(r.claims.map(c => birthKey(c.host))).size !== r.claims.length) fail('HOST_RECOVERY_INVALID');
  for (const c of r.claims) if (!c || Object.keys(c).some(k => !['workspaceKey','host'].includes(k)) || !validBirth(c.host) || !r.participants.some(p => p.workspaceKey === c.workspaceKey) || old.some(b => same(b,c.host))) fail('HOST_RECOVERY_INVALID');
  if (!same(r.owner,r.originalOwner) && !r.claims.some(c => same(c.host,r.owner)) || r.phase === 'cancelled' && (r.dispatched.length || r.claims.length) || ['verified','complete'].includes(r.phase) && r.claims.length !== r.participants.length) fail('HOST_RECOVERY_INVALID');
  if (r.verifiedHubs !== undefined && (!['verified','complete'].includes(r.phase) || !Array.isArray(r.verifiedHubs) || r.verifiedHubs.length !== r.claims.length || r.verifiedHubs.some(b=>!validBirth(b)) || new Set(r.verifiedHubs.map(birthKey)).size !== r.verifiedHubs.length || r.verifiedHubs.some(b=>old.some(o=>same(o,b))))) fail('HOST_RECOVERY_INVALID');
  if (['verified','complete'].includes(r.phase) && !r.verifiedHubs) fail('HOST_RECOVERY_INVALID');
  return structuredClone(s);
}
/** Post-write observation only. This state NEVER grants credential-write or rollback
 * authority. Callers must retain the original account journal and its lock. */
export class ComponentHostRecovery {
  private readonly state: LocalState<HostRecoveryState>;
  constructor(home: string, private readonly io: HostRecoveryIO, state?: LocalState<HostRecoveryState>) {
    this.state = state ?? new PrivateState(path.join(home,'.gemini','antigravity-workbench-component-host-recovery'),parse,()=>({}));
  }
  async read(): Promise<HostRecoveryRecord | undefined> { return parse(await this.state.read()).record; }
  private async current(attempt: string): Promise<HostRecoveryRecord> { const r = await this.read(); if (!r || r.attempt !== attempt) fail('HOST_RECOVERY_CHANGED'); return r!; }
  private async cas(before: HostRecoveryRecord, change: (r: HostRecoveryRecord) => void): Promise<void> {
    await this.state.transaction(s => { if (!isDeepStrictEqual(s.record,before)) fail('HOST_RECOVERY_CHANGED'); change(s.record!); parse(s); });
  }
  async prepare(input: { attempt: string; journal: HostRecoveryJournal; owner: WindowBirth; participants: HostRecoveryParticipant[]; deadline: number; confirmed: boolean }): Promise<void> {
    installed(input.journal);
    if (!input.confirmed) fail('HOST_RECOVERY_CONSENT_REQUIRED');
    if (!same(await this.io.self(),input.owner) || await this.io.inspect(input.owner) !== 'alive') fail('HOST_RECOVERY_OWNER_UNVERIFIED');
    if (input.deadline <= this.io.now() || input.deadline > this.io.now()+300_000) fail('HOST_RECOVERY_DEADLINE');
    const r = parse({record:{schema:1,attempt:input.attempt,journalId:input.journal.id,targetId:input.journal.target.id,originalOwner:input.owner,owner:input.owner,deadline:input.deadline,phase:'prepared',participants:input.participants,dispatched:[],claims:[]}}).record!;
    for (const p of r.participants) if (await this.io.inspect(p.host) !== 'alive' || (await Promise.all(p.hubs.map(h=>this.io.inspect(h)))).some(s=>s==='unknown')) fail('HOST_RECOVERY_PARTICIPANT_UNVERIFIED');
    await this.state.transaction(s=>{
      parse(s);
      if(s.history?.some(old=>old.attempt===r.attempt))fail('HOST_RECOVERY_REPLAY');
      if(s.record){
        if(isDeepStrictEqual(s.record,r))return;
        if(!['complete','cancelled'].includes(s.record.phase))fail('HOST_RECOVERY_PENDING');
        if(s.record.attempt===r.attempt)fail('HOST_RECOVERY_REPLAY');
        if((s.history?.length??0)>=32)fail('HOST_RECOVERY_HISTORY_FULL');
        (s.history??=[]).push(s.record);
      }
      s.record=r;parse(s);
    });
  }
  async markDispatchOnce(attempt: string, workspaceKey: string): Promise<boolean> {
    const r = await this.current(attempt), p = r.participants.find(p=>p.workspaceKey===workspaceKey);
    if (!p || !same(await this.io.self(),p.host) || await this.io.inspect(p.host)!=='alive') fail('HOST_RECOVERY_PARTICIPANT_UNVERIFIED');
    if (r.dispatched.includes(workspaceKey)) return false;
    if (!['prepared','dispatched'].includes(r.phase) || this.io.now()>=r.deadline) fail('HOST_RECOVERY_DISPATCH_CLOSED');
    await this.cas(r,s=>{s.dispatched.push(workspaceKey);s.phase='dispatched';});return true;
  }
  async cancel(attempt: string): Promise<void> {
    const r=await this.current(attempt);
    if (!same(await this.io.self(),r.owner) || await this.io.inspect(r.owner)!=='alive') fail('HOST_RECOVERY_OWNER_UNVERIFIED');
    if (r.dispatched.length || r.claims.length || !['prepared','cancelled'].includes(r.phase)) fail('HOST_RECOVERY_OBSERVE_ONLY');
    await this.cas(r,s=>{s.phase='cancelled';});
  }
  async renewConsent(attempt: string, deadline: number, confirmed: boolean, observed?: HostRecoveryParticipant[]): Promise<void> {
    if (!confirmed) fail('HOST_RECOVERY_CONSENT_REQUIRED');
    const r=await this.current(attempt), self=await this.io.self();
    if (!['prepared','dispatched'].includes(r.phase) || r.claims.length || !same(self,r.originalOwner) || !same(self,r.owner) || await this.io.inspect(self)!=='alive') fail('HOST_RECOVERY_OWNER_UNVERIFIED');
    if (!Number.isSafeInteger(deadline) || deadline<=this.io.now() || deadline>this.io.now()+300_000) fail('HOST_RECOVERY_DEADLINE');
    const participants = structuredClone(r.participants);
    if (observed) {
      if (observed.length !== participants.length) fail('HOST_RECOVERY_PARTICIPANT_UNVERIFIED');
      for (const p of observed) {
        const before = participants.find(v => v.workspaceKey === p.workspaceKey && same(v.host,p.host));
        if (!before || !Array.isArray(p.hubs)) fail('HOST_RECOVERY_PARTICIPANT_UNVERIFIED');
        for (const hub of p.hubs) {
          if (!validBirth(hub) || await this.io.inspect(hub) === 'unknown') fail('HOST_RECOVERY_PARTICIPANT_UNVERIFIED');
          if (!before!.hubs.some(h => same(h,hub))) before!.hubs.push(hub);
        }
      }
    }
    await this.cas(r,s=>{s.deadline=deadline;s.participants=participants;});
  }
  async claim(attempt: string, workspaceKey: string): Promise<void> {
    const r=await this.current(attempt), next=await this.io.self(), p=r.participants.find(p=>p.workspaceKey===workspaceKey);
    if (!p || !['prepared','dispatched','verified'].includes(r.phase) || await this.io.inspect(r.originalOwner)!=='dead' || await this.io.inspect(p.host)!=='dead' || await this.io.inspect(next)!=='alive') fail('HOST_RECOVERY_CLAIM_UNVERIFIED');
    const existing=r.claims.find(c=>c.workspaceKey===workspaceKey);
    if(existing && same(existing.host,next))return;
    if(r.participants.some(p=>[p.host,...p.hubs].some(b=>same(b,next))) || r.claims.some(c=>same(c.host,next)) || r.retiredBirths?.some(b=>same(b,next)))fail('HOST_RECOVERY_DUPLICATE_CLAIM');
    if(existing){
      if(await this.io.inspect(existing.host)!=='dead')fail('HOST_RECOVERY_DUPLICATE_CLAIM');
      // Keep the retired host and its last verified Hub as death obligations.
      const retired=[...(r.retiredBirths??[]),existing.host];
      const oldHub=r.verifiedHubs?.[r.claims.indexOf(existing)];if(oldHub)retired.push(oldHub);
      if(retired.length>128)fail('HOST_RECOVERY_HISTORY_FULL');
      await this.cas(r,s=>{s.claims.find(c=>c.workspaceKey===workspaceKey)!.host=next;if(same(s.owner,existing.host))s.owner=next;s.retiredBirths=retired;delete s.verifiedHubs;s.phase='dispatched';});
      return;
    }
    await this.cas(r,s=>{s.claims.push({workspaceKey,host:next});if(!s.claims.slice(0,-1).length)s.owner=next;});
  }
  /** An already claimed survivor can observe recovery after the new owner dies.
   * This does not replace that dead participant's identity or authorize writes. */
  async takeOwnership(attempt: string): Promise<void> {
    await this.io.assertOperation();
    const r=await this.current(attempt), self=await this.io.self();
    if(!['prepared','dispatched','verified'].includes(r.phase) || !r.claims.some(c=>same(c.host,self)) || await this.io.inspect(self)!=='alive')fail('HOST_RECOVERY_OWNER_UNVERIFIED');
    if(same(r.owner,self))return;
    if(await this.io.inspect(r.owner)!=='dead' || await this.io.inspect(r.originalOwner)!=='dead')fail('HOST_RECOVERY_OWNER_UNVERIFIED');
    await this.io.assertOperation();await this.cas(r,s=>{s.owner=self;});
  }
  private async settled(r: HostRecoveryRecord): Promise<void> {
    if (!same(await this.io.self(),r.owner) || await this.io.inspect(r.owner)!=='alive' || r.claims.length!==r.participants.length)fail('HOST_RECOVERY_NOT_SETTLED');
    for(const p of r.participants)for(const b of [p.host,...p.hubs])if(await this.io.inspect(b)!=='dead')fail('HOST_RECOVERY_OLD_PROCESS_PENDING');
    for(const b of r.retiredBirths??[])if(await this.io.inspect(b)!=='dead')fail('HOST_RECOVERY_OLD_PROCESS_PENDING');
    for(const c of r.claims)if(await this.io.inspect(c.host)!=='alive')fail('HOST_RECOVERY_NOT_SETTLED');
  }
  async verifyAll(attempt: string, journal: HostRecoveryJournal): Promise<void> {
    await this.io.assertOperation();installed(journal);const r=await this.current(attempt);
    if(r.journalId!==journal.id || r.targetId!==journal.target.id || !['prepared','dispatched','verified'].includes(r.phase))fail('HOST_RECOVERY_CHANGED');
    await this.settled(r);
    const hubs: WindowBirth[]=[];
    for(const c of r.claims){const proof=await this.io.fresh(r.participants.find(p=>p.workspaceKey===c.workspaceKey)!,c.host,r.targetId);if(proof.targetId!==r.targetId || !same(proof.host,c.host) || !validBirth(proof.hub) || await this.io.inspect(proof.hub)!=='alive' || r.participants.some(p=>[p.host,...p.hubs].some(b=>same(b,proof.hub))) || r.retiredBirths?.some(b=>same(b,proof.hub)) || hubs.some(b=>same(b,proof.hub)))fail('HOST_RECOVERY_IDENTITY_UNVERIFIED');hubs.push(proof.hub);}
    await this.io.assertOperation();await this.settled(r);await this.cas(r,s=>{s.phase='verified';s.verifiedHubs=hubs;});
  }
  /** Caller must freshly verifyAll in THIS operation; this marks host
   * observation only, never proves an account journal finalized. */
  async complete(attempt: string): Promise<void> {
    await this.io.assertOperation();const r=await this.current(attempt);if(!['verified','complete'].includes(r.phase))fail('HOST_RECOVERY_NOT_VERIFIED');
    await this.settled(r);for(const b of r.verifiedHubs!)if(await this.io.inspect(b)!=='alive')fail('HOST_RECOVERY_IDENTITY_UNVERIFIED');await this.io.assertOperation();await this.cas(r,s=>{s.phase='complete';});
  }
}

/** Census corroboration, never identity proof: each claimed host must have one
 * current Hub, and no unbound/orphan Hub may be mistaken for a retired process. */
export function assertHostRecoveryProcessSnapshot(claims: { host: WindowBirth }[], processes: { parentPid: number; kind: string }[]): void {
  if (!claims.length || processes.some(p => p.kind === 'unverified' || !claims.some(c => c.host.pid === p.parentPid)) ||
      claims.some(c => processes.filter(p => p.parentPid === c.host.pid).length !== 1)) throw new HostRecoveryError('HOST_RECOVERY_OLD_PROCESS_PENDING');
}
