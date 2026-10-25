import * as os from 'node:os';
import * as vscode from 'vscode';
import { readWindowPlatformAcceptance } from './window-platform-acceptance';
import { LiveError } from './live-storage';
import { AutomaticOfflineControl } from './offline-automatic';
import { captureCurrentWindow, requestCurrentWindowClose, saveCurrentWindow, type CurrentWindowSnapshot } from './vscode-window-participant';
import { WslWindowLauncher, type WslLaunchPlan } from './wsl-window-launcher';
import { WindowReopen } from './window-reopen';
import { WindowRuntimeChannel, type WindowRuntimeMember } from './window-runtime-channel';
import { WindowGroupReopen } from './window-group-reopen';
import { createHash } from 'node:crypto';
import type { OfflineCensus } from './offline-switch';
import { bindWslWorkspace } from './wsl-workspace';
import { WindowSwitchError } from './window-switch-protocol';

export interface AutomaticWindowContext { current: CurrentWindowSnapshot; plan: WslLaunchPlan; sessionInterruptionConfirmed?: boolean; members?: WindowRuntimeMember[] }
/** An explicitly imported, operator-reviewed window acceptance binds this
 * launcher. It never attests credentials or login success. A changed launcher
 * or authority invalidates the binding; no --version probe creates it. */
