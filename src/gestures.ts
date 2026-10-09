import type { Camera } from './camera';
import type { Vec } from './fit';

export interface GestureOptions {
  camera: Camera;
  /** The camera moved; redraw. */
  onChange: () => void;
  /** A click or tap that wasn't a drag, in pane coordinates. */
  onTap?: (p: Vec) => void;
  /** Mouse position in pane coordinates, or null when it leaves the pane or a drag starts. */
  onHover?: (p: Vec | null) => void;
  /** Double click or double tap zooms in. Off where a single click already does something. */
  doubleTapZoom?: boolean;
}

/** Pointer movement below this counts as a tap, not a drag. */
const TAP_SLOP = 5;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_ZOOM = 2;

/**
 * Pan and zoom for one pane. Drag pans; two fingers pinch-zoom around the point between them and
 * pan at the same time; trackpad pinch and the scroll wheel zoom towards the cursor.
 * Returns a function that removes the listeners.
 */
export function attachGestures(el: HTMLElement, opts: GestureOptions): () => void {
  const { camera } = opts;
  const pointers = new Map<number, Vec>();
  let tapStart: Vec | null = null;
  let moved = false;
  let lastTap: { at: number; p: Vec } | null = null;
  let gestureScale = 1;
  let inSafariGesture = false;

  const local = (e: { clientX: number; clientY: number }): Vec => {
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const centroid = (): Vec => {
    let x = 0;
    let y = 0;
    for (const p of pointers.values()) {
      x += p.x;
      y += p.y;
    }
    return { x: x / pointers.size, y: y / pointers.size };
  };

  const spread = (): number => {
    const [a, b] = [...pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    el.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, local(e));
    if (pointers.size === 1) {
      tapStart = local(e);
      moved = false;
    } else {
      // A second finger means this is a pinch, never a tap; the finger left behind keeps panning.
      tapStart = null;
      moved = true;
    }
    opts.onHover?.(null);
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!pointers.has(e.pointerId)) {
      if (e.pointerType === 'mouse') opts.onHover?.(local(e));
      return;
    }
    const before = centroid();
    const beforeSpread = pointers.size === 2 ? spread() : 0;
    pointers.set(e.pointerId, local(e));
    const after = centroid();

    if (tapStart && !moved && Math.hypot(after.x - tapStart.x, after.y - tapStart.y) > TAP_SLOP) {
      moved = true;
    }
    if (pointers.size === 1 && !moved) return;

    camera.panBy(after.x - before.x, after.y - before.y);
    if (pointers.size === 2 && beforeSpread > 0) {
      camera.zoomAt(after, spread() / beforeSpread);
    }
    opts.onChange();
  };

  const onPointerUp = (e: PointerEvent) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    const p = local(e);
    if (pointers.size === 0 && tapStart && !moved && e.type === 'pointerup') {
      handleTap(p);
    }
    if (pointers.size === 0) tapStart = null;
    if (e.pointerType === 'mouse') opts.onHover?.(p);
  };

  const handleTap = (p: Vec) => {
    const now = performance.now();
    if (
      opts.doubleTapZoom &&
      lastTap &&
      now - lastTap.at < DOUBLE_TAP_MS &&
      Math.hypot(p.x - lastTap.p.x, p.y - lastTap.p.y) < TAP_SLOP * 4
    ) {
      lastTap = null;
      camera.zoomAt(p, DOUBLE_TAP_ZOOM);
      opts.onChange();
      return;
    }
    lastTap = { at: now, p };
    opts.onTap?.(p);
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    if (inSafariGesture) return;
    let dy = e.deltaY;
    if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) dy *= 16;
    else if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) dy *= camera.viewHeight;
    // Trackpad pinch arrives as a wheel event with ctrlKey set, in small steps.
    const rate = e.ctrlKey ? 0.01 : 0.002;
    camera.zoomAt(local(e), Math.exp(-dy * rate));
    opts.onChange();
  };

  // Safari on macOS reports trackpad pinch as non-standard gesture events.
  type GestureEvent = UIEvent & { scale: number; clientX: number; clientY: number };
  const onGestureStart = (e: Event) => {
    e.preventDefault();
    inSafariGesture = true;
    gestureScale = 1;
  };
  const onGestureChange = (e: Event) => {
    e.preventDefault();
    const g = e as GestureEvent;
    camera.zoomAt(local(g), g.scale / gestureScale);
    gestureScale = g.scale;
    opts.onChange();
  };
  const onGestureEnd = (e: Event) => {
    e.preventDefault();
    inSafariGesture = false;
  };

  const onLeave = () => {
    if (pointers.size === 0) opts.onHover?.(null);
  };

  el.addEventListener('pointerdown', onPointerDown);
  el.addEventListener('pointermove', onPointerMove);
  el.addEventListener('pointerup', onPointerUp);
  el.addEventListener('pointercancel', onPointerUp);
  el.addEventListener('pointerleave', onLeave);
  el.addEventListener('wheel', onWheel, { passive: false });
  el.addEventListener('gesturestart', onGestureStart);
  el.addEventListener('gesturechange', onGestureChange);
  el.addEventListener('gestureend', onGestureEnd);

  return () => {
    el.removeEventListener('pointerdown', onPointerDown);
    el.removeEventListener('pointermove', onPointerMove);
    el.removeEventListener('pointerup', onPointerUp);
    el.removeEventListener('pointercancel', onPointerUp);
    el.removeEventListener('pointerleave', onLeave);
    el.removeEventListener('wheel', onWheel);
    el.removeEventListener('gesturestart', onGestureStart);
    el.removeEventListener('gesturechange', onGestureChange);
    el.removeEventListener('gestureend', onGestureEnd);
  };
}

/**
 * Stops the browser's own page zoom (trackpad pinch, ctrl+scroll, Safari gestures, iOS double-tap
 * and pinch) everywhere, so only the map zooms.
 */
export function preventPageZoom() {
  const stop = (e: Event) => e.preventDefault();
  document.addEventListener('wheel', (e) => e.ctrlKey && e.preventDefault(), { passive: false });
  document.addEventListener('gesturestart', stop, { passive: false });
  document.addEventListener('gesturechange', stop, { passive: false });
  document.addEventListener('gestureend', stop, { passive: false });
  document.addEventListener('touchmove', (e) => e.touches.length > 1 && e.preventDefault(), {
    passive: false,
  });
  document.addEventListener('dblclick', stop, { passive: false });
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && ['+', '=', '-', '0'].includes(e.key)) e.preventDefault();
  });
}
