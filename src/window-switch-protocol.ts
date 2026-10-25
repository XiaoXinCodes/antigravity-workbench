/** Window lifecycle only. No credential values, shell commands or official
 * extension hooks belong in this protocol. Platform adapters are mandatory;
 * implementing an adapter as a successful no-op violates this contract. */
export interface WindowBirth { pid: number; startIdentity: string }
export interface WindowReopenDescriptor {
  window: string;
  host: WindowBirth;
  scope: string;
  // Opaque capabilities issued and revalidated by a platform adapter, never
  // executable paths/argv supplied by a workspace or extension command caller.
  launcher: string;
  profile: string;
  authority: string;
  workspace: { kind: 'folder' | 'workspace'; uri: string };
}
export type WindowSwitchPhase = 'preparing' | 'armed' | 'closing' | 'switching' | 'reopening' | 'verifying' | 'verified' | 'cancelled' | 'recovery-required';
export interface WindowSwitchRecord {
  schema: 1;
  id: string;
  attempt: string;
  scope: string;
  phase: WindowSwitchPhase;
  windows: WindowReopenDescriptor[];
  closeRequested: string[];
  reopened: string[];
  deadline: number;
  executor?: WindowBirth;
  outcome?: 'original' | 'target' | 'unknown';
  reason?: string;
}
export interface WindowSwitchRuntime {
  /** Durable CAS/readback. The same cross-process attempt lock covers prepare,
   * execute and recover; it must survive neither host death nor lease loss. */
  exclusive<T>(work: () => Promise<T>): Promise<T>;
  read(): Promise<WindowSwitchRecord | undefined>;
  save(next: WindowSwitchRecord, expected: WindowSwitchRecord | undefined): Promise<void>;
  now(): number;
  cancelled(attempt: string): Promise<boolean>;
  /** Complete scope census, including relevant hosts with no Hub. Reject
   * unmapped hosts, unregistered windows and new births, not just ready peers. */
  participants(scope: string): Promise<{ complete: boolean; windows: WindowReopenDescriptor[] }>;
  /** Actively validate exact client/profile/authority + launcher survival.
   * Returning false/throwing must not close windows or mutate credentials. */
  canReopen(window: WindowReopenDescriptor): Promise<boolean>;
  /** Each participant uses native save handling, including untitled/custom
   * editors. false means cancel or save failure. Never discard dirty state. */
  saveWindow(window: WindowReopenDescriptor): Promise<boolean>;
  /** ACK only after independent executor has durably accepted this exact id,
   * attempt and descriptors. Lost ACK is not permission to close anything. */
  handoff(record: WindowSwitchRecord): Promise<{ id: string; attempt: string; executor: WindowBirth }>;
  assertExecutor(executor: WindowBirth): Promise<void>;
  /** Request THIS window's native close, preserving all native vetoes. */
  requestClose(window: WindowReopenDescriptor): Promise<void>;
  /** Observe exact birth exit. A close command result is never an exit ACK. */
  exited(window: WindowReopenDescriptor): Promise<boolean>;
  /** Join this exact close request. 'open' requires a definitive native veto
   * or cancellation with no pending close continuation; mere liveness is not
   * enough. 'pending' retains recovery so a late exit cannot be forgotten. */
  settleClose(window: WindowReopenDescriptor, attempt: string): Promise<'closed' | 'open' | 'pending'>;
  wait(): Promise<void>;
  /** Existing guarded transaction. Recheck all host/Hub exits and new births
   * before every mutation, retain backups, do not overwrite unknown bytes.
   * Return only after all writes have settled. Never abandon on a timeout. */
  switchAccount(record: WindowSwitchRecord): Promise<void>;
  /** Join the actual writer/operation lock, including lost/late acknowledgments.
   * unknown still means writers settled, but credentials must not be replaced. */
  settle(record: WindowSwitchRecord): Promise<'original' | 'target' | 'unknown'>;
  /** Idempotent by attempt+window; native adapter must return only after new
   * window registration, not simply successful spawn. Keep durable receipts. */
  reopen(window: WindowReopenDescriptor, attempt: string): Promise<void>;
  /** Fresh official identity proof after new host registration. */
  verify(record: WindowSwitchRecord, outcome: 'original' | 'target'): Promise<boolean>;
}
export class WindowSwitchError extends Error {
  constructor(readonly code: string) { super(code); }
}
function fail(code: string): never { throw new WindowSwitchError(code); }
const key = (w: WindowReopenDescriptor): string => JSON.stringify(w);
const code = (e: unknown): string => e instanceof WindowSwitchError ? e.code : 'WINDOW_ADAPTER_FAILED';
function descriptors(windows: WindowReopenDescriptor[], scope: string): void {
  if (!windows.length || windows.length > 32 || new Set(windows.map(w => w.window)).size !== windows.length ||
    new Set(windows.map(w => `${w.host.pid}:${w.host.startIdentity}`)).size !== windows.length) fail('WINDOW_PARTICIPANTS_UNVERIFIED');
  for (const w of windows) {
    if (w.scope !== scope || !Number.isSafeInteger(w.host.pid) || w.host.pid < 1 ||
      ![w.window, w.host.startIdentity, w.launcher, w.profile, w.authority, w.workspace.uri].every(v => typeof v === 'string' && v.length > 0 && v.length <= 4096 && ![...v].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) ||
      !['folder', 'workspace'].includes(w.workspace.kind)) fail('WINDOW_DESCRIPTOR_UNVERIFIED');
  }
}
/** Platform-independent implementation, intentionally NOT wired to production
 * until a Windows/WSL adapter proves the capabilities described above. */
