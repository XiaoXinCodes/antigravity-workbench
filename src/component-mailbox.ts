import { validateRouteRepairRecord, type RouteRepairRecord } from './component-route-repair';
import { fileRouteFailureReason, type FileRouteFailureReason } from './file-route-failure';
import { debugErrorCode } from './debug-events';
import { COMPONENT_REQUEST_TIMEOUT_MS } from './official-restart';
import { randomUUID } from 'node:crypto';
import { LiveError } from './live-storage';
import { probeProcessIdentity, type LockInspection, type LiveLocks } from './live-lock';
import { type LocalState, PrivateState } from './private-state';
import { ComponentRestoreFailure, type ComponentFailureDetail, type ComponentBirth, type ComponentParticipant, type ComponentReceipt, type ComponentVerification } from './component-coordination';

type Action = 'prepare' | 'stop' | 'resume' | 'release' | 'verify' | 'restartHost' | 'repairRoute';
interface Request { id: string; action: Action; operation: LockInspection; recovery: string; recovering?: boolean; challenge?: string }
interface Reply { fileRouteFailureReason?: FileRouteFailureReason; id: string; ok: boolean; code?: string; receipt?: ComponentReceipt; verification?: ComponentVerification }
interface ActorFailure { fileRouteFailureReason?: FileRouteFailureReason; action: Action; code: string; at: string }
interface Actor { routeRepair?: RouteRepairRecord; workspaceKey?: string; lastHub?: ComponentBirth; failures?: ActorFailure[]; host: ComponentBirth; verification?: 'identity-v1'; request?: Request; reply?: Reply; recovery?: string; phase?: 'ready' | 'stopping' | 'stopped' | 'restoring' }
interface Mailboxes { schema: 1; actors: Actor[] }
export interface ComponentMailboxOptions {
  workspaceKey?: string;
  repairRoute?(record: RouteRepairRecord | undefined, save: (record: RouteRepairRecord) => Promise<void>, assertOwner: () => Promise<void>, transaction: string): Promise<void>;
  /** Validate explicit handoff and durably mark dispatch once before returning. */
  restartHost?(recoveryId: string): Promise<() => Promise<void>>;
}
export interface ComponentRecoveryParticipant { host: ComponentBirth; workspaceKey?: string; lastHub?: ComponentBirth; recovery?: string; phase?: Actor['phase']; failures?: ActorFailure[] }
export interface LocalComponentActor {
  /** Read-only once create has settled; failure dispatches no stop/restart. */
  prepare(): Promise<ComponentReceipt>; stop(): Promise<void>; resume(): Promise<void>;
  describe?(): Promise<ComponentReceipt>;
  verify?(challenge: string): Promise<ComponentVerification>;
}
const same = (a: ComponentBirth, b: ComponentBirth): boolean => a.pid === b.pid && a.startIdentity === b.startIdentity;
const validBirth = (value: unknown): value is ComponentBirth => {
  const v = value as ComponentBirth | undefined;
  return !!v && Number.isSafeInteger(v.pid) && v.pid > 0 && typeof v.startIdentity === 'string' && /^linux:[a-f0-9-]{36}:[0-9]+$/.test(v.startIdentity);
};
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
function parse(value: unknown): Mailboxes {
  const v = value as Mailboxes;
  if (!v || v.schema !== 1 || !Array.isArray(v.actors) || v.actors.length > 128) throw new LiveError('COMPONENT_MAILBOX_INVALID');
  for (const row of v.actors) {
    if (row.routeRepair !== undefined && (!validateRouteRepairRecord(row.routeRepair) || row.routeRepair.transaction !== row.recovery || !same(row.routeRepair.host, row.host))) throw new LiveError('COMPONENT_MAILBOX_INVALID');
    if (row.workspaceKey !== undefined && (typeof row.workspaceKey !== 'string' || !/^[a-f0-9]{64}$/.test(row.workspaceKey)) || row.lastHub !== undefined && !validBirth(row.lastHub) || !validBirth(row.host) || row.verification !== undefined && row.verification !== 'identity-v1' || row.recovery !== undefined && !uuid(row.recovery) ||
        row.phase !== undefined && !['ready', 'stopping', 'stopped', 'restoring'].includes(row.phase)) throw new LiveError('COMPONENT_MAILBOX_INVALID');
    if (row.failures && (!Array.isArray(row.failures) || row.failures.length > 8 || row.failures.some(f => f.fileRouteFailureReason !== undefined && fileRouteFailureReason(f) !== f.fileRouteFailureReason || !['prepare', 'stop', 'resume', 'release', 'verify', 'restartHost', 'repairRoute'].includes(f.action) || debugErrorCode({ code: f.code }) !== f.code || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(f.at)))) throw new LiveError('COMPONENT_MAILBOX_INVALID');
    if (row.request && (!uuid(row.request.id) || !uuid(row.request.recovery) || !['prepare', 'stop', 'resume', 'release', 'verify', 'restartHost', 'repairRoute'].includes(row.request.action) ||
        row.request.operation?.state !== 'active' || !uuid(row.request.operation.owner?.id) ||
        row.request.recovering !== undefined && typeof row.request.recovering !== 'boolean' ||
        row.request.action === 'verify' && !uuid(row.request.challenge) || row.request.action !== 'verify' && row.request.challenge !== undefined)) throw new LiveError('COMPONENT_MAILBOX_INVALID');
    if (row.reply && (row.reply.fileRouteFailureReason !== undefined && fileRouteFailureReason(row.reply) !== row.reply.fileRouteFailureReason || !uuid(row.reply.id) || typeof row.reply.ok !== 'boolean' || row.reply.code !== undefined && !/^[A-Z_]{1,80}$/.test(row.reply.code) || row.reply.receipt &&
        (!validBirth(row.reply.receipt.host) || !validBirth(row.reply.receipt.hub) || row.reply.receipt.contract !== '1.8.0' ||
          row.reply.receipt.stopped !== undefined && typeof row.reply.receipt.stopped !== 'boolean' || row.reply.receipt.verification !== undefined && row.reply.receipt.verification !== 'identity-v1'))) throw new LiveError('COMPONENT_MAILBOX_INVALID');
    if (row.reply?.verification && (!validBirth(row.reply.verification.host) || !validBirth(row.reply.verification.hub) || !/^[a-f0-9]{64}$/.test(row.reply.verification.digest))) throw new LiveError('COMPONENT_MAILBOX_INVALID');
  }
  if (new Set(v.actors.map(row => `${row.host.pid}:${row.host.startIdentity}`)).size !== v.actors.length) throw new LiveError('COMPONENT_MAILBOX_INVALID');
  return v;
}
/** Private same-user file IPC. Host identities are selected by the native
 * census, never by this registry. The operation/recovery lock authenticates a
 * request; filesystem ownership is the same trust boundary as existing locks.
 * No timeout restores a component or deletes a pending request. */
