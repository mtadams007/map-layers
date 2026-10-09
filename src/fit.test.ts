import { describe, expect, it } from 'vitest';
import {
  apply,
  compose,
  fit,
  invert,
  outliers,
  solveAffine,
  solveSimilarity,
  type PointPair,
  type Transform,
} from './fit';

function similarity(scale: number, angle: number, tx: number, ty: number): Transform {
  const c = scale * Math.cos(angle);
  const s = scale * Math.sin(angle);
  return [c, -s, tx, s, c, ty];
}

function pairsFor(t: Transform, layer: { x: number; y: number }[]): PointPair[] {
  return layer.map((p) => ({ layer: p, base: apply(t, p) }));
}

function expectTransform(actual: Transform | null, expected: Transform, digits = 6) {
  expect(actual).not.toBeNull();
  actual!.forEach((v, i) => expect(v).toBeCloseTo(expected[i], digits));
}

const corners = [
  { x: 0, y: 0 },
  { x: 2480, y: 0 },
  { x: 2480, y: 1650 },
  { x: 0, y: 1650 },
  { x: 1200, y: 800 },
];

describe('solveSimilarity', () => {
  it('recovers an exact transform from 2 points', () => {
    const t = similarity(1.7, 0.3, 812, -95);
    expectTransform(solveSimilarity(pairsFor(t, corners.slice(0, 2))), t);
  });

  it('recovers an exact transform at large coordinates', () => {
    const t = similarity(4.6, -1.1, 11000, 8000);
    expectTransform(solveSimilarity(pairsFor(t, corners)), t, 4);
  });

  it('rejects too few or coincident points', () => {
    expect(solveSimilarity([])).toBeNull();
    expect(solveSimilarity([{ layer: { x: 1, y: 1 }, base: { x: 5, y: 5 } }])).toBeNull();
    const p = { layer: { x: 10, y: 10 }, base: { x: 0, y: 0 } };
    expect(solveSimilarity([p, { ...p }])).toBeNull();
  });

  it('spreads noise as a least-squares fit', () => {
    const t = similarity(2, 0.5, 100, 200);
    const pairs = pairsFor(t, corners);
    pairs[0].base.x += 3;
    pairs[1].base.x -= 3;
    const result = fit('similarity', pairs)!;
    expect(result.rms).toBeGreaterThan(0);
    expect(result.rms).toBeLessThan(3);
  });
});

describe('solveAffine', () => {
  it('recovers a stretch and skew that similarity cannot', () => {
    const t: Transform = [1.3, 0.2, 50, -0.1, 0.8, 400];
    const pairs = pairsFor(t, corners);
    expectTransform(solveAffine(pairs), t);
    expect(fit('affine', pairs)!.rms).toBeCloseTo(0, 6);
    expect(fit('similarity', pairs)!.rms).toBeGreaterThan(10);
  });

  it('needs 3 points that are not in a line', () => {
    const t = similarity(1, 0, 0, 0);
    expect(solveAffine(pairsFor(t, corners.slice(0, 2)))).toBeNull();
    const line = [
      { x: 0, y: 0 },
      { x: 100, y: 100 },
      { x: 300, y: 300 },
    ];
    expect(solveAffine(pairsFor(t, line))).toBeNull();
  });
});

describe('invert and compose', () => {
  it('round-trips', () => {
    const t: Transform = [1.3, 0.2, 50, -0.1, 0.8, 400];
    expectTransform(compose(invert(t)!, t), [1, 0, 0, 0, 1, 0]);
    const p = { x: 123, y: -45 };
    const q = apply(invert(t)!, apply(t, p));
    expect(q.x).toBeCloseTo(p.x, 9);
    expect(q.y).toBeCloseTo(p.y, 9);
  });
});

describe('outliers', () => {
  it('flags the point from the wireframe', () => {
    expect(outliers([1.2, 1.6, 10.4])).toEqual([false, false, true]);
  });

  it('ignores small errors and short lists', () => {
    expect(outliers([0.5, 0.6, 2.5])).toEqual([false, false, false]);
    expect(outliers([0, 50])).toEqual([false, false]);
  });
});
