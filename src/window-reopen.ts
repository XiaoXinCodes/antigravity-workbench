import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { PrivateState } from './private-state';
import { probeProcessIdentity } from './live-lock';
import { WindowSwitchError, type WindowBirth } from './window-switch-protocol';
import { WslWindowLauncher, WindowLaunchNotDispatched, validateWslLaunchPlan, type WslLaunchPlan } from './wsl-window-launcher';

interface ReopenRequest {
  attempt: string; phase: 'prepared' | 'launching' | 'registered';
  plan: WslLaunchPlan; oldHost: WindowBirth; newHost?: WindowBirth;
  closeRequested: boolean;
}
const equalBirth = (a: WindowBirth, b: WindowBirth): boolean => a.pid === b.pid && a.startIdentity === b.startIdentity;
const validBirth = (b: WindowBirth): boolean => !!b && Number.isSafeInteger(b.pid) && b.pid > 0 && typeof b.startIdentity === 'string' && b.startIdentity.length > 0 && b.startIdentity.length < 256;
export interface ReopenIO {
  exited(host: WindowBirth): Promise<boolean>;
  alive(host: WindowBirth): Promise<boolean>;
  now(): number;
  wait(): Promise<void>;
}
const native: ReopenIO = {
  async exited(host) { const p = await probeProcessIdentity(host.pid); return p.state === 'dead' || p.state === 'alive' && p.startIdentity !== host.startIdentity; },
  async alive(host) { const p = await probeProcessIdentity(host.pid); return p.state === 'alive' && p.startIdentity === host.startIdentity; },
  now: Date.now, wait: () => new Promise(resolve => setTimeout(resolve, 100)),
};
/** One active reopen per credential scope. Durable launch intent prevents
 * duplicate windows after lost acknowledgments; a new extension host claims
 * only its matching workspace and only after the exact original birth exits. */
