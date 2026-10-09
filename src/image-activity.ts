import { LiveError } from './live-storage';

/** Same-host UI coordination. The filesystem account-operation lock additionally
 * covers separate extension hosts during the actual image batch. */
const images = new Map<string, { count: number; cancel?: () => void }>();
let revision = 0;
let changingAccount = false;
export interface ImageActivitySnapshot { revision: number; ids: readonly string[]; canCancel: boolean }
export function snapshotImageOperations(): ImageActivitySnapshot {
  return { revision, ids: [...images.keys()], canCancel: images.size > 0 && [...images.values()].every(item => !!item.cancel) };
}
/** Consent binds the exact local task set. It never authorizes a replacement,
 * a foreign extension host, or ending an extension-host process. */
export async function cancelImageOperations(expected: ImageActivitySnapshot): Promise<void> {
  if (changingAccount || revision !== expected.revision || !expected.canCancel || expected.ids.length !== images.size || expected.ids.some(id => !images.get(id)?.cancel)) throw new LiveError('LOCK_OWNERSHIP_CHANGED');
  const selected = expected.ids.map(id => images.get(id)!);
  for (const item of selected) item.cancel!();
  const until = Date.now() + 10_000;
  while (expected.ids.some((id, index) => images.get(id) === selected[index])) {
    if (Date.now() >= until) throw new LiveError('ACCOUNT_SWITCH_IMAGE_RUNNING');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  // New work after consent is never cancelled implicitly.
  if (images.size) throw new LiveError('LOCK_OWNERSHIP_CHANGED');
}
export function enterImageOperation(id: string, options: { cancel?: () => void } = {}): () => void {
  if (changingAccount) throw new Error('IMAGE_ACCOUNT_RECOVERY_PENDING');
  const item = images.get(id) ?? { count: 0 };
  item.count++; if (options.cancel) item.cancel = options.cancel;
  images.set(id, item); ++revision;
  let released = false;
  return () => { if (released) return; released = true; if (--item.count === 0 && images.get(id) === item) images.delete(id); ++revision; };
}
export function enterAccountChange(): () => void {
  if (images.size) throw new LiveError('ACCOUNT_SWITCH_IMAGE_RUNNING');
  if (changingAccount) throw new LiveError('LIVE_OPERATION_IN_PROGRESS');
  changingAccount = true;
  let released = false;
  return () => { if (!released) { released = true; changingAccount = false; } };
}