export async function automaticWindowContext(): Promise<AutomaticWindowContext> {
  try {
    const current = await captureCurrentWindow();
    if (process.platform !== 'linux' || current.remoteName !== 'wsl' || !current.workspace) throw 0;
    const proof = await readWindowPlatformAcceptance(os.homedir());
    // A path supplied by the successful isolated acceptance run is an explicit
    // binding, not a PATH search or guessed machine-specific installation.
    const workspace = bindWslWorkspace(current.workspace, current.remoteName, process.env.WSL_DISTRO_NAME, proof.authority);
    const plan = await new WslWindowLauncher(undefined, { ...process.env, VSCODE_CLIENT_COMMAND: process.env.VSCODE_CLIENT_COMMAND ?? proof.executable }).discover(workspace);
    if (plan.fingerprint !== proof.fingerprint || plan.authority !== proof.authority) throw 0;
    return { current, plan };
  } catch { throw new LiveError('OFFLINE_AUTOMATIC_WINDOW_UNAVAILABLE'); }
}
export async function assertSingleWindow(context: AutomaticWindowContext, census: OfflineCensus, scope?: string): Promise<void> {
  // Keep the exported name for old callers; the implementation now verifies
  // every relevant host against the live cooperating-window registry.
  if (!scope) throw new LiveError('OFFLINE_AUTOMATIC_WINDOWS_UNSUPPORTED');
  const channel = new WindowRuntimeChannel(os.homedir());
  const own: WindowRuntimeMember = { window: createHash('sha256').update(`${context.current.host.pid}:${context.current.host.startIdentity}`).digest('hex'), host: context.current.host, plan: context.plan, scope };
  await channel.pruneExited(); await channel.register(own);
  const roster = await channel.roster(census, scope);
  if (!roster.complete || !roster.members.some(m => m.window === own.window)) throw new LiveError('OFFLINE_AUTOMATIC_WINDOWS_UNSUPPORTED');
  // The initiating UI stays alive until all peer close requests have settled.
  context.members = [...roster.members.filter(m => m.window !== own.window), own];
}
export async function prepareWindowReopen(context: AutomaticWindowContext, attempt: string, transactionId?: string): Promise<void> {
  if (!context.members || !transactionId) throw new LiveError('OFFLINE_AUTOMATIC_WINDOWS_UNSUPPORTED');
  const channel = new WindowRuntimeChannel(os.homedir());
  await channel.createGroup(attempt, transactionId, context.members);
  try {
    await new WindowGroupReopen(os.homedir()).prepare(attempt, context.members);
    for (const m of context.members) await channel.request(attempt, m.window, 'save');
    const deadline = Date.now() + 60_000;
    for (;;) {
      const g = await channel.readGroup(attempt);
      if (!g || g.cancelled || g.requests.some(r => r.result === 'cancelled' || r.result === 'failed')) throw new LiveError('CANCELLED');
      if (g.members.every(m => g.requests.some(r => r.window === m.window && r.kind === 'save' && r.result === 'saved'))) return;
      if (Date.now() >= deadline) throw new LiveError('OFFLINE_CLOSE_TIMEOUT');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  } catch (e) {
    await channel.cancel(attempt);
    if (e instanceof WindowSwitchError && e.code === 'WINDOW_CANCELLED') throw new LiveError('CANCELLED');
    throw e;
  }
}
export async function saveAutomaticWindow(context: AutomaticWindowContext): Promise<boolean> {
  // A terminal's existence does not prove a running job, and the public API
  // cannot prove pre-existing shell jobs idle or guaranteed to persist. The
  // one transaction confirmation explicitly covers interruption, not disposal.
  // Native close/save vetoes remain intact; we never call terminal.dispose,
  // terminateTask or stopDebugging to bypass them.
  if ((vscode.window.terminals.length || vscode.tasks.taskExecutions.length || vscode.debug.activeDebugSession) && !context.sessionInterruptionConfirmed) throw new LiveError('OFFLINE_AUTOMATIC_WINDOW_BUSY');
  return saveCurrentWindow(context.current);
}
export async function closeAutomaticWindow(context: AutomaticWindowContext, attempt: string, transactionId: string): Promise<void> {
  if (context.members) {
    const group = await new WindowRuntimeChannel(os.homedir()).readGroup(attempt);
    const state = await new AutomaticOfflineControl(os.homedir(), transactionId).read();
    if (!group?.executor || group.cancelled || state.attempt !== attempt || state.cancelled) throw new LiveError('OFFLINE_ATTEMPT_CHANGED');
    // The acknowledged independent helper, not the initiating host, owns
    // sequenced close requests. Actor loops perform the actual native calls.
    return;
  }
  if (!await saveAutomaticWindow(context)) throw new LiveError('CANCELLED');
  await requestCurrentWindowClose(context.current, async () => {
    const state = await new AutomaticOfflineControl(os.homedir(), transactionId).read();
    if (state.attempt !== attempt || state.cancelled || state.status !== 'WAITING_FOR_CLOSE') throw new LiveError('OFFLINE_ATTEMPT_CHANGED');
    await new WslWindowLauncher().validate(context.plan);
  }, () => new WindowReopen(os.homedir()).markCloseRequested(attempt));
}
export async function completeWindowReopenIfPresent(attempt: string | undefined): Promise<void> {
  if (!attempt) return;
  const group = new WindowGroupReopen(os.homedir());
  if (await group.hasAttempt(attempt)) {
    const channel = new WindowRuntimeChannel(os.homedir()), pending = await channel.readGroup(attempt);
    if (!pending) await group.clearUnstarted(attempt);
    else { await channel.cancel(attempt); await channel.assertFinishable(attempt);
      await group.prepare(attempt, pending.members); await group.clearVerified(attempt); await channel.finish(attempt); }
  } else if (await new WindowRuntimeChannel(os.homedir()).readGroup(attempt)) await new WindowRuntimeChannel(os.homedir()).finish(attempt);
  const reopen = new WindowReopen(os.homedir());
  if (await reopen.hasAttempt(attempt)) await reopen.clearVerified(attempt);
}
export async function assertNoPendingWindowAttempt(attempt: string | undefined): Promise<void> {
  if (attempt && await new WindowGroupReopen(os.homedir()).hasAttempt(attempt)) {
    const channel = new WindowRuntimeChannel(os.homedir()), pending = await channel.readGroup(attempt), group = new WindowGroupReopen(os.homedir());
    if (!pending) await group.clearUnstarted(attempt);
    else { await channel.cancel(attempt); await channel.assertFinishable(attempt);
      await group.prepare(attempt, pending.members); await group.clearVerified(attempt); await channel.finish(attempt); }
  }
  // A crash after group receipt cleanup but before channel.finish must be
  // settled before the caller resets the account epoch.
  if (attempt) {
    const channel = new WindowRuntimeChannel(os.homedir());
    if (await channel.readGroup(attempt)) { await channel.cancel(attempt); await channel.assertFinishable(attempt); await channel.finish(attempt); }
  }
  const reopen = new WindowReopen(os.homedir());
  if (attempt && await reopen.hasAttempt(attempt)) {
    const current = await captureCurrentWindow();
    try { await reopen.releaseForRecovery(attempt, current.host); }
    catch { throw new LiveError('OFFLINE_REOPEN_REQUIRED'); }
  }
}
export async function hasAutomaticWindowAttempt(attempt: string | undefined): Promise<boolean> { return !!attempt && (await new WindowGroupReopen(os.homedir()).hasAttempt(attempt) || await new WindowReopen(os.homedir()).hasAttempt(attempt)); }
/** Startup registers a new host, not a successful login. The existing offline
 * recovery poll still owns fresh RPC verification and backup preservation. */
export function registerWindowRejoin(context: vscode.ExtensionContext): void {
  let disposed = false;
  const timer = setTimeout(() => {
    if (disposed || process.platform !== 'linux' || vscode.env.remoteName !== 'wsl') return;
    void captureCurrentWindow().then(async current => {
      if (current.workspace) {
        const workspace = bindWslWorkspace(current.workspace, current.remoteName, process.env.WSL_DISTRO_NAME);
        if (await new WindowGroupReopen(os.homedir()).claim(workspace.uri, current.remoteName, current.host)) {
          const group = await new WindowRuntimeChannel(os.homedir()).readGroup();
          if (group) await context.globalState.update('automatic-offline.last.v1', { host: group.scope, id: group.transactionId });
        }
        await new WindowReopen(os.homedir()).claim(workspace.uri, current.remoteName, current.host);
      }
    }).catch(() => undefined); // Missing/unsafe receipts never imply success.
  }, 0);
  timer.unref(); context.subscriptions.push({ dispose: () => { disposed = true; clearTimeout(timer); } });
}
