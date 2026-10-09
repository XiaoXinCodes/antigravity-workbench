import type { LocalState } from './private-state';
import type { WakeState } from './wake-state';
import { quotaFraction, quotaIsStale } from './quota-presentation';
export interface AlertSample { accountId: string; fingerprint: string; quotaKey: string; modelLabel: string; observedAt: string; fraction: number | null | undefined }
export interface QuotaAlert extends AlertSample { edge: 'low' | 'exhausted' | 'recovered' }
export async function observeQuotaAlerts(store: LocalState<WakeState>, samples: readonly AlertSample[], now = Date.now()): Promise<QuotaAlert[]> {
  return store.transaction(state => {
    const alerts: QuotaAlert[] = [];
    for (const sample of samples) {
      const fraction = quotaFraction(sample.fraction), observedAt = Date.parse(sample.observedAt);
      if (fraction === null || quotaIsStale(sample.observedAt, now)) continue;
      const key = JSON.stringify([sample.accountId, sample.fingerprint, sample.quotaKey]);
      const previous = state.readings.find(r => r.key === key); if (previous && observedAt <= previous.observedAt) continue;
      const next = fraction === 0 ? 'exhausted' : fraction * 100 <= state.alerts.threshold ? 'low' : 'healthy';
      // First observation seeds a baseline; enabling a preference does not emit
      // an old condition as a new event. Unknown/failed observations leave it intact.
      const edge = previous && next !== previous.state ? next === 'healthy' ? 'recovered' : next : undefined;
      if (edge && state.alerts[edge]) alerts.push({ ...sample, edge });
      if (previous) Object.assign(previous, { observedAt, state: next }); else state.readings.push({ key, observedAt, state: next });
    }
    state.readings = state.readings.sort((a, b) => b.observedAt - a.observedAt).slice(0, 10000);
    return alerts;
  });
}
