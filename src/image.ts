export interface DecodedImage {
  source: ImageBitmap | HTMLImageElement;
  width: number;
  height: number;
  /** Release the decoded pixels once they are on the GPU. */
  release(): void;
}

export const ACCEPTED_TYPES = ['image/png', 'image/jpeg'];

/**
 * Decode an image file at full size. Very large images can be refused by createImageBitmap in some
 * browsers, so fall back to an <img> element, which the browser decodes lazily as it is read.
 */
export async function decodeImage(file: Blob, name: string): Promise<DecodedImage> {
  try {
    // No premultiply option: the renderer reads pixels back through a 2D canvas anyway, and on
    // Safari the conversion can cost an extra full copy of the image.
    const bitmap = await createImageBitmap(file);
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      release: () => bitmap.close(),
    };
  } catch {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return {
        source: img,
        width: img.naturalWidth,
        height: img.naturalHeight,
        release: () => URL.revokeObjectURL(url),
      };
    } catch {
      URL.revokeObjectURL(url);
      throw new Error(`Couldn't read ${name}. Is it a PNG or JPEG?`);
    }
  }
}

/** A small PNG data URL for the layer list and the map thumbnail. */
export async function thumbnail(image: DecodedImage, maxSide = 320): Promise<string> {
  const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
  const w = Math.max(1, Math.round(image.width * scale));
  const h = Math.max(1, Math.round(image.height * scale));
  const small = await createImageBitmap(image.source, {
    resizeWidth: w,
    resizeHeight: h,
    resizeQuality: 'medium',
  });
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d')!.drawImage(small, 0, 0);
  small.close();
  return canvas.toDataURL('image/png');
}

/**
 * Longest side of the smaller copy made for phones. Decoding a larger image can exceed what Safari
 * allows one tab on an older iPhone (a 12 mini crashed opening an 11,871 × 8,951 px map).
 */
export const PHONE_MAX_SIDE = 6000;

export function needsPhoneCopy(width: number, height: number): boolean {
  return Math.max(width, height) > PHONE_MAX_SIDE;
}

/**
 * A copy of the image no larger than PHONE_MAX_SIDE, made on the laptop so phones never decode the
 * original. JPEG stays JPEG; PNG stays PNG so transparency is kept. Returns null if none is needed.
 */
export async function makePhoneCopy(image: DecodedImage, type: string): Promise<Blob | null> {
  if (!needsPhoneCopy(image.width, image.height)) return null;
  const scale = PHONE_MAX_SIDE / Math.max(image.width, image.height);
  const w = Math.round(image.width * scale);
  const h = Math.round(image.height * scale);
  const small = await createImageBitmap(image.source, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d')!.drawImage(small, 0, 0);
  small.close();
  const outType = type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, outType, 0.9));
  canvas.width = canvas.height = 0;
  if (!blob) throw new Error("The smaller copy for phones couldn't be made.");
  return blob;
}

/**
 * Touch-first devices (phones, tablets) open the smaller phone copies. Their memory per tab is far
 * below a laptop's, and decoding a full-size map there can crash the page.
 */
export function usesPhoneCopies(): boolean {
  return window.matchMedia('(pointer: coarse)').matches;
}
