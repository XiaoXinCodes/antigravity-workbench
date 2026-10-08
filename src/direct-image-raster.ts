import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { decodePng, MAX_IMAGE_BYTES, readImageBytes, type ImageInfo } from './image-files';

export type RasterMime = 'image/png' | 'image/jpeg';
export interface DirectRaster { data: Buffer; info: ImageInfo; mime: RasterMime; extension: 'png' | 'jpg' }

/** Validate a bounded baseline/extended-sequential/progressive Huffman JPEG container.
 * This checks segment/table/scan structure and dimensions, not decoded pixels.
 * Original bytes are preserved. Native image preview performs raster decoding.
 */
export function inspectJpeg(bytes: Buffer): ImageInfo {
  const fail = (): never => { throw new Error('IMAGE_INVALID_JPEG'); };
  if (bytes.length < 64 || bytes.length > MAX_IMAGE_BYTES || bytes[0] !== 0xff || bytes[1] !== 0xd8) fail();
  let offset = 2, width = 0, height = 0, progressive = false, scans = 0, segments = 0, entropyBytes = 0;
  const components = new Map<number, number>(), quant = new Set<number>(), dc = new Set<number>(), ac = new Set<number>();
  while (offset < bytes.length) {
    if (++segments > 4096 || bytes[offset++] !== 0xff) fail();
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9) {
      if (offset !== bytes.length || !width || !scans || !entropyBytes) fail();
      return { width, height, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    }
    if (marker === undefined || marker === 0 || marker === 0xd8 || marker >= 0xd0 && marker <= 0xd7 || offset + 2 > bytes.length) fail();
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) fail();
    const start = offset + 2, end = offset + length;
    offset = end;
    if (marker === 0xdb) {
      let p = start;
      while (p < end) {
        const table = bytes[p++]!, precision = table >> 4, id = table & 15;
        if (precision > 1 || id > 3 || p + 64 * (precision + 1) > end) fail();
        for (let i = 0; i < 64; i++) {
          const value = precision ? bytes.readUInt16BE(p + i * 2) : bytes[p + i];
          if (!value) fail();
        }
        p += 64 * (precision + 1); quant.add(id);
      }
      if (p !== end) fail();
    } else if (marker === 0xc4) {
      let p = start;
      while (p < end) {
        if (p + 17 > end) fail();
        const table = bytes[p++]!, kind = table >> 4, id = table & 15;
        if (kind > 1 || id > 3) fail();
        let count = 0, slots = 1;
        for (let i = 0; i < 16; i++) { const n = bytes[p + i]!; count += n; slots = slots * 2 - n; if (slots < 0) fail(); }
        p += 16;
        if (!count || count > 256 || p + count > end) fail();
        if (kind === 0) for (let i = 0; i < count; i++) if (bytes[p + i]! > 11) fail();
        p += count; (kind === 0 ? dc : ac).add(id);
      }
      if (p !== end) fail();
    } else if ([0xc0, 0xc1, 0xc2].includes(marker!)) {
      if (width || end - start < 9 || bytes[start] !== 8) fail();
      height = bytes.readUInt16BE(start + 1); width = bytes.readUInt16BE(start + 3);
      const count = bytes[start + 5]!;
      if (!width || !height || width > 8192 || height > 8192 || width * height > 24_000_000 ||
          ![1, 3, 4].includes(count) || end - start !== 6 + count * 3) fail();
      progressive = marker === 0xc2;
      for (let i = 0; i < count; i++) {
        const p = start + 6 + i * 3, id = bytes[p]!, sampling = bytes[p + 1]!, table = bytes[p + 2]!;
        if (components.has(id) || !(sampling >> 4) || (sampling >> 4) > 4 || !(sampling & 15) || (sampling & 15) > 4 || table > 3) fail();
        components.set(id, table);
      }
    } else if (marker === 0xda) {
      const count = bytes[start]!;
      if (!width || !count || count > components.size || end - start !== 1 + count * 2 + 3 || ++scans > 256) fail();
      const spectralStart = bytes[end - 3]!, spectralEnd = bytes[end - 2]!, approximation = bytes[end - 1]!;
      if (spectralStart > spectralEnd || spectralEnd > 63 || (!progressive && (spectralStart !== 0 || spectralEnd !== 63 || approximation !== 0)) ||
          progressive && (spectralStart === 0 && spectralEnd !== 0 || spectralStart > 0 && count !== 1 ||
            (approximation >> 4) > 13 || (approximation & 15) > 13 || (approximation >> 4) > 0 && (approximation >> 4) !== (approximation & 15) + 1)) fail();
      const selected = new Set<number>();
      for (let i = 0; i < count; i++) {
        const id = bytes[start + 1 + i * 2]!, tables = bytes[start + 2 + i * 2]!;
        const table = components.get(id);
        if (table === undefined || !quant.has(table) || selected.has(id) || (tables >> 4) > 3 || (tables & 15) > 3 ||
            (spectralStart === 0 && (approximation >> 4) === 0 && !dc.has(tables >> 4)) || spectralEnd > 0 && !ac.has(tables & 15)) fail();
        selected.add(id);
      }
      let scanBytes = 0;
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) { offset++; scanBytes++; continue; }
        let next = offset + 1;
        while (bytes[next] === 0xff) next++;
        if (bytes[next] === 0 || bytes[next]! >= 0xd0 && bytes[next]! <= 0xd7) { scanBytes++; offset = next + 1; continue; }
        break;
      }
      if (!scanBytes) fail();
      entropyBytes += scanBytes;
    } else if (marker === 0xdd) {
      if (end - start !== 2) fail();
    } else if (!(marker! >= 0xe0 && marker! <= 0xef) && marker !== 0xfe) {
      // No arithmetic/lossless/hierarchical JPEG, external data, or unknown markers.
      fail();
    }
  }
  return fail();
}

export function decodeDirectRaster(data: Buffer, declaredMime?: string): DirectRaster {
  const mime: RasterMime | undefined = data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ? 'image/png'
    : data[0] === 0xff && data[1] === 0xd8 ? 'image/jpeg' : undefined;
  const declared = declaredMime?.trim().toLowerCase();
  if (!mime || declared && declared !== mime && !(declared === 'image/jpg' && mime === 'image/jpeg')) throw new Error('IMAGE_DIRECT_MIME_INVALID');
  return { data, mime, extension: mime === 'image/png' ? 'png' : 'jpg', info: mime === 'image/png' ? decodePng(data) : inspectJpeg(data) };
}

export async function readDirectRaster(file: string, root: string): Promise<DirectRaster> {
  const ext = path.extname(file).toLowerCase();
  if (!['.png', '.jpg', '.jpeg'].includes(ext)) throw new Error('IMAGE_UNSAFE_FILE');
  return decodeDirectRaster(await readImageBytes(file, root), ext === '.png' ? 'image/png' : 'image/jpeg');
}
