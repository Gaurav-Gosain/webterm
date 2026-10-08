/**
 * Kitty graphics protocol parsing and payload decoding.
 *
 * Kept free of DOM and xterm references so it can be exercised directly.
 */

/** 'G' = 71, the APC payload prefix for kitty graphics. */
export const KITTY_APC_IDENT = 71;

export interface KittyCommand {
  [key: string]: string | number | undefined;
  a?: string;
  t?: string;
  d?: string;
  o?: string;
  f?: number;
  i?: number;
  I?: number;
  p?: number;
  s?: number;
  v?: number;
  c?: number;
  r?: number;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  X?: number;
  Y?: number;
  z?: number;
  m?: number;
  q?: number;
  /** 1 for a virtual placement, shown through unicode placeholder cells. */
  U?: number;
  /** Non-zero for a placement positioned relative to another one. */
  P?: number;
}

/**
 * Keys whose values are numeric. Everything else stays a string.
 *
 * A key missing from here is not a cosmetic difference: it arrives as the
 * string '1' and every `=== 1` test against it silently fails. `U` was missing,
 * which made virtual placements indistinguishable from ordinary ones.
 */
const NUMERIC_KEYS = 'iIpsvwhxyXYzcrmqCSOUP';

export function parseControl(str: string): KittyCommand {
  const out: KittyCommand = {};
  if (!str) return out;
  for (const part of str.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq);
    const val = part.slice(eq + 1);
    if (NUMERIC_KEYS.indexOf(key) >= 0 && val !== '' && !isNaN(Number(val))) {
      out[key] = Number(val);
    } else {
      out[key] = val;
    }
  }
  // Format is numeric, but 'f' is not in the numeric key list above because it
  // shares its letter with nothing else and reads more clearly here.
  if (out.f !== undefined) out.f = Number(out.f);
  return out;
}

/** Split an APC payload into its control string and its data, ident stripped. */
export function splitApc(data: string): { control: KittyCommand; payload: string } {
  // xterm.js passes the APC payload including the ident byte, so data[0] is 'G'.
  const body = data.charCodeAt(0) === KITTY_APC_IDENT ? data.slice(1) : data;
  const semi = body.indexOf(';');
  return {
    control: parseControl(semi >= 0 ? body.slice(0, semi) : body),
    payload: semi >= 0 ? body.slice(semi + 1) : '',
  };
}

export function base64Decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * The largest image, in pixels, the overlay decodes by default: 4096 by 4096,
 * which is 64 MiB as RGBA.
 *
 * Every byte of a kitty transmission comes from the far end, and the size it
 * declares is not the size it sends. One 348 KB `o=z` payload declaring
 * 8192x8192 made the browser allocate a 256 MiB bitmap and grow by 600 MiB.
 */
export const DEFAULT_MAX_IMAGE_PIXELS = 4096 * 4096;

/**
 * The decoded bytes all stored images may hold together by default before the
 * least recently used unplaced one is evicted. kitty's own quota is 320 MB.
 */
export const DEFAULT_STORAGE_BYTES = 320 * 1024 * 1024;

/** The base64 length of `bytes` bytes of data. */
export function base64Length(bytes: number): number {
  return 4 * Math.ceil(bytes / 3);
}

/** Raised when a transmission is larger than the limits allow. */
export class ImageTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageTooLargeError';
  }
}

/** Raised when `f=100` data is not a PNG, or a PNG the browser cannot decode. */
export class BadPngError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadPngError';
  }
}

/**
 * The reply a failed decode gets, in kitty's `ECODE:message` form. The
 * message is cut to printable characters, because it is written back into the
 * application's input stream.
 */
export function decodeErrorReply(error: unknown): string {
  const code =
    error instanceof ImageTooLargeError ? 'EFBIG' : error instanceof BadPngError ? 'EBADPNG' : 'EINVAL';
  const message = error instanceof Error ? error.message : String(error);
  // eslint-disable-next-line no-control-regex
  return `${code}:${message.replace(/[\x00-\x1f\x7f-\x9f;]/g, ' ').slice(0, 200)}`;
}

/**
 * Check a declared or decoded image size against the pixel cap. Returns an
 * error message for a size that must not be decoded, and null for one that
 * may be.
 */
export function checkImageSize(width: number, height: number, maxPixels: number): string | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 0 || height < 0) {
    return `invalid size ${width}x${height}`;
  }
  if (width * height > maxPixels) {
    return `${width}x${height} is more than ${maxPixels} pixels`;
  }
  return null;
}

/**
 * The width and height in a PNG header, or null when `bytes` does not start
 * with one. Read before the browser decodes the image, so a small PNG that
 * declares a huge canvas is refused before any pixel buffer exists.
 */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24) return null;
  for (let i = 0; i < signature.length; i++) if (bytes[i] !== signature[i]) return null;
  // The first chunk must be IHDR: length (4), type (4), then width and height.
  if (String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]) !== 'IHDR') return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16, false), height: view.getUint32(20, false) };
}

/**
 * Inflate a zlib stream, stopping once the output passes `limit` bytes.
 *
 * The output is counted as it is produced and the stream is cancelled at the
 * limit, so a deflate bomb costs at most `limit` bytes, never its full size.
 */
export async function inflate(bytes: Uint8Array, limit = Infinity): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('DecompressionStream unavailable, cannot handle o=z');
  }
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('deflate'));
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new ImageTooLargeError(`inflated data is more than ${limit} bytes`);
    }
    parts.push(value);
  }
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

export function rgbToRgba(rgb: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
    out[j] = rgb[i];
    out[j + 1] = rgb[i + 1];
    out[j + 2] = rgb[i + 2];
    out[j + 3] = 255;
  }
  return out;
}

/**
 * Fit a raw RGBA buffer to the declared dimensions.
 *
 * If a chunk was dropped somewhere upstream there are fewer bytes than
 * expected. Rendering only the complete rows that arrived is right; padding
 * shifts every subsequent row and produces a visibly torn image rather than a
 * short one.
 */
export function fitRgba(
  rgba: Uint8Array,
  width: number,
  height: number,
): { data: Uint8Array; height: number } {
  const bytesPerRow = width * 4;
  const expected = width * height * 4;
  if (rgba.byteLength < expected) {
    const actualHeight = Math.max(1, Math.floor(rgba.byteLength / bytesPerRow));
    return { data: rgba.subarray(0, actualHeight * bytesPerRow), height: actualHeight };
  }
  if (rgba.byteLength > expected) return { data: rgba.subarray(0, expected), height };
  return { data: rgba, height };
}

/**
 * Clamp a source rectangle to an image's native bounds so drawImage never
 * throws InvalidStateError when an emitter passes a region that overflows.
 */
export function clampSourceRect(
  rect: { x: number; y: number; w: number; h: number },
  image: { width: number; height: number },
): { x: number; y: number; w: number; h: number } {
  let { x, y, w, h } = rect;
  if (x < 0) {
    w += x;
    x = 0;
  }
  if (y < 0) {
    h += y;
    y = 0;
  }
  if (x + w > image.width) w = image.width - x;
  if (y + h > image.height) h = image.height - y;
  return { x, y, w, h };
}
