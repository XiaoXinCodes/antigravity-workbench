import * as https from 'node:https';
import type { IncomingMessage } from 'node:http';
import { validImageProject } from './direct-image-project';
import { imageEndpoint, imageEndpointHost, IMAGE_HTTP_USER_AGENT, type ImageEndpoint } from './direct-image-protocol';

const PATH = '/v1internal:loadCodeAssist';
const BODY = JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } });
const RESPONSE_LIMIT = 256 * 1024;
type RequestHttps = (options: https.RequestOptions, callback: (response: IncomingMessage) => void) => ReturnType<typeof https.request>;

/** One fixed authenticated metadata lookup. Never refresh, retry, redirect, save or print credentials/project. */
export async function resolveImageProject(token: string, signal: AbortSignal, requestHttps: RequestHttps = https.request, endpoint: ImageEndpoint = 'daily'): Promise<string> {
  const host = imageEndpointHost(endpoint);
  if (signal.aborted) throw new Error('IMAGE_CANCELLED');
  if (!/^[A-Za-z0-9._~+/-]+=*$/.test(token) || token.length > 16_384) throw new Error('IMAGE_DIRECT_AUTH_REQUIRED');
  return new Promise((resolve, reject) => {
    let done = false, count = 0;
    const chunks: Buffer[] = [];
    const finish = (error?: Error, value?: string) => {
      if (done) return;
      done = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
      chunks.length = 0;
      if (error) reject(error); else resolve(value as string);
    };
    const req = requestHttps({ protocol: 'https:', hostname: host, port: 443, path: PATH, method: 'POST',
      agent: false, rejectUnauthorized: true,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(BODY), 'User-Agent': IMAGE_HTTP_USER_AGENT } }, response => {
      if (response.statusCode !== 200) { response.destroy(); finish(new Error('IMAGE_DIRECT_PROJECT_LOOKUP_FAILED')); return; }
      if (typeof response.headers['content-type'] !== 'string' ||
          !/^application\/json(?:\s*;|$)/i.test(response.headers['content-type'])) {
        response.destroy(); finish(new Error('IMAGE_DIRECT_PROJECT_LOOKUP_INVALID')); return;
      }
      response.on('data', (chunk: Buffer) => {
        if (done) return;
        count += chunk.length;
        if (count > RESPONSE_LIMIT) { req.destroy(); finish(new Error('IMAGE_DIRECT_PROJECT_LOOKUP_INVALID')); }
        else chunks.push(Buffer.from(chunk));
      });
      response.on('end', () => {
        let parsed: unknown;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { finish(new Error('IMAGE_DIRECT_PROJECT_LOOKUP_INVALID')); return; }
        const value = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ?
          (parsed as Record<string, unknown>).cloudaicompanionProject : undefined;
        if (!validImageProject(value)) { finish(new Error('IMAGE_DIRECT_PROJECT_LOOKUP_INVALID')); return; }
        finish(undefined, value);
      });
      response.on('aborted', () => finish(new Error('IMAGE_DIRECT_PROJECT_LOOKUP_FAILED')));
      response.on('error', () => finish(new Error('IMAGE_DIRECT_PROJECT_LOOKUP_FAILED')));
    });
    const abort = () => { req.destroy(); finish(new Error('IMAGE_DIRECT_PROJECT_LOOKUP_FAILED')); };
    const timer = setTimeout(() => { req.destroy(); finish(new Error('IMAGE_DIRECT_PROJECT_LOOKUP_FAILED')); }, 15_000);
    req.on('error', () => finish(new Error('IMAGE_DIRECT_PROJECT_LOOKUP_FAILED')));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    req.end(BODY);
  });
}

/** Ephemeral provenance: the caller must use this project with this endpoint only. */
export async function resolveEndpointImageProject(token: string, signal: AbortSignal, endpoint: ImageEndpoint,
  requestHttps: RequestHttps = https.request): Promise<{ projectId: string; endpoint: ImageEndpoint }> {
  const pinned = imageEndpoint(endpoint);
  return { projectId: await resolveImageProject(token, signal, requestHttps, pinned), endpoint: pinned };
}
