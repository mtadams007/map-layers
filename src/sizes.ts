// Which image a device opens. Large layers get smaller "phone copies" so devices with little
// memory never decode the full-size original. Each device has a size limit (its "budget") and
// opens the sharpest version within it.

/**
 * Longest side of each phone copy, largest first. 6,000 px suits Android phones; an iPhone 12 mini
 * crashed at 6,000 but not reliably below, so iPhones use 4,096.
 */
export const PHONE_SIZES = [6000, 4096] as const;

/** The size budgets a device can step down through after a crash, largest first. */
export const BUDGET_STEPS = [Infinity, ...PHONE_SIZES];

export interface Size {
  width: number;
  height: number;
}

/** Size of a copy whose longest side is `maxSide`. */
export function scaledSize({ width, height }: Size, maxSide: number): Size {
  const scale = maxSide / Math.max(width, height);
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/** The phone copy sizes a layer of this size needs: each one smaller than the original. */
export function copySizesFor({ width, height }: Size): number[] {
  return PHONE_SIZES.filter((s) => Math.max(width, height) > s);
}

/** A version of a layer that could be opened: the original or a phone copy. */
export interface Version {
  /** Its longest side in pixels. */
  side: number;
}

/**
 * The sharpest version whose longest side fits the budget, or null if none does (the map needs
 * exporting again from a laptop to get smaller copies).
 */
export function pickVersion<V extends Version>(versions: V[], budget: number): V | null {
  const fitting = versions.filter((v) => v.side <= budget);
  if (fitting.length === 0) return null;
  return fitting.reduce((best, v) => (v.side > best.side ? v : best));
}

/** The next smaller budget after one that crashed, or null if there's nothing smaller. */
export function nextBudget(crashed: number): number | null {
  const i = BUDGET_STEPS.indexOf(crashed);
  return i >= 0 && i + 1 < BUDGET_STEPS.length ? BUDGET_STEPS[i + 1] : null;
}
