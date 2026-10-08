import { t as tr } from './i18n';
import * as path from 'node:path';
import * as files from './image-files';
import { saveDirectImage } from './direct-image-output';
import { validImageProject } from './direct-image-project';
import { sanitizeDebugData } from './debug-events';
import { imageEndpoint, imageRequestEnvelope, type ImageEndpoint } from './direct-image-protocol';
import { decodeDirectImageResponse } from './direct-image-response';
import { readDirectRaster, type RasterMime } from './direct-image-raster';
export { decodeDirectImageResponse } from './direct-image-response';

export interface DirectImageRequest {
  prompt: string; accountId: string; modelId: string; aspectRatio: string;
  outputDirectory: string; references: string[]; count?: number;
  size?: 'auto' | '1K' | '2K' | '4K'; quality?: 'auto' | 'detail';
  endpoint?: ImageEndpoint; accountSource?: 'current' | 'saved';
  referenceHashes?: Readonly<Record<string, string>>;
}
export interface BoundImageAccount {
  readonly accountId?: string; readonly modelSource?: 'official-hub' | 'saved-account';
  readonly token: string; readonly projectId: string; readonly modelId: string;
  readonly projectSource?: 'saved-token' | 'loadCodeAssist';
  readonly endpoint?: ImageEndpoint; readonly modelEnum?: string;
  verify(signal: AbortSignal): Promise<void>;
}
export interface DirectImageDependencies {
  bind(accountId: string, modelId: string, signal: AbortSignal): Promise<BoundImageAccount>;
  send(token: string, body: unknown, signal: AbortSignal, endpoint?: ImageEndpoint): Promise<unknown>;
  onProgress?: (value: { phase: string; message: string }) => void;
}
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MODEL = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{2,127}$/;
const RATIOS = new Set(['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3']);
function check(signal: AbortSignal) { if (signal.aborted) throw new Error('IMAGE_CANCELLED'); }

/** The image operation has no agent, commands, plugins, SDK identity, or tool execution. */
export function buildDirectImageBody(request: DirectImageRequest, bound: BoundImageAccount, refs: readonly (Buffer | { data: Buffer; mime: RasterMime })[]) {
  const rasterRefs = refs.map(ref => Buffer.isBuffer(ref) ? { data: ref, mime: 'image/png' as const } : ref);
  if (bound.accountId !== undefined && bound.accountId !== request.accountId || !ID.test(request.accountId) || !MODEL.test(request.modelId) || bound.modelId !== request.modelId ||
      !validImageProject(bound.projectId) || !RATIOS.has(request.aspectRatio) || refs.length > 3 ||
      rasterRefs.some(x => !['image/png', 'image/jpeg'].includes(x.mime) || x.data.length > 8 * 1024 * 1024) || rasterRefs.reduce((n, x) => n + x.data.length, 0) > 16 * 1024 * 1024) throw new Error('IMAGE_DIRECT_SCOPE_INVALID');
  const prompt = [request.prompt, request.quality === 'detail' ? 'Artwork preference: rich fine details.' : ''].filter(Boolean).join('\n');
  const imageConfig: Record<string, string> = { aspectRatio: request.aspectRatio };
  if (request.size && request.size !== 'auto') imageConfig.imageSize = request.size;
  const envelope = imageRequestEnvelope(bound.modelId, bound.modelEnum);
  return { project: bound.projectId, requestId: envelope.requestId,
    request: { contents: [{ role: 'user', parts: [{ text: prompt }, ...rasterRefs.map(ref => ({ inlineData: { mimeType: ref.mime, data: ref.data.toString('base64') } }))] }],
      labels: envelope.labels, generationConfig: { candidateCount: 1, imageConfig } },
    model: bound.modelId, requestType: 'image_gen' };
}

