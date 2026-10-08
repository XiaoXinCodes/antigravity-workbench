/* eslint-disable no-control-regex -- Deliberately reject terminal/control characters in identity and quota fields. */
import { t as tr } from './i18n';
import * as http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { LiveError } from './live-storage';
import type { HubProof } from './live-switch';

export interface OfficialApi { port: number; csrfToken: string }
export function hasOfficialHubApi(value: unknown): value is OfficialApi {
  if (!value || typeof value !== 'object') return false;
  const { port, csrfToken } = value as Partial<OfficialApi>;
  return Number.isInteger(port) && typeof port === 'number' && port >= 1 && port <= 65535 && typeof csrfToken === 'string' && /^[a-zA-Z0-9_-]{16,128}$/.test(csrfToken);
}
function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function email(value: unknown): string {
  if (typeof value !== 'string' || !/^[^\s@\x00-\x1f<>]{1,128}@[^\s@\x00-\x1f<>]{1,128}$/.test(value)) throw new LiveError('HUB_EMAIL_MISSING');
  return value.toLowerCase();
}
const restartEpochs = new Map<string, string>();
function capabilityGeneration(api: OfficialApi): string {
  if (!hasOfficialHubApi(api)) throw new LiveError('OFFICIAL_HUB_API_UNAVAILABLE');
  return createHash('sha256').update(`${api.port}:${api.csrfToken}`).digest('hex');
}
export function generation(api: OfficialApi): string {
  const capability = capabilityGeneration(api);
  return restartEpochs.get(capability) ?? capability;
}
/** Call only after observing a controlled stop (zero backends/no API) followed
 * by one fresh backend and a stable API. Fixed-port official configurations reuse
 * their CSRF capability; this local epoch represents that observed process change.
 * It is not an identity proof; the transaction still requires fresh server identity.
 */
export function noteObservedHubRestart(api: OfficialApi): string {
  const capability = capabilityGeneration(api);
  const epoch = createHash('sha256').update(`${capability}:${randomUUID()}`).digest('hex');
  restartEpochs.set(capability, epoch);
  return epoch;
}
export function parseHubProof(auth: unknown, status: unknown, api: OfficialApi): HubProof {
  if (object(object(auth).authResult).hasValidAuth !== true) throw new LiveError('HUB_AUTH_INVALID');
  const user = object(object(status).userStatus);
  const identity = email(user.email);
  const configs = object(user.cascadeModelConfigData).clientModelConfigs;
  const buckets: HubProof['buckets'] = [];
  if (Array.isArray(configs)) for (const item of configs.slice(0, 100)) {
    const model = object(item), quota = object(model.quotaInfo);
    if (!Object.keys(quota).length) continue;
    const value = quota.remainingFraction;
    const label = typeof model.label === 'string' ? model.label : typeof model.modelId === 'string' ? model.modelId : tr("liveHub.c98e118e0a");
    buckets.push({ label: label.replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, 120), remaining: typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null, resetAt: typeof quota.resetTime === 'string' && Number.isFinite(Date.parse(quota.resetTime)) ? quota.resetTime : null });
  }
  return { email: identity, generation: generation(api), observedAt: new Date().toISOString(), authValid: true, buckets };
}
type HubMethod = 'GetAuthStatus' | 'GetUserStatus' | 'GetAvailableModels' | 'RetrieveUserQuotaSummary' | 'Login';
function requestHub(api: OfficialApi, method: HubMethod, payload: string, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
  const cancelled = method === 'Login' ? 'LOGIN_CANCELLED' : 'QUOTA_QUERY_CANCELLED';
  if (signal?.aborted) return Promise.reject(new LiveError(cancelled));
  if (!hasOfficialHubApi(api)) return Promise.reject(new LiveError('OFFICIAL_HUB_API_UNAVAILABLE'));
  return new Promise((resolve, reject) => {
    let bytes = 0, body = '', done = false;
    const finish = (error?: LiveError, value?: unknown): void => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); if (error) reject(error); else resolve(value); };
    // Fixed loopback only, no proxy, no redirects, no remote URL, no persisted CSRF material.
    const req = http.request({ hostname: '127.0.0.1', port: api.port, method: 'POST', path: `/exa.language_server_pb.LanguageServerService/${method}`, agent: false,
      headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', 'x-codeium-csrf-token': api.csrfToken } }, response => {
      response.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 1024 * 1024) { req.destroy(); finish(new LiveError('HUB_RESPONSE_TOO_LARGE')); } else body += chunk.toString('utf8'); });
      response.on('end', () => {
        if (response.statusCode !== 200) { finish(new LiveError('HUB_RPC_FAILED')); return; }
        try { finish(undefined, JSON.parse(body)); } catch { finish(new LiveError('HUB_RESPONSE_INVALID')); }
      });
      response.on('error', () => finish(new LiveError('HUB_RPC_FAILED')));
    });
    const abort = (): void => { req.destroy(); finish(new LiveError(cancelled)); };
    const timer = setTimeout(() => { req.destroy(); finish(new LiveError(method === 'Login' ? 'LOGIN_TIMEOUT' : 'HUB_RPC_TIMEOUT')); }, timeoutMs);
    req.on('error', () => finish(new LiveError('HUB_RPC_FAILED')));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    req.end(payload);
  });
}
export function hubRpc(api: OfficialApi, method: 'GetAuthStatus' | 'GetUserStatus' | 'GetAvailableModels', signal?: AbortSignal): Promise<unknown> {
  return requestHub(api, method, '{}', 15_000, signal);
}
export async function loginWithOfficialHub(api: OfficialApi, signal: AbortSignal): Promise<void> {
  // Official agy owns its client, PKCE/state, browser, callback, exchange, and original storage.
  // No Google authorization URL, code, verifier, token, or third-party client secret crosses this RPC.
  const response = await requestHub(api, 'Login', '{"isGcpTos":false,"additionalScopes":[],"enableBusinessLogin":false}', 310_000, signal);
  if (signal.aborted) throw new LiveError('LOGIN_CANCELLED');
  if (object(object(response).authResult).hasValidAuth !== true) throw new LiveError('LOGIN_NOT_AUTHENTICATED');
}
export async function queryHub(api: OfficialApi, signal?: AbortSignal): Promise<HubProof> {
  const auth = await hubRpc(api, 'GetAuthStatus', signal);
  const status = await hubRpc(api, 'GetUserStatus', signal);
  return parseHubProof(auth, status, api);
}

