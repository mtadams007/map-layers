// Least-squares fitting of a layer to the base layer from matching points.
// A transform is a 2×3 matrix [a, b, c, d, e, f] mapping layer pixels to base pixels:
//   X = a·x + b·y + c
//   Y = d·x + e·y + f

export interface Vec {
  x: number;
  y: number;
}

export type Transform = [number, number, number, number, number, number];

export type FitMode = 'similarity' | 'affine';

export interface PointPair {
  layer: Vec;
  base: Vec;
}

export interface FitResult {
  transform: Transform;
  /** Distance in base pixels between each base point and where the fit puts its layer point. */
  errors: number[];
  rms: number;
}

export const IDENTITY: Transform = [1, 0, 0, 0, 1, 0];

/** Minimum points for each mode. */
export const MIN_POINTS: Record<FitMode, number> = { similarity: 2, affine: 3 };

export function apply(t: Transform, p: Vec): Vec {
  return { x: t[0] * p.x + t[1] * p.y + t[2], y: t[3] * p.x + t[4] * p.y + t[5] };
}

export function invert(t: Transform): Transform | null {
  const [a, b, c, d, e, f] = t;
  const det = a * e - b * d;
  if (Math.abs(det) < 1e-12) return null;
  const ia = e / det;
  const ib = -b / det;
  const id = -d / det;
  const ie = a / det;
  return [ia, ib, -(ia * c + ib * f), id, ie, -(id * c + ie * f)];
}

/** a ∘ b: apply b first, then a. */
export function compose(a: Transform, b: Transform): Transform {
  return [
    a[0] * b[0] + a[1] * b[3],
    a[0] * b[1] + a[1] * b[4],
    a[0] * b[2] + a[1] * b[5] + a[2],
    a[3] * b[0] + a[4] * b[3],
    a[3] * b[1] + a[4] * b[4],
    a[3] * b[2] + a[4] * b[5] + a[5],
  ];
}

interface Centred {
  lc: Vec;
  bc: Vec;
  /** Layer points minus their centroid. */
  l: Vec[];
  /** Base points minus their centroid. */
  b: Vec[];
}

// Centring first keeps the sums small, which matters with coordinates around 10,000 px.
function centre(pairs: PointPair[]): Centred {
  const n = pairs.length;
  const lc = { x: 0, y: 0 };
  const bc = { x: 0, y: 0 };
  for (const p of pairs) {
    lc.x += p.layer.x / n;
    lc.y += p.layer.y / n;
    bc.x += p.base.x / n;
    bc.y += p.base.y / n;
  }
  return {
    lc,
    bc,
    l: pairs.map((p) => ({ x: p.layer.x - lc.x, y: p.layer.y - lc.y })),
    b: pairs.map((p) => ({ x: p.base.x - bc.x, y: p.base.y - bc.y })),
  };
}

/** Shift, rotation and uniform scale. Needs 2 distinct layer points. */
export function solveSimilarity(pairs: PointPair[]): Transform | null {
  if (pairs.length < 2) return null;
  const { lc, bc, l, b } = centre(pairs);
  let sxx = 0;
  let dot = 0;
  let cross = 0;
  for (let i = 0; i < l.length; i++) {
    sxx += l[i].x * l[i].x + l[i].y * l[i].y;
    dot += l[i].x * b[i].x + l[i].y * b[i].y;
    cross += l[i].x * b[i].y - l[i].y * b[i].x;
  }
  if (sxx < 1e-9) return null;
  const a = dot / sxx;
  const s = cross / sxx;
  if (Math.abs(a) < 1e-12 && Math.abs(s) < 1e-12) return null;
  return [a, -s, bc.x - (a * lc.x - s * lc.y), s, a, bc.y - (s * lc.x + a * lc.y)];
}

/** Full affine: adds separate x/y scale and skew. Needs 3 layer points that are not in a line. */
export function solveAffine(pairs: PointPair[]): Transform | null {
  if (pairs.length < 3) return null;
  const { lc, bc, l, b } = centre(pairs);
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  let sxu = 0;
  let syu = 0;
  let sxv = 0;
  let syv = 0;
  for (let i = 0; i < l.length; i++) {
    const { x, y } = l[i];
    sxx += x * x;
    sxy += x * y;
    syy += y * y;
    sxu += x * b[i].x;
    syu += y * b[i].x;
    sxv += x * b[i].y;
    syv += y * b[i].y;
  }
  const det = sxx * syy - sxy * sxy;
  // Relative test so the threshold doesn't depend on image size.
  if (det <= 1e-9 * (sxx * syy) || sxx * syy === 0) return null;
  const a = (sxu * syy - syu * sxy) / det;
  const bb = (syu * sxx - sxu * sxy) / det;
  const d = (sxv * syy - syv * sxy) / det;
  const e = (syv * sxx - sxv * sxy) / det;
  return [a, bb, bc.x - (a * lc.x + bb * lc.y), d, e, bc.y - (d * lc.x + e * lc.y)];
}

export function solve(mode: FitMode, pairs: PointPair[]): Transform | null {
  return mode === 'similarity' ? solveSimilarity(pairs) : solveAffine(pairs);
}

export function errorsFor(t: Transform, pairs: PointPair[]): number[] {
  return pairs.map((p) => {
    const q = apply(t, p.layer);
    return Math.hypot(q.x - p.base.x, q.y - p.base.y);
  });
}

export function rmsOf(errors: number[]): number {
  if (errors.length === 0) return 0;
  return Math.sqrt(errors.reduce((s, e) => s + e * e, 0) / errors.length);
}

export function fit(mode: FitMode, pairs: PointPair[]): FitResult | null {
  const transform = solve(mode, pairs);
  if (!transform) return null;
  const errors = errorsFor(transform, pairs);
  return { transform, errors, rms: rmsOf(errors) };
}

/**
 * Flags points whose error stands out from the rest: more than twice the median error
 * and more than a few pixels. Needs at least 3 points; with 2 the fit is exact.
 */
export function outliers(errors: number[], minPx = 3): boolean[] {
  if (errors.length < 3) return errors.map(() => false);
  const sorted = [...errors].sort((x, y) => x - y);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const limit = Math.max(2 * median, minPx);
  return errors.map((e) => e > limit);
}