let running = false;
/** Called only after the image UI's per-batch modal consent. No automatic retry. */
export async function generateDirectImage(request: DirectImageRequest, signal: AbortSignal, deps: DirectImageDependencies) {
  if (typeof request.prompt !== 'string' || !request.prompt.trim() || request.prompt.length > 16_000 ||
      !Array.isArray(request.references) || request.references.length > 3 ||
      !RATIOS.has(request.aspectRatio) || !request.outputDirectory ||
      !ID.test(request.accountId) || !MODEL.test(request.modelId)) throw new Error('IMAGE_DIRECT_SCOPE_INVALID');
  if (running) throw new Error('IMAGE_BUSY');
  check(signal); running = true;
  try {
    const output = await files.checkedDirectory(request.outputDirectory);
    if (output === path.parse(output).root) throw new Error('IMAGE_LOCAL_DIRECTORY_REQUIRED');
    const refs: { data: Buffer; mime: RasterMime }[] = [];
    for (const reference of request.references) {
      check(signal); const raster = await readDirectRaster(reference, await files.checkedDirectory(path.dirname(reference)));
      if (request.referenceHashes?.[reference] && request.referenceHashes[reference] !== raster.info.sha256) throw Error('IMAGE_EDIT_SOURCE_CHANGED');
      refs.push({ data: raster.data, mime: raster.mime });
    }
    const bound = await deps.bind(request.accountId, request.modelId, signal); check(signal);
    const endpoint = imageEndpoint(bound.endpoint);
    if (request.endpoint !== undefined && imageEndpoint(request.endpoint) !== endpoint) throw new Error('IMAGE_DIRECT_ENDPOINT_CHANGED');
    const body = buildDirectImageBody(request, bound, refs);
    await bound.verify(signal); check(signal);
    deps.onProgress?.({ phase: 'generating', message: tr("directImageCore.436b020753") });
    let response: unknown;
    try { response = await deps.send(bound.token, body, signal, endpoint); }
    catch (error) {
      // A sent request may have reached the server; do not convert it to retryable cancellation.
      if (error instanceof Error && /^IMAGE_DIRECT_[A-Z_]+$/.test(error.message)) {
        const failure = error as Error & { projectSource?: 'saved-token' | 'loadCodeAssist'; modelSource?: 'official-hub' | 'saved-account' };
        if (bound.projectSource) failure.projectSource = bound.projectSource;
        failure.modelSource = bound.modelSource ?? 'official-hub';
        throw failure;
      }
      throw new Error('IMAGE_DIRECT_OUTCOME_UNKNOWN');
    }
    try { await bound.verify(signal); }
    catch (error) {
      if (signal.aborted) throw new Error('IMAGE_DIRECT_OUTCOME_UNKNOWN');
      throw error;
    }
    if (signal.aborted) throw new Error('IMAGE_DIRECT_OUTCOME_UNKNOWN');
    deps.onProgress?.({ phase: 'validating', message: tr("directImageCore.e0534b3f25") });
    // Validate the entire chosen candidate before saving any part. No extra request
    // is issued when a single candidate contains several image artifacts.
    const decoded = decodeDirectImageResponse(response);
    const saved = [];
    let savingFailure: Error | undefined;
    for (const image of decoded) {
      try { saved.push({ ...await saveDirectImage(image, output), accountId: request.accountId }); }
      catch (error) {
        if (!saved.length) throw error;
        // Keep already verified artifacts visible and stop the batch. A local
        // save failure must never authorize another billable request.
        savingFailure = error instanceof Error && /^IMAGE_[A-Z_]+$/u.test(error.message)
          ? error : new Error('IMAGE_LOCAL_IO_ERROR');
        break;
      }
    }
    return { images: saved, completedAt: new Date().toISOString(), identity: null, quota: null, conversationId: null,
      ...(savingFailure ? { savingFailure } : {}),
      warning: tr("directImageCore.b2a5c90cf4") };
  } finally { running = false; }
}

/** One request per requested count, serially; each may yield several artifacts. */
export async function generateDirectImageBatch(request: DirectImageRequest, signal: AbortSignal, deps: DirectImageDependencies) {
  request = { ...request, references: Array.isArray(request.references) ? [...request.references] : request.references,
    ...(request.referenceHashes ? { referenceHashes: { ...request.referenceHashes } } : {}) };
  const count = request.count ?? 1;
  if (!Number.isInteger(count) || count < 1 || count > 4) throw new Error('IMAGE_DIRECT_SCOPE_INVALID');
  const images: Awaited<ReturnType<typeof generateDirectImage>>['images'] = [];
  let completedRequests = 0;
  // Freeze one binding for the complete batch; subsequent requests never resolve another account or model.
  let binding: Promise<BoundImageAccount> | undefined;
  const frozenDeps: DirectImageDependencies = { ...deps, bind: (id, model, requestSignal) => binding ??= deps.bind(id, model, requestSignal) };
  for (let index = 0; index < count; index++) {
    if (signal.aborted) break;
    try {
      const result = await generateDirectImage({ ...request, count: 1 }, signal, frozenDeps);
      images.push(...result.images);
      if (result.savingFailure) throw result.savingFailure;
      completedRequests++;
    } catch (error) {
      if (!images.length) throw error;
      const safe = sanitizeDebugData(error) ?? {};
      const failure = {
        ...(typeof safe.httpStatus === 'number' ? { httpStatus: safe.httpStatus } : {}),
        ...(typeof safe.serviceStatus === 'string' ? { serviceStatus: safe.serviceStatus } : {}),
        ...(typeof safe.serviceReason === 'string' ? { serviceReason: safe.serviceReason } : {}),
        ...(typeof safe.retryAfterSeconds === 'number' ? { retryAfterSeconds: safe.retryAfterSeconds } : {}),
        ...Object.fromEntries(['responseShape', 'requestId', 'respondedAt', 'projectSource', 'modelSource', 'evidence', 'responseEvidence']
          .filter(key => safe[key] !== undefined).map(key => [key, safe[key]])),
      };
      return { images, completedAt: new Date().toISOString(), identity: null, quota: null, conversationId: null,
        warning: tr("directImageCore.20f47b294f"),
        batch: { requested: count, completed: completedRequests, artifactCount: images.length, outcome: 'partial' as const,
          error: error instanceof Error && /^IMAGE_[A-Z_]+$/.test(error.message) ? error.message : 'IMAGE_DIRECT_OUTCOME_UNKNOWN', failure } };
    }
  }
  return { images, completedAt: new Date().toISOString(), identity: null, quota: null, conversationId: null,
    warning: tr("directImageCore.0c1a8af010"),
    batch: { requested: count, completed: completedRequests, artifactCount: images.length, outcome: signal.aborted ? 'cancelled' as const : 'complete' as const } };
}
