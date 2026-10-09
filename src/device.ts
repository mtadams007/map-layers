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
