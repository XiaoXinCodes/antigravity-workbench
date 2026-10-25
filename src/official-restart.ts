import { generation, hasOfficialHubApi, noteObservedHubRestart } from './live-hub';
import { LiveError } from './live-storage';

export const OFFICIAL_RESTART_TIMEOUT_MS = 60_000;
export const COMPONENT_REQUEST_TIMEOUT_MS = OFFICIAL_RESTART_TIMEOUT_MS + 30_000;
export type OfficialRestartStage = 'commands' | 'observing' | 'ready';
export const OFFICIAL_RECONNECT = 'antigravity.reconnect';
export const OFFICIAL_FOCUS = 'antigravity.panel.focus';
export function canRestartOfficialComponent(commands: readonly string[]): boolean {
  return commands.includes(OFFICIAL_RECONNECT) && commands.includes(OFFICIAL_FOCUS);
}
interface RestartRuntime {
  api(): unknown; assertCurrent(): void; processCount(): Promise<number>;
  execute(command: string): PromiseLike<unknown>; wait?(ms: number): Promise<void>;
  observeOnly?: boolean;
  now?(): number; timeoutMs?: number; onStage?(stage: OfficialRestartStage): void;
}
/** Reconnect is the official registered command. It invalidates the renderer's
 * cached server URL and re-renders an already resolved view. Focus resolves a
 * view only when needed; it is not an unconditional backend start command. Do not use triggerUpdate (updates software), resetConversation, private
 * workbench commands, activate() twice, or mutate the official workspace history.
 */
export async function restartOfficialComponent(_previous: string, runtime: RestartRuntime): Promise<string> {
  const now = runtime.now ?? Date.now;
  const budget = runtime.timeoutMs ?? OFFICIAL_RESTART_TIMEOUT_MS;
  const until = now() + budget;
  let expired = false, timer: NodeJS.Timeout | undefined;
  const assertCurrent = (): void => {
    if (expired || now() >= until) throw new LiveError('OFFICIAL_COMPONENT_RESTART_TIMEOUT');
    runtime.assertCurrent();
  };
  const work = async (): Promise<string> => {
    assertCurrent();
    if (!runtime.observeOnly) {
    const api = runtime.api();
    if (hasOfficialHubApi(api) || await runtime.processCount() !== 0) throw new LiveError('OFFICIAL_BACKEND_NOT_STOPPED');
    assertCurrent();
    if (hasOfficialHubApi(runtime.api())) throw new LiveError('OFFICIAL_BACKEND_NOT_STOPPED');
    runtime.onStage?.('commands');
    try { await runtime.execute(OFFICIAL_RECONNECT); }
    catch { assertCurrent(); throw new LiveError('OFFICIAL_COMPONENT_RECONNECT_FAILED'); }
    assertCurrent();
    try { await runtime.execute(OFFICIAL_FOCUS); }
    catch { assertCurrent(); throw new LiveError('OFFICIAL_COMPONENT_FOCUS_FAILED'); }
    assertCurrent();
    }
    runtime.onStage?.('observing');
    const wait = runtime.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    do {
      assertCurrent();
      const current = runtime.api();
      if (hasOfficialHubApi(current)) {
        const pinned = { port: current.port, csrfToken: current.csrfToken };
        const next = generation(pinned), count = await runtime.processCount();
        assertCurrent();
        if (count > 1) throw new LiveError('CLOSE_OTHER_AGY_PROCESSES');
        const stable = runtime.api();
        if (!hasOfficialHubApi(stable) || generation(stable) !== next) throw new LiveError('HUB_CHANGED_DURING_OPERATION');
        if (count === 1) { runtime.onStage?.('ready'); return noteObservedHubRestart(pinned); }
      }
      await wait(Math.min(200, Math.max(0, until - now())));
    } while (now() < until);
    throw new LiveError('OFFICIAL_COMPONENT_RESTART_TIMEOUT');
  };
  // One budget covers preflight, both command awaits and process observation.
  // Expiry fences every continuation; it cannot cancel official internal setup.
  try {
    return await Promise.race([work(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { expired = true; reject(new LiveError('OFFICIAL_COMPONENT_RESTART_TIMEOUT')); }, budget);
    })]);
  } finally { expired = true; clearTimeout(timer); }
}
