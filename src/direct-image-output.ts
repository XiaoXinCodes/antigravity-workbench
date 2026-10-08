import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { checkedDirectory, readPng, type ImageInfo } from './image-files';
import { decodeDirectRaster, readDirectRaster, type RasterMime } from './direct-image-raster';

/** Save original validated PNG/JPEG bytes; MIME controls the local extension. */
export async function saveDirectImage(image: { data: Buffer; info: ImageInfo; mime?: RasterMime }, outputRoot: string) {
  if (await fs.realpath(outputRoot) !== outputRoot) throw new Error('IMAGE_DIRECTORY_CHANGED');
  const raster = decodeDirectRaster(image.data, image.mime);
  if (raster.info.sha256 !== image.info.sha256) throw new Error('IMAGE_FILE_CHANGED');
  const output = path.join(outputRoot, `antigravity-image-${randomUUID()}.${raster.extension}`);
  await fs.writeFile(output, image.data, { flag: 'wx', mode: 0o600 });
  const saved = await readDirectRaster(output, outputRoot);
  if (saved.info.sha256 !== image.info.sha256) throw new Error('IMAGE_FILE_CHANGED');
  return { file: output, ...saved.info, mime: saved.mime };
}

/** Import only a PNG explicitly picked from one official conversation directory. */
export async function recoverExistingImage(source: string, outputDirectory: string, home: string) {
  const nativeHome = await checkedDirectory(home);
  const output = await checkedDirectory(outputDirectory);
  const conversationId = path.basename(path.dirname(source));
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(conversationId)) throw new Error('IMAGE_ARTIFACT_PATH_REJECTED');
  const root = path.join(nativeHome, '.gemini', 'antigravity-cli', 'brain', conversationId);
  const filename = path.basename(source);
  if (!path.isAbsolute(source) || path.dirname(source) !== root || !/^[a-z0-9]+(?:_[a-z0-9]+)*_[0-9]+\.png$/u.test(filename))
    throw new Error('IMAGE_ARTIFACT_PATH_REJECTED');
  const image = await readPng(source, root);
  return saveDirectImage(image, output);
}
