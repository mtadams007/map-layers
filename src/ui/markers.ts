import type { Vec } from '../fit';

export interface MarkerSpec {
  /** Stable key so a marker being dragged keeps its element across frames. */
  key: string;
  at: Vec;
  label?: string;
  /** Extra CSS classes: 'pending', 'outlier', 'predicted', 'fitted'. */
  className?: string;
  /** Small caption next to the marker. */
  note?: string;
  /** Called with the new pane position while the marker is dragged. */
  onDrag?: (p: Vec) => void;
  onDragEnd?: () => void;
}

/**
 * Keeps a set of absolutely positioned marker elements in sync with a list of specs, reusing
 * elements by key so drags survive redraws.
 */
export class MarkerLayer {
  private els = new Map<string, HTMLElement>();
  private specs = new Map<string, MarkerSpec>();

  constructor(private container: HTMLElement) {}

  update(specs: MarkerSpec[]) {
    const seen = new Set<string>();
    for (const spec of specs) {
      seen.add(spec.key);
      this.specs.set(spec.key, spec);
      let el = this.els.get(spec.key);
      if (!el) {
        el = this.create(spec.key);
        this.els.set(spec.key, el);
        this.container.append(el);
      }
      const className = `marker ${spec.className ?? ''} ${spec.onDrag ? 'draggable' : ''}`;
      if (el.className !== className) el.className = className;
      const label = el.firstElementChild as HTMLElement;
      if (label.textContent !== (spec.label ?? '')) label.textContent = spec.label ?? '';
      const note = el.lastElementChild as HTMLElement;
      if (note.textContent !== (spec.note ?? '')) note.textContent = spec.note ?? '';
      note.hidden = !spec.note;
      el.style.transform = `translate(${spec.at.x}px, ${spec.at.y}px)`;
    }
    for (const [key, el] of this.els) {
      if (!seen.has(key)) {
        el.remove();
        this.els.delete(key);
        this.specs.delete(key);
      }
    }
  }

  private create(key: string): HTMLElement {
    const el = document.createElement('div');
    const dot = document.createElement('span');
    dot.className = 'marker-dot';
    const note = document.createElement('span');
    note.className = 'marker-note';
    el.append(dot, note);

    let dragging = false;
    let grab: Vec = { x: 0, y: 0 };
    const local = (e: PointerEvent): Vec => {
      const r = this.container.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    el.addEventListener('pointerdown', (e) => {
      const spec = this.specs.get(key);
      if (!spec?.onDrag) return;
      e.stopPropagation();
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      dragging = true;
      // Keep the offset between the pointer and the marker centre so it doesn't jump.
      const p = local(e);
      grab = { x: p.x - spec.at.x, y: p.y - spec.at.y };
    });
    el.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      e.stopPropagation();
      const p = local(e);
      this.specs.get(key)?.onDrag?.({ x: p.x - grab.x, y: p.y - grab.y });
    });
    const end = (e: PointerEvent) => {
      if (!dragging) return;
      e.stopPropagation();
      dragging = false;
      this.specs.get(key)?.onDragEnd?.();
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    return el;
  }
}
