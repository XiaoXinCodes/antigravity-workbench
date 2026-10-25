import { PrivateState } from './private-state';
import { isDeepStrictEqual } from 'node:util';
import { validateWindowSwitchRecord } from './window-switch-journal';
import { WindowSwitchError, type WindowBirth, type WindowReopenDescriptor } from './window-switch-protocol';

export interface CurrentWindowBinding {
  /** The adapter must bind this host to its current renderer/workspace and
   * actual profile, not infer other windows from persisted VS Code history.
   * undefined means no supported verified mapping; no registration occurs. */
  capture(): Promise<WindowReopenDescriptor | undefined>;
  self(): Promise<WindowBirth>;
}
function validate(w: WindowReopenDescriptor): WindowReopenDescriptor {
  return validateWindowSwitchRecord({ schema: 1, id: 'registration', attempt: 'registration', scope: w.scope,
    phase: 'preparing', windows: [w], closeRequested: [], reopened: [], deadline: 1 }).windows[0]!;
}
const birth = (b: WindowBirth): string => `${b.pid}:${b.startIdentity}`;
/** Durable registry of cooperating windows; a fresh scope census is always
 * authoritative. Timestamps/heartbeats are NOT substitutes for process birth.
 * Missing actors (including live hosts without a Hub) reject the whole set. */
export class WindowParticipants {
  private readonly state: PrivateState<{ windows: WindowReopenDescriptor[] }>;
  constructor(directory: string) {
    this.state = new PrivateState(directory, value => {
      const data = value as { windows: WindowReopenDescriptor[] };
      if (!data || Object.keys(data).some(k => k !== 'windows') || !Array.isArray(data.windows) || data.windows.length > 128)
        throw new WindowSwitchError('WINDOW_REGISTRY_INVALID');
      const windows = data.windows.map(validate);
      if (new Set(windows.map(w => w.window)).size !== windows.length || new Set(windows.map(w => birth(w.host))).size !== windows.length)
        throw new WindowSwitchError('WINDOW_REGISTRY_INVALID');
      return { windows };
    }, () => ({ windows: [] }));
  }
  async register(adapter: CurrentWindowBinding): Promise<void> {
    const before = await adapter.self(), captured = await adapter.capture(), after = await adapter.self();
    if (!captured || birth(before) !== birth(after) || birth(captured.host) !== birth(after)) throw new WindowSwitchError('WINDOW_HOST_BINDING_UNVERIFIED');
    const descriptor = validate(captured);
    await this.state.transaction(data => {
      if (data.windows.some(w => isDeepStrictEqual(w, descriptor))) return;
      // Do not let a later registration replace another live window's binding.
      if (data.windows.some(w => w.window === descriptor.window || birth(w.host) === birth(descriptor.host)))
        throw new WindowSwitchError('WINDOW_ALREADY_REGISTERED');
      data.windows.push(descriptor);
    });
  }
  /** Explicit startup maintenance. Only independently observed exited births
   * can be removed; age, stale heartbeat and unknown access are insufficient.
   * Prepared transactions retain their own immutable descriptor copies. */
  async pruneExited(inspect: (host: WindowBirth) => Promise<'exited' | 'alive' | 'unknown'>): Promise<void> {
    const previous = (await this.state.read()).windows;
    const dead: WindowReopenDescriptor[] = [];
    for (const w of previous) if (await inspect(w.host) === 'exited') dead.push(w);
    await this.state.transaction(data => { data.windows = data.windows.filter(w => !dead.some(old => isDeepStrictEqual(w, old))); });
  }
  async snapshot(scope: string, census: { complete: boolean; unknown: boolean; hosts: WindowBirth[] }): Promise<{ complete: boolean; windows: WindowReopenDescriptor[] }> {
    if (!census.complete || census.unknown || !census.hosts.length || new Set(census.hosts.map(birth)).size !== census.hosts.length)
      return { complete: false, windows: [] };
    const rows = (await this.state.read()).windows.filter(w => w.scope === scope && census.hosts.some(h => birth(h) === birth(w.host)));
    // Old births do not count, and no unrelated scope is pulled into the close set.
    return rows.length === census.hosts.length ? { complete: true, windows: rows } : { complete: false, windows: [] };
  }
}
