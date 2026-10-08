import * as https from 'node:https';
import { LiveError } from './live-storage';
import { validImageProject } from './direct-image-project';

/** Deliberately no configurable URL, proxy, redirect, OAuth client, or refresh endpoint. */
export const ACCOUNT_QUOTA_ENDPOINTS = Object.freeze({
  identity: 'https://www.googleapis.com/oauth2/v2/userinfo',
  quota: 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
});
export type AccountQuotaEndpoint = keyof typeof ACCOUNT_QUOTA_ENDPOINTS;
export interface AccountQuotaRequest {
  endpoint: AccountQuotaEndpoint;
  accessToken: string;
  projectId?: string;
  signal: AbortSignal;
}
export type AccountQuotaTransport = (request: AccountQuotaRequest) => Promise<unknown>;
const RESPONSE_LIMIT = 1024 * 1024;

export function validBearerToken(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 16_384 && /^[A-Za-z0-9._~+/-]+=*$/.test(value);
}
export function validQuotaProject(value: unknown): value is string {
  return validImageProject(value);
}
function statusError(status: number | undefined): LiveError {
  if (status === 401) return new LiveError('ACCOUNT_QUOTA_REAUTH_REQUIRED');
  if (status === 403) return new LiveError('ACCOUNT_QUOTA_FORBIDDEN');
  if (status === 429) return new LiveError('ACCOUNT_QUOTA_RATE_LIMITED');
  if (status !== undefined && status >= 300 && status < 400) return new LiveError('ACCOUNT_QUOTA_REDIRECT_BLOCKED');
  return new LiveError('ACCOUNT_QUOTA_REQUEST_FAILED');
}

/** Local extension-host HTTPS only. Secrets never enter URLs, error text or disk. */
export const requestAccountQuota: AccountQuotaTransport = request => {
  if (request.signal.aborted) return Promise.reject(new LiveError('QUOTA_QUERY_CANCELLED'));
  if (!Object.hasOwn(ACCOUNT_QUOTA_ENDPOINTS, request.endpoint)) return Promise.reject(new LiveError('ACCOUNT_QUOTA_ENDPOINT_BLOCKED'));
  if (!validBearerToken(request.accessToken) || request.projectId !== undefined && !validQuotaProject(request.projectId)) {
    return Promise.reject(new LiveError('ACCOUNT_QUOTA_TOKEN_UNSUPPORTED'));
  }
  const url = new URL(ACCOUNT_QUOTA_ENDPOINTS[request.endpoint]);
  // Defense in depth: no user-controlled path, scheme, port, query, or userinfo.
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash ||
      !['www.googleapis.com', 'cloudcode-pa.googleapis.com'].includes(url.hostname)) return Promise.reject(new LiveError('ACCOUNT_QUOTA_ENDPOINT_BLOCKED'));
  const body = request.endpoint === 'quota' ? JSON.stringify(request.projectId ? { project: request.projectId } : {}) : undefined;
  return new Promise((resolve, reject) => {
    let done = false, bytes = 0;
    const chunks: Buffer[] = [];
    const finish = (error?: LiveError, value?: unknown): void => {
      if (done) return;
      done = true; clearTimeout(timer); request.signal.removeEventListener('abort', abort);
      chunks.length = 0;
      if (error) reject(error); else resolve(value);
    };
    // node:https ignores HTTP(S)_PROXY. agent:false avoids pooled cross-request state.
    // Always verify TLS even if an inherited process environment disables it globally.
    const req = https.request({ protocol: 'https:', hostname: url.hostname, port: 443, path: url.pathname,
      method: request.endpoint === 'identity' ? 'GET' : 'POST', agent: false, rejectUnauthorized: true,
      headers: { Authorization: `Bearer ${request.accessToken}`, Accept: 'application/json',
        'User-Agent': 'Antigravity-Workbench-Quota/1.0', 'Cache-Control': 'no-cache',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }) },
    }, response => {
      // Do not read/retain a server error body, which may echo credentials.
      if (response.statusCode !== 200) { const error = statusError(response.statusCode); response.destroy(); finish(error); return; }
      const contentType = response.headers['content-type'];
      if (typeof contentType !== 'string' || !/^application\/json(?:\s*;|$)/i.test(contentType)) {
        response.destroy(); finish(new LiveError('ACCOUNT_QUOTA_RESPONSE_INVALID')); return;
      }
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > RESPONSE_LIMIT) { response.destroy(); req.destroy(); finish(new LiveError('ACCOUNT_QUOTA_RESPONSE_TOO_LARGE')); }
        else chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          const raw = Buffer.concat(chunks), text = raw.toString('utf8');
          if (!Buffer.from(text, 'utf8').equals(raw)) throw new Error();
          finish(undefined, JSON.parse(text));
        } catch { finish(new LiveError('ACCOUNT_QUOTA_RESPONSE_INVALID')); }
      });
      response.on('aborted', () => finish(new LiveError('ACCOUNT_QUOTA_REQUEST_FAILED')));
      response.on('error', () => finish(new LiveError('ACCOUNT_QUOTA_REQUEST_FAILED')));
    });
    const abort = (): void => { req.destroy(); finish(new LiveError('QUOTA_QUERY_CANCELLED')); };
    const timer = setTimeout(() => { req.destroy(); finish(new LiveError('ACCOUNT_QUOTA_TIMEOUT')); }, 15_000);
    req.on('error', () => finish(new LiveError('ACCOUNT_QUOTA_REQUEST_FAILED')));
    request.signal.addEventListener('abort', abort, { once: true });
    if (request.signal.aborted) { abort(); return; }
    req.end(body);
  });
};
