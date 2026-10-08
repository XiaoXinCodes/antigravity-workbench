import * as https from 'node:https';
import type { IncomingMessage } from 'node:http';
import { imageHttpFailure, type ImageResponseShape } from './direct-image-http-error';
import { imageEndpointHost, IMAGE_HTTP_USER_AGENT, type ImageEndpoint } from './direct-image-protocol';
import { imageResponseFailure, rememberImageTransport, responseContentType } from './image-response-evidence';

const PATH = '/v1internal:generateContent';
const RESPONSE_LIMIT = 36 * 1024 * 1024;
const ERROR_RESPONSE_LIMIT = 16 * 1024;
type RequestHttps = (options: https.RequestOptions, callback: (response: IncomingMessage) => void) => ReturnType<typeof https.request>;

/** Fixed first-party destination and operation; no proxy, redirect, logging, account rotation or retry. */
export async function sendDirectImage(token: string, body: unknown, signal: AbortSignal, requestHttps: RequestHttps = https.request, endpoint: ImageEndpoint = 'daily'): Promise<unknown> {
  const host = imageEndpointHost(endpoint);
  if (signal.aborted) throw new Error('IMAGE_CANCELLED');
  if (!/^[A-Za-z0-9._~+/-]+=*$/.test(token) || token.length > 16_384) throw new Error('IMAGE_DIRECT_AUTH_REQUIRED');
  const input = JSON.stringify(body);
  if (!input || Buffer.byteLength(input) > 24 * 1024 * 1024) throw new Error('IMAGE_DIRECT_SCOPE_INVALID');
  const requestId = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>).requestId : undefined;
  // Transient exclusions only. Request text and credentials never enter diagnostic output.
  const envelope = body as { project?: unknown; request?: { contents?: { parts?: { text?: unknown }[] }[] } } | null;
  const excludedText = [token];
  if (typeof envelope?.project === 'string') excludedText.push(envelope.project);
  if (Array.isArray(envelope?.request?.contents)) for (const content of envelope.request.contents.slice(0, 16)) {
    if (Array.isArray(content?.parts)) for (const part of content.parts.slice(0, 16)) {
      if (typeof part?.text === 'string') excludedText.push(part.text);
    }
  }
  return new Promise((resolve, reject) => {
    let done = false, count = 0;
    const chunks: Buffer[] = [];
    const finish = (error?: Error, response?: unknown) => {
      if (done) return;
      done = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
      chunks.length = 0;
      if (error) reject(error); else resolve(response);
    };
    const req = requestHttps({ protocol: 'https:', hostname: host, port: 443, path: PATH, method: 'POST',
      agent: false, rejectUnauthorized: true,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(input), 'User-Agent': IMAGE_HTTP_USER_AGENT } }, response => {
      if (response.statusCode !== 200) {
        const status = response.statusCode ?? 0;
        const retryAfter = response.headers['retry-after'];
        const json = typeof response.headers['content-type'] === 'string' && /^application\/json(?:\s*;|$)/i.test(response.headers['content-type']);
        const fail = (value?: unknown, shape: ImageResponseShape = 'unstructured') =>
          finish(imageHttpFailure(status, value, retryAfter, requestId as string | undefined, shape, Date.now(), excludedText));
        if (!json) { response.destroy(); fail(); return; }
        let errorBytes = 0;
        const errorChunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          if (done) return;
          errorBytes += chunk.length;
          if (errorBytes > ERROR_RESPONSE_LIMIT) { fail(undefined, 'oversize'); response.destroy(); }
          else errorChunks.push(Buffer.from(chunk));
        });
        response.on('end', () => {
          let parsed: unknown;
          try { parsed = JSON.parse(Buffer.concat(errorChunks).toString('utf8')); } catch { fail(); return; }
          fail(parsed, parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
            'error' in parsed && typeof parsed.error === 'object' ? 'structured' : 'unstructured');
        });
        response.on('aborted', () => fail());
        response.on('error', () => fail());
        return;
      }
      if (typeof response.headers['content-type'] !== 'string' || !/^application\/json(?:\s*;|$)/i.test(response.headers['content-type'])) {
        finish(imageResponseFailure(undefined, 'content-type', undefined,
          { httpStatus: 200, contentType: responseContentType(response.headers['content-type']), bodyBytes: 0 })); response.destroy(); return;
      }
      response.on('data', (chunk: Buffer) => {
        if (done) return;
        count += chunk.length;
        if (count > RESPONSE_LIMIT) { finish(imageResponseFailure(undefined, 'body-limit', undefined,
          { httpStatus: 200, contentType: 'application/json', bodyBytes: Math.min(count, 64 * 1024 * 1024) })); req.destroy(); }
        else chunks.push(Buffer.from(chunk));
      });
      response.on('end', () => {
        if (done) return;
        const transport = { httpStatus: 200, contentType: 'application/json' as const, bodyBytes: count };
        let value: unknown;
        try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { finish(imageResponseFailure(undefined, 'json', undefined, transport)); return; }
        if (!value || typeof value !== 'object') { finish(imageResponseFailure(value, 'root', undefined, transport)); return; }
        rememberImageTransport(value, transport);
        finish(undefined, value);
      });
      response.on('aborted', () => finish(new Error('IMAGE_DIRECT_OUTCOME_UNKNOWN')));
      response.on('error', () => finish(new Error('IMAGE_DIRECT_OUTCOME_UNKNOWN')));
    });
    const abort = () => { req.destroy(); finish(new Error('IMAGE_DIRECT_OUTCOME_UNKNOWN')); };
    const timer = setTimeout(() => { req.destroy(); finish(new Error('IMAGE_DIRECT_OUTCOME_UNKNOWN')); }, 600_000);
    req.on('error', () => finish(new Error('IMAGE_DIRECT_OUTCOME_UNKNOWN')));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    req.end(input);
  });
}
