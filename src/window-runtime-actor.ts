import * as os from 'node:os';
import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import { automaticWindowContext, saveAutomaticWindow, type AutomaticWindowContext } from './automatic-window-entry';
import { captureCurrentWindow, requestCurrentWindowClose } from './vscode-window-participant';
import { bindWslWorkspace } from './wsl-workspace';
import { resolveCredentialHostId } from './native-host';
import { AutomaticOfflineControl } from './offline-automatic';
import { WindowRuntimeChannel, type WindowRuntimeMember } from './window-runtime-channel';
import { WindowGroupReopen } from './window-group-reopen';
import { recoverWindowRuntime } from './window-runtime-recovery';
import { WslWindowLauncher } from './wsl-window-launcher';

export function runtimeMember(context: AutomaticWindowContext, scope: string): WindowRuntimeMember {
  return { window: createHash('sha256').update(`${context.current.host.pid}:${context.current.host.startIdentity}`).digest('hex'),
    host: context.current.host, plan: context.plan, scope };
}
/** Each extension host only acts on its own birth-bound request. No command
 * names, script bodies, credentials or arbitrary paths cross this channel. */
export function registerWindowRuntime(context: vscode.ExtensionContext): void {
  let scope = '', lastRecovery = 0;
  let disposed = false, running = false, cached: AutomaticWindowContext | undefined;
  const channel = new WindowRuntimeChannel(os.homedir());
  const tick = async (): Promise<void> => {
    if (disposed || running || process.platform !== 'linux' || vscode.env.remoteName !== 'wsl') return;
    running = true;
    try {
      if (!cached) {
        const candidate = await automaticWindowContext();
        const candidateScope = await resolveCredentialHostId(context, vscode.env.remoteName, 'wsl-file');
        await channel.register(runtimeMember(candidate, candidateScope));
        cached = candidate; scope = candidateScope;
      }
      const request = await channel.take(cached.current.host);
      if (!request) {
        if (!await channel.readGroup()) {
          const current = await captureCurrentWindow();
          if (!current.workspace || bindWslWorkspace(current.workspace, current.remoteName, process.env.WSL_DISTRO_NAME).uri !== cached.plan.workspace.uri) { cached = undefined; return; }
        }
        if (Date.now() - lastRecovery > 5000) { lastRecovery = Date.now(); await recoverWindowRuntime(os.homedir(), scope, cached.plan.workspace.uri); }
        return;
      }
      try {
        const now = await captureCurrentWindow();
        if (!now.workspace || now.host.startIdentity !== cached.current.host.startIdentity ||
          bindWslWorkspace(now.workspace, now.remoteName, process.env.WSL_DISTRO_NAME).uri !== cached.plan.workspace.uri) throw Error('WINDOW_CHANGED');
        const group = await channel.readGroup(request.attempt);
        if (!group) throw Error('GROUP_MISSING');
        await context.globalState.update('automatic-offline.last.v1', { host: group.scope, id: group.transactionId });
        const control = new AutomaticOfflineControl(os.homedir(), group.transactionId);
        const assertLive = async (): Promise<void> => {
          await channel.authorize(request.attempt, request.nonce, cached!.current.host);
          const state = await control.read(), active = await channel.readGroup(request.attempt);
          if (state.attempt !== request.attempt || state.cancelled || !active || active.cancelled) throw Error('ATTEMPT_CANCELLED');
          if (request.kind === 'close' && state.status !== 'WAITING_FOR_CLOSE') throw Error('EXECUTOR_NOT_READY');
          await new WslWindowLauncher().validate(cached!.plan);
        };
        await assertLive();
        // The initiating transaction modal explicitly covers all participants.
        cached.sessionInterruptionConfirmed = true;
        if (request.kind === 'save') {
          const saved = await saveAutomaticWindow(cached);
          await channel.ack(request.attempt, request.nonce, cached.current.host, saved ? 'saved' : 'cancelled');
        } else {
          await requestCurrentWindowClose(cached.current, assertLive, async () => { await channel.markCloseDispatched(request.attempt, request.nonce, cached!.current.host); await new WindowGroupReopen(os.homedir()).markCloseRequested(request.attempt, request.window); });
          await channel.ack(request.attempt, request.nonce, cached.current.host, 'close-returned');
        }
      } catch {
        await channel.ack(request.attempt, request.nonce, cached.current.host, 'failed').catch(() => undefined);
      }
    } catch { /* Missing platform proof or unsafe records never authorize actions. */ }
    finally { running = false; }
  };
  const timer = setInterval(() => { void tick(); }, 500); timer.unref(); void tick();
  context.subscriptions.push({ dispose: () => { disposed = true; clearInterval(timer); } });
}
