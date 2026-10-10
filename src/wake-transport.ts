import * as https from 'node:https';
import { randomUUID } from 'node:crypto';
import { cloudCodeHost, type CloudCodeEndpoint } from './cloudcode-service';
import { validImageProject } from './direct-image-project';
import { validBearerToken } from './account-quota-transport';
import type { WakeResult } from './wake-engine';
export interface WakeBinding { token: string; projectId: string; modelId: string; endpoint: CloudCodeEndpoint; verify(signal: AbortSignal): Promise<void> }
export function wakeRequestBody(binding: WakeBinding, outputBudget: number): Record<string, unknown> {
  if (!validImageProject(binding.projectId) || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/.test(binding.modelId) || !Number.isInteger(outputBudget) || outputBudget < 1 || outputBudget > 64) throw Error('WAKE_REQUEST_INVALID');
  return { project: binding.projectId, model: binding.modelId, requestId: randomUUID(), userAgent: 'antigravity', requestType: 'agent',
    request: { session_id: randomUUID(), contents: [{ role: 'user', parts: [{ text: 'Hi' }] }], generationConfig: { maxOutputTokens: outputBudget, temperature: 0 } } };
}
const object = (v: unknown): Record<string, unknown> | undefined => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
export function parseWakeStream(text: string): WakeResult {
  let complete = false, outputTokens: number | undefined, totalTokens: number | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue; const data = line.slice(5).trim(); if (data === '[DONE]') { complete = true; continue; }
    let v: Record<string, unknown> | undefined; try { v = object(JSON.parse(data)); } catch { return { phase: 'unknown', code: 'WAKE_RESPONSE_INVALID' }; }
    if (!v || v.error) return { phase: 'failed', code: 'WAKE_SERVER_ERROR' };
    const response = object(v.response) ?? v, candidates = response.candidates;
    if (Array.isArray(candidates) && candidates.some(c => typeof object(c)?.finishReason === 'string' && object(c)?.finishReason !== 'FINISH_REASON_UNSPECIFIED' && object(c)?.finishReason !== '')) complete = true;
    const usage = object(response.usageMetadata) ?? object(v.usageMetadata);
    const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
    outputTokens = count(usage?.candidatesTokenCount) ?? outputTokens; totalTokens = count(usage?.totalTokenCount) ?? totalTokens;
  }
  return { phase: complete ? 'succeeded' : 'unknown', code: complete ? 'WAKE_COMPLETE' : 'WAKE_OUTCOME_UNKNOWN', ...(outputTokens === undefined ? {} : { outputTokens }), ...(totalTokens === undefined ? {} : { totalTokens }) };
}
/** One request, fixed hosts, no redirect/retry. A lost response after send is unknown. */
export async function sendWake(binding: WakeBinding, outputBudget: number, signal: AbortSignal, beforeSend: () => Promise<void>, requestHttps: typeof https.request = https.request): Promise<WakeResult> {
  const body = JSON.stringify(wakeRequestBody(binding, outputBudget));
  if (!validBearerToken(binding.token)) throw Error('WAKE_AUTH_REQUIRED');
  const host = cloudCodeHost(binding.endpoint); await binding.verify(signal);
  if (signal.aborted) throw Error('WAKE_CANCELLED');
  await beforeSend();
  return new Promise<WakeResult>(resolve => {
    let settled = false, bytes = 0; const chunks: Buffer[] = []; let request: ReturnType<typeof https.request> | undefined;
    const finish = (result: WakeResult) => { if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort); resolve(result); };
    const unknown = () => { finish({ phase: 'unknown', code: 'WAKE_OUTCOME_UNKNOWN' }); request?.destroy(); };
    const abort = () => unknown(); const timer = setTimeout(unknown, 30_000); timer.unref?.();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { unknown(); return; }
    try {
      request = requestHttps({ hostname: host, port: 443, method: 'POST', path: '/v1internal:streamGenerateContent?alt=sse', headers: { Authorization: `Bearer ${binding.token}`, 'Content-Type': 'application/json', Accept: 'text/event-stream', 'Content-Length': Buffer.byteLength(body) } }, response => {
        if (response.statusCode !== 200) { response.resume(); finish({ phase: 'failed', code: 'WAKE_HTTP_REJECTED' }); return; }
        response.on('data', (chunk: Buffer | string) => { const buffer = Buffer.from(chunk); bytes += buffer.length; if (bytes > 2 * 1024 * 1024) unknown(); else chunks.push(buffer); });
        response.on('end', () => finish(parseWakeStream(Buffer.concat(chunks).toString('utf8')))); response.on('error', unknown); response.on('aborted', unknown);
      });
      request.on('error', unknown); request.end(body);
    } catch { unknown(); }
  });
}
