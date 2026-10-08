/** Export only fixed enums and counts, never arbitrary errors, identities or logs. */
export const ACCEPTANCE_ACTIONS = ['account-saved', 'oauth-original-restored', 'switch-verified', 'restore-verified', 'quota-ready', 'quota-failed', 'account-removed'] as const;
export type AcceptanceAction = typeof ACCEPTANCE_ACTIONS[number];
export interface AcceptanceEvent { action: AcceptanceAction; at: string }
export function acceptanceEvents(value: unknown): AcceptanceEvent[] {
  if (!Array.isArray(value)) return [];
  return value.slice(-100).filter((item): item is AcceptanceEvent => !!item && typeof item === 'object' && ACCEPTANCE_ACTIONS.includes(item.action) && typeof item.at === 'string' && Number.isFinite(Date.parse(item.at)))
    .map(item => ({ action: item.action, at: new Date(item.at).toISOString() }));
}
export function acceptanceReport(value: unknown, accountCount: number, platform: string, version?: unknown): string {
  const extensionVersion = typeof version === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(version) ? version : 'unknown';
  return JSON.stringify({ schema: 1, extensionVersion, platform: ['win32', 'darwin', 'linux'].includes(platform) ? platform : 'unknown',
    savedAccountCount: Number.isSafeInteger(accountCount) && accountCount >= 0 && accountCount <= 50 ? accountCount : 0,
    events: acceptanceEvents(value), scope: 'Observed local operations only; real two-account coverage must be checked against the local checklist.' }, null, 2) + '\n';
}
