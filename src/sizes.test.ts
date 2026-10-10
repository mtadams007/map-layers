import { describe, expect, it } from 'vitest';
import { copySizesFor, nextBudget, pickVersion, scaledSize } from './sizes';

describe('phone copy sizes', () => {
  it('makes a copy for each size smaller than the image', () => {
    expect(copySizesFor({ width: 11871, height: 8951 })).toEqual([6000, 4096]);
    expect(copySizesFor({ width: 5000, height: 3000 })).toEqual([4096]);
    expect(copySizesFor({ width: 2000, height: 1500 })).toEqual([]);
  });

  it('keeps the aspect ratio', () => {
    expect(scaledSize({ width: 11871, height: 8951 }, 4096)).toEqual({ width: 4096, height: 3088 });
  });
});

describe('pickVersion', () => {
  const paris = [{ side: 11871, name: 'original' }, { side: 6000, name: '6000' }, { side: 4096, name: '4096' }];

  it('opens the sharpest version within the budget', () => {
    expect(pickVersion(paris, Infinity)?.name).toBe('original');
    expect(pickVersion(paris, 6000)?.name).toBe('6000');
    expect(pickVersion(paris, 4096)?.name).toBe('4096');
  });

  it('opens a small original as it is', () => {
    expect(pickVersion([{ side: 2000, name: 'original' }], 4096)?.name).toBe('original');
  });

  it('finds nothing when every version is over the budget', () => {
    expect(pickVersion([{ side: 11871 }, { side: 6000 }], 4096)).toBeNull();
  });
});

describe('nextBudget', () => {
  it('steps down after a crash, and stops at the smallest copy', () => {
    expect(nextBudget(Infinity)).toBe(6000);
    expect(nextBudget(6000)).toBe(4096);
    expect(nextBudget(4096)).toBeNull();
  });
});
