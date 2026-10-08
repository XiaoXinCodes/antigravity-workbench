/* eslint-disable no-control-regex -- Reject control characters in server identities. */
import { createHash, randomUUID } from 'node:crypto';
import { LiveError, assertSlotIdentity, tokenAccountHint, validateSlots, type TokenSlots } from './live-storage';
import { parseFreshQuota } from './live-hub';
import type { LiveAccount, HubProof } from './live-switch';
import { CONSUMER_CLIENT_ID_SHA256, type ConsumerRefreshProvider } from './account-quota-client';
import { requestAccountQuota, validBearerToken, validQuotaProject, type AccountQuotaTransport, type AccountQuotaRequest } from './account-quota-transport';

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue { return value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {}; }
function identityEmail(value: unknown): string {
  if (typeof value !== 'string' || !/^[^\s@\x00-\x1f\x7f<>]{1,128}@[^\s@\x00-\x1f\x7f<>]{1,128}$/.test(value) || /[\u202a-\u202e\u2066-\u2069]/u.test(value)) throw new LiveError('ACCOUNT_QUOTA_IDENTITY_INVALID');
  return value.toLowerCase();
}
export function parseAccountQuotaIdentity(value: unknown): { email: string; subject: string } {
  const user = object(value);
  if (user.verified_email !== true || typeof user.id !== 'string' || !/^[a-zA-Z0-9_-]{1,255}$/.test(user.id)) throw new LiveError('ACCOUNT_QUOTA_IDENTITY_INVALID');
  return { email: identityEmail(user.email), subject: user.id };
}
export interface SavedQuotaRefresh {
  provider: ConsumerRefreshProvider;
  loadPending(expectedSlots: TokenSlots): Promise<TokenSlots | undefined>;
  stage(expectedSlots: TokenSlots, nextSlots: TokenSlots): Promise<void>;
  commit(expectedSlots: TokenSlots, nextSlots: TokenSlots): Promise<void>;
}
export interface SavedAccountQuotaOptions { refresh?: SavedQuotaRefresh; phase?: (phase: 'refreshing' | 'saving' | 'querying') => void }
export interface SavedAccountBearer {
  readonly accountId: string; readonly accessToken: string; readonly expiry: number; readonly email: string; readonly subject: string;
  readonly projectId?: string;
  assertPublicResponse(value: unknown): void;
}
interface SavedAccess { accountId: string; email: string; accessToken: string; expiry: number; refreshToken: string; refreshEligible: boolean; projectId?: string; subjectHint?: string }
function knownAudience(stored: ObjectValue): boolean {
  if (typeof stored.id_token !== 'string') return true;
  try {
    const claims = object(JSON.parse(Buffer.from(stored.id_token.split('.')[1] || '', 'base64url').toString('utf8')));
    if (claims.aud === undefined) return true;
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    return audiences.length === 1 && typeof audiences[0] === 'string' && createHash('sha256').update(audiences[0]).digest('hex') === CONSUMER_CLIENT_ID_SHA256;
  } catch { return false; }
}
function refreshedSlots(expected: TokenSlots, value: unknown, now: number): TokenSlots {
  const response = object(value);
  if (!validBearerToken(response.access_token) || response.token_type !== undefined && (typeof response.token_type !== 'string' || response.token_type.toLowerCase() !== 'bearer') ||
      !Number.isSafeInteger(response.expires_in) || (response.expires_in as number) < 1 || (response.expires_in as number) > 31_536_000 ||
      response.refresh_token !== undefined && !validBearerToken(response.refresh_token) || response.id_token !== undefined && (typeof response.id_token !== 'string' || response.id_token.length > 65_536 || !/^[A-Za-z0-9_.-]+$/.test(response.id_token))) throw new LiveError('ACCOUNT_QUOTA_REFRESH_OUTCOME_UNKNOWN');
  const update = (raw: string | null): string | null => {
    if (raw === null) return null;
    const stored = object(JSON.parse(raw)), token = object(stored.token);
    return JSON.stringify({ ...stored, token: { ...token, access_token: response.access_token, token_type: 'Bearer',
      refresh_token: response.refresh_token ?? token.refresh_token, expiry: new Date(now + (response.expires_in as number) * 1000).toISOString(), expires_in: response.expires_in },
      ...(response.id_token === undefined ? {} : { id_token: response.id_token }) });
  };
  return { ...expected, keyring: update(expected.keyring), file: update(expected.file) };
}

