import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { PrivateState } from './private-state';
import { probeProcessIdentity } from './live-lock';
import { WindowReopen, type ReopenIO } from './window-reopen';
import { WindowSwitchError, type WindowBirth } from './window-switch-protocol';
import { validateWslLaunchPlan, type WslLaunchPlan, type WslWindowLauncher } from './wsl-window-launcher';

export interface GroupReopenMember { window: string; host: WindowBirth; plan: WslLaunchPlan; scope: string }
interface Group { attempt: string; phase: 'preparing' | 'ready'; members: GroupReopenMember[]; requested: string[] }
interface GroupState { group?: Group }
export interface GroupReopenResult { reopened: string[]; pending: string[]; failed: { window: string; code: string }[] }
const native: ReopenIO = {
  async exited(host) { const p = await probeProcessIdentity(host.pid); return p.state === 'dead' || p.state === 'alive' && p.startIdentity !== host.startIdentity; },
  async alive(host) { const p = await probeProcessIdentity(host.pid); return p.state === 'alive' && p.startIdentity === host.startIdentity; },
  now: Date.now, wait: () => new Promise(resolve => setTimeout(resolve, 100)),
};
const id = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(v);
function parse(value: unknown): GroupState {
  const s = value as GroupState;
  if (!s || typeof s !== 'object' || Object.keys(s).some(k => k !== 'group')) throw new WindowSwitchError('WINDOW_GROUP_INVALID');
  if (!s.group) return {};
  const g = s.group;
  if (Object.keys(g).some(k => !['attempt','phase','members','requested'].includes(k)) || !/^[a-f0-9-]{36}$/.test(g.attempt) ||
      !['preparing','ready'].includes(g.phase) || !Array.isArray(g.members) || !g.members.length || g.members.length > 32 || !Array.isArray(g.requested)) throw new WindowSwitchError('WINDOW_GROUP_INVALID');
  const members = g.members.map(m => {
    if (!m || Object.keys(m).some(k => !['window','host','plan','scope'].includes(k)) || !id(m.window) || !id(m.scope) || !m.host ||
        Object.keys(m.host).some(k => !['pid','startIdentity'].includes(k)) || !Number.isSafeInteger(m.host.pid) || m.host.pid < 1 ||
        typeof m.host.startIdentity !== 'string' || !m.host.startIdentity.length || m.host.startIdentity.length > 256) throw new WindowSwitchError('WINDOW_GROUP_INVALID');
    return { ...m, plan: validateWslLaunchPlan(m.plan) };
  });
  if (new Set(members.map(m => m.window)).size !== members.length || new Set(members.map(m => `${m.host.pid}:${m.host.startIdentity}`)).size !== members.length ||
      new Set(members.map(m => m.plan.workspace.uri)).size !== members.length || new Set(members.map(m => m.scope)).size !== 1 ||
      new Set(g.requested).size !== g.requested.length || g.requested.some(w => !members.some(m => m.window === w))) throw new WindowSwitchError('WINDOW_GROUP_INVALID');
  return { group: { ...g, members } };
}
/** Actual persistent multi-window reopen receipts. Call prepare/recover/clear
 * under the account operation lock; only registration/dispatch acknowledgments
 * are concurrent. No credentials, commands or arbitrary paths are persisted. */
