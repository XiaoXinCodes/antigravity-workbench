import { accountDisplayFingerprint } from './quota-presentation';
import type { LiveAccountView } from './live-ui';

export const QUOTA_BATCH_LIMIT = 50;
export interface QuotaBatchState { running: boolean; cancelled: boolean; completed: number; total: number; skipped: number; omitted: number }
/** Serial requests deliberately retain the existing host/rotation lock for each
 * read. Cancellation stops the queue immediately, while in-progress rotation is
 * allowed to finish safely under that lock before another request can begin. */
export class ManualQuotaBatch {
  private work: Promise<void> | undefined;
  private revision = 0;
  private state: QuotaBatchState = { running: false, cancelled: false, completed: 0, total: 0, skipped: 0, omitted: 0 };
  constructor(private readonly accounts: () => LiveAccountView[], private readonly read: (id: string) => Promise<void>, private readonly cancelRead: () => void, private readonly changed: () => void) {}
  getState(): QuotaBatchState { return { ...this.state }; }
  cancel(): void { if (!this.work) return; ++this.revision; this.state.cancelled = true; this.cancelRead(); this.changed(); }
  dispose(): void { this.cancel(); }
  start(): Promise<void> {
    if (this.work) return this.work;
    const available = [...new Map(this.accounts().filter(account => account.hostCurrent !== false).map(account => [account.id, account])).values()];
    const targets = available.slice(0, QUOTA_BATCH_LIMIT).map(account => ({ id: account.id, fingerprint: accountDisplayFingerprint(account) }));
    const revision = ++this.revision;
    this.state = { running: true, cancelled: false, completed: 0, total: targets.length, skipped: 0, omitted: Math.max(0, available.length - targets.length) };
    // Publish the promise before notifying views so reentrant clicks coalesce.
    this.work = Promise.resolve().then(async () => {
      this.changed();
      for (const target of targets) {
        if (revision !== this.revision) break;
        const account = this.accounts().find(account => account.id === target.id && account.hostCurrent !== false);
        if (!account || accountDisplayFingerprint(account) !== target.fingerprint) { ++this.state.skipped; this.changed(); continue; }
        try { await this.read(target.id); } catch { if (revision === this.revision) { ++this.state.skipped; this.changed(); } continue; }
        if (revision !== this.revision) break;
        ++this.state.completed; this.changed();
      }
    }).finally(() => { this.work = undefined; this.state.running = false; this.changed(); });
    return this.work;
  }
}
