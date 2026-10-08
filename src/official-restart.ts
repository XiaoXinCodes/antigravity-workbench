import { generation, hasOfficialHubApi, noteObservedHubRestart } from './live-hub';
import { LiveError } from './live-storage';

export const OFFICIAL_RECONNECT = 'antigravity.reconnect';
export const OFFICIAL_FOCUS = 'antigravity.panel.focus';
export function canRestartOfficialComponent(commands: readonly string[]): boolean {
  return commands.includes(OFFICIAL_RECONNECT) && commands.includes(OFFICIAL_FOCUS);
}
interface RestartRuntime {
  api(): unknown; assertCurrent(): void; processCount(): Promise<number>;
  execute(command: string): PromiseLike<unknown>; wait?(ms: number): Promise<void>;
  now?(): number; timeoutMs?: number;
}
/** Reconnect is the official registered command. It invalidates the renderer's
 * cached server URL; focusing its view runs desktopSetup and starts the stopped
 * backend. Do not use triggerUpdate (updates software), resetConversation, private
 * workbench commands, activate() twice, or mutate the official workspace history.
 */
export async function restartOfficialComponent(_previous: string, runtime: RestartRuntime): Promise<string> {
  runtime.assertCurrent();
  const api = runtime.api();
  if (hasOfficialHubApi(api) || await runtime.processCount() !== 0) throw new LiveError('OFFICIAL_BACKEND_NOT_STOPPED');
  runtime.assertCurrent();
  // The official backend may have started while the process query was pending.
  if (hasOfficialHubApi(runtime.api())) throw new LiveError('OFFICIAL_BACKEND_NOT_STOPPED');
  let commandTimer: NodeJS.Timeout | undefined;
  let commandExpired = false;
  try {
    await Promise.race([
      (async () => {
        try { await runtime.execute(OFFICIAL_RECONNECT); }
        catch { throw new LiveError('OFFICIAL_COMPONENT_RECONNECT_FAILED'); }
        if (commandExpired) throw new LiveError('OFFICIAL_COMPONENT_RESTART_TIMEOUT');
        runtime.assertCurrent();
        try { await runtime.execute(OFFICIAL_FOCUS); }
        catch { throw new LiveError('OFFICIAL_COMPONENT_FOCUS_FAILED'); }
      })(),
      new Promise<never>((_resolve, reject) => { commandTimer = setTimeout(() => { commandExpired = true; reject(new LiveError('OFFICIAL_COMPONENT_RESTART_TIMEOUT')); }, runtime.timeoutMs ?? 30_000); }),
    ]);
  } finally { clearTimeout(commandTimer); }
  const now = runtime.now ?? Date.now, until = now() + (runtime.timeoutMs ?? 30_000);
  const wait = runtime.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  do {
    runtime.assertCurrent();
    const current = runtime.api();
    if (hasOfficialHubApi(current)) {
      const pinned = { port: current.port, csrfToken: current.csrfToken };
      const next = generation(pinned), count = await runtime.processCount();
      if (count > 1) throw new LiveError('CLOSE_OTHER_AGY_PROCESSES');
      runtime.assertCurrent();
      const stable = runtime.api();
      if (!hasOfficialHubApi(stable) || generation(stable) !== next) throw new LiveError('HUB_CHANGED_DURING_OPERATION');
      if (count === 1) return noteObservedHubRestart(pinned);
    }
    await wait(200);
  } while (now() < until);
  // A command returning does not prove a new backend, identity or loaded token.
  throw new LiveError('OFFICIAL_COMPONENT_RESTART_TIMEOUT');
}