/** Decode the audited native Go StoredToken, not a JWT identity claim or a Manager export. */
function savedAccess(account: LiveAccount, now: number, allowExpired = false): SavedAccess {
  if (!account || !/^[a-f0-9-]{36}$/.test(account.id)) throw new LiveError('ACCOUNT_QUOTA_ACCOUNT_INVALID');
  const expectedEmail = identityEmail(account.expectedEmail);
  try { validateSlots(account.slots); assertSlotIdentity(account.slots, expectedEmail); }
  catch { throw new LiveError('ACCOUNT_QUOTA_TOKEN_UNSUPPORTED'); }
  const rows = [account.slots.keyring, account.slots.file].filter((value): value is string => value !== null);
  const hints = rows.map(tokenAccountHint);
  // Unsigned JWT subject hints must never arbitrate different refresh credentials.
  if (hints.some(hint => hint.refresh !== hints[0]!.refresh)) throw new LiveError('ACCOUNT_QUOTA_TOKEN_CONFLICT');
  const candidates = rows.map((raw, index) => {
    const stored = object(JSON.parse(raw)), token = object(stored.token);
    if (stored.auth_method !== undefined && stored.auth_method !== '' && stored.auth_method !== 'oauth' && stored.auth_method !== 'consumer' ||
        token.token_type !== undefined && token.token_type !== '' && (typeof token.token_type !== 'string' || token.token_type.toLowerCase() !== 'bearer')) {
      throw new LiveError('ACCOUNT_QUOTA_TOKEN_UNSUPPORTED');
    }
    // expires_in is relative to token issuance, NOT capturedAt. Never extend it from capture time.
    const expiry = typeof token.expiry === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(token.expiry) ? Date.parse(token.expiry) : NaN;
    const projectId = stored.project_id;
    if (projectId !== undefined && projectId !== '' && !validQuotaProject(projectId)) throw new LiveError('ACCOUNT_QUOTA_TOKEN_UNSUPPORTED');
    return { accountId: account.id, email: expectedEmail, accessToken: token.access_token, expiry, refreshToken: hints[index]!.refresh,
      refreshEligible: stored.auth_method === 'consumer' && knownAudience(stored),
      ...(projectId ? { projectId: projectId as string } : {}), ...(hints[index]!.subject ? { subjectHint: hints[index]!.subject! } : {}) };
  });
  const available = candidates.filter(row => validBearerToken(row.accessToken) && Number.isFinite(row.expiry) && row.expiry > now + 30_000)
    .sort((a, b) => b.expiry - a.expiry)[0] ?? (allowExpired ? candidates[0] : undefined);
  if (!available) throw new LiveError('ACCOUNT_QUOTA_REAUTH_REQUIRED');
  return { ...available, accessToken: validBearerToken(available.accessToken) ? available.accessToken : '', refreshEligible: candidates.every(row => row.refreshEligible) };
}

/** Local structural readiness only, never a network authorization claim. */
export function savedLoginLocallyUsable(account: LiveAccount, now = Date.now()): boolean {
  try {
    const saved = savedAccess(account, now, true);
    return validBearerToken(saved.accessToken) && (!Number.isFinite(saved.expiry) || saved.expiry > now + 30_000) || saved.refreshEligible && validBearerToken(saved.refreshToken);
  } catch { return false; }
}

