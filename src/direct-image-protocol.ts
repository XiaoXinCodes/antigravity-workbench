import { modelEnum as readModelEnum } from './model-catalog';
import { randomUUID } from 'node:crypto';

/** Independently implemented wire contract; no upstream source or catalogue is bundled. */
export type ImageEndpoint = 'production' | 'daily';
export const IMAGE_HTTP_USER_AGENT = 'Antigravity-Workbench/0.1.15';
export function imageEndpoint(value: unknown = 'daily'): ImageEndpoint {
  if (value !== 'production' && value !== 'daily') throw new Error('IMAGE_DIRECT_ENDPOINT_INVALID');
  return value;
}
export function imageEndpointHost(value: ImageEndpoint): string {
  return imageEndpoint(value) === 'daily' ? 'daily-cloudcode-pa.googleapis.com' : 'cloudcode-pa.googleapis.com';
}
export function validImageRequestId(value: unknown): value is string {
  return typeof value === 'string' && /^(?:agent-)?[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
}
export function imageModelEnum(value: unknown): string | undefined {
  return readModelEnum(value);
}

/** Optional model metadata comes only from the selected account directory. */
export function imageRequestEnvelope(_modelId: string, currentModelEnum?: string) {
  const trajectory = randomUUID();
  const modelEnum = imageModelEnum(currentModelEnum);
  const labels: Record<string, string> = {
    last_step_index: '0', ...(modelEnum ? { model_enum: modelEnum } : {}),
    request_id: `${trajectory}-0`, trajectory_id: trajectory,
  };
  return { requestId: `agent-${randomUUID()}`, labels };
}