export class ComponentMailbox {
  private readonly state: LocalState<Mailboxes>;
  private running = false;
  private stopped = false;
  private timer: NodeJS.Timeout | undefined;
  private actor: LocalComponentActor | undefined;
  private receipt: ComponentReceipt | undefined;
  private currentRequest: Request | undefined;
  private settledReply: Reply | undefined;
  private restartEffect: { id: string; run: () => Promise<void> } | undefined;
  constructor(directory: string, private readonly host: ComponentBirth, private readonly locks: LiveLocks,
    private readonly create: (assertOwner: () => Promise<void>, recovering: boolean) => Promise<LocalComponentActor>,
    state?: LocalState<Mailboxes>, private readonly inspectHost: typeof probeProcessIdentity = probeProcessIdentity, private readonly options: ComponentMailboxOptions = {}) {
    if (options.workspaceKey !== undefined && (typeof options.workspaceKey !== 'string' || !/^[a-f0-9]{64}$/.test(options.workspaceKey))) throw new LiveError('COMPONENT_MAILBOX_INVALID');
    this.state = state ?? new PrivateState(directory, parse, () => ({ schema: 1, actors: [] }));
  }
  async start(): Promise<void> {
    const obsolete: ComponentBirth[] = [];
    for (const row of (await this.readStable()).actors) {
      if (row.recovery) continue;
      const status = await probeProcessIdentity(row.host.pid);
      if (status.state === 'dead' || status.state === 'alive' && status.startIdentity !== row.host.startIdentity) obsolete.push(row.host);
    }
    await this.state.transaction(state => {
      state.actors = state.actors.filter(row => row.recovery || !obsolete.some(host => same(host, row.host)));
      // Replacing a same-birth pending actor would lose an in-flight stop.
      if (state.actors.some(row => same(row.host, this.host))) throw new LiveError('COMPONENT_MAILBOX_ALREADY_REGISTERED');
      state.actors.push({ host: this.host, ...(this.options.workspaceKey ? { workspaceKey: this.options.workspaceKey } : {}) });
    });
    const tick = async (): Promise<void> => {
      if (this.stopped) return;
      try { await this.poll(); } catch { /* Durable request remains pending; never fake an ACK. */ }
      if (!this.stopped) { this.timer = setTimeout(() => { void tick(); }, 150); this.timer.unref(); }
    };
    void tick();
  }
  dispose(): void { this.stopped = true; clearTimeout(this.timer); }
  async hasRestoration(transaction?: string): Promise<boolean> {
    const actors = (await this.readStable()).actors;
    if (transaction !== undefined && actors.some(row => row.recovery && row.recovery !== transaction)) throw new LiveError('RECOVERY_CHANGED');
    return actors.some(row => !!row.recovery && (transaction === undefined || row.recovery === transaction));
  }
  async hasRouteRepair(transaction?: string): Promise<boolean> {
    return (await this.readStable()).actors.some(row => row.routeRepair && (transaction === undefined || row.recovery === transaction));
  }
  async recoverRoutes(operation: LockInspection, transaction: string): Promise<void> {
    const owned = async (): Promise<void> => {
      const marker = await this.locks.inspectRecovery();
      if (!await this.locks.isOperationCurrent(operation) || marker.owner?.schema !== 2 || marker.owner.id !== transaction || marker.owner.owner !== operation.owner?.owner) throw new LiveError('RECOVERY_CHANGED');
    };
    await owned();
    const rows = (await this.readStable()).actors;
    if (rows.some(row => row.routeRepair && row.recovery !== transaction)) throw new LiveError('RECOVERY_CHANGED');
    for (const row of rows) {
      if (!row.routeRepair || !row.recovery) continue;
      const host = await this.inspectHost(row.host.pid);
      if (host.state === 'unknown') throw new LiveError('HOST_IDENTITY_UNAVAILABLE');
      if (host.state === 'dead' || host.startIdentity !== row.host.startIdentity) {
        const old = await this.inspectHost(row.routeRepair.oldHub.pid);
        if (old.state === 'unknown' || old.state === 'alive' && old.startIdentity === row.routeRepair.oldHub.startIdentity) throw new LiveError('COMPONENT_ACTION_PENDING');
        if (row.routeRepair.newHub) {
          const next = await this.inspectHost(row.routeRepair.newHub.pid);
          if (next.state === 'unknown' || next.state === 'alive' && next.startIdentity === row.routeRepair.newHub.startIdentity) throw new LiveError('COMPONENT_ACTION_PENDING');
        }
        await owned();
        // Both recorded generations and their owning host exited. No account
        // was written by route repair. Preserve inert evidence in failures.
        await this.state.transaction(state => { const current = state.actors.find(a => same(a.host,row.host)); if (!current || current.recovery !== row.recovery) throw new LiveError('RECOVERY_CHANGED'); delete current.routeRepair; delete current.recovery; delete current.phase; });
        continue;
      }
      const peer = this.participant(row.host,operation,row.recovery);
      await peer.repairRoute(); await peer.release();
    }
  }
  async recoveryHosts(transaction: string): Promise<ComponentBirth[]> {
    if (!uuid(transaction)) throw new LiveError('RECOVERY_CHANGED');
    const actors = (await this.readStable()).actors;
    if (actors.some(row => row.recovery && row.recovery !== transaction)) throw new LiveError('RECOVERY_CHANGED');
    return actors.filter(row => row.recovery === transaction).map(row => ({ ...row.host }));
  }
  async recoveryParticipants(transaction: string, includeReleased = false): Promise<ComponentRecoveryParticipant[]> {
    if (!uuid(transaction)) throw new LiveError('RECOVERY_CHANGED');
    const actors = (await this.readStable()).actors;
    if (actors.some(row => row.recovery && row.recovery !== transaction)) throw new LiveError('RECOVERY_CHANGED');
    return actors.filter(row => row.recovery === transaction || includeReleased && this.releasedFrom(row, transaction)).map(row => ({ host: { ...row.host },
      ...(row.workspaceKey ? { workspaceKey: row.workspaceKey } : {}), ...(row.lastHub ? { lastHub: { ...row.lastHub } } : {}),
      ...(row.recovery ? { recovery: row.recovery } : {}), ...(row.phase ? { phase: row.phase } : {}), ...(row.failures ? { failures: structuredClone(row.failures) } : {}) }));
  }
  private releasedFrom(row: Actor, transaction: string): boolean {
    return row.recovery === undefined && row.phase === undefined && row.request?.action === 'release' &&
      row.request.recovery === transaction && row.reply?.id === row.request.id && row.reply.ok === true;
  }
  /** Rebind only an exact successful release from this transaction. The caller
   * must additionally possess the committed result and explicit user consent. */
  async rebindReleased(transaction: string, operation: LockInspection, host: ComponentBirth): Promise<void> {
    if (!uuid(transaction) || !validBirth(host)) throw new LiveError('RECOVERY_CHANGED');
    const owned = async (): Promise<void> => {
      if (operation.state !== 'active' || !operation.owner || !await this.locks.isOperationCurrent(operation)) throw new LiveError('LOCK_OWNERSHIP_CHANGED');
      const recovery = await this.locks.inspectRecovery();
      if (recovery.owner?.schema !== 2 || recovery.owner.id !== transaction || recovery.owner.owner !== operation.owner.owner) throw new LiveError('RECOVERY_CHANGED');
    };
    await owned();
    const identity = await this.inspectHost(host.pid);
    if (identity.state === 'unknown') throw new LiveError('HOST_IDENTITY_UNAVAILABLE');
    if (identity.state !== 'alive' || identity.startIdentity !== host.startIdentity) throw new LiveError('COMPONENT_PARTICIPANT_UNAVAILABLE');
    await owned();
    await this.state.transaction(state => {
      const row = state.actors.find(value => same(value.host, host));
      if (!row || !this.releasedFrom(row, transaction) || row.request?.operation.owner?.owner !== operation.owner?.owner) throw new LiveError('RECOVERY_CHANGED');
      row.recovery = transaction;
    });
  }
  /** After credential finalization, clear only explicitly proven host handoffs.
   * No component resume/stop hooks run; unknown process state never authorizes cleanup.
   * A new host may have exited after finalization: clearing its markers is only
   * historical cleanup, never evidence of a currently authenticated instance. */
  async finishHostRecovery(transaction: string, operation: LockInspection, oldHosts: ComponentBirth[], newHosts: ComponentBirth[]): Promise<void> {
    if (!uuid(transaction) || !oldHosts.length || !newHosts.length || [...oldHosts, ...newHosts].some(h => !validBirth(h)) ||
        new Set([...oldHosts, ...newHosts].map(h => `${h.pid}:${h.startIdentity}`)).size !== oldHosts.length + newHosts.length) throw new LiveError('RECOVERY_CHANGED');
    const owned = async (): Promise<void> => {
      if (!await this.locks.isOperationCurrent(operation) || (await this.locks.inspectRecovery()).state !== 'absent') throw new LiveError('RECOVERY_CHANGED');
    };
    await owned();
    for (const host of oldHosts) {
      const identity = await this.inspectHost(host.pid);
      if (identity.state === 'unknown') throw new LiveError('HOST_IDENTITY_UNAVAILABLE');
      if (identity.state === 'alive' && identity.startIdentity === host.startIdentity) throw new LiveError('COMPONENT_ACTION_PENDING');
    }
    const exitedNewHosts: ComponentBirth[] = [];
    for (const host of newHosts) {
      const identity = await this.inspectHost(host.pid);
      if (identity.state === 'unknown') throw new LiveError('HOST_IDENTITY_UNAVAILABLE');
      if (identity.state === 'dead' || identity.state === 'alive' && identity.startIdentity !== host.startIdentity) exitedNewHosts.push(host);
    }
    await owned();
    await this.state.transaction(state => {
      const matching = state.actors.filter(row => row.recovery === transaction);
      if (matching.some(row => !oldHosts.some(h => same(h, row.host)) && !newHosts.some(h => same(h, row.host))) ||
          newHosts.some(host => !state.actors.some(row => same(row.host, host) && (row.recovery === transaction && (row.phase === 'ready' || exitedNewHosts.some(h => same(h, host))) || row.recovery === undefined && row.phase === undefined && row.verification === undefined) && (!row.request || row.reply?.id === row.request.id))) ||
          [...oldHosts, ...newHosts].some(host => state.actors.some(row => same(row.host, host) && row.recovery !== undefined && row.recovery !== transaction))) throw new LiveError('RECOVERY_CHANGED');
      // Preserve old rows and diagnostics as inert evidence instead of deleting
      // failures. Only the transaction markers are cleared after exit proof.
      for (const row of matching) { delete row.recovery; delete row.phase; delete row.verification; }
    });
  }
  async requiresVerification(transaction: string): Promise<boolean> {
    if (!uuid(transaction)) throw new LiveError('RECOVERY_CHANGED');
    const actors = (await this.readStable()).actors;
    if (actors.some(row => row.recovery && row.recovery !== transaction)) throw new LiveError('RECOVERY_CHANGED');
    return actors.some(row => row.recovery === transaction && row.verification === 'identity-v1');
  }
  /** Complete component restoration after a committed credential transaction.
   * Absence of the shared recovery marker is mandatory. Pending credential
   * journals must be reconciled by the caller before using this operation. */
  async restoreCompleted(operation: LockInspection): Promise<void> {
    if (!await this.locks.isOperationCurrent(operation) || (await this.locks.inspectRecovery()).state !== 'absent') throw new LiveError('RECOVERY_CHANGED');
    const failures: ComponentFailureDetail[] = [];
    for (const row of (await this.readStable()).actors) {
      if (!row.recovery) continue;
      const identity = await probeProcessIdentity(row.host.pid);
      if (identity.state === 'unknown') throw new LiveError('HOST_IDENTITY_UNAVAILABLE');
      if (identity.state === 'alive' && identity.startIdentity === row.host.startIdentity) {
        const participant = this.participant(row.host, operation, row.recovery);
        try { await participant.resume(); }
        catch (error) { failures.push({ hostPid: row.host.pid, stage: 'resume', code: debugErrorCode(error) }); continue; }
        try { await participant.release(); }
        catch (error) { failures.push({ hostPid: row.host.pid, stage: 'release', code: debugErrorCode(error) }); }
      } else await this.state.transaction(state => {
        state.actors = state.actors.filter(value => !same(value.host, row.host));
      });
    }
    if (failures.length) throw new ComponentRestoreFailure(failures);
  }
  private async readStable(): Promise<Mailboxes> {
    const until = Date.now() + 2000;
    for (;;) {
      try { return await this.state.read(); }
      catch (error) {
        // Atomic replacement can unlink the descriptor a reader just opened,
        // changing its ctime while preserving immutable bytes. Reopen/reprove;
        // never accept that changed snapshot or retry ownership/schema errors.
        if (!(error instanceof Error) || error.message !== 'AUTOMATION_STORAGE_CHANGED' || Date.now() >= until) throw error;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
  }
  private async assertOwner(): Promise<void> {
    const request = this.currentRequest;
    if (!request || !await this.locks.isSharedOperationCurrent(request.operation)) throw new LiveError('LOCK_OWNERSHIP_CHANGED');
    const recovery = await this.locks.inspectRecovery();
    // Successful transaction finalization clears the recovery marker before
    // peers resume. An absent marker may authorize restoration/release only;
    // it must never authorize preparing or stopping another transaction.
    if (recovery.state === 'absent' && ['resume', 'release'].includes(request.action)) return;
    if (recovery.owner?.schema === 4 || recovery.owner?.id !== request.recovery || recovery.owner?.owner !== request.operation.owner?.owner) throw new LiveError('RECOVERY_CHANGED');
  }
  private async runRestartEffect(request: Request): Promise<void> {
    const effect = this.restartEffect;
    if (!effect || effect.id !== request.id) return;
    this.restartEffect = undefined; // Never repeat an ambiguous native dispatch.
    try {
      // The coordinator may release its operation as soon as it reads ACK.
      // This exception is ONLY for an acknowledged restart effect: the adapter
      // must revalidate its durable handoff, installed journal and recovery lock.
      const row = (await this.readStable()).actors.find(value => same(value.host, this.host));
      if (request.action !== 'restartHost' || row?.request?.id !== request.id || row.request.action !== 'restartHost' ||
          row.request.recovery !== request.recovery || row.reply?.id !== request.id || !row.reply.ok) throw new LiveError('RECOVERY_CHANGED');
      await effect.run();
    }
    catch (error) {
      const classified = debugErrorCode(error), code = classified === 'UNCLASSIFIED_ERROR' ? 'COMPONENT_PARTICIPANT_FAILED' : classified;
      await this.state.transaction(state => {
        const current = state.actors.find(value => same(value.host, this.host));
        if (!current) throw new LiveError('COMPONENT_MAILBOX_CHANGED');
        current.failures = [...(current.failures ?? []), { action: 'resume' as const, code, at: new Date().toISOString() }].slice(-8);
      });
    }
  }
  private async poll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const row = (await this.readStable()).actors.find(value => same(value.host, this.host));
      const request = row?.request;
      if (!row || !request || row.reply?.id === request.id) return;
      if (this.settledReply?.id === request.id) {
        const reply = this.settledReply;
        await this.state.transaction(state => {
          const current = state.actors.find(value => same(value.host, this.host));
          if (!current || current.request?.id !== request.id) throw new LiveError('COMPONENT_MAILBOX_CHANGED');
          current.reply = reply;
          if (!reply.ok) current.failures = [...(current.failures ?? []), { action: request.action === 'restartHost' ? 'resume' as const : request.action, code: reply.code ?? 'COMPONENT_PARTICIPANT_FAILED', ...(fileRouteFailureReason(reply) ? {fileRouteFailureReason: fileRouteFailureReason(reply)!} : {}), at: new Date().toISOString() }].slice(-8);
        });
        await this.runRestartEffect(request);
        return;
      }
      this.currentRequest = request;
      let verification: ComponentVerification | undefined;
      let ok = false;
      let code = 'COMPONENT_PARTICIPANT_FAILED';
      let routeReason: FileRouteFailureReason | undefined;
      try {
        await this.assertOwner();
        if (row.recovery && row.recovery !== request.recovery) throw new LiveError('RECOVERY_CHANGED');
        if (request.action === 'repairRoute') {
          if (!this.options.repairRoute || this.actor || this.receipt || row.recovery && !row.routeRepair) throw new LiveError('COMPONENT_CONTRACT_UNSUPPORTED');
          await this.options.repairRoute(row.routeRepair, async record => {
            await this.assertOwner();
            await this.state.transaction(state => {
              const current = state.actors.find(value => same(value.host, this.host));
              if (!current || current.request?.id !== request.id || record.transaction !== request.recovery || !same(record.host, this.host)) throw new LiveError('RECOVERY_CHANGED');
              current.routeRepair = structuredClone(record); current.recovery = request.recovery; current.lastHub = record.newHub ?? record.oldHub; current.phase = record.phase === 'proved' ? 'ready' : 'restoring';
            });
          }, () => this.assertOwner(), request.recovery);
        } else if (request.action === 'prepare') {
          if (row.routeRepair) throw new LiveError('COMPONENT_RESTORE_REQUIRED');
          // Finalized handoff cleanup may clear durable ownership while this
          // host remains alive. Drop only idle cached actors, without hooks.
          if (!row.recovery) { this.actor = undefined; this.receipt = undefined; }
          if (this.actor) {
            // A replacement coordinator may rejoin the SAME recovery only,
            // after obtaining the existing global operation lock. The local
            // actor must re-prove its actual state; a recorded ACK is not proof.
            if (!this.actor.describe || row.recovery !== request.recovery) throw new LiveError('COMPONENT_ACTION_PENDING');
            this.receipt = await this.actor.describe();
          } else {
            const actor = await this.create(() => this.assertOwner(), request.recovering === true);
            const receipt = await actor.prepare();
            this.actor = actor; this.receipt = receipt;
          }
          if (!this.actor?.verify && this.receipt) delete this.receipt.verification;
          await this.state.transaction(state => {
            const current = state.actors.find(value => same(value.host, this.host))!;
            current.recovery = request.recovery;
            if (this.receipt) current.lastHub = { ...this.receipt.hub };
            if (this.receipt?.verification === 'identity-v1') current.verification = 'identity-v1';
            current.phase = this.receipt?.stopped ? 'stopped' : 'ready';
          });
        } else if (request.action === 'restartHost') {
          if (row.recovery !== request.recovery || !this.options.restartHost) throw new LiveError('COMPONENT_CONTRACT_UNSUPPORTED');
          const effect = await this.options.restartHost(request.recovery);
          if (typeof effect !== 'function') throw new LiveError('COMPONENT_CONTRACT_UNSUPPORTED');
          await this.assertOwner();
          this.restartEffect = { id: request.id, run: effect };
        } else if (request.action === 'verify') {
          if (!this.actor?.verify || row.phase !== 'ready' || !uuid(request.challenge)) throw new LiveError('COMPONENT_CONTRACT_UNSUPPORTED');
          const result = await this.actor.verify(request.challenge);
          if (!validBirth(result.host) || !same(result.host, this.host) || !validBirth(result.hub) || !/^[a-f0-9]{64}$/.test(result.digest)) throw new LiveError('COMPONENT_IDENTITY_UNVERIFIED');
          verification = { host: { pid: result.host.pid, startIdentity: result.host.startIdentity }, hub: { pid: result.hub.pid, startIdentity: result.hub.startIdentity }, digest: result.digest };
          await this.assertOwner();
        } else if (request.action === 'stop' || request.action === 'resume') {
          if (!this.actor || !this.receipt) throw new LiveError('COMPONENT_ACTOR_UNAVAILABLE');
          await this.state.transaction(state => {
            state.actors.find(value => same(value.host, this.host))!.phase = request.action === 'stop' ? 'stopping' : 'restoring';
          });
          await this.assertOwner();
          if (request.action === 'stop') await this.actor.stop(); else await this.actor.resume();
          await this.assertOwner();
          await this.state.transaction(state => {
            state.actors.find(value => same(value.host, this.host))!.phase = request.action === 'stop' ? 'stopped' : 'ready';
          });
        } else {
          if (row.routeRepair && row.routeRepair.phase !== 'proved') throw new LiveError('COMPONENT_RESTORE_REQUIRED');
          if (row.phase && row.phase !== 'ready') throw new LiveError('COMPONENT_RESTORE_REQUIRED');
          this.actor = undefined; this.receipt = undefined;
          await this.state.transaction(state => {
            const current = state.actors.find(value => same(value.host, this.host))!;
            delete current.recovery; delete current.phase; delete current.verification; delete current.routeRepair;
          });
        }
        ok = true;
      } catch (error) {
        // Only our typed fixed codes; never persist official exception text.
        routeReason = fileRouteFailureReason(error);
        const classified = debugErrorCode(error);
        code = classified === 'UNCLASSIFIED_ERROR' ? 'COMPONENT_PARTICIPANT_FAILED' : classified;
      }
      const reply: Reply = { id: request.id, ok, ...(!ok ? { code, ...(routeReason ? { fileRouteFailureReason: routeReason } : {}) } : {}), ...(ok && request.action === 'prepare' && this.receipt ? { receipt: this.receipt } : {}), ...(ok && verification ? { verification } : {}) };
      this.settledReply = reply;
      await this.state.transaction(state => {
        const current = state.actors.find(value => same(value.host, this.host));
        if (!current || current.request?.id !== request.id) throw new LiveError('COMPONENT_MAILBOX_CHANGED');
        current.reply = reply;
        if (!ok) current.failures = [...(current.failures ?? []), { action: request.action === 'restartHost' ? 'resume' as const : request.action, code, ...(routeReason ? {fileRouteFailureReason: routeReason} : {}), at: new Date().toISOString() }].slice(-8);
      });
      if (ok) await this.runRestartEffect(request);
    } finally { this.running = false; }
  }
  participant(host: ComponentBirth, operation: LockInspection, recovery: string, timeoutMs = COMPONENT_REQUEST_TIMEOUT_MS, recovering = false): ComponentParticipant & { requestRestart(): Promise<void>; repairRoute(): Promise<void> } {
    let pending: { id: string; action: Action; challenge?: string } | undefined;
    const join = async (id: string, action: Action): Promise<Reply> => {
      const dispatched = async (): Promise<Reply | undefined> => {
        if (action !== 'restartHost') return;
        const row = (await this.readStable()).actors.find(value => same(value.host, host));
        if (row?.request?.id !== id || row.request.action !== 'restartHost' || row.request.recovery !== recovery || row.reply?.id !== id || !row.reply.ok) return;
        if (!await this.locks.isOperationCurrent(operation)) throw new LiveError('LOCK_OWNERSHIP_CHANGED');
        return row.reply; // Dispatch ACK only; never evidence of restart completion.
      };
      const until = Date.now() + timeoutMs;
      do {
        if (!await this.locks.isOperationCurrent(operation)) throw new LiveError('LOCK_OWNERSHIP_CHANGED');
        const ack = await dispatched(); if (ack) return ack;
        const identity = await this.inspectHost(host.pid);
        if (identity.state === 'dead' || identity.state === 'alive' && identity.startIdentity !== host.startIdentity) {
          const lateAck = await dispatched(); if (lateAck) return lateAck;
          throw new LiveError('COMPONENT_PARTICIPANT_UNAVAILABLE');
        }
        if (identity.state === 'unknown') throw new LiveError('HOST_IDENTITY_UNAVAILABLE');
        const row = (await this.readStable()).actors.find(value => same(value.host, host));
        if (row?.reply?.id === id) {
          if (!await this.locks.isOperationCurrent(operation)) throw new LiveError('LOCK_OWNERSHIP_CHANGED');
          return row.reply;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      } while (Date.now() < until);
      throw new LiveError('COMPONENT_ACTION_PENDING');
    };
    const checked = (reply: Reply): Reply => {
      if (!reply.ok) throw Object.assign(new LiveError(reply.code ?? 'COMPONENT_PARTICIPANT_FAILED'), fileRouteFailureReason(reply) ? {fileRouteFailureReason: fileRouteFailureReason(reply)!} : {});
      return reply;
    };
    const call = async (action: Action, challenge?: string): Promise<Reply> => {
      if (!await this.locks.isOperationCurrent(operation)) throw new LiveError('LOCK_OWNERSHIP_CHANGED');
      // A replacement coordinator joins a durable in-flight request before
      // issuing its own. The old actor may still be completing a real stop.
      const prior = (await this.readStable()).actors.find(value => same(value.host, host));
      if (!pending && prior?.request && prior.reply?.id !== prior.request.id) {
        if (prior.request.recovery !== recovery) throw new LiveError('RECOVERY_CHANGED');
        await join(prior.request.id, prior.request.action);
      }
      if (pending) {
        const previous = pending, reply = await join(previous.id, previous.action);
        pending = undefined;
        if (previous.action === action && previous.challenge === challenge) return checked(reply);
        // For cleanup, wait for the real prior action to settle even if its
        // result was failure. Do not discard its identity on an IPC timeout.
      }
      const id = randomUUID();
      await this.state.transaction(state => {
        const row = state.actors.find(value => same(value.host, host));
        if (!row) throw new LiveError('COMPONENT_PARTICIPANT_UNAVAILABLE');
        if (row.request && row.reply?.id !== row.request.id) throw new LiveError('COMPONENT_ACTION_PENDING');
        row.request = { id, action, operation, recovery, recovering, ...(challenge ? { challenge } : {}) }; delete row.reply;
      });
      pending = { id, action, ...(challenge ? { challenge } : {}) };
      const reply = await join(id, action); pending = undefined;
      return checked(reply);
    };
    return { host, prepare: async () => {
      const receipt = (await call('prepare')).receipt;
      if (!receipt || !same(receipt.host, host)) throw new LiveError('COMPONENT_MAILBOX_CHANGED');
      return receipt;
    }, verify: async challenge => {
      if (!uuid(challenge)) throw new LiveError('COMPONENT_IDENTITY_UNVERIFIED');
      const proof = (await call('verify', challenge)).verification;
      if (!proof || !same(proof.host, host)) throw new LiveError('COMPONENT_MAILBOX_CHANGED');
      return proof;
    }, repairRoute: async () => { await call('repairRoute'); }, requestRestart: async () => { await call('restartHost'); }, stop: async () => { await call('stop'); }, resume: async () => { await call('resume'); }, release: async () => { await call('release'); } };
  }
}