const STORE_ERRORS = new Set(['ACCOUNT_QUOTA_REFRESH_CONFLICT', 'ACCOUNT_QUOTA_REFRESH_RECOVERY_INVALID', 'ACCOUNT_QUOTA_REFRESH_SAVE_FAILED']);
const SAFE_ERRORS = new Set([...STORE_ERRORS, 'ACCOUNT_QUOTA_ACCOUNT_INVALID', 'ACCOUNT_QUOTA_IDENTITY_INVALID', 'ACCOUNT_QUOTA_IDENTITY_MISMATCH',
  'ACCOUNT_QUOTA_TOKEN_UNSUPPORTED', 'ACCOUNT_QUOTA_TOKEN_CONFLICT', 'ACCOUNT_QUOTA_REAUTH_REQUIRED', 'ACCOUNT_QUOTA_FORBIDDEN',
  'ACCOUNT_QUOTA_RATE_LIMITED', 'ACCOUNT_QUOTA_REDIRECT_BLOCKED', 'ACCOUNT_QUOTA_REQUEST_FAILED', 'ACCOUNT_QUOTA_ENDPOINT_BLOCKED',
  'ACCOUNT_QUOTA_RESPONSE_INVALID', 'ACCOUNT_QUOTA_RESPONSE_TOO_LARGE', 'ACCOUNT_QUOTA_TIMEOUT', 'ACCOUNT_QUOTA_EMPTY',
  'ACCOUNT_QUOTA_ALREADY_RUNNING', 'ACCOUNT_QUOTA_QUEUE_FULL', 'ACCOUNT_QUOTA_CLIENT_UNVERIFIED', 'ACCOUNT_QUOTA_REFRESH_PENDING', 'ACCOUNT_QUOTA_REFRESH_OUTCOME_UNKNOWN', 'ACCOUNT_QUOTA_SECURE_SAVE_FAILED', 'QUOTA_QUERY_CANCELLED']);
function safeError(error: unknown): LiveError {
  return error instanceof LiveError && SAFE_ERRORS.has(error.code) ? new LiveError(error.code) : new LiveError('ACCOUNT_QUOTA_REQUEST_FAILED');
}
function checkAbort(signal: AbortSignal): void { if (signal.aborted) throw new LiveError('QUOTA_QUERY_CANCELLED'); }
function cancellable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(new LiveError('QUOTA_QUERY_CANCELLED'));
    signal.addEventListener('abort', abort, { once: true });
    work.then(value => { signal.removeEventListener('abort', abort); if (signal.aborted) abort(); else resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort();
  });
}