export class WindowReopen {
  private readonly state: PrivateState<{ request?: ReopenRequest }>;
  readonly directory: string;
  constructor(home: string, private readonly io: ReopenIO = native) {
    this.directory = path.join(home, '.gemini', 'antigravity-workbench-window-reopen');
    this.state = new PrivateState(this.directory, value => {
      const data = value as { request?: ReopenRequest };
      if (!data || typeof data !== 'object' || Object.keys(data).some(k => k !== 'request')) throw new WindowSwitchError('WINDOW_REOPEN_RECORD_INVALID');
      if (!data.request) return {};
      const r = data.request;
      if (Object.keys(r).some(k => !['attempt','phase','plan','oldHost','newHost','closeRequested'].includes(k)) || typeof r.closeRequested !== 'boolean' ||
        !/^[a-f0-9-]{36}$/.test(r.attempt) || !['prepared','launching','registered'].includes(r.phase) || !validBirth(r.oldHost) ||
        r.newHost !== undefined && !validBirth(r.newHost) || r.phase === 'registered' && !r.newHost) throw new WindowSwitchError('WINDOW_REOPEN_RECORD_INVALID');
      return { request: { ...r, plan: validateWslLaunchPlan(r.plan) } };
    }, () => ({}));
  }
  async prepare(attempt: string, plan: WslLaunchPlan, oldHost: WindowBirth): Promise<void> {
    await this.state.transaction(data => {
      if (data.request) throw new WindowSwitchError('WINDOW_REOPEN_PENDING');
      data.request = { attempt, plan: validateWslLaunchPlan(plan), oldHost, phase: 'prepared', closeRequested: false };
    });
  }
  async hasAttempt(attempt: string): Promise<boolean> {
    try { await fs.lstat(this.directory); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
    return (await this.state.read()).request?.attempt === attempt;
  }
  async clearVerified(attempt: string): Promise<void> {
    // Called only after the account transaction's fresh identity verification;
    // not by startup registration or CLI completion.
    const original = (await this.state.read()).request;
    const undispatched = original?.attempt === attempt && original.phase === 'prepared' && !original.closeRequested && await this.io.alive(original.oldHost);
    await this.state.transaction(data => {
      if (data.request?.attempt !== attempt || data.request.phase !== 'registered' && !(undispatched && data.request.phase === 'prepared' && !data.request.closeRequested)) throw new WindowSwitchError('WINDOW_REOPEN_PENDING');
      delete data.request;
    });
  }
  async markCloseRequested(attempt: string): Promise<void> {
    await this.state.transaction(data => {
      if (data.request?.attempt !== attempt || data.request.phase !== 'prepared') throw new WindowSwitchError('WINDOW_REOPEN_PENDING');
      data.request.closeRequested = true;
    });
  }
  /** Lifecycle settlement only, called under the credential transaction lock.
   * A failed target login need NOT authenticate before restoring its backup.
   * This never clears the account journal/marker or any credential material. */
  async releaseForRecovery(attempt: string, currentHost: WindowBirth): Promise<void> {
    const r = (await this.state.read()).request;
    if (!r || r.attempt !== attempt || !await this.io.alive(currentHost)) throw new WindowSwitchError('WINDOW_REOPEN_PENDING');
    const registered = r.phase === 'registered' && r.newHost && equalBirth(r.newHost, currentHost) && await this.io.exited(r.oldHost);
    const undispatched = r.phase === 'prepared' && !r.closeRequested && equalBirth(r.oldHost, currentHost);
    if (!registered && !undispatched) throw new WindowSwitchError('WINDOW_REOPEN_PENDING');
    await this.state.transaction(data => {
      if (JSON.stringify(data.request) !== JSON.stringify(r)) throw new WindowSwitchError('WINDOW_ATTEMPT_CHANGED');
      delete data.request;
    });
  }
  async claim(workspaceUri: string, remoteName: string | null, current: WindowBirth): Promise<boolean> {
    try { await fs.lstat(this.directory); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
    const r = (await this.state.read()).request;
    if (!r || remoteName !== 'wsl' || r.plan.workspace.uri !== workspaceUri ||
      equalBirth(r.oldHost, current) || !await this.io.exited(r.oldHost) || !await this.io.alive(current)) return false;
    if (r.phase === 'registered' && r.newHost) {
      if (equalBirth(r.newHost, current)) return true;
      if (!await this.io.exited(r.newHost)) return false;
    }
    return this.state.transaction(data => {
      if (!data.request || JSON.stringify(data.request) !== JSON.stringify(r)) return false;
      data.request.phase = 'registered'; data.request.newHost = current; return true;
    });
  }
  async reopen(attempt: string, launcher: Pick<WslWindowLauncher, 'launch'>, deadlineMs = 30_000): Promise<WindowBirth> {
    if (!Number.isFinite(deadlineMs) || deadlineMs < 1 || deadlineMs > 60_000) throw new WindowSwitchError('WINDOW_ARGUMENT_INVALID');
    const original = (await this.state.read()).request;
    if (!original || original.attempt !== attempt || !await this.io.exited(original.oldHost)) throw new WindowSwitchError('WINDOW_OLD_HOST_ALIVE');
    let launch = false;
    await this.state.transaction(data => {
      if (data.request?.attempt !== attempt) throw new WindowSwitchError('WINDOW_ATTEMPT_CHANGED');
      if (data.request.phase === 'prepared') { data.request.phase = 'launching'; launch = true; }
    });
    if (launch) {
      // A failing CLI may already have opened the window. Always reconcile the
      // durable registration; never launch a second time on this attempt.
      try { await launcher.launch(original.plan); }
      catch (error) {
        if (error instanceof WindowLaunchNotDispatched) {
          await this.state.transaction(data => {
            if (data.request?.attempt === attempt && data.request.phase === 'launching') data.request.phase = 'prepared';
          });
          throw error;
        }
        // All other failures can have occurred after a real window was opened.
      }
    }
    const deadline = this.io.now() + deadlineMs;
    do {
      const current = (await this.state.read()).request;
      if (!current || current.attempt !== attempt) throw new WindowSwitchError('WINDOW_ATTEMPT_CHANGED');
      if (current.phase === 'registered' && current.newHost && await this.io.alive(current.newHost)) return current.newHost;
      await this.io.wait();
    } while (this.io.now() < deadline);
    throw new WindowSwitchError('WINDOW_REOPEN_REGISTRATION_TIMEOUT');
  }
}
