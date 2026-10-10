import { randomUUID } from 'node:crypto';
import type * as vscode from 'vscode';

type Storage = Pick<vscode.Memento, 'get' | 'update'>;
const PREFERENCES = 'quota.presentation.v1';
const VIEW = 'antigravityAccounts.quotaViewState';
const REVISION = 'quota.ui.revision.v1';
interface CoordinatedStorage extends Storage { updateFromCurrent(key: string, transform: (current: unknown) => unknown): Promise<void> }
const stores = new WeakMap<object, CoordinatedStorage>();

export function writeQuotaPreferences(storage: Storage, transform: (current: unknown) => unknown): Promise<void> {
  const coordinated = stores.get(storage);
  return coordinated ? coordinated.updateFromCurrent(PREFERENCES, transform) : Promise.resolve(storage.update(PREFERENCES, transform(storage.get(PREFERENCES))));
}

// Memento notifications replace the whole extension cache, including delayed
// echoes of this window's older writes. Keep these two UI domains together.
export function quotaUiStorage(storage: Storage): Storage {
  const existing = stores.get(storage);
  if (existing) return existing;
  let snapshot: Record<string, unknown> = {}, revision: unknown;
  let initialRevision: unknown;
  let initialized = false, queue: Promise<unknown> = Promise.resolve();
  const writer = randomUUID() + ':';
  let sequence = 0;
  const ownRevisions = new Set<unknown>();
  const read = (): void => {
    const observed = storage.get(REVISION);
    const ownEcho = typeof observed === 'string' && observed.startsWith(writer) && /^[1-9]\d*$/u.test(observed.slice(writer.length)) && Number(observed.slice(writer.length)) <= sequence;
    if (!initialized || observed !== revision && observed !== initialRevision && !ownEcho && !ownRevisions.has(observed)) {
      if (!initialized) initialRevision = observed;
      snapshot = { [PREFERENCES]: storage.get(PREFERENCES), [VIEW]: storage.get(VIEW) };
      revision = observed; initialized = true;
    }
  };
  const result: CoordinatedStorage = {
    get<T>(key: string, fallback?: T): T | undefined {
      read();
      const value = key === PREFERENCES || key === VIEW ? snapshot[key] : storage.get<T>(key);
      return value === undefined ? fallback : value as T;
    },
    update(key: string, value: unknown): Promise<void> {
      return result.updateFromCurrent(key, () => value);
    },
    updateFromCurrent(key: string, transform: (current: unknown) => unknown): Promise<void> {
      if (key !== PREFERENCES && key !== VIEW) return Promise.resolve(storage.update(key, transform(storage.get(key))));
      const work = queue.then(async () => {
        read();
        const next = { ...snapshot, [key]: transform(snapshot[key]) }, nextRevision = writer + (++sequence);
        // Include the initial revision so its late echo cannot undo a commit.
        if (typeof revision !== 'string' || !revision.startsWith(writer)) ownRevisions.add(revision);
        while (ownRevisions.size > 64) ownRevisions.delete(ownRevisions.values().next().value);
        // All calls run in the same turn and share Memento's single write batch.
        await Promise.all([storage.update(PREFERENCES, next[PREFERENCES]), storage.update(VIEW, next[VIEW]), storage.update(REVISION, nextRevision)]);
        snapshot = next; revision = nextRevision;
      });
      queue = work.catch(() => undefined);
      return work;
    },
  };
  stores.set(storage, result);
  stores.set(result, result);
  return result;
}
