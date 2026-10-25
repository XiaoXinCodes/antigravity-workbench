import { LiveError } from './live-storage';
import type { ComponentBirth } from './component-coordination';

export interface RouteRepairRecord {
  schema: 1;
  transaction: string;
  host: ComponentBirth;
  oldHub: ComponentBirth;
  phase: 'prepared' | 'stopping' | 'stopped' | 'starting' | 'proved';
  newHub?: ComponentBirth;
}
export interface RouteRepairRuntime {
  transaction: string;
  host: ComponentBirth;
  assertOwner(): Promise<void>;
  /** Reject unknown ownership; returns the exact currently owned birth. */
  inspectOwned(): Promise<ComponentBirth>;
  /** Resolves only after durable read-back/settlement. */
  save(record: RouteRepairRecord): Promise<void>;
  stop(oldHub: ComponentBirth): Promise<void>;
  /** True means affirmative exit of the OLD birth, even when a new Hub is alive.
   * Never use timeout or absence of exports as exit evidence. */
  isStopped(oldHub: ComponentBirth): Promise<boolean>;
  /** Dispatch only if no owned Hub/start already exists; runtime must reject
   * unknown or replacement activity rather than starting over it. */
  startOnce(): Promise<void>;
  /** Observes an existing start; must not itself dispatch setup. */
  observeStarted(): Promise<ComponentBirth>;
  proveOwnRoute(newHub: ComponentBirth): Promise<void>;
}
const same = (a: ComponentBirth, b: ComponentBirth): boolean => a.pid === b.pid && a.startIdentity === b.startIdentity;
const valid = (b: ComponentBirth): boolean => !!b && Object.keys(b).every(k => ['pid','startIdentity'].includes(k)) && Number.isSafeInteger(b.pid) && b.pid > 0 && typeof b.startIdentity === 'string' && /^linux:[a-f0-9-]{36}:[0-9]+$/.test(b.startIdentity);
export function validateRouteRepairRecord(value: unknown): value is RouteRepairRecord {
  const r = value as RouteRepairRecord | undefined;
  return !!r && Object.keys(r).every(k => ['schema','transaction','host','oldHub','phase','newHub'].includes(k)) && r.schema === 1 &&
    typeof r.transaction === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(r.transaction) && valid(r.host) && valid(r.oldHub) &&
    ['prepared','stopping','stopped','starting','proved'].includes(r.phase) &&
    (r.newHub === undefined ? r.phase !== 'proved' : valid(r.newHub) && !same(r.oldHub, r.newHub) && ['starting','proved'].includes(r.phase));
}
const changed = (): never => { throw new LiveError('HUB_CHANGED_DURING_OPERATION'); };
/** Component-only evidence repair. No credential reader/writer is available.
 * A persisted starting phase is intentionally never redispatched: a crash between
 * saving and dispatch is ambiguous and needs observation or explicit recovery.
 * The caller owns serialization across invocations and supplies an operation fence.
 */
export async function repairComponentRoute(previous: RouteRepairRecord | undefined, runtime: RouteRepairRuntime): Promise<RouteRepairRecord> {
  const call = async <T>(operation: () => Promise<T>): Promise<T> => {
    await runtime.assertOwner(); const result = await operation(); await runtime.assertOwner(); return result;
  };
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(runtime.transaction) || !valid(runtime.host)) changed();
  let record: RouteRepairRecord;
  const persist = async (next: RouteRepairRecord): Promise<void> => {
    await call(() => runtime.save(structuredClone(next))); record = structuredClone(next);
  };
  const owned = async (): Promise<ComponentBirth> => {
    const value = await call(() => runtime.inspectOwned()); if (!valid(value)) changed(); return { ...value };
  };
  if (previous) {
    if (!validateRouteRepairRecord(previous) || previous.transaction !== runtime.transaction || !same(previous.host, runtime.host)) changed();
    record = structuredClone(previous);
  } else {
    const oldHub = await owned();
    record = { schema: 1, transaction: runtime.transaction, host: { ...runtime.host }, oldHub, phase: 'prepared' };
    await persist(record);
  }
  if (record.phase === 'prepared' || record.phase === 'stopping') {
    if (!await call(() => runtime.isStopped(record.oldHub))) {
      if (!same(await owned(), record.oldHub)) changed();
      if (record.phase !== 'stopping') await persist({ ...record, phase: 'stopping' });
      // Persistence can await: re-pin ownership immediately before stop.
      if (!same(await owned(), record.oldHub)) changed();
      await call(() => runtime.stop({ ...record.oldHub }));
      if (!await call(() => runtime.isStopped(record.oldHub))) throw new LiveError('OFFICIAL_BACKEND_NOT_STOPPED');
    }
    await persist({ ...record, phase: 'stopped' });
  }
  if (record.phase === 'stopped') {
    if (!await call(() => runtime.isStopped(record.oldHub))) throw new LiveError('OFFICIAL_BACKEND_NOT_STOPPED');
    await persist({ ...record, phase: 'starting' });
    await call(() => runtime.startOnce());
  }
  if (record.phase === 'starting' || record.phase === 'proved') {
    if (!await call(() => runtime.isStopped(record.oldHub))) throw new LiveError('OFFICIAL_BACKEND_NOT_STOPPED');
    const next = await call(() => runtime.observeStarted());
    if (!valid(next) || same(next, record.oldHub) || record.newHub && !same(next, record.newHub)) changed();
    if (!same(await owned(), next)) changed();
    // Pin the observed generation durably before proof; a retry cannot silently
    // substitute another process for this instance if its evidence is missing.
    if (!record.newHub) await persist({ ...record, newHub: { ...next } });
    if (!same(await owned(), next)) changed();
    await call(() => runtime.proveOwnRoute({ ...next }));
    if (!same(await owned(), next)) changed();
    await persist({ ...record, phase: 'proved' });
  }
  return structuredClone(record);
}