function quotaLabel(value: unknown): string {
  return typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 120) : '';
}
/** Official agy 1.2.14 quota_summary.proto; this is distinct from cached model config quotaInfo. */
export function parseFreshQuota(value: unknown): HubProof['buckets'] {
  const summary = object(object(value).response);
  if (summary.groups !== undefined && !Array.isArray(summary.groups) || summary.buckets !== undefined && !Array.isArray(summary.buckets)) throw new LiveError('HUB_QUOTA_RESPONSE_INVALID');
  const groups = Array.isArray(summary.groups) ? summary.groups : [];
  const legacy = Array.isArray(summary.buckets) ? summary.buckets : [];
  if (groups.length > 100 || legacy.length > 200) throw new LiveError('HUB_QUOTA_RESPONSE_INVALID');
  const rows: { group: string; value: unknown }[] = [];
  for (const item of groups) {
    const group = object(item);
    if (group.buckets !== undefined && !Array.isArray(group.buckets)) throw new LiveError('HUB_QUOTA_RESPONSE_INVALID');
    for (const bucket of Array.isArray(group.buckets) ? group.buckets : []) {
      rows.push({ group: quotaLabel(group.displayName), value: bucket });
      if (rows.length > 200) throw new LiveError('HUB_QUOTA_RESPONSE_INVALID');
    }
  }
  // The top-level buckets field is deprecated. Do not double-count when groups are present.
  if (!rows.length) for (const bucket of legacy) rows.push({ group: '', value: bucket });
  if (!rows.length) throw new LiveError('HUB_QUOTA_EMPTY');
  return rows.map(({ group, value: row }) => {
    const bucket = object(row), fraction = bucket.remainingFraction, amount = bucket.remainingAmount;
    if (!Object.keys(bucket).length || fraction != null && (typeof fraction !== 'number' || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) || fraction != null && amount != null || bucket.disabled !== undefined && typeof bucket.disabled !== 'boolean') throw new LiveError('HUB_QUOTA_RESPONSE_INVALID');
    let remainingAmount: string | undefined;
    if (amount != null) {
      const candidate = typeof amount === 'string' ? amount : typeof amount === 'number' && Number.isSafeInteger(amount) ? String(amount) : '';
      if (!/^(0|[1-9][0-9]{0,18})$/.test(candidate) || BigInt(candidate) > 9223372036854775807n) throw new LiveError('HUB_QUOTA_RESPONSE_INVALID');
      remainingAmount = candidate;
    }
    const label = quotaLabel(bucket.displayName) || quotaLabel(bucket.bucketId) || tr("liveHub.32ce9f0658");
    const window = quotaLabel(bucket.window);
    return {
      label: [group, label, window].filter((part, index, all) => part && all.indexOf(part) === index).join(' · ').slice(0, 120),
      remaining: typeof fraction === 'number' ? fraction : null,
      resetAt: typeof bucket.resetTime === 'string' && Number.isFinite(Date.parse(bucket.resetTime)) ? bucket.resetTime : null,
      ...(remainingAmount !== undefined ? { remainingAmount } : {}),
      ...(bucket.disabled === true ? { disabled: true } : {}),
    };
  });
}

