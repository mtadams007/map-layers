import { copySizesFor, scaledSize } from './sizes';

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

export interface PhoneCopy {
  /** Longest side it was made at (one of PHONE_SIZES). */
  maxSide: number;
  width: number;
  height: number;
  blob: Blob;
}

/**
 * Smaller copies of a decoded image for devices with little memory, one per size in PHONE_SIZES
 * that is smaller than the image. Made on the laptop so phones never decode the original. JPEG
 * stays JPEG; PNG stays PNG so transparency is kept.
 */
export async function makePhoneCopies(image: DecodedImage, type: string, only?: number[]): Promise<PhoneCopy[]> {
  const copies: PhoneCopy[] = [];
  for (const maxSide of copySizesFor(image)) {
    if (only && !only.includes(maxSide)) continue;
    const { width, height } = scaledSize(image, maxSide);
    const small = await createImageBitmap(image.source, { resizeWidth: width, resizeHeight: height, resizeQuality: 'high' });
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d')!.drawImage(small, 0, 0);
    small.close();
    const outType = type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, outType, 0.9));
    canvas.width = canvas.height = 0;
    if (!blob) throw new Error("The smaller copies for phones couldn't be made.");
    copies.push({ maxSide, width, height, blob });
  }
  return copies;
}
