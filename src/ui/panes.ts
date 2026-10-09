import { Camera } from '../camera';
import { apply, compose, invert, type Transform, type Vec } from '../fit';
import { attachGestures } from '../gestures';
import type { Renderer } from '../gl/renderer';
import {
  baseLayer,
  fitSummary,
  pointsMoved,
  selectedLayer,
  state,
  transformOf,
  type Layer,
} from '../state';
import { MarkerLayer, type MarkerSpec } from './markers';

export type PaneKind = 'layer' | 'base' | 'overlay' | 'view';

const LOUPE_RADIUS = 64;
const LOUPE_ZOOM = 4;
const PANE_BG: [number, number, number] = [0.913, 0.922, 0.937];

export interface PaneHooks {
  requestDraw: () => void;
  /** A point was clicked on the layer or base pane. */
  place: (side: 'layer' | 'base', p: Vec) => void;
  /** Points were dragged; refresh the fit readout. */
  pointsDragged: () => void;
  /** A drag finished; refresh everything. */
  dragEnded: () => void;
}

/** One base-space camera shared by the base, overlay and view panes, so switching keeps the spot. */
const baseCamera = new Camera();
const layerCameras = new Map<string, Camera>();

export function forgetCamera(layerId: string) {
  layerCameras.delete(layerId);
}

export function resetBaseCamera() {
  const base = baseLayer();
  if (base) baseCamera.setBounds({ x: 0, y: 0, width: base.width, height: base.height }, true);
}

function cameraFor(kind: PaneKind, layer: Layer | undefined): Camera {
  if (kind === 'layer' && layer) {
    let cam = layerCameras.get(layer.id);
    if (!cam) {
      cam = new Camera();
      cam.setBounds({ x: 0, y: 0, width: layer.width, height: layer.height });
      layerCameras.set(layer.id, cam);
    }
    return cam;
  }
  const base = baseLayer();
  if (base) {
    const b = baseCamera.bounds;
    if (b.width !== base.width || b.height !== base.height) {
      baseCamera.setBounds({ x: 0, y: 0, width: base.width, height: base.height }, true);
    }
  }
  return baseCamera;
}

/** Camera as a transform: content pixels → pane pixels. */
function viewMatrix(cam: Camera): Transform {
  return [cam.scale, 0, cam.offsetX, 0, cam.scale, cam.offsetY];
}

export class Pane {
  private markers: MarkerLayer;
  private loupe: HTMLElement;
  private hover: Vec | null = null;
  private detach: () => void;

  constructor(
    readonly kind: PaneKind,
    readonly body: HTMLElement,
    private hooks: PaneHooks,
  ) {
    const markerEl = document.createElement('div');
    markerEl.className = 'markers';
    this.loupe = document.createElement('div');
    this.loupe.className = 'loupe';
    this.loupe.hidden = true;
    this.loupe.innerHTML = '<span class="loupe-label">Loupe ×4</span>';
    this.loupe.style.width = this.loupe.style.height = `${LOUPE_RADIUS * 2}px`;
    body.append(markerEl, this.loupe);
    this.markers = new MarkerLayer(markerEl);

    const picking = kind === 'layer' || kind === 'base';
    this.detach = attachGestures(body, {
      camera: this.camera,
      onChange: hooks.requestDraw,
      doubleTapZoom: !picking,
      onTap: picking ? (p) => this.tap(p) : undefined,
      onHover:
        kind === 'view'
          ? undefined
          : (p) => {
              this.hover = p;
              hooks.requestDraw();
            },
    });
  }

  get camera(): Camera {
    return cameraFor(this.kind, selectedLayer());
  }

  destroy() {
    this.detach();
  }

  private tap(p: Vec) {
    const c = this.camera.toContent(p);
    const bounds = this.camera.bounds;
    if (c.x < 0 || c.y < 0 || c.x > bounds.width || c.y > bounds.height) return;
    this.hooks.place(this.kind as 'layer' | 'base', c);
  }