export class WindowGroupReopen {
  readonly directory: string;
  private readonly state: PrivateState<GroupState>;
  constructor(home: string, private readonly io: ReopenIO = native) {
    this.directory = path.join(home, '.gemini', 'antigravity-workbench-window-group');
    this.state = new PrivateState(this.directory, parse, () => ({}));
  }
  private child(g: Group, m: GroupReopenMember): WindowReopen {
    const segment = createHash('sha256').update(g.attempt).update('\0').update(m.window).digest('hex');
    return new WindowReopen(path.join(this.directory, 'receipts', segment), this.io);
  }
  private async receiptState(g: Group, m: GroupReopenMember): Promise<{ phase: string; newHost?: WindowBirth; closeRequested: boolean }> {
    type Receipt = { request?: { attempt: string; phase: string; plan: WslLaunchPlan; oldHost: WindowBirth; newHost?: WindowBirth; closeRequested: boolean } };
    const state = await new PrivateState<Receipt>(this.child(g, m).directory, value => {
      const r = value as Receipt, q = r?.request;
      if (!q || Object.keys(r).some(k => k !== 'request') || Object.keys(q).some(k => !['attempt','phase','plan','oldHost','newHost','closeRequested'].includes(k)) ||
          q.attempt !== g.attempt || !['prepared','launching','registered'].includes(q.phase) || !isDeepStrictEqual(q.plan, m.plan) ||
          !isDeepStrictEqual(q.oldHost, m.host) || typeof q.closeRequested !== 'boolean' ||
          q.newHost !== undefined && (!Number.isSafeInteger(q.newHost.pid) || q.newHost.pid < 1 || typeof q.newHost.startIdentity !== 'string' || !q.newHost.startIdentity.length)) throw new WindowSwitchError('WINDOW_GROUP_INVALID');
      return r;
    }, () => { throw new WindowSwitchError('WINDOW_GROUP_INVALID'); }).read();
    return state.request!;
  }
  private async read(): Promise<Group | undefined> {
    try { await fs.lstat(this.directory); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; }
    return (await this.state.read()).group;
  }
  async hasAttempt(attempt: string): Promise<boolean> { return (await this.read())?.attempt === attempt; }
  async prepare(attempt: string, members: GroupReopenMember[]): Promise<void> {
    const proposed = parse({ group: { attempt, phase: 'preparing', members, requested: [] } }).group!;
    await this.state.transaction(s => {
      if (s.group) {
        if (s.group.attempt !== attempt || !isDeepStrictEqual(s.group.members, proposed.members)) throw new WindowSwitchError('WINDOW_GROUP_PENDING');
      } else s.group = proposed;
    });
    const g = (await this.read())!;
    if (g.phase === 'ready') return;
    for (const m of g.members) {
      const receipt = this.child(g, m);
      if (!await receipt.hasAttempt(attempt)) await receipt.prepare(attempt, m.plan, m.host);
      else await this.receiptState(g, m);
    }
    await this.state.transaction(s => {
      if (!s.group || s.group.attempt !== attempt || !isDeepStrictEqual(s.group.members, g.members) || s.group.phase !== 'preparing') throw new WindowSwitchError('WINDOW_ATTEMPT_CHANGED');
      s.group.phase = 'ready';
    });
  }
  async markCloseRequested(attempt: string, window: string): Promise<void> {
    const g = await this.read(), m = g?.members.find(w => w.window === window);
    if (!g || !m || g.attempt !== attempt || g.phase !== 'ready') throw new WindowSwitchError('WINDOW_GROUP_NOT_READY');
    // Child intent first. A crash before group intent remains safe: the caller
    // has not been allowed to dispatch yet and child will refuse early cleanup.
    if (!g.requested.includes(window)) await this.child(g, m).markCloseRequested(attempt);
    await this.state.transaction(s => {
      if (!s.group || s.group.attempt !== attempt || s.group.phase !== 'ready' || !isDeepStrictEqual(s.group.members, g.members)) throw new WindowSwitchError('WINDOW_ATTEMPT_CHANGED');
      if (!s.group.requested.includes(window)) s.group.requested.push(window);
    });
  }
  async claim(workspaceUri: string, remoteName: string | null, current: WindowBirth): Promise<boolean> {
    const g = await this.read();
    if (!g || g.phase !== 'ready' || remoteName !== 'wsl') return false;
    const m = g.members.find(w => w.plan.workspace.uri === workspaceUri);
    return !!m && this.child(g, m).claim(workspaceUri, remoteName, current);
  }
  async recover(attempt: string, launcher: Pick<WslWindowLauncher, 'launch'>, deadlineMs = 30_000): Promise<GroupReopenResult> {
    const g = await this.read();
    if (!g || g.attempt !== attempt || g.phase !== 'ready') throw new WindowSwitchError('WINDOW_GROUP_NOT_READY');
    const result: GroupReopenResult = { reopened: [], pending: [], failed: [] };
    for (const m of g.members) {
      try {
        if (!await this.io.exited(m.host)) { if (g.requested.includes(m.window)) result.pending.push(m.window); continue; }
        // Even a participant that exited before its close command needs its
        // workspace restored. The child's durable spawn intent fences retries.
        await this.child(g, m).reopen(attempt, launcher, deadlineMs);
        result.reopened.push(m.window);
      } catch (e) {
        result.failed.push({ window: m.window, code: e instanceof WindowSwitchError ? e.code : 'WINDOW_REOPEN_FAILED' });
      }
    }
    return result;
  }
  /** Orphan preparation cleanup only. Caller holds the credential operation
   * lock and has established that no matching runtime channel exists. Missing
   * children can result from a crash during prepare; they are not created here.
   * Retain every existing child as evidence and never start or stop a process. */
  async clearUnstarted(attempt: string): Promise<void> {
    const g = await this.read();
    if (!g || g.attempt !== attempt || g.requested.length) throw new WindowSwitchError('WINDOW_REOPEN_PENDING');
    for (const m of g.members) {
      if (!await this.io.alive(m.host)) throw new WindowSwitchError('WINDOW_REOPEN_PENDING');
      try { await fs.lstat(path.join(this.child(g, m).directory, 'state.json')); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; throw e; }
      const r = await this.receiptState(g, m);
      if (r.phase !== 'prepared' || r.closeRequested) throw new WindowSwitchError('WINDOW_REOPEN_PENDING');
    }
    // Recheck after awaited receipt inspection, not just an earlier census.
    for (const m of g.members) if (!await this.io.alive(m.host)) throw new WindowSwitchError('WINDOW_REOPEN_PENDING');
    await this.state.transaction(s => {
      if (!s.group || !isDeepStrictEqual(s.group, g)) throw new WindowSwitchError('WINDOW_ATTEMPT_CHANGED');
      delete s.group;
    });
  }
  /** Only the fresh identity-verified account completion path invokes this.
   * Check every receipt BEFORE dropping the group marker. Child receipts are
   * retained as inert evidence under the unique attempt directories; deleting
   * them one at a time would lose retryability on a partial cleanup crash. */
  async clearVerified(attempt: string): Promise<void> {
    const g = await this.read();
    if (!g || g.attempt !== attempt || g.phase !== 'ready') throw new WindowSwitchError('WINDOW_GROUP_NOT_READY');
    for (const m of g.members) {
      const r = await this.receiptState(g, m);
      const registered = r.phase === 'registered' && r.newHost && await this.io.exited(m.host) && await this.io.alive(r.newHost);
      const undispatched = r.phase === 'prepared' && !r.closeRequested && await this.io.alive(m.host);
      if (!registered && !undispatched) throw new WindowSwitchError('WINDOW_REOPEN_PENDING');
    }
    await this.state.transaction(s => {
      if (!s.group || !isDeepStrictEqual(s.group, g)) throw new WindowSwitchError('WINDOW_ATTEMPT_CHANGED');
      delete s.group;
    });
  }
}
