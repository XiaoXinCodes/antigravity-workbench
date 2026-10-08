import * as https from 'node:https';
import type { IncomingMessage } from 'node:http';
import { LiveError } from './live-storage';
import { validImageProject } from './direct-image-project';
import { imageEndpointHost, IMAGE_HTTP_USER_AGENT, type ImageEndpoint } from './direct-image-protocol';

const PATH = '/v1internal:fetchAvailableModels';
const RESPONSE_LIMIT = 2 * 1024 * 1024;
type RequestHttps = (options: https.RequestOptions, callback: (response: IncomingMessage) => void) => ReturnType<typeof https.request>;

/** One target-account catalog lookup using the verified project and bearer from the same transaction. Never refresh, retry, redirect, save or print credentials/project. */
export async function readSavedImageModels(token: string, project: string, signal: AbortSignal, endpoint: ImageEndpoint, requestHttps: RequestHttps = https.request): Promise<unknown> {
  if (!validImageProject(project)) throw new Error('IMAGE_SAVED_MODELS_INVALID');
  const BODY = JSON.stringify({ project });
  const host = imageEndpointHost(endpoint);
  if (signal.aborted) throw new Error('IMAGE_CANCELLED');
  if (!/^[A-Za-z0-9._~+/-]+=*$/.test(token) || token.length > 16_384) throw new Error('IMAGE_DIRECT_AUTH_REQUIRED');
  return new Promise((resolve, reject) => {
    let done = false, count = 0;
    const chunks: Buffer[] = [];
    const finish = (error?: Error, value?: unknown) => {
      if (done) return;
      done = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
      chunks.length = 0;
      if (error) reject(error); else resolve(value);
    };
    const req = requestHttps({ protocol: 'https:', hostname: host, port: 443, path: PATH, method: 'POST',
      agent: false, rejectUnauthorized: true,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(BODY), 'User-Agent': IMAGE_HTTP_USER_AGENT } }, response => {
      if (response.statusCode !== 200) { response.destroy(); finish(response.statusCode === 401 ? new LiveError('ACCOUNT_QUOTA_REAUTH_REQUIRED') : new Error(response.statusCode === 403 ? 'IMAGE_SAVED_MODELS_FORBIDDEN' : response.statusCode === 429 ? 'IMAGE_DIRECT_RATE_LIMITED' : [500, 502, 503, 504].includes(response.statusCode ?? 0) ? 'IMAGE_SAVED_MODELS_TRANSIENT' : 'IMAGE_SAVED_MODELS_FAILED')); return; }
      if (typeof response.headers['content-type'] !== 'string' ||
          !/^application\/json(?:\s*;|$)/i.test(response.headers['content-type'])) {
        response.destroy(); finish(new Error('IMAGE_SAVED_MODELS_INVALID')); return;
      }
      response.on('data', (chunk: Buffer) => {
        if (done) return;
        count += chunk.length;
        if (count > RESPONSE_LIMIT) { req.destroy(); finish(new Error('IMAGE_SAVED_MODELS_INVALID')); }
        else chunks.push(Buffer.from(chunk));
      });
      response.on('end', () => {
        let parsed: unknown;
        try { const bytes = Buffer.concat(chunks), text = bytes.toString('utf8'); if (!Buffer.from(text).equals(bytes)) throw new Error(); parsed = JSON.parse(text); }
        catch { finish(new Error('IMAGE_SAVED_MODELS_INVALID')); return; }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { finish(new Error('IMAGE_SAVED_MODELS_INVALID')); return; }
        finish(undefined, parsed);
      });
      response.on('aborted', () => finish(new Error('IMAGE_SAVED_MODELS_TRANSIENT')));
      response.on('error', () => finish(new Error('IMAGE_SAVED_MODELS_TRANSIENT')));
    });
    const abort = () => { finish(new Error('IMAGE_CANCELLED')); req.destroy(); };
    const timer = setTimeout(() => { finish(new Error('IMAGE_SAVED_MODELS_TRANSIENT')); req.destroy(); }, 15_000);
    req.on('error', (error: NodeJS.ErrnoException) => finish(new Error(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE'].includes(error.code ?? '') ? 'IMAGE_SAVED_MODELS_TRANSIENT' : 'IMAGE_SAVED_MODELS_FAILED')));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    req.end(BODY);
  });
}