  draw(renderer: Renderer) {
    const rect = this.body.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    const cam = this.camera;
    cam.setView(rect.width, rect.height);
    renderer.beginPane(rect, PANE_BG);

    this.drawContent(renderer, viewMatrix(cam), false);

    const loupeOn = this.hover !== null && this.kind !== 'view';
    this.loupe.hidden = !loupeOn;
    if (loupeOn) {
      const h = this.hover!;
      const s = cam.scale * LOUPE_ZOOM;
      const c = cam.toContent(h);
      // Same content point stays under the cursor, magnified around it.
      const zoomed: Transform = [s, 0, h.x - c.x * s, 0, s, h.y - c.y * s];
      this.drawContent(renderer, zoomed, true, { x: h.x, y: h.y, radius: LOUPE_RADIUS });
      this.loupe.style.transform = `translate(${h.x - LOUPE_RADIUS}px, ${h.y - LOUPE_RADIUS}px)`;
    }

    this.markers.update(this.markerSpecs(cam));
  }

  private drawContent(
    renderer: Renderer,
    view: Transform,
    pixelated: boolean,
    clip?: { x: number; y: number; radius: number },
  ) {
    const layer = selectedLayer();
    const base = baseLayer();
    if (clip) {
      // Clear the loupe circle so it isn't mixed with the normal view underneath.
      renderer.fillCircle(clip, PANE_BG);
    }
    switch (this.kind) {
      case 'layer':
        if (layer) renderer.draw(layer.id, { matrix: view, opacity: 1, pixelated, clip });
        break;
      case 'base':
        if (base) renderer.draw(base.id, { matrix: view, opacity: 1, pixelated, clip });
        break;
      case 'overlay': {
        if (base) renderer.draw(base.id, { matrix: view, opacity: 1, pixelated, clip });
        const t = layer && layer.id !== base?.id ? transformOf(layer) : null;
        if (layer && t) {
          renderer.draw(layer.id, {
            matrix: compose(view, t),
            opacity: state.overlayOpacity,
            pixelated,
            clip,
          });
        }
        break;
      }
      case 'view':
        for (let i = state.layers.length - 1; i >= 0; i--) {
          const l = state.layers[i];
          const t = transformOf(l);
          if (!l.visible || !t) continue;
          renderer.draw(l.id, { matrix: compose(view, t), opacity: l.opacity, pixelated, clip });
        }
        break;
    }
  }

  private markerSpecs(cam: Camera): MarkerSpec[] {
    const layer = selectedLayer();
    if (!layer || layer.id === state.baseId || this.kind === 'view') return [];
    const summary = fitSummary(layer);
    const t = transformOf(layer);
    const specs: MarkerSpec[] = [];
    const side = this.kind === 'layer' ? 'layer' : 'base';

    const drag = (move: (c: Vec) => void) => ({
      onDrag: (p: Vec) => {
        move(cam.toContent(p));
        pointsMoved(layer);
        this.hooks.pointsDragged();
      },
      onDragEnd: this.hooks.dragEnded,
    });

    layer.points.forEach((pt, i) => {
      const outlier = summary.outliers[i];
      specs.push({
        key: `p${pt.id}`,
        at: cam.toScreen(pt[side]),
        label: String(i + 1),
        className: outlier ? 'outlier' : '',
        ...drag((c) => (pt[side] = c)),
      });
      // On the base, show where the fit puts an outlier so the gap is visible.
      if (outlier && t && side === 'base') {
        specs.push({
          key: `f${pt.id}`,
          at: cam.toScreen(apply(t, pt.layer)),
          className: 'fitted',
          note: `fit puts ${i + 1} here`,
        });
      }
    });

    const pending = layer.pending;
    const n = String(layer.points.length + 1);
    if (pending?.[side]) {
      specs.push({
        key: 'pending',
        at: cam.toScreen(pending[side]!),
        label: n,
        className: 'pending',
        ...drag((c) => (pending[side] = c)),
      });
    }
    // Once a fit exists, hint where the other half of a pending point should go.
    const other = side === 'layer' ? 'base' : 'layer';
    if (pending?.[other] && !pending[side] && t && this.kind !== 'overlay') {
      const m = side === 'base' ? t : invert(t);
      if (m) {
        specs.push({
          key: 'predicted',
          at: cam.toScreen(apply(m, pending[other]!)),
          className: 'predicted',
          note: 'fit expects it here',
        });
      }
    }
    return specs;
  }
}
