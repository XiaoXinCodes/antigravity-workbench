import { WindowRuntimeChannel } from './window-runtime-channel';
import { probeProcessIdentity } from './live-lock';
import { WindowSwitchError, type WindowBirth } from './window-switch-protocol';

export class WindowRuntimeDriver {
  constructor(private readonly channel: WindowRuntimeChannel,
    private readonly inspect: (host: WindowBirth) => Promise<'alive' | 'exited' | 'unknown'> = async h => {
      const p = await probeProcessIdentity(h.pid);
      return p.state === 'dead' || p.state === 'alive' && p.startIdentity !== h.startIdentity ? 'exited' : p.state === 'alive' ? 'alive' : 'unknown';
    }) {}
  async start(attempt: string, executor: WindowBirth): Promise<void> {
    await this.channel.arm(attempt, executor);
    await this.advance(attempt);
  }
  /** One requested native close at a time. Neither command ACK nor timeout
   * authorizes the next close or a credential mutation. */
  async advance(attempt: string): Promise<void> {
    const g = await this.channel.readGroup(attempt);
    if (!g || g.cancelled) throw new WindowSwitchError('WINDOW_CANCELLED');
    for (const member of g.members) {
      const req = g.requests.find(r => r.window === member.window && r.kind === 'close');
      if (req?.result === 'failed' || req?.result === 'cancelled') throw new WindowSwitchError('WINDOW_SAVE_CANCELLED');
      const status = await this.inspect(member.host);
      if (status === 'unknown') throw new WindowSwitchError('WINDOW_HOST_BINDING_UNVERIFIED');
      if (status === 'exited') continue;
      if (!req) await this.channel.request(attempt, member.window, 'close');
      return;
    }
  }
}
