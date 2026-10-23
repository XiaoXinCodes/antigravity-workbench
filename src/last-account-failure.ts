import { fileRouteFailureReason, type FileRouteFailureReason } from './file-route-failure';
import { debugErrorCode } from './debug-events';
import type { LiveInstallStage } from './live-switch';

export const LAST_ACCOUNT_FAILURE = 'live-switch.lastFailure.v1';
const ACTIONS = ['login', 'capture', 'switch', 'verify', 'quota', 'restore', 'remove', 'export', 'import'] as const;
export const OFFLINE_PREPARE_STAGES = ['route', 'args', 'confirm', 'lock', 'contract', 'census', 'scope', 'prepare', 'helper'] as const;
const STAGES = [...OFFLINE_PREPARE_STAGES, 'command', 'preflight', 'stop', 'backup', 'credential-write', 'credential-readback', 'journal-installed', 'reconnect', 'verify', 'resume', 'restore', 'cleanup'] as const;
const PHASES = ['none', 'authorizing', 'prepared', 'installed', 'restored', 'unavailable'] as const;
export type AccountFailureStage = typeof OFFLINE_PREPARE_STAGES[number] | LiveInstallStage | 'command' | 'verify' | 'resume' | 'restore' | 'cleanup';
export interface LastAccountFailure {
  schema: 1; at: string; action: typeof ACTIONS[number]; stage: AccountFailureStage;
  phase: typeof PHASES[number]; code: string; recoveryCode?: string; fileRouteFailureReason?: FileRouteFailureReason;
}
function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  try { const property = Object.getOwnPropertyDescriptor(value, key); return property && 'value' in property ? property.value : undefined; }
  catch { return undefined; }
}
function member<T extends string>(value: unknown, values: readonly T[]): value is T { return typeof value === 'string' && values.includes(value as T); }
/** A single bounded failure survives debug-OFF and reload. Never persist raw
 * errors, stacks, messages, account/transaction IDs, paths or credential data. */
export function readLastAccountFailure(value: unknown): LastAccountFailure | undefined {
  const at = own(value, 'at'), action = own(value, 'action'), stage = own(value, 'stage'), phase = own(value, 'phase');
  const code = own(value, 'code'), recoveryCode = own(value, 'recoveryCode');
  if (own(value, 'schema') !== 1 || typeof at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(at) || !Number.isFinite(Date.parse(at)) ||
      !member(action, ACTIONS) || !member(stage, STAGES) || !member(phase, PHASES) || typeof code !== 'string' || debugErrorCode({code}) !== code) return undefined;
  return { schema: 1, at, action, stage, phase, code,
    ...(fileRouteFailureReason(value) ? { fileRouteFailureReason: fileRouteFailureReason(value)! } : {}),
    ...(typeof recoveryCode === 'string' && debugErrorCode({code: recoveryCode}) === recoveryCode ? {recoveryCode} : {}) };
}
