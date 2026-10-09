import type { Transform } from './fit';

export interface ThumbLayer {
  /** Small image of the layer (a data URL). */
  thumbnail: string;
  width: number;
  height: number;
  /** Layer pixels → base pixels. */
  transform: Transform;
  opacity: number;
}

/**
 * A small PNG of the map as it looks in View, for the library. Built from the layer thumbnails, so
 * no full-size image is touched. `layers` are bottom first.
 */
export async function composeThumbnail(base: { width: number; height: number }, layers: ThumbLayer[], maxSide = 320): Promise<Blob | null> {
  const s = maxSide / Math.max(base.width, base.height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(base.width * s));
  canvas.height = Math.max(1, Math.round(base.height * s));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.imageSmoothingQuality = 'high';
  for (const l of layers) {
    const img = await loadImage(l.thumbnail);
    // Thumbnail pixels → layer pixels → base pixels → canvas pixels.
    const k = l.width / img.naturalWidth;
    const [a, b, c, d, e, f] = l.transform;
    ctx.setTransform(s * a * k, s * d * k, s * b * k, s * e * k, s * c, s * f);
    ctx.globalAlpha = l.opacity;
    ctx.drawImage(img, 0, 0);
  }
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/png'));
}

function loadImage(src: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = src;
  return img.decode().then(() => img);
}
