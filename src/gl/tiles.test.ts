import { describe, expect, it } from 'vitest';
import { splits } from './renderer';

describe('splits', () => {
  it('keeps an image that fits as one tile', () => {
    expect(splits(1675, 4096)).toEqual([{ start: 0, size: 1675, src: 0, srcSize: 1675 }]);
  });

  it('covers the Paris map width with padded tiles that fit the limit', () => {
    const parts = splits(11871, 4096);
    let next = 0;
    for (const p of parts) {
      expect(p.start).toBe(next);
      expect(p.srcSize).toBeLessThanOrEqual(4096);
      expect(p.src).toBeLessThanOrEqual(p.start);
      expect(p.src + p.srcSize).toBeGreaterThanOrEqual(p.start + p.size);
      next = p.start + p.size;
    }
    expect(next).toBe(11871);
    expect(parts).toHaveLength(3);
  });
});