export class WindowSwitchProtocol {
  constructor(private readonly io: WindowSwitchRuntime) {}
  private async save(next: WindowSwitchRecord, previous: WindowSwitchRecord | undefined): Promise<WindowSwitchRecord> {
    await this.io.save(structuredClone(next), previous);
    return next;
  }
  private async checkpoint(r: WindowSwitchRecord): Promise<void> {
    if (await this.io.cancelled(r.attempt)) fail('WINDOW_CANCELLED');
    if (this.io.now() >= r.deadline) fail('WINDOW_TIMEOUT');
  }
  private async roster(r: WindowSwitchRecord): Promise<void> {
    const actual = await this.io.participants(r.scope);
    if (!actual.complete) fail('WINDOW_PARTICIPANTS_UNVERIFIED');
    descriptors(actual.windows, r.scope);
    if (actual.windows.length !== r.windows.length || actual.windows.some(w => !r.windows.some(old => key(w) === key(old)))) fail('WINDOW_PARTICIPANTS_CHANGED');
  }
  prepare(input: { id: string; attempt: string; scope: string; confirmed: boolean; deadline: number }): Promise<void> {
    return this.io.exclusive(async () => {
      // Existing/legacy/offline attempts are never implicitly adopted or reset.
      if (await this.io.read()) fail('WINDOW_ATTEMPT_EXISTS');
      if (!input.confirmed) fail('WINDOW_CONSENT_REQUIRED');
      if (![input.id, input.attempt, input.scope].every(v => typeof v === 'string' && /^[a-zA-Z0-9-]{1,128}$/.test(v)) ||
        !Number.isFinite(input.deadline) || input.deadline <= this.io.now() || input.deadline - this.io.now() > 300_000) fail('WINDOW_ARGUMENT_INVALID');
      const actual = await this.io.participants(input.scope);
      if (!actual.complete) fail('WINDOW_PARTICIPANTS_UNVERIFIED');
      descriptors(actual.windows, input.scope);
      let r: WindowSwitchRecord = { schema: 1, id: input.id, attempt: input.attempt, scope: input.scope, deadline: input.deadline,
        phase: 'preparing', windows: structuredClone(actual.windows), closeRequested: [], reopened: [] };
      for (const w of r.windows) if (!await this.io.canReopen(w)) fail('WINDOW_REOPEN_UNAVAILABLE');
      r = await this.save(r, undefined);
      try {
        for (const w of r.windows) {
          await this.checkpoint(r);
          if (!await this.io.saveWindow(w)) fail('WINDOW_SAVE_CANCELLED');
        }
        await this.roster(r); await this.checkpoint(r);
        const ack = await this.io.handoff(structuredClone(r));
        if (ack.id !== r.id || ack.attempt !== r.attempt || !Number.isSafeInteger(ack.executor.pid) || ack.executor.pid < 1 || !ack.executor.startIdentity) fail('WINDOW_HANDOFF_UNVERIFIED');
        await this.io.assertExecutor(ack.executor);
        await this.checkpoint(r);
        await this.save({ ...r, phase: 'armed', executor: ack.executor }, r);
      } catch (e) {
        // No window can be closed while durable phase remains preparing.
        await this.save({ ...r, phase: 'cancelled', reason: code(e), outcome: 'original' }, r);
        throw e;
      }
    });
  }
  execute(attempt: string): Promise<void> {
    return this.io.exclusive(async () => {
      let r = await this.io.read();
      if (!r || r.attempt !== attempt || r.phase !== 'armed' || !r.executor) fail('WINDOW_ATTEMPT_NOT_ARMED');
      await this.io.assertExecutor(r.executor);
      let finishing = false;
      try {
        await this.roster(r); await this.checkpoint(r);
        for (const w of r.windows) if (!await this.io.canReopen(w)) fail('WINDOW_REOPEN_UNAVAILABLE');
        for (const w of r.windows) {
          await this.checkpoint(r);
          r = await this.save({ ...r, phase: 'closing', closeRequested: [...r.closeRequested, w.window] }, r);
          await this.io.requestClose(w);
          while (!await this.io.exited(w)) { await this.checkpoint(r); await this.io.wait(); }
        }
        await this.checkpoint(r);
        r = await this.save({ ...r, phase: 'switching' }, r);
        await this.io.switchAccount(structuredClone(r));
        finishing = true;
        await this.finish(r);
      } catch (e) {
        if (finishing) throw e;
        // Re-read durable stage: the writer may have committed before an ACK
        // was lost. Never run the credential switch a second time here.
        const current = await this.io.read();
        if (!current || current.attempt !== attempt) throw e;
        await this.finish(current, code(e));
        throw e;
      }
    });
  }
  /** Recovery is explicit. It never continues an interrupted switch/close. */
  recover(attempt: string): Promise<void> {
    return this.io.exclusive(async () => {
      const r = await this.io.read();
      if (!r || r.attempt !== attempt || r.phase === 'verified' || r.phase === 'cancelled') fail('WINDOW_RECOVERY_NOT_PENDING');
      await this.finish(r, r.reason ?? 'WINDOW_INTERRUPTED');
    });
  }
  private async finish(initial: WindowSwitchRecord, reason?: string): Promise<void> {
    let r = initial;
    try {
      const outcome = await this.io.settle(structuredClone(r));
      r = await this.save({ ...r, phase: 'reopening', outcome, ...(reason ? { reason } : {}) }, r);
      let closePending = false;
      for (const w of r.windows) {
        if (!r.closeRequested.includes(w.window) || r.reopened.includes(w.window)) continue;
        const close = await this.io.settleClose(w, r.attempt);
        // One unresolved native dialog must not strand OTHER windows whose
        // exact old births are already gone. Keep the attempt unresolved,
        // but restore every independently confirmed closed participant.
        if (close === 'pending') { closePending = true; continue; }
        const gone = await this.io.exited(w);
        if (gone !== (close === 'closed')) fail('WINDOW_CLOSE_UNVERIFIED');
        if (close === 'open') continue;
        await this.io.reopen(w, r.attempt);
        r = await this.save({ ...r, reopened: [...r.reopened, w.window] }, r);
      }
      if (closePending) fail('WINDOW_CLOSE_PENDING');
      if (outcome === 'unknown') fail('WINDOW_STORAGE_IDENTITY_UNKNOWN');
      r = await this.save({ ...r, phase: 'verifying' }, r);
      if (!await this.io.verify(structuredClone(r), outcome)) fail('WINDOW_IDENTITY_UNVERIFIED');
      await this.save({ ...r, phase: outcome === 'target' ? 'verified' : 'cancelled' }, r);
    } catch (e) {
      await this.save({ ...r, phase: 'recovery-required', reason: code(e) }, r);
      throw e;
    }
  }
}
