/** Closed diagnostic vocabulary: never accept exception text, log lines or paths. */
export const FILE_ROUTE_FAILURE_REASONS = [
  'host-mismatch', 'directory-permissions', 'open-log-count', 'log-file-metadata',
  'inode-mismatch', 'read-stability', 'pid-marker-missing', 'pid-marker-mismatch',
  'port-marker-missing', 'port-marker-mismatch', 'filemode-marker-missing',
  'filemode-marker-mismatch', 'marker-ambiguity', 'marker-order',
] as const;
export type FileRouteFailureReason = typeof FILE_ROUTE_FAILURE_REASONS[number];
export function fileRouteFailureReason(value: unknown): FileRouteFailureReason | undefined {
  try {
    if (!value || typeof value !== 'object') return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, 'fileRouteFailureReason');
    const reason: unknown = descriptor && 'value' in descriptor ? descriptor.value : undefined;
    return typeof reason === 'string' && FILE_ROUTE_FAILURE_REASONS.includes(reason as FileRouteFailureReason) ? reason as FileRouteFailureReason : undefined;
  } catch { return undefined; }
}
