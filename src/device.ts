/**
 * Touch-first devices (phones, tablets) get the phone layout: Library and View only, no Create
 * mode. They also open the smaller phone copies of large images, since their memory per tab is far
 * below a laptop's.
 */
export function isPhone(): boolean {
  return window.matchMedia('(pointer: coarse)').matches;
}

/** iPhone or iPad, including iPads that report themselves as a Mac. */
export function isIOS(): boolean {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.userAgent.includes('Macintosh') && navigator.maxTouchPoints > 1);
}

/** Running as an installed app from the home screen rather than in a browser tab. */
export function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

const BUDGET_KEY = 'map-layers:max-side';
const OPENING_KEY = 'map-layers:opening';

/**
 * Longest image side this device opens. Laptops open originals; iPhones and iPads get 4,096 px
 * (an iPhone 12 mini crashed at 6,000); other touch devices 6,000. If a map has crashed the page
 * here before, the lowered limit remembered after that crash applies.
 */
export function sizeBudget(): number {
  const base = !isPhone() ? Infinity : isIOS() ? 4096 : 6000;
  const lowered = Number(readStored(BUDGET_KEY));
  return lowered > 0 ? Math.min(base, lowered) : base;
}

export function lowerSizeBudget(to: number) {
  writeStored(BUDGET_KEY, String(to));
}

export interface OpeningNote {
  name: string;
  budget: number;
}

/**
 * Note that a map is being opened. When the page is killed for using too much memory (Safari on
 * iPhone does this), the note is still there at the next start, and the device can step down.
 */
export function noteOpening(note: OpeningNote) {
  writeStored(OPENING_KEY, JSON.stringify({ ...note, budget: Number.isFinite(note.budget) ? note.budget : 'original' }));
}

export function clearOpening() {
  removeStored(OPENING_KEY);
}

/** A note left by an opening that never finished, i.e. the page was killed. Clears it. */
export function takeCrashedOpening(): OpeningNote | null {
  const raw = readStored(OPENING_KEY);
  removeStored(OPENING_KEY);
  if (!raw) return null;
  try {
    const note = JSON.parse(raw);
    return { name: String(note.name), budget: note.budget === 'original' ? Infinity : Number(note.budget) };
  } catch {
    return null;
  }
}

/** localStorage may be unavailable (private browsing, blocked storage); then nothing is kept. */
export function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not kept.
  }
}

function removeStored(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    // Nothing to do.
  }
}
