import type { Vec } from './fit';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Most screen pixels per content pixel. Past this the view is just big blurry squares. */
export const MAX_SCALE = 32;

/**
 * Maps content coordinates (layer or base pixels) to pane coordinates (CSS pixels from the pane's
 * top-left corner): screen = content · scale + offset.
 */
export class Camera {
  scale = 1;
  offsetX = 0;
  offsetY = 0;
  /** Content area the camera is limited to. */
  bounds: Rect = { x: 0, y: 0, width: 1, height: 1 };
  /** Pane size in CSS pixels. */
  viewWidth = 1;
  viewHeight = 1;
  private fitted = false;

  toScreen(p: Vec): Vec {
    return { x: p.x * this.scale + this.offsetX, y: p.y * this.scale + this.offsetY };
  }

  toContent(p: Vec): Vec {
    return { x: (p.x - this.offsetX) / this.scale, y: (p.y - this.offsetY) / this.scale };
  }

  /** Scale at which the whole content fits the pane. Also the zoom-out limit. */
  fitScale(): number {
    const { width, height } = this.bounds;
    return Math.min(this.viewWidth / width, this.viewHeight / height);
  }

  setView(width: number, height: number) {
    if (width < 1 || height < 1) return;
    // Keep the content point at the centre of the pane where it was.
    const centre = this.toContent({ x: this.viewWidth / 2, y: this.viewHeight / 2 });
    this.viewWidth = width;
    this.viewHeight = height;
    if (!this.fitted) {
      this.fit();
      return;
    }
    this.offsetX = width / 2 - centre.x * this.scale;
    this.offsetY = height / 2 - centre.y * this.scale;
    this.clamp();
  }

  setBounds(bounds: Rect, refit = false) {
    this.bounds = bounds;
    if (refit || !this.fitted) this.fit();
    else this.clamp();
  }

  fit() {
    this.fitted = this.viewWidth > 1 && this.viewHeight > 1;
    const { x, y, width, height } = this.bounds;
    this.scale = this.fitScale();
    this.offsetX = this.viewWidth / 2 - (x + width / 2) * this.scale;
    this.offsetY = this.viewHeight / 2 - (y + height / 2) * this.scale;
  }

  /** Zoom by `factor`, keeping the content under the pane point `anchor` in place. */
  zoomAt(anchor: Vec, factor: number) {
    const before = this.toContent(anchor);
    this.scale = Math.min(MAX_SCALE, Math.max(this.fitScale(), this.scale * factor));
    this.offsetX = anchor.x - before.x * this.scale;
    this.offsetY = anchor.y - before.y * this.scale;
    this.clamp();
  }

  panBy(dx: number, dy: number) {
    this.offsetX += dx;
    this.offsetY += dy;
    this.clamp();
  }

  /** Centre the pane on a content point without changing the zoom. */
  centreOn(p: Vec) {
    this.offsetX = this.viewWidth / 2 - p.x * this.scale;
    this.offsetY = this.viewHeight / 2 - p.y * this.scale;
    this.clamp();
  }

  /**
   * Keeps the content on screen: when it is smaller than the pane it stays centred on that axis,
   * otherwise its edges can't be dragged inside the pane's edges.
   */
  private clamp() {
    const { x, y, width, height } = this.bounds;
    this.offsetX = clampAxis(this.offsetX, x * this.scale, width * this.scale, this.viewWidth);
    this.offsetY = clampAxis(this.offsetY, y * this.scale, height * this.scale, this.viewHeight);
  }
}

function clampAxis(offset: number, start: number, size: number, view: number): number {
  if (size <= view) return (view - size) / 2 - start;
  return Math.min(-start, Math.max(view - size - start, offset));
}
