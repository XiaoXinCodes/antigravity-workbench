import { LiveError } from './live-storage';

/** Same-host UI coordination. The filesystem account-operation lock additionally
 * covers separate extension hosts during the actual image batch. */
const images = new Map<string, number>();
let changingAccount = false;
export function enterImageOperation(id: string): () => void {
  if (changingAccount) throw new Error('IMAGE_ACCOUNT_RECOVERY_PENDING');
  images.set(id, (images.get(id) ?? 0) + 1);
  let released = false;
  return () => { if (released) return; released = true; const n = (images.get(id) ?? 1) - 1; if (n) images.set(id, n); else images.delete(id); };
}
export function enterAccountChange(): () => void {
  if (images.size) throw new LiveError('ACCOUNT_SWITCH_IMAGE_RUNNING');
  if (changingAccount) throw new LiveError('LIVE_OPERATION_IN_PROGRESS');
  changingAccount = true;
  let released = false;
  return () => { if (!released) { released = true; changingAccount = false; } };
}
