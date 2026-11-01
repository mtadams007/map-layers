// Sizes offered when saving the map as a PNG or JPEG image.

import { scaledSize, type Size } from './sizes';

export type ExportArea = 'view' | 'map';
export type ExportFormat = 'jpeg' | 'png';

export interface CanvasLimits {
  maxSide: number;
  maxPixels: number;
}

/**
 * How big an image the browser can build. Safari (and every browser on iPhone and iPad, which all
 * use Safari's engine) refuses canvases over about 16.7 million pixels; Chrome and Firefox allow
 * far more, up to 32,767 px on a side.
 */
export function canvasLimits(webKit: boolean): CanvasLimits {
  return webKit ? { maxSide: 16384, maxPixels: 16_777_216 } : { maxSide: 32767, maxPixels: 250_000_000 };
}

/** Shrink a size, keeping its shape, until it fits the limits. */
export function fitToLimits({ width, height }: Size, limits: CanvasLimits): Size {
  const scale = Math.min(1, limits.maxSide / Math.max(width, height), Math.sqrt(limits.maxPixels / (width * height)));
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}

export interface SizeOption extends Size {
  label: string;
}

/**
 * Sizes to offer for the whole map: 2,000 and 4,000 px on the longest side (when clearly smaller
 * than the largest), plus the largest the device can produce. `maxSource` is the sharpest image
 * this device has loaded (its phone copy size on a phone; Infinity on a laptop), since saving
 * larger than that adds no detail.
 */
export function mapSizeOptions(base: Size, maxSource: number, limits: CanvasLimits): SizeOption[] {
  const side = Math.max(base.width, base.height);
  const largest = fitToLimits(side > maxSource ? scaledSize(base, maxSource) : base, limits);
  const largestSide = Math.max(largest.width, largest.height);
  const options: SizeOption[] = [];
  for (const [label, s] of [['Small', 2000], ['Medium', 4000]] as const) {
    // Skip sizes close to the largest; they'd be near-duplicates.
    if (s < largestSide * 0.8) options.push({ label, ...scaledSize(base, s) });
  }
  const full = largest.width === base.width && largest.height === base.height;
  options.push({ label: full ? 'Full size' : 'Largest possible here', ...largest });
  return options;
}
