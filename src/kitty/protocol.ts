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

export async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('DecompressionStream unavailable, cannot handle o=z');
  }
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
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
