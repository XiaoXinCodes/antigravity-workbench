import { MAX_IMAGE_BYTES } from './image-files';
import { decodeDirectRaster, type DirectRaster } from './direct-image-raster';
import { imageResponseFailure, responseOwn as own } from './image-response-evidence';

const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const MAX_PARTS = 64, MAX_IMAGES = 8, MAX_BASE64 = 32 * 1024 * 1024;

/** A single generateContent request may return text and multiple image parts.
 * Like Manager's Images route, consume the first candidate only. Never fetch
 * fileData/URLs or turn response text into a path, command, or second request.
 */
export function decodeDirectImageResponse(value: unknown): DirectRaster[] {
  if (!object(value)) throw imageResponseFailure(value, 'root');
  const wrapped = Object.hasOwn(value, 'response');
  const root = wrapped ? own(value, 'response') : value;
  if (!object(root)) throw imageResponseFailure(value, 'wrapper');
  if (object(own(value, 'error')) || object(own(root, 'error'))) throw imageResponseFailure(value, 'service-error');
  const candidates = own(root, 'candidates');
  if (!Array.isArray(candidates) || !candidates.length || candidates.length > 32) throw imageResponseFailure(value, 'candidates');
  const parts = own(own(own(candidates, '0'), 'content'), 'parts');
  if (!Array.isArray(parts) || parts.length > MAX_PARTS) throw imageResponseFailure(value, 'parts');
  const images: DirectRaster[] = [];
  let totalBytes = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = own(parts, String(i));
    const camel = own(part, 'inlineData'), snake = own(part, 'inline_data');
    if (camel === undefined && snake === undefined) continue;
    if (camel !== undefined && snake !== undefined) throw imageResponseFailure(value, 'inline-data', i);
    const inline = camel ?? snake;
    if (!object(inline)) throw imageResponseFailure(value, 'inline-data', i);
    if (images.length === MAX_IMAGES) throw imageResponseFailure(value, 'image-limit', i);
    const mime = own(inline, 'mimeType'), snakeMime = own(inline, 'mime_type');
    if (mime !== undefined && snakeMime !== undefined && mime !== snakeMime) throw imageResponseFailure(value, 'mime', i);
    const declared = mime ?? snakeMime;
    if (declared !== undefined && typeof declared !== 'string') throw imageResponseFailure(value, 'mime', i);
    const encoded = own(inline, 'data');
    if (typeof encoded !== 'string' || encoded.length > MAX_BASE64) throw imageResponseFailure(value, 'base64', i);
    // Protobuf bytes can use standard or URL-safe base64 with/without padding.
    // Whitespace is bounded; re-encoding rejects altered trailing bits/junk.
    const compact = encoded.replace(/[\t\r\n ]/gu, '');
    if (!compact || /[^A-Za-z0-9+/_=-]/u.test(compact) || /[+/]/u.test(compact) && /[-_]/u.test(compact)) throw imageResponseFailure(value, 'base64', i);
    const canonical = compact.replace(/-/gu, '+').replace(/_/gu, '/');
    if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(canonical) || canonical.replace(/=+$/u, '').length % 4 === 1 || canonical.includes('=') && canonical.length % 4 !== 0) throw imageResponseFailure(value, 'base64', i);
    const bytes = Buffer.from(canonical, 'base64');
    if (bytes.toString('base64').replace(/=+$/u, '') !== canonical.replace(/=+$/u, '')) throw imageResponseFailure(value, 'base64', i);
    totalBytes += bytes.length;
    if (totalBytes > MAX_IMAGE_BYTES) throw imageResponseFailure(value, 'image-bytes-limit', i);
    try { images.push(decodeDirectRaster(bytes, declared as string | undefined)); }
    catch (error) { throw imageResponseFailure(value, error instanceof Error && error.message === 'IMAGE_INVALID_PNG' ? 'png' : error instanceof Error && error.message === 'IMAGE_INVALID_JPEG' ? 'jpeg' : 'mime', i); }
  }
  if (!images.length) throw imageResponseFailure(value, 'no-images');
  return images;
}
