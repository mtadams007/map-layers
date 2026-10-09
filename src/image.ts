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
export async function decodeImage(file: File): Promise<DecodedImage> {
  try {
    const bitmap = await createImageBitmap(file, { premultiplyAlpha: 'premultiply' });
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
      throw new Error(`Couldn't read ${file.name}. Is it a PNG or JPEG?`);
    }
  }
}

/** A small PNG data URL for the layer list. */
export async function thumbnail(image: DecodedImage, maxSide = 112): Promise<string> {
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