/** Dependencies are for isolated fixtures, never workspace settings or webview messages. */
export class SavedAccountQuotaClient {
  private active = 0;
  private readonly ids = new Set<string>();
  private readonly grants = new Set<string>();
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly transport: AccountQuotaTransport = requestAccountQuota, private readonly now: () => number = Date.now, private readonly deadlineMs = 45_000) {
    if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 60_000) throw new LiveError('ACCOUNT_QUOTA_REQUEST_FAILED');
  }
  private async acquire(signal: AbortSignal): Promise<() => void> {
    checkAbort(signal);
    if (this.active < 2) this.active++;
    else {
      if (this.waiting.length >= 50) throw new LiveError('ACCOUNT_QUOTA_QUEUE_FULL');
      await new Promise<void>((resolve, reject) => {
        const ready = (): void => { signal.removeEventListener('abort', abort); resolve(); };
        const abort = (): void => { const index = this.waiting.indexOf(ready); if (index !== -1) this.waiting.splice(index, 1); reject(new LiveError('QUOTA_QUERY_CANCELLED')); };
        this.waiting.push(ready); signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
    }
    let released = false;
    return () => { if (released) return; released = true; const next = this.waiting.shift(); if (next) next(); else this.active--; };
  }
  async query(account: LiveAccount, signal?: AbortSignal, options: SavedAccountQuotaOptions = {}): Promise<HubProof> {
    return this.withAccess(account, signal, options, async (access, requestSignal) => {
      const response = await this.transport({ endpoint: 'quota', accessToken: access.accessToken, signal: requestSignal,
        ...(access.projectId ? { projectId: access.projectId } : {}) });
      access.assertPublicResponse(response);
      let buckets: HubProof['buckets'];
      try { buckets = parseFreshQuota({ response }); }
      catch (error) { throw new LiveError(error instanceof LiveError && error.code === 'HUB_QUOTA_EMPTY' ? 'ACCOUNT_QUOTA_EMPTY' : 'ACCOUNT_QUOTA_RESPONSE_INVALID'); }
      return { email: access.email, generation: `saved-account:${access.accountId}:${randomUUID()}`, observedAt: new Date(this.now()).toISOString(), authValid: true, quotaSource: 'server', buckets };
    });
  }
  /** The caller holds the host mutation lock and establishes user intent before loading the account
   * (a quota-query confirmation or explicit selection of an existing image account).
   * Only metadata belongs inside this transaction: never a billable image submission. */
  async withAccess<T>(account: LiveAccount, signal: AbortSignal | undefined, options: SavedAccountQuotaOptions,
    operation: (access: SavedAccountBearer, signal: AbortSignal) => Promise<T>): Promise<T> {
    if (signal?.aborted) throw new LiveError('QUOTA_QUERY_CANCELLED');
    if (!account || !account.slots) throw new LiveError('ACCOUNT_QUOTA_ACCOUNT_INVALID');
    const expectedSlots = structuredClone(account.slots);
    const pinned = { ...account, slots: expectedSlots };
    let saved = savedAccess(pinned, this.now(), !!options.refresh);
    const originalSubject = saved.subjectHint;
    const sensitive = new Set<string>([saved.accessToken, saved.refreshToken].filter(Boolean));
    for (const raw of [expectedSlots.keyring, expectedSlots.file]) if (raw) { const token = object(object(JSON.parse(raw)).token); if (typeof token.access_token === 'string' && token.access_token) sensitive.add(token.access_token); if (typeof token.refresh_token === 'string' && token.refresh_token) sensitive.add(token.refresh_token); }
    if (this.ids.has(saved.accountId)) throw new LiveError('ACCOUNT_QUOTA_ALREADY_RUNNING');
    this.ids.add(saved.accountId);
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    let timedOut = false, release: (() => void) | undefined, refreshed = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.deadlineMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const phase = (value: 'refreshing' | 'saving' | 'querying'): void => { try { options.phase?.(value); } catch { /* Rendering cannot interrupt credential durability. */ } };
    const assertIdentity = (identity: { email: string; subject: string }): void => {
      if (identity.email !== saved.email || originalSubject !== undefined && identity.subject !== originalSubject) throw new LiveError('ACCOUNT_QUOTA_IDENTITY_MISMATCH');
    };
    const performRefresh = async (pending?: TokenSlots): Promise<void> => {
      const hooks = options.refresh;
      if (!hooks || hooks.provider.clientIdSha256 !== CONSUMER_CLIENT_ID_SHA256 || !saved.refreshEligible) throw new LiveError('ACCOUNT_QUOTA_CLIENT_UNVERIFIED');
      checkAbort(controller.signal);
      let source = pending ? savedAccess({ ...pinned, slots: pending }, this.now(), true) : saved;
      if (!source.refreshEligible || !validBearerToken(source.refreshToken)) throw new LiveError('ACCOUNT_QUOTA_CLIENT_UNVERIFIED');
      const grant = createHash('sha256').update(source.refreshToken).digest('hex');
      if (this.grants.has(grant)) throw new LiveError('ACCOUNT_QUOTA_ALREADY_RUNNING');
      this.grants.add(grant);
      const transaction = new AbortController();
      // Once a token exchange starts, caller cancellation cannot safely discard a
      // potentially rotated response. Finish this bounded identity/save transaction.
      const deadline = setTimeout(() => transaction.abort(), 35_000);
      let candidate = pending, staged = pending !== undefined, committed = false;
      try {
        if (!candidate || !source.accessToken || !Number.isFinite(source.expiry) || source.expiry <= this.now() + 5_000) {
          phase('refreshing');
          let response: unknown;
          try { response = await cancellable(hooks.provider.exchange(source.refreshToken, transaction.signal), transaction.signal); }
          catch (error) { if (error instanceof LiveError && SAFE_ERRORS.has(error.code) && error.code !== 'QUOTA_QUERY_CANCELLED') throw error; throw new LiveError('ACCOUNT_QUOTA_REFRESH_OUTCOME_UNKNOWN'); }
          candidate = refreshedSlots(candidate ?? expectedSlots, response, this.now());
          phase('saving');
          try { await hooks.stage(expectedSlots, candidate); staged = true; }
          catch (error) { throw new LiveError(error instanceof LiveError && STORE_ERRORS.has(error.code) ? error.code : 'ACCOUNT_QUOTA_SECURE_SAVE_FAILED'); }
          source = savedAccess({ ...pinned, slots: candidate }, this.now(), true);
          if (!source.refreshEligible) throw new LiveError('ACCOUNT_QUOTA_CLIENT_UNVERIFIED');
        }
        sensitive.add(source.accessToken); sensitive.add(source.refreshToken);
        const identity = parseAccountQuotaIdentity(await cancellable(this.transport({ endpoint: 'identity', accessToken: source.accessToken, signal: transaction.signal }), transaction.signal));
        assertIdentity(identity);
        phase('saving');
        try { await hooks.commit(expectedSlots, candidate); committed = true; }
        catch (error) { throw new LiveError(error instanceof LiveError && STORE_ERRORS.has(error.code) ? error.code : 'ACCOUNT_QUOTA_SECURE_SAVE_FAILED'); }
        saved = source; refreshed = true;
      } catch (error) {
        if (staged && !committed && !(error instanceof LiveError && ([...STORE_ERRORS, 'ACCOUNT_QUOTA_IDENTITY_MISMATCH', 'ACCOUNT_QUOTA_CLIENT_UNVERIFIED', 'ACCOUNT_QUOTA_SECURE_SAVE_FAILED'].includes(error.code)))) throw new LiveError('ACCOUNT_QUOTA_REFRESH_PENDING');
        throw error;
      } finally { clearTimeout(deadline); this.grants.delete(grant); }
      checkAbort(controller.signal);
    };
    const request = async (endpoint: AccountQuotaRequest['endpoint']): Promise<unknown> => {
      checkAbort(controller.signal);
      if (!saved.accessToken || !Number.isFinite(saved.expiry) || saved.expiry <= this.now() + 5_000) throw new LiveError('ACCOUNT_QUOTA_REAUTH_REQUIRED');
      return cancellable(this.transport({ endpoint, accessToken: saved.accessToken, signal: controller.signal,
        ...(endpoint === 'quota' && saved.projectId ? { projectId: saved.projectId } : {}) }), controller.signal);
    };
    try {
      release = await this.acquire(controller.signal);
      const pending = await options.refresh?.loadPending(expectedSlots);
      if (pending) await performRefresh(pending);
      else if (!saved.accessToken || !Number.isFinite(saved.expiry) || saved.expiry <= this.now() + 30_000) await performRefresh();
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          phase('querying');
          const before = parseAccountQuotaIdentity(await request('identity')); assertIdentity(before);
          if (saved.expiry <= this.now() + 5_000) throw new LiveError('ACCOUNT_QUOTA_REAUTH_REQUIRED');
          const result = await cancellable(operation({ accountId: saved.accountId, accessToken: saved.accessToken, expiry: saved.expiry, email: before.email, subject: before.subject,
            ...(saved.projectId ? { projectId: saved.projectId } : {}),
            assertPublicResponse(value) {
              const encoded = JSON.stringify(value);
              if ([...sensitive].some(secret => encoded?.includes(secret))) throw new LiveError('ACCOUNT_QUOTA_RESPONSE_INVALID');
            } }, controller.signal), controller.signal);
          const after = parseAccountQuotaIdentity(await request('identity'));
          checkAbort(controller.signal);
          if (before.email !== after.email || before.subject !== after.subject) throw new LiveError('ACCOUNT_QUOTA_IDENTITY_MISMATCH');
          return result;
        } catch (error) {
          if (!refreshed && options.refresh && error instanceof LiveError && error.code === 'ACCOUNT_QUOTA_REAUTH_REQUIRED') { await performRefresh(); continue; }
          throw error;
        }
      }
      throw new LiveError('ACCOUNT_QUOTA_REAUTH_REQUIRED');
    } catch (error) {
      if (error instanceof Error && /^IMAGE_[A-Z_]+$/.test(error.message)) throw new Error(error.message);
      // Never hide unfinished rotated-grant persistence behind a cosmetic cancellation.
      if (error instanceof LiveError && [...STORE_ERRORS, 'ACCOUNT_QUOTA_REFRESH_PENDING', 'ACCOUNT_QUOTA_REFRESH_OUTCOME_UNKNOWN', 'ACCOUNT_QUOTA_SECURE_SAVE_FAILED', 'ACCOUNT_QUOTA_IDENTITY_MISMATCH', 'ACCOUNT_QUOTA_CLIENT_UNVERIFIED'].includes(error.code)) throw safeError(error);
      throw timedOut ? new LiveError('ACCOUNT_QUOTA_TIMEOUT') : signal?.aborted ? new LiveError('QUOTA_QUERY_CANCELLED') : safeError(error);
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); release?.(); this.ids.delete(saved.accountId); }
  }
}

const localQuotaClient = new SavedAccountQuotaClient();
/** Caller must receive an explicit user quota action before loading a saved login from SecretStorage. */
export function querySavedAccountQuota(account: LiveAccount, signal?: AbortSignal, options: SavedAccountQuotaOptions = {}): Promise<HubProof> {
  return localQuotaClient.query(account, signal, options);
}
