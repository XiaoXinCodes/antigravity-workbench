import { quotaFraction, quotaIsStale } from './quota-presentation';
import type { ImageQuotaSnapshot } from './image-quota';
import { randomUUID } from 'node:crypto';
import type { LocalState } from './private-state';
import { wakeOccurrences } from './wake-schedule';
import { parseWakeTask, type WakeState, type WakeTask, type WakeInstance } from './wake-state';
export interface WakeResult { phase: 'succeeded' | 'failed' | 'unknown' | 'skipped'; code: string; outputTokens?: number; totalTokens?: number }
export interface WakeExecution {
  fingerprint(accountId: string): string | undefined;
  quota?(task: WakeTask, signal: AbortSignal): Promise<ImageQuotaSnapshot>;
  run(task: WakeTask, signal: AbortSignal, beforeSend: () => Promise<void>): Promise<WakeResult>;
}
const LATE_MS = 5 * 60_000, LEASE_MS = 2 * 60_000;
const running = (i: WakeInstance) => i.phase === 'preparing' || i.phase === 'sent';
/** Durable occurrence claim precedes preparation; durable sent marker precedes bytes.
 * A crashed or timed-out sent instance is never re-issued by any window. */
export class WakeEngine {
  private active = new Map<string, AbortController>();
  private ticking: Promise<void> | undefined;
  private disposed = false;
  constructor(readonly store: LocalState<WakeState>, private readonly execution: WakeExecution, private readonly changed: () => void = () => undefined, private readonly now: () => number = Date.now) {}
  async consent(): Promise<void> { await this.store.transaction(s => { s.consent = true; }); this.changed(); }
  async enable(enabled: boolean): Promise<void> {
    await this.store.transaction(s => {
      if (enabled && !s.consent) throw Error('WAKE_CONSENT_REQUIRED');
      if (s.enabled !== enabled) for (const t of s.tasks) { t.revision = randomUUID(); delete t.recovery; }
      s.enabled = enabled;
      // Resuming never catches up runs that occurred while disabled.
      if (enabled) for (const t of s.tasks) { t.nextDue = wakeOccurrences(t.schedule, this.now())[0]!; delete t.recovery; }
    });
    if (!enabled) for (const a of this.active.values()) a.abort(); this.changed();
  }
  async save(task: WakeTask, expectedRevision?: string): Promise<void> {
    const next = parseWakeTask({ ...task, revision: randomUUID(), nextDue: wakeOccurrences(task.schedule, this.now())[0] });
    delete next.recovery;
    if (this.execution.fingerprint(next.accountId) !== next.fingerprint) throw Error('WAKE_ACCOUNT_CHANGED');
    await this.store.transaction(s => {
      if (next.enabled && !s.consent) throw Error('WAKE_CONSENT_REQUIRED');
      const index = s.tasks.findIndex(t => t.id === next.id);
      if (expectedRevision !== undefined && (index < 0 || s.tasks[index]!.revision !== expectedRevision)) throw Error('WAKE_TASK_CHANGED');
      if (index < 0) { if (s.tasks.length >= 50) throw Error('WAKE_TASK_LIMIT'); s.tasks.push(next); } else s.tasks[index] = next;
    });
    this.active.get(next.id)?.abort(); this.changed();
  }
  async pause(id: string, enabled = false, expectedRevision?: string): Promise<void> {
    await this.store.transaction(s => {
      const task = s.tasks.find(t => t.id === id); if (expectedRevision !== undefined && (!task || task.revision !== expectedRevision)) throw Error('WAKE_TASK_CHANGED'); if (!task) return;
      if (enabled && !s.consent) throw Error('WAKE_CONSENT_REQUIRED');
      delete task.recovery; task.enabled = enabled; task.revision = randomUUID(); task.nextDue = wakeOccurrences(task.schedule, this.now())[0]!;
    }); this.active.get(id)?.abort(); this.changed();
  }
  async remove(id: string, expectedRevision?: string): Promise<void> { await this.store.transaction(s => { const task = s.tasks.find(t => t.id === id); if (expectedRevision !== undefined && (!task || task.revision !== expectedRevision)) throw Error('WAKE_TASK_CHANGED'); s.tasks = s.tasks.filter(t => t.id !== id); }); this.active.get(id)?.abort(); this.changed(); }
  async cancel(id: string, expectedRevision?: string): Promise<void> { await this.pause(id, false, expectedRevision); }
  private claim(s: WakeState, task: WakeTask, due: number, manual: boolean): WakeInstance | undefined {
    // A single durable execution slot is shared by all windows and accounts.
    if (s.instances.some(running)) return;
    const id = manual ? `${task.id}:manual:${randomUUID()}` : `${task.id}:${task.revision}:${due}`;
    if (s.instances.some(i => i.id === id)) return;
    const instance: WakeInstance = { id, taskId: task.id, revision: task.revision, accountId: task.accountId, modelId: task.modelId, due, manual, nonce: randomUUID(), leaseUntil: this.now() + LEASE_MS, phase: 'preparing', code: '' };
    s.instances.push(instance);
    // Keep all unfinished records, bound completed history. nextDue prevents
    // pruning a completed record from making the same occurrence eligible again.
    const completed = s.instances.filter(i => !running(i));
    if (completed.length > 400) { const drop = new Set(completed.slice(0, completed.length - 400).map(i => i.id)); s.instances = s.instances.filter(i => !drop.has(i.id)); }
    return structuredClone(instance);
  }
  async test(id: string, expectedRevision?: string): Promise<void> {
    if (this.disposed || this.active.has(id)) return;
    const claimed = await this.store.transaction(s => {
      if (!s.consent) throw Error('WAKE_CONSENT_REQUIRED');
      const task = s.tasks.find(t => t.id === id); if (!task) throw Error('WAKE_TASK_MISSING');
      if (expectedRevision !== undefined && task.revision !== expectedRevision) throw Error('WAKE_TASK_CHANGED');
      const instance = this.claim(s, task, this.now(), true); return instance ? { task: structuredClone(task), instance } : undefined;
    });
    if (claimed) await this.execute(claimed.task, claimed.instance);
  }
  tick(): Promise<void> {
    if (this.disposed) return Promise.resolve(); if (this.ticking) return this.ticking;
    const work = this.scan().finally(() => { this.ticking = undefined; }); this.ticking = work; return work;
  }
  private async scan(): Promise<void> {
    const claims = await this.store.transaction(s => {
      for (const i of s.instances.filter(running)) if (i.leaseUntil <= this.now()) {
        i.phase = i.phase === 'sent' ? 'unknown' : 'skipped'; i.code = i.phase === 'unknown' ? 'WAKE_OUTCOME_UNKNOWN' : 'WAKE_LEASE_EXPIRED';
        const t = s.tasks.find(t => t.id === i.taskId); if (t && i.phase === 'unknown') t.enabled = false;
      }
      const claims: { task: WakeTask; instance: WakeInstance }[] = [];
      for (const task of s.tasks) {
        if (this.execution.fingerprint(task.accountId) !== task.fingerprint) { task.enabled = false; continue; }
        if (!s.consent || !s.enabled || !task.enabled || task.nextDue > this.now()) continue;
        const due = task.nextDue;
        const instance = this.claim(s, task, due, false); if (!instance) continue;
        task.nextDue = wakeOccurrences(task.schedule, this.now())[0]!;
        if (this.now() - due > LATE_MS) { delete task.recovery; s.instances.find(i => i.id === instance.id)!.phase = 'skipped'; s.instances.find(i => i.id === instance.id)!.code = 'WAKE_TOO_LATE'; }
        else claims.push({ task: structuredClone(task), instance });
      }
      return claims;
    });
    this.changed();
    // Bound network concurrency to one. A delayed second claim rechecks lateness
    // before sending and cannot become a backlog burst after sleep.
    for (const claim of claims) { if (this.disposed) break; await this.execute(claim.task, claim.instance); }
  }
  private async execute(task: WakeTask, instance: WakeInstance): Promise<void> {
    const abort = new AbortController(); this.active.set(task.id, abort);
    let sent = false, recoveryObservedAt: string | undefined;
    const valid = (s: WakeState): boolean => {
      const current = s.tasks.find(t => t.id === task.id), row = s.instances.find(i => i.id === instance.id);
      return !this.disposed && !abort.signal.aborted && !!row && row.nonce === instance.nonce && running(row) && row.leaseUntil > this.now() && !!current && current.revision === task.revision && s.consent && (instance.manual || s.enabled && current.enabled) && this.execution.fingerprint(task.accountId) === task.fingerprint;
    };
    const timer = setInterval(() => { void this.store.read().then(s => { if (!valid(s)) abort.abort(); }, () => abort.abort()); }, 1000); timer.unref?.();
    let result: WakeResult;
    try {
      if (!valid(await this.store.read())) throw Error('WAKE_CANCELLED');
      if (!instance.manual && task.schedule.mode === 'quota-recovery') {
        let sample: ImageQuotaSnapshot | undefined;
        try { sample = await this.execution.quota?.(task, abort.signal); } catch { /* A failed check cannot confirm recovery. */ }
        const trigger = await this.store.transaction(s => {
          if (!valid(s)) throw Error('WAKE_CANCELLED');
          const current = s.tasks.find(t => t.id === task.id)!;
          const fraction = quotaFraction(sample?.remainingFraction), observedAt = sample ? Date.parse(sample.queriedAt) : NaN;
          const fresh = !!sample && sample.accountId === task.accountId && sample.modelId === task.modelId && sample.endpoint === task.endpoint && !quotaIsStale(sample.queriedAt, this.now()) && fraction !== null && (!current.recovery || observedAt > current.recovery.observedAt);
          if (!fresh) { if (current.recovery) current.recovery.valid = false; return false; }
          const previous = current.recovery;
          current.recovery = { fraction, observedAt, valid: true };
          return !!previous && previous.valid !== false && previous.fraction !== null && previous.fraction < 1 && fraction === 1 && this.now() - previous.observedAt <= (task.schedule.pollMinutes! * 2 * 60_000 + LATE_MS);
        });
        if (!trigger) { result = { phase: 'skipped', code: sample ? 'WAKE_QUOTA_WAITING' : 'WAKE_QUOTA_UNAVAILABLE' }; }
        else { recoveryObservedAt = sample!.queriedAt; result = await this.send(task, instance, abort, valid, () => { sent = true; }, recoveryObservedAt); }
      } else result = await this.send(task, instance, abort, valid, () => { sent = true; });

    } catch (e) { const code = e instanceof Error && /^[A-Z_0-9]{1,100}$/.test(e.message) ? e.message : 'WAKE_REQUEST_FAILED'; result = { phase: sent ? 'unknown' : 'failed', code: sent ? 'WAKE_OUTCOME_UNKNOWN' : code }; }
    finally { clearInterval(timer); if (this.active.get(task.id) === abort) this.active.delete(task.id); }
    await this.store.transaction(s => {
      const row = s.instances.find(i => i.id === instance.id); if (!row || row.nonce !== instance.nonce || !running(row)) return;
      const current = s.tasks.find(t => t.id === task.id), invalid = abort.signal.aborted || !current || current.revision !== task.revision || this.execution.fingerprint(task.accountId) !== task.fingerprint;
      const phase = sent && invalid ? 'unknown' : !sent && invalid ? 'cancelled' : result.phase;
      Object.assign(row, result, { phase, code: phase === 'unknown' ? 'WAKE_OUTCOME_UNKNOWN' : phase === 'cancelled' ? 'WAKE_CANCELLED' : result.code });
      if (phase === 'unknown' && current) current.enabled = false;
    }); this.changed();
  }
  private send(task: WakeTask, instance: WakeInstance, abort: AbortController, valid: (s: WakeState) => boolean, markSent: () => void, recoveryObservedAt?: string): Promise<WakeResult> {
    return this.execution.run(task, abort.signal, async () => {
        await this.store.transaction(s => {
          if (!valid(s)) throw Error('WAKE_CANCELLED');
          if (recoveryObservedAt && quotaIsStale(recoveryObservedAt, this.now())) throw Error('WAKE_QUOTA_STALE');
          if (!instance.manual && this.now() - instance.due > LATE_MS) throw Error('WAKE_TOO_LATE');
          s.instances.find(i => i.id === instance.id)!.phase = 'sent';
        });
        // If disposal occurs during durable save, retain sent/unknown rather than retry.
        markSent(); if (abort.signal.aborted || this.disposed) throw Error('WAKE_OUTCOME_UNKNOWN'); this.changed();
      });
  }
  dispose(): void { this.disposed = true; for (const a of this.active.values()) a.abort(); }
}
