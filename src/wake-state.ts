import { quotaFraction } from './quota-presentation';
import { validateWakeSchedule, type WakeSchedule } from './wake-schedule';
import type { ImageEndpoint } from './direct-image-protocol';
export interface WakeTask { id: string; revision: string; accountId: string; fingerprint: string; modelId: string; endpoint: ImageEndpoint; schedule: WakeSchedule; enabled: boolean; outputBudget: number; nextDue: number; recovery?: { fraction: number | null; observedAt: number; valid?: boolean } }
export type WakeOutcome = 'preparing' | 'sent' | 'succeeded' | 'failed' | 'unknown' | 'cancelled' | 'skipped';
export interface WakeInstance { id: string; taskId: string; revision: string; accountId: string; modelId: string; due: number; manual: boolean; nonce: string; leaseUntil: number; phase: WakeOutcome; code: string; outputTokens?: number; totalTokens?: number }
export interface AlertSettings { low: boolean; exhausted: boolean; recovered: boolean; threshold: number }
export interface AlertReading { key: string; observedAt: number; state: 'healthy' | 'low' | 'exhausted' }
export interface WakeState { schema: 1; consent: boolean; enabled: boolean; tasks: WakeTask[]; instances: WakeInstance[]; alerts: AlertSettings; readings: AlertReading[] }
export const initialWakeState = (): WakeState => ({ schema: 1, consent: false, enabled: false, tasks: [], instances: [], alerts: { low: false, exhausted: false, recovered: false, threshold: 10 }, readings: [] });
const bad = (): never => { throw Error('AUTOMATION_STATE_INVALID'); };
const obj = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : bad();
const text = (v: unknown, max = 1000): string => typeof v === 'string' && v.length > 0 && v.length <= max ? v : bad();
const bool = (v: unknown): boolean => typeof v === 'boolean' ? v : bad();
const number = (v: unknown, max = Number.MAX_SAFE_INTEGER): number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= max ? v : bad();
const uuid = (v: unknown): string => { const s = text(v, 36); return /^[a-f0-9-]{36}$/.test(s) ? s : bad(); };
const rows = (v: unknown, max: number): unknown[] => Array.isArray(v) && v.length <= max ? v : bad();
export function parseWakeTask(value: unknown): WakeTask {
  const v = obj(value), outputBudget = number(v.outputBudget, 64), modelId = text(v.modelId, 128);
  if (!outputBudget || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/.test(modelId) || !['daily', 'production'].includes(String(v.endpoint))) bad();
  let recovery: WakeTask['recovery'];
  if (v.recovery !== undefined) { const r = obj(v.recovery), fraction = quotaFraction(r.fraction); if (r.fraction !== null && fraction === null) bad(); recovery = { fraction, observedAt: number(r.observedAt), valid: r.valid === undefined ? true : bool(r.valid) }; }
  return { id: uuid(v.id), revision: uuid(v.revision), accountId: uuid(v.accountId), fingerprint: text(v.fingerprint, 2000), modelId, endpoint: v.endpoint as ImageEndpoint,
    schedule: validateWakeSchedule(v.schedule as WakeSchedule), enabled: bool(v.enabled), outputBudget, nextDue: number(v.nextDue), ...(recovery ? { recovery } : {}) };
}
export function parseWakeState(value: unknown): WakeState {
  const v = obj(value), a = obj(v.alerts), threshold = number(a.threshold, 99); if (v.schema !== 1 || !threshold) bad();
  const tasks = rows(v.tasks, 50).map(parseWakeTask);
  if (new Set(tasks.map(t => t.id)).size !== tasks.length) bad();
  const instances = rows(v.instances, 500).map(item => {
    const i = obj(item), phase = text(i.phase); if (!['preparing', 'sent', 'succeeded', 'failed', 'unknown', 'cancelled', 'skipped'].includes(phase)) bad();
    return { id: text(i.id, 300), taskId: uuid(i.taskId), revision: uuid(i.revision), accountId: uuid(i.accountId), modelId: text(i.modelId, 128), due: number(i.due), manual: bool(i.manual), nonce: uuid(i.nonce), leaseUntil: number(i.leaseUntil), phase: phase as WakeOutcome,
      code: typeof i.code === 'string' && /^[A-Z_0-9]{0,100}$/.test(i.code) ? i.code : bad(), ...(i.outputTokens === undefined ? {} : { outputTokens: number(i.outputTokens) }), ...(i.totalTokens === undefined ? {} : { totalTokens: number(i.totalTokens) }) };
  });
  if (new Set(instances.map(i => i.id)).size !== instances.length) bad();
  const readings = rows(v.readings, 10000).map(item => { const r = obj(item); if (!['healthy', 'low', 'exhausted'].includes(String(r.state))) bad(); return { key: text(r.key, 4000), observedAt: number(r.observedAt), state: r.state as AlertReading['state'] }; });
  return { schema: 1, consent: bool(v.consent), enabled: bool(v.enabled), tasks, instances, alerts: { low: bool(a.low), exhausted: bool(a.exhausted), recovered: bool(a.recovered), threshold }, readings };
}
