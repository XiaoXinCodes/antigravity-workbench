import { randomUUID } from 'node:crypto';
import { LiveError } from './live-storage';
import { probeProcessIdentity, type LockInspection, type LiveLocks } from './live-lock';
import { type LocalState, PrivateState } from './private-state';
import type { ComponentBirth, ComponentParticipant, ComponentReceipt } from './component-coordination';

type Action = 'prepare' | 'stop' | 'resume' | 'release';
interface Request { id: string; action: Action; operation: LockInspection; recovery: string; recovering?: boolean }
interface Reply { id: string; ok: boolean; code?: string; receipt?: ComponentReceipt }
interface Actor { host: ComponentBirth; request?: Request; reply?: Reply; recovery?: string; phase?: 'ready' | 'stopping' | 'stopped' | 'restoring' }
interface Mailboxes { schema: 1; actors: Actor[] }
export interface LocalComponentActor {
  /** Read-only once create has settled; failure dispatches no stop/restart. */
  prepare(): Promise<ComponentReceipt>; stop(): Promise<void>; resume(): Promise<void>;
  describe?(): Promise<ComponentReceipt>;
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
    if (!validBirth(row.host) || row.recovery !== undefined && !uuid(row.recovery) ||
        row.phase !== undefined && !['ready', 'stopping', 'stopped', 'restoring'].includes(row.phase)) throw new LiveError('COMPONENT_MAILBOX_INVALID');
    if (row.request && (!uuid(row.request.id) || !uuid(row.request.recovery) || !['prepare', 'stop', 'resume', 'release'].includes(row.request.action) ||
        row.request.operation?.state !== 'active' || !uuid(row.request.operation.owner?.id) ||
        row.request.recovering !== undefined && typeof row.request.recovering !== 'boolean')) throw new LiveError('COMPONENT_MAILBOX_INVALID');
    if (row.reply && (!uuid(row.reply.id) || typeof row.reply.ok !== 'boolean' || row.reply.code !== undefined && !/^[A-Z_]{1,80}$/.test(row.reply.code) || row.reply.receipt &&
        (!validBirth(row.reply.receipt.host) || !validBirth(row.reply.receipt.hub) || row.reply.receipt.contract !== '1.8.0' ||
          row.reply.receipt.stopped !== undefined && typeof row.reply.receipt.stopped !== 'boolean'))) throw new LiveError('COMPONENT_MAILBOX_INVALID');
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
  constructor(directory: string, private readonly host: ComponentBirth, private readonly locks: LiveLocks,
    private readonly create: (assertOwner: () => Promise<void>, recovering: boolean) => Promise<LocalComponentActor>,
    state?: LocalState<Mailboxes>) {
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
      state.actors.push({ host: this.host });
    });
    const tick = async (): Promise<void> => {
      if (this.stopped) return;
      try { await this.poll(); } catch { /* Durable request remains pending; never fake an ACK. */ }
      if (!this.stopped) { this.timer = setTimeout(() => { void tick(); }, 150); this.timer.unref(); }
    };
    void tick();
  }
  dispose(): void { this.stopped = true; clearTimeout(this.timer); }
  async hasRestoration(): Promise<boolean> { return (await this.readStable()).actors.some(row => !!row.recovery); }
  /** Complete component restoration after a committed credential transaction.
   * Absence of the shared recovery marker is mandatory. Pending credential
   * journals must be reconciled by the caller before using this operation. */
  async restoreCompleted(operation: LockInspection): Promise<void> {
    if (!await this.locks.isOperationCurrent(operation) || (await this.locks.inspectRecovery()).state !== 'absent') throw new LiveError('RECOVERY_CHANGED');
    for (const row of (await this.readStable()).actors) {
      if (!row.recovery) continue;
      const identity = await probeProcessIdentity(row.host.pid);
      if (identity.state === 'unknown') throw new LiveError('HOST_IDENTITY_UNAVAILABLE');
      if (identity.state === 'alive' && identity.startIdentity === row.host.startIdentity) {
        const participant = this.participant(row.host, operation, row.recovery);
        await participant.resume(); await participant.release();
      } else await this.state.transaction(state => {
        state.actors = state.actors.filter(value => !same(value.host, row.host));
      });
    }
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
        });
        return;
      }
      this.currentRequest = request;
      let ok = false;
      let code = 'COMPONENT_PARTICIPANT_FAILED';
      try {
        await this.assertOwner();
        if (row.recovery && row.recovery !== request.recovery) throw new LiveError('RECOVERY_CHANGED');
        if (request.action === 'prepare') {
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
          await this.state.transaction(state => {
            const current = state.actors.find(value => same(value.host, this.host))!;
            current.recovery = request.recovery; current.phase = this.receipt?.stopped ? 'stopped' : 'ready';
          });
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
          if (row.phase && row.phase !== 'ready') throw new LiveError('COMPONENT_RESTORE_REQUIRED');
          this.actor = undefined; this.receipt = undefined;
          await this.state.transaction(state => {
            const current = state.actors.find(value => same(value.host, this.host))!;
            delete current.recovery; delete current.phase;
          });
        }
        ok = true;
      } catch (error) {
        // Only our typed fixed codes; never persist official exception text.
        if (error instanceof LiveError && /^[A-Z_]{1,80}$/.test(error.code)) code = error.code;
      }
      const reply: Reply = { id: request.id, ok, ...(!ok ? { code } : {}), ...(ok && request.action === 'prepare' && this.receipt ? { receipt: this.receipt } : {}) };
      this.settledReply = reply;
      await this.state.transaction(state => {
        const current = state.actors.find(value => same(value.host, this.host));
        if (!current || current.request?.id !== request.id) throw new LiveError('COMPONENT_MAILBOX_CHANGED');
        current.reply = reply;
      });
    } finally { this.running = false; }
  }
  participant(host: ComponentBirth, operation: LockInspection, recovery: string, timeoutMs = 40_000, recovering = false): ComponentParticipant {
    let pending: { id: string; action: Action } | undefined;
    const join = async (id: string): Promise<Reply> => {
      const until = Date.now() + timeoutMs;
      do {
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
      if (!reply.ok) throw new LiveError(reply.code ?? 'COMPONENT_PARTICIPANT_FAILED');
      return reply;
    };
    const call = async (action: Action): Promise<Reply> => {
      if (!await this.locks.isOperationCurrent(operation)) throw new LiveError('LOCK_OWNERSHIP_CHANGED');
      // A replacement coordinator joins a durable in-flight request before
      // issuing its own. The old actor may still be completing a real stop.
      const prior = (await this.readStable()).actors.find(value => same(value.host, host));
      if (!pending && prior?.request && prior.reply?.id !== prior.request.id) {
        if (prior.request.recovery !== recovery) throw new LiveError('RECOVERY_CHANGED');
        await join(prior.request.id);
      }
      if (pending) {
        const previous = pending, reply = await join(previous.id);
        pending = undefined;
        if (previous.action === action) return checked(reply);
        // For cleanup, wait for the real prior action to settle even if its
        // result was failure. Do not discard its identity on an IPC timeout.
      }
      const id = randomUUID();
      await this.state.transaction(state => {
        const row = state.actors.find(value => same(value.host, host));
        if (!row) throw new LiveError('COMPONENT_PARTICIPANT_UNAVAILABLE');
        if (row.request && row.reply?.id !== row.request.id) throw new LiveError('COMPONENT_ACTION_PENDING');
        row.request = { id, action, operation, recovery, recovering }; delete row.reply;
      });
      pending = { id, action };
      const reply = await join(id); pending = undefined;
      return checked(reply);
    };
    return { host, prepare: async () => {
      const receipt = (await call('prepare')).receipt;
      if (!receipt || !same(receipt.host, host)) throw new LiveError('COMPONENT_MAILBOX_CHANGED');
      return receipt;
    }, stop: async () => { await call('stop'); }, resume: async () => { await call('resume'); }, release: async () => { await call('release'); } };
  }
}
