import { randomUUID } from 'node:crypto';

/** Independently implemented wire contract; no upstream source or catalogue is bundled. */
export type ImageEndpoint = 'production' | 'daily';
export const IMAGE_HTTP_USER_AGENT = 'Antigravity-Workbench/0.1.8';
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
  return typeof value === 'string' && /^MODEL_[A-Z0-9_]{1,80}$/u.test(value) ? value : undefined;
}

/** Only one independently recorded ID correspondence; never use it for a different model. */
export function imageRequestEnvelope(modelId: string, currentModelEnum?: string) {
  const trajectory = randomUUID();
  const modelEnum = imageModelEnum(currentModelEnum) ??
    (modelId === 'gemini-3.1-flash-image' ? 'MODEL_PLACEHOLDER_M21' : undefined);
  const labels: Record<string, string> = {
    last_step_index: '0', ...(modelEnum ? { model_enum: modelEnum } : {}),
    request_id: `${trajectory}-0`, trajectory_id: trajectory,
  };
  if (modelId.startsWith('gemini-')) Object.assign(labels, {
    used_claude: 'false', used_claude_conservative: 'false', used_non_gemini_model: 'false',
  });
  return { requestId: `agent-${randomUUID()}`, labels };
}
