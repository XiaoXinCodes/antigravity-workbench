import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import * as https from 'node:https';
import { LiveError } from './live-storage';
import { validBearerToken } from './account-quota-transport';

// Fingerprints of Google's distributed *public native consumer-client* settings,
// independently checked in audited agy 1.2.14 auth.getOauthParams. No full client
// constants are bundled. These are client-binding facts, not user credentials.
export const CONSUMER_CLIENT_ID_SHA256 = 'bf00c418024ba6bf606ccdc37120976e41bc429dd1d46ecf16a729aa532626ea';
const CONSUMER_SHARED_SETTING_SHA256 = '1d2f041093fd95aa8995a038c711d50a7960da09a505381c09a745d6ad0ecc60';
export interface ConsumerOAuthClient { readonly clientId: string; readonly clientSecret: string }
export interface ConsumerRefreshProvider {
  readonly clientIdSha256: string;
  exchange(refreshToken: string, signal: AbortSignal): Promise<unknown>;
}
export function hasVerifiedConsumerClient(client: ConsumerOAuthClient): boolean {
  return typeof client?.clientId === 'string' && typeof client?.clientSecret === 'string' &&
    createHash('sha256').update(client.clientId).digest('hex') === CONSUMER_CLIENT_ID_SHA256 &&
    createHash('sha256').update(client.clientSecret).digest('hex') === CONSUMER_SHARED_SETTING_SHA256;
}

/** Read only the fixed official executable selected by the trusted host resolver.
 * No execution, workspace path, registry, account file, or keyring access. */
export async function readInstalledConsumerOAuthClient(executable: string, signal?: AbortSignal): Promise<ConsumerOAuthClient> {
  let file;
  try {
    if (signal?.aborted) throw new LiveError('QUOTA_QUERY_CANCELLED');
    const link = await fs.lstat(executable);
    if (!link.isFile() || link.isSymbolicLink() || link.size < 1 || link.size > 512 * 1024 * 1024 || process.platform !== 'win32' && (link.mode & 0o022)) throw new LiveError('ACCOUNT_QUOTA_CLIENT_UNVERIFIED');
    file = await fs.open(executable, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const before = await file.stat();
    if (before.ino !== link.ino || before.dev !== link.dev || before.size !== link.size || before.mtimeMs !== link.mtimeMs || before.ctimeMs !== link.ctimeMs) throw new LiveError('ACCOUNT_QUOTA_CLIENT_UNVERIFIED');
    let offset = 0, carry = '', clientId: string | undefined, clientSecret: string | undefined;
    const chunk = Buffer.alloc(1024 * 1024);
    while (true) {
      if (signal?.aborted) throw new LiveError('QUOTA_QUERY_CANCELLED');
      const { bytesRead } = await file.read(chunk, 0, chunk.length, offset);
      if (!bytesRead) break;
      offset += bytesRead;
      if (offset > before.size) throw new LiveError('ACCOUNT_QUOTA_CLIENT_UNVERIFIED');
      const text = carry + chunk.subarray(0, bytesRead).toString('latin1');
      for (const match of text.matchAll(/[0-9]{10,16}-[a-z0-9]{24,64}\.apps\.googleusercontent\.com/g)) {
        if (createHash('sha256').update(match[0]).digest('hex') === CONSUMER_CLIENT_ID_SHA256) clientId = match[0];
      }
      // Native Go strings are adjacent, not necessarily NUL-terminated.
      for (const match of text.matchAll(/GOCSPX-[A-Za-z0-9_-]{28}/g)) {
        if (createHash('sha256').update(match[0]).digest('hex') === CONSUMER_SHARED_SETTING_SHA256) clientSecret = match[0];
      }
      carry = text.slice(-256);
    }
    const after = await file.stat(), current = await fs.lstat(executable);
    if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || current.isSymbolicLink() || current.ino !== before.ino || current.dev !== before.dev || current.size !== before.size || current.mtimeMs !== before.mtimeMs || current.ctimeMs !== before.ctimeMs || !clientId || !clientSecret) throw new LiveError('ACCOUNT_QUOTA_CLIENT_UNVERIFIED');
    return Object.freeze({ clientId, clientSecret });
  } catch (error) { throw new LiveError(error instanceof LiveError && error.code === 'QUOTA_QUERY_CANCELLED' ? error.code : 'ACCOUNT_QUOTA_CLIENT_UNVERIFIED'); }
  finally { await file?.close(); }
}

