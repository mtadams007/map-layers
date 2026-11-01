import { describe, expect, it } from 'vitest';
import { canvasLimits, fitToLimits, mapSizeOptions } from './imageExport';

const paris = { width: 11871, height: 8951 };

describe('mapSizeOptions', () => {
  it('offers small, medium and full size on a laptop in Chrome or Firefox', () => {
    const options = mapSizeOptions(paris, Infinity, canvasLimits(false));
    expect(options.map((o) => o.label)).toEqual(['Small', 'Medium', 'Full size']);
    expect(options[0]).toMatchObject({ width: 2000, height: 1508 });
    expect(options[2]).toMatchObject(paris);
  });

  it('caps the largest size in Safari at about 16.7 million pixels', () => {
    const options = mapSizeOptions(paris, Infinity, canvasLimits(true));
    expect(options.map((o) => o.label)).toEqual(['Small', 'Largest possible here']);
    const largest = options.at(-1)!;
    expect(largest.width * largest.height).toBeLessThanOrEqual(16_777_216);
    expect(largest.width / largest.height).toBeCloseTo(paris.width / paris.height, 2);
  });

  it('on a phone, goes no larger than the copy it has loaded', () => {
    const options = mapSizeOptions(paris, 4096, canvasLimits(true));
    expect(options.map((o) => o.label)).toEqual(['Small', 'Largest possible here']);
    expect(options[1]).toMatchObject({ width: 4096, height: 3088 });
  });

  it('offers only the full size for a small map', () => {
    expect(mapSizeOptions({ width: 1800, height: 1200 }, Infinity, canvasLimits(false))).toEqual([
      { label: 'Full size', width: 1800, height: 1200 },
    ]);
  });
});

describe('fitToLimits', () => {
  it('leaves sizes within the limits alone', () => {
    expect(fitToLimits({ width: 3000, height: 2000 }, canvasLimits(true))).toEqual({ width: 3000, height: 2000 });
  });
});
