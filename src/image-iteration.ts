import { t as tr } from './i18n';
import * as path from 'node:path';
import { readDirectRaster } from './direct-image-raster';
import type { ImageOrigin, ImageTask, SavedImage } from './image-session-store';

export function resultImage(tasks: readonly ImageTask[], taskId: unknown, index: unknown): { task: ImageTask; image: SavedImage; index: number } {
  if (typeof taskId !== 'string' || !Number.isInteger(index) || Number(index) < 0) throw Error('IMAGE_RESULT_UNAVAILABLE');
  const task = tasks.find(task => task.id === taskId), image = task?.images[Number(index)];
  if (!task || !image || !['complete', 'partial'].includes(task.phase)) throw Error('IMAGE_RESULT_UNAVAILABLE');
  return { task, image, index: Number(index) };
}
export async function checkedResult(task: ImageTask, image: SavedImage) {
  const raster = await readDirectRaster(image.file, task.outputDirectory);
  if (image.sha256 && image.sha256 !== raster.info.sha256) throw Error('IMAGE_EDIT_SOURCE_CHANGED');
  return raster;
}
export async function prepareImageOrigin(task: ImageTask, image: SavedImage, index: number): Promise<ImageOrigin> {
  if (!task.accountId || task.count < 1) throw Error('IMAGE_EDIT_ACCOUNT_MISSING');
  const raster = await checkedResult(task, image);
  if (raster.data.length > 8 * 1024 * 1024) throw Error('IMAGE_EDIT_REFERENCE_TOO_LARGE');
  return { taskId: task.id, imageIndex: index, rootTaskId: task.origin?.rootTaskId ?? task.id,
    rootImageIndex: task.origin?.rootImageIndex ?? index, file: image.file, outputDirectory: task.outputDirectory,
    sha256: raster.info.sha256, width: raster.info.width, height: raster.info.height, accountId: task.accountId, modelId: task.modelId };
}
export async function verifyImageOrigin(origin: ImageOrigin): Promise<void> {
  if (origin.legacyUnverified || !origin.sha256) throw Error('IMAGE_EDIT_SOURCE_UNVERIFIED');
  const raster = await readDirectRaster(origin.file, origin.outputDirectory);
  if (raster.info.sha256 !== origin.sha256) throw Error('IMAGE_EDIT_SOURCE_CHANGED');
}
export interface ImageVersion { key: string; taskId: string; index: number; label: string; file: string; outputDirectory: string;
  width: number; height: number; sha256?: string }
export function imageVersions(tasks: readonly ImageTask[], selected: ImageTask, index: number) {
  const rootId = selected.origin?.rootTaskId ?? selected.id, rootIndex = selected.origin?.rootImageIndex ?? index;
  const versions: ImageVersion[] = [];
  const family = tasks.filter(task => task.id === rootId || task.origin?.rootTaskId === rootId && task.origin.rootImageIndex === rootIndex);
  for (const task of family) {
    if (!['complete', 'partial'].includes(task.phase)) continue;
    for (const [i, image] of task.images.entries()) {
      if (task.id === rootId && i !== rootIndex) continue;
      versions.push({ key: `${task.id}:${i}`, taskId: task.id, index: i,
        label: tr("imageIteration.aa35853718", { p0: task.id === rootId ? tr("imageIteration.4b1db520af") : tr("imageIteration.45816c9956"), p1: tasks.indexOf(task) + 1, p2: i + 1, p3: task.phase === 'partial' ? tr("imageIteration.3694dfa68f") : '' }),
        file: image.file, outputDirectory: task.outputDirectory, width: image.width, height: image.height, ...(image.sha256 ? { sha256: image.sha256 } : {}) });
    }
  }
  for (const task of family) {
    const o = task.origin;
    if (!o || versions.some(v => v.key === `${o.taskId}:${o.imageIndex}`)) continue;
    versions.unshift({ key: `${o.taskId}:${o.imageIndex}`, taskId: o.taskId, index: o.imageIndex, label: tr("imageIteration.49ecb3f9a7"),
      file: o.file, outputDirectory: o.outputDirectory, width: o.width, height: o.height, ...(o.sha256 ? { sha256: o.sha256 } : {}) });
  }
  const chosen = `${selected.id}:${index}`, parent = selected.origin ? `${selected.origin.taskId}:${selected.origin.imageIndex}` : chosen;
  return { versions, left: versions.some(v => v.key === parent) ? parent : chosen,
    right: selected.origin ? chosen : versions.at(-1)?.key ?? chosen };
}
export async function inspectVersion(version: ImageVersion): Promise<string | undefined> {
  try { const raster = await readDirectRaster(version.file, version.outputDirectory);
    if (version.sha256 && raster.info.sha256 !== version.sha256) return tr("imageIteration.cc114c1115");
    return undefined;
  } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? tr("imageIteration.fa9e79cdcb") : tr("imageIteration.b4a2cff0e7"); }
}
export function imageActionMessage(error: unknown): string {
  const code = error instanceof Error ? error.message : '';
  const messages: Record<string, string> = {
    IMAGE_CANCELLED: tr("imageIteration.3e68a3cd81"),
    IMAGE_RESULT_UNAVAILABLE: tr("imageIteration.7d297a1b43"),
    IMAGE_EDIT_ACCOUNT_MISSING: tr("imageIteration.5c9f7b4fa6"),
    IMAGE_EDIT_ACCOUNT_REMOVED: tr("imageIteration.2fe61de421"),
    IMAGE_EDIT_MODEL_UNAVAILABLE: tr("imageIteration.cb97cd25a7"),
    IMAGE_EDIT_ENDPOINT_CHANGED: tr("imageIteration.b42f36efda"),
    IMAGE_EDIT_REFERENCE_TOO_LARGE: tr("imageIteration.9cc7a12d20"),
    IMAGE_EDIT_SOURCE_CHANGED: tr("imageIteration.4c3cf54a8b"),
    IMAGE_EDIT_SOURCE_UNVERIFIED: tr("imageIteration.390369b1bf"),
    IMAGE_DRAFT_LIMIT: tr("imageIteration.cfcbb43f9f"),
    IMAGE_PROJECT_OUTSIDE: tr("imageIteration.54a2fc3d47"),
    IMAGE_PROJECT_TARGET_MISSING: tr("imageIteration.2f29207fd6"),
    IMAGE_PROJECT_TARGET_CHANGED: tr("imageIteration.ef35c7534c"),
    IMAGE_PROJECT_TARGET_UNSAVED: tr("imageIteration.dadcc5d699"),
    IMAGE_PROJECT_TARGET_OUTSIDE: tr("imageIteration.5ead2b3b3b"),
    IMAGE_PROJECT_READONLY: tr("imageIteration.4287aef8b7"),
    IMAGE_PROJECT_HOST_MISMATCH: tr("imageIteration.bd470e0d39"),
    IMAGE_PROJECT_EXISTS: tr("imageIteration.c6ca280036"),
    IMAGE_PROJECT_COPY_CHANGED: tr("imageIteration.902bf7fa47"),
    IMAGE_SESSION_SAVE_REQUIRED: tr("imageIteration.8304cd2821"),
  };
  if (messages[code]) return messages[code]!;
  if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return tr("imageIteration.9271e4709c");
  return tr("imageIteration.4b8397b006");
}
export const imageName = (file: string) => path.basename(file);