/** No alternate clients/endpoints/proxies or new grants. Refresh belongs to the user's selected account operation. */
export function createConsumerRefreshTransport(
  request: typeof https.request = https.request,
  acceptsClient: (client: ConsumerOAuthClient) => boolean = hasVerifiedConsumerClient,
): (client: ConsumerOAuthClient, refreshToken: string, signal: AbortSignal) => Promise<unknown> {
return (client, refreshToken, signal) => {
  if (!acceptsClient(client)) return Promise.reject(new LiveError('ACCOUNT_QUOTA_CLIENT_UNVERIFIED'));
  if (!validBearerToken(refreshToken)) return Promise.reject(new LiveError('ACCOUNT_QUOTA_TOKEN_UNSUPPORTED'));
  if (signal.aborted) return Promise.reject(new LiveError('QUOTA_QUERY_CANCELLED'));
  const body = new URLSearchParams({ client_id: client.clientId, client_secret: client.clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }).toString();
  return new Promise((resolve, reject) => {
    let done = false, bytes = 0; const chunks: Buffer[] = [];
    const finish = (error?: LiveError, value?: unknown): void => { if (done) return; done = true; clearTimeout(timer); signal.removeEventListener('abort', abort); chunks.length = 0; if (error) reject(error); else resolve(value); };
    const req = request({ protocol: 'https:', hostname: 'oauth2.googleapis.com', port: 443, path: '/token', method: 'POST', agent: false, rejectUnauthorized: true,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'Content-Length': Buffer.byteLength(body), 'User-Agent': 'Antigravity-Workbench-Quota/1.0' } }, response => {
      if (response.statusCode && response.statusCode >= 500) { response.destroy(); finish(new LiveError('ACCOUNT_QUOTA_REFRESH_OUTCOME_UNKNOWN')); return; }
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400) { response.destroy(); finish(new LiveError('ACCOUNT_QUOTA_REDIRECT_BLOCKED')); return; }
      if (typeof response.headers['content-type'] !== 'string' || !/^application\/json(?:\s*;|$)/i.test(response.headers['content-type'])) { response.destroy(); finish(new LiveError('ACCOUNT_QUOTA_REFRESH_OUTCOME_UNKNOWN')); return; }
      response.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 256 * 1024) { req.destroy(); finish(new LiveError('ACCOUNT_QUOTA_REFRESH_OUTCOME_UNKNOWN')); } else chunks.push(chunk); });
      response.on('end', () => {
        let value: unknown;
        try { const raw = Buffer.concat(chunks), text = raw.toString('utf8'); if (!Buffer.from(text).equals(raw)) throw new Error(); value = JSON.parse(text); }
        catch { finish(new LiveError('ACCOUNT_QUOTA_REFRESH_OUTCOME_UNKNOWN')); return; }
        if (response.statusCode === 200) { finish(undefined, value); return; }
        const code = value && typeof value === 'object' ? (value as { error?: unknown }).error : undefined;
        finish(new LiveError(code === 'invalid_grant' ? 'ACCOUNT_QUOTA_REAUTH_REQUIRED' : code === 'invalid_client' || code === 'unauthorized_client' || response.statusCode === 401 ? 'ACCOUNT_QUOTA_CLIENT_UNVERIFIED' : response.statusCode === 403 ? 'ACCOUNT_QUOTA_FORBIDDEN' : response.statusCode === 429 ? 'ACCOUNT_QUOTA_RATE_LIMITED' : 'ACCOUNT_QUOTA_REQUEST_FAILED'));
      });
      response.on('aborted', () => finish(new LiveError('ACCOUNT_QUOTA_REFRESH_OUTCOME_UNKNOWN')));
      response.on('error', () => finish(new LiveError('ACCOUNT_QUOTA_REFRESH_OUTCOME_UNKNOWN')));
    });
    const abort = (): void => { req.destroy(); finish(new LiveError('ACCOUNT_QUOTA_REFRESH_OUTCOME_UNKNOWN')); };
    const timer = setTimeout(abort, 15_000);
    req.on('error', () => finish(new LiveError('ACCOUNT_QUOTA_REFRESH_OUTCOME_UNKNOWN')));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    req.end(body);
  });
};
}
export const requestConsumerRefresh = createConsumerRefreshTransport();
export function createConsumerRefreshProvider(executable: string): ConsumerRefreshProvider {
  return { clientIdSha256: CONSUMER_CLIENT_ID_SHA256, async exchange(refreshToken, signal) {
    const client = await readInstalledConsumerOAuthClient(executable, signal);
    return requestConsumerRefresh(client, refreshToken, signal);
  } };
}
