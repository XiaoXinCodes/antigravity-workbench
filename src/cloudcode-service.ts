/** Service routing is independent of whether a model reads or generates images. */
export type CloudCodeEndpoint = 'daily' | 'production';
export function cloudCodeHost(endpoint: CloudCodeEndpoint): string {
  if (endpoint === 'daily') return 'daily-cloudcode-pa.googleapis.com';
  if (endpoint === 'production') return 'cloudcode-pa.googleapis.com';
  throw Error('CLOUD_CODE_ENDPOINT_INVALID');
}
