/* eslint-disable no-control-regex -- File paths must not contain control characters. */
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import * as path from 'node:path';
import { inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';

export const MAX_IMAGE_BYTES = 24 * 1024 * 1024;
export interface ImageInfo { width: number; height: number; bytes: number; sha256: string }
function fail(): never { throw new Error('IMAGE_INVALID_PNG'); }
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const b of bytes) { crc ^= b; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
/** Fully validate the supported non-interlaced PNG raster, including CRCs, zlib and scanline filters. */
export function decodePng(bytes: Buffer): ImageInfo {
  if (bytes.length > MAX_IMAGE_BYTES || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) fail();
  let offset = 8; let width = 0; let height = 0; let bits = 0; let color = -1; let ended = false; let palette = 0; let dataEnded = false;
  const data: Buffer[] = [];
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) fail();
    const length = bytes.readUInt32BE(offset); if (length > MAX_IMAGE_BYTES || offset + length + 12 > bytes.length) fail();
    const type = bytes.toString('ascii', offset + 4, offset + 8); const chunk = bytes.subarray(offset + 8, offset + 8 + length);
    if (!/^[A-Za-z]{4}$/u.test(type) || crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== bytes.readUInt32BE(offset + 8 + length)) fail();
    if (offset === 8 && type !== 'IHDR') fail();
    if (type === 'IHDR') {
      if (width || length !== 13) fail();
      width = chunk.readUInt32BE(0); height = chunk.readUInt32BE(4); bits = chunk[8]!; color = chunk[9]!;
      if (!width || !height || width > 8192 || height > 8192 || width * height > 24_000_000 || chunk[10] !== 0 || chunk[11] !== 0 || chunk[12] !== 0) fail();
      const allowed: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!allowed[color]?.includes(bits)) fail();
    } else if (type === 'PLTE') {
      if (data.length || palette || length === 0 || length % 3 || length > 768) fail(); palette = length / 3;
    } else if (type === 'IDAT') { if (dataEnded) fail(); data.push(chunk); }
    else if (type === 'IEND') { if (length || offset + 12 !== bytes.length) fail(); ended = true; }
    else { if (data.length) dataEnded = true; if (/^[A-Z]/u.test(type)) fail(); }
    offset += length + 12;
  }
  if (!ended || !data.length || (color === 3 && (!palette || palette > 2 ** bits))) fail();
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[color]!;
  const stride = Math.ceil(width * channels * bits / 8); const bpp = Math.max(1, Math.ceil(channels * bits / 8));
  const expected = (stride + 1) * height; if (expected > 192 * 1024 * 1024) fail();
  let raw: Buffer; try { raw = inflateSync(Buffer.concat(data), { maxOutputLength: expected + 1 }); } catch { return fail(); }
  if (raw.length !== expected) fail();
  const previous = Buffer.alloc(stride); const row = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!; if (filter > 4) fail();
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? row[x - bpp]! : 0; const b = previous[x]!; const c = x >= bpp ? previous[x - bpp]! : 0;
      const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
      const add = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? Math.floor((a + b) / 2) : pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      row[x] = (raw[y * (stride + 1) + 1 + x]! + add) & 255;
    }
    if (color === 3) for (let x = 0; x < width; x++) {
      const bit = x * bits; const index = (row[Math.floor(bit / 8)]! >>> (8 - bits - bit % 8)) & ((1 << bits) - 1); if (index >= palette) fail();
    }
    row.copy(previous);
  }
  return { width, height, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}
export async function checkedDirectory(directory: string): Promise<string> {
  if (!path.isAbsolute(directory) || /[\x00-\x1f]/u.test(directory)) throw new Error('IMAGE_LOCAL_DIRECTORY_REQUIRED');
  const resolved = await fs.realpath(directory);
  if (!(await fs.stat(resolved)).isDirectory()) throw new Error('IMAGE_LOCAL_DIRECTORY_REQUIRED');
  // A selected parent may be a platform alias (macOS /var); canonicalize once, then pin all child checks.
  return resolved;
}
export async function readPng(file: string, root?: string): Promise<{ data: Buffer; info: ImageInfo }> {
  if (!path.isAbsolute(file) || path.extname(file).toLowerCase() !== '.png' || /[\x00-\x1f]/u.test(file)) throw new Error('IMAGE_PNG_REQUIRED');
  const data = await readImageBytes(file, root);
  return { data, info: decodePng(data) };
}
/** Compare canonical paths without treating a Windows drive-letter casing change as a link. */
export function sameImagePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const normalize = (value: string) => platform === 'win32' ? value.replace(/^[A-Z]:/, drive => drive.toLowerCase()) : value;
  return normalize(a) === normalize(b);
}
/** Bounded ancestor walk; exposed for Windows regression tests on other hosts. */
export function imageAncestorDirectories(file: string, root: string, platform: NodeJS.Platform = process.platform): string[] {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const rel = paths.relative(root, file);
  if (!rel || rel.startsWith(`..${paths.sep}`) || rel === '..' || paths.isAbsolute(rel)) throw new Error('IMAGE_PATH_OUTSIDE_OUTPUT');
  const parents: string[] = [];
  let parent = paths.dirname(file);
  while (!sameImagePath(parent, root, platform)) {
    parents.push(parent);
    const next = paths.dirname(parent);
    if (next === parent) throw new Error('IMAGE_PATH_OUTSIDE_OUTPUT');
    parent = next;
  }
  return parents;
}
/** Shared stable local-file read. Format-specific callers must validate the bytes. */
export async function readImageBytes(file: string, root?: string): Promise<Buffer> {
  if (!path.isAbsolute(file) || /[\x00-\x1f]/u.test(file)) throw new Error('IMAGE_UNSAFE_FILE');
  const normalized = path.resolve(file);
  if (root) {
    for (const parent of imageAncestorDirectories(normalized, root)) if ((await fs.lstat(parent)).isSymbolicLink()) throw new Error('IMAGE_LINK_REJECTED');
    if (!sameImagePath(await fs.realpath(root), root)) throw new Error('IMAGE_DIRECTORY_CHANGED');
  }
  const before = await fs.lstat(normalized);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_IMAGE_BYTES) throw new Error('IMAGE_UNSAFE_FILE');
  if (!sameImagePath(await fs.realpath(normalized), normalized)) throw new Error('IMAGE_LINK_REJECTED');
  const handle = await fs.open(normalized, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.nlink !== 1 || st.ino !== before.ino || st.dev !== before.dev || st.size !== before.size) throw new Error('IMAGE_FILE_CHANGED');
    const data = Buffer.alloc(st.size + 1); const { bytesRead } = await handle.read(data, 0, data.length, 0);
    if (bytesRead !== st.size) throw new Error('IMAGE_FILE_CHANGED');
    const after = await handle.stat(), current = await fs.lstat(normalized);
    if (after.size !== st.size || after.mtimeMs !== st.mtimeMs || after.ctimeMs !== st.ctimeMs || current.ino !== st.ino || current.dev !== st.dev || current.isSymbolicLink()) throw new Error('IMAGE_FILE_CHANGED');
    if (root && !sameImagePath(await fs.realpath(root), root)) throw new Error('IMAGE_DIRECTORY_CHANGED');
    return data.subarray(0, bytesRead);
  } finally { await handle.close(); }
}