export async function queryFreshQuota(api: OfficialApi, expectedEmail?: string, signal?: AbortSignal): Promise<HubProof> {
  if (signal?.aborted) throw new LiveError('QUOTA_QUERY_CANCELLED');
  if (!hasOfficialHubApi(api)) throw new LiveError('OFFICIAL_HUB_API_UNAVAILABLE');
  // Pin every request to one official hub capability; never select a saved credential or log in.
  const pinned = { port: api.port, csrfToken: api.csrfToken };
  const before = await queryHub(pinned, signal);
  if (expectedEmail !== undefined && before.email !== email(expectedEmail)) throw new LiveError('HUB_QUOTA_ACCOUNT_MISMATCH');
  // Verified in agy 1.2.14: forceRefresh clears the summary cache and waits for the
  // remote retrieveUserQuotaSummary request. Errors propagate instead of returning old rows.
  const response = await requestHub(pinned, 'RetrieveUserQuotaSummary', '{"forceRefresh":true}', 30_000, signal);
  const buckets = parseFreshQuota(response);
  const after = await queryHub(pinned, signal);
  if (signal?.aborted) throw new LiveError('QUOTA_QUERY_CANCELLED');
  if (before.email !== after.email || before.generation !== after.generation || generation(api) !== before.generation) throw new LiveError('HUB_CHANGED_DURING_QUERY');
  return { ...after, observedAt: new Date().toISOString(), buckets, quotaSource: 'server' };
}

/** Empty-session verification is a negative auth check, pinned to one fresh hub. */
export async function querySignedOutHub(api: OfficialApi, signal?: AbortSignal): Promise<{ generation: string; authValid: false }> {
  const pinned = { port: api.port, csrfToken: api.csrfToken };
  for (let count = 0; count < 2; count++) {
    const auth = object(await hubRpc(pinned, 'GetAuthStatus', signal));
    if (object(auth.authResult).hasValidAuth !== false) throw new LiveError('HUB_SIGNED_OUT_NOT_VERIFIED');
  }
  return { generation: generation(pinned), authValid: false };
}
/** Force a successful server refresh for identity verification, even when no quota rows exist. */
export async function queryFreshIdentity(api: OfficialApi, signal?: AbortSignal): Promise<HubProof> {
  const pinned = { port: api.port, csrfToken: api.csrfToken };
  const before = await queryHub(pinned, signal);
  const response = await requestHub(pinned, 'RetrieveUserQuotaSummary', '{"forceRefresh":true}', 30_000, signal);
  const envelope = object(response);
  if (!Object.hasOwn(envelope, 'response') || !envelope.response || typeof envelope.response !== 'object' || Array.isArray(envelope.response) || Object.hasOwn(envelope, 'error')) throw new LiveError('HUB_QUOTA_RESPONSE_INVALID');
  try { parseFreshQuota(response); } catch (error) { if (!(error instanceof LiveError) || error.code !== 'HUB_QUOTA_EMPTY') throw error; }
  const after = await queryHub(pinned, signal);
  if (signal?.aborted) throw new LiveError('QUOTA_QUERY_CANCELLED');
  if (before.email !== after.email || before.generation !== after.generation || generation(api) !== before.generation) throw new LiveError('HUB_CHANGED_DURING_QUERY');
  // Identity checks never seed account quota UI from cached GetUserStatus models.
  return { ...after, buckets: [], quotaSource: 'server' };
}
