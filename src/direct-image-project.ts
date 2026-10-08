/* eslint-disable no-control-regex -- Reject controls in an opaque server-owned project value. */

/** Project is an opaque Cloud Code value, not a user-supplied GCP project slug. */
export function validImageProject(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 &&
    Buffer.byteLength(value, 'utf8') <= 512 && Buffer.from(value, 'utf8').toString('utf8') === value &&
    !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(value) &&
    !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value);
}

export type SavedProject = { kind: 'saved'; value: string } |
  { kind: 'missing' | 'invalid' | 'conflict' };

export function savedProject(values: readonly unknown[]): SavedProject {
  if (!values.length) return { kind: 'missing' };
  const absent = values.map(value => value === undefined || value === null || value === '');
  if (absent.every(Boolean)) return { kind: 'missing' };
  if (values.some((value, index) => !absent[index] && !validImageProject(value))) return { kind: 'invalid' };
  if (absent.some(Boolean)) return { kind: 'conflict' };
  const first = values[0] as string;
  return values.every(value => value === first) ? { kind: 'saved', value: first } : { kind: 'conflict' };
}
